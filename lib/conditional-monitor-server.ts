import {
  decodeConditionalMonitorPage,
  decodeMonitorNotice,
  type ConditionalMonitorPage,
  type MonitorMatch,
  type MonitorNotice,
} from './conditional-monitor';
import {
  decodeConditionalOrder,
  conditionalOrderSide,
} from './conditional-order';
import { observeTokenMarket, type SavedTokenMarket } from './token-market';
import { validateTokenSource } from './token-source';
import { reviewMarketTrigger } from './market-trigger';
import { UUID } from './wallet-operation';

type Job = {
  owner_id: string;
  project_id: string;
  revision: number;
  project_revision: number;
  enabled: number;
  next_check_at: number;
  lease_token: string | null;
  lease_until: number | null;
  attempts: number;
  error: string | null;
  last_checked_at: number | null;
  match_keys: string;
};
type Project = {
  revision: number;
  archived: number;
  chain: string;
  address: string;
  decimals: number;
};
type OrderRow = {
  id: string;
  revision: number;
  state: string;
  document: string;
  createdAt: string;
  updatedAt: string;
};
const projectSQL =
  "SELECT revision,archived,chain,address,json_extract(document,'$.token.decimals') AS decimals FROM imported_token_projects WHERE owner_id=? AND id=?";
const ordersSQL = `SELECT o.id,o.revision,o.state,o.document,o.created_at AS createdAt,o.updated_at AS updatedAt FROM conditional_sell_orders o JOIN workspace_wallets w ON w.owner_id=o.owner_id AND w.address=json_extract(o.document,'$.wallet') AND w.chain='Solana' AND w.archived=0 AND w.revision=json_extract(o.document,'$.walletRevision') WHERE o.owner_id=? AND o.project_id=? AND o.state='draft' AND json_extract(o.document,'$.projectRevision')=? ORDER BY o.id LIMIT 101`;
const key = (id: string, revision: number, level: number) =>
  `${id}:${revision}:${level}`;
export class MonitorConflict extends Error {}
export async function requireMonitorStorage(db: D1Database) {
  const tables = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE (type='table' AND name IN ('conditional_monitor_jobs','conditional_monitor_notices','conditional_monitor_runtime')) OR (type='trigger' AND name IN ('conditional_order_identity','conditional_order_retained','conditional_monitor_notice_immutable','conditional_monitor_notice_retained'))",
    )
    .all();
  if (tables.results.length !== 7)
    throw new Error('Conditional monitoring storage unavailable.');
}
function publicJob(row: Job): NonNullable<ConditionalMonitorPage['monitor']> {
  if (![0, 1].includes(row.enabled)) throw new Error('Invalid monitor state.');
  return {
    revision: row.revision,
    projectRevision: row.project_revision,
    enabled: row.enabled === 1,
    nextCheckAt: row.next_check_at,
    lastCheckedAt: row.last_checked_at,
    error: row.error,
  };
}
export async function readConditionalMonitor(
  db: D1Database,
  owner: string,
  projectId: string,
): Promise<ConditionalMonitorPage | null> {
  await requireMonitorStorage(db);
  const results = await db.batch([
    db
      .prepare(
        'SELECT id FROM imported_token_projects WHERE owner_id=? AND id=?',
      )
      .bind(owner, projectId),
    db
      .prepare(
        'SELECT * FROM conditional_monitor_jobs WHERE owner_id=? AND project_id=?',
      )
      .bind(owner, projectId),
    db
      .prepare(
        'SELECT id,created_at AS createdAt,document FROM conditional_monitor_notices WHERE owner_id=? AND project_id=? ORDER BY sequence DESC LIMIT 10',
      )
      .bind(owner, projectId),
    db.prepare(
      "SELECT last_seen_at FROM conditional_monitor_runtime WHERE name='conditional-market'",
    ),
    db
      .prepare(
        `SELECT id,revision,state,document,created_at AS createdAt,updated_at AS updatedAt FROM conditional_sell_orders WHERE owner_id=? AND project_id=? LIMIT 101`,
      )
      .bind(owner, projectId),
  ]);
  if (!results[0].results.length) return null;
  const row = results[1].results[0] as unknown as Job | undefined;
  const runtime = results[3].results[0] as { last_seen_at: number } | undefined;
  if (results[4].results.length > 100)
    throw new Error('Conditional order history exceeds its bound.');
  const orders = new Map(
    (results[4].results as unknown as OrderRow[]).map((r) => {
      const o = decodeConditionalOrder({ ...r, terms: JSON.parse(r.document) });
      if (o.terms.projectId !== projectId)
        throw new Error('Notice order context differs.');
      return [o.id, o];
    }),
  );
  return decodeConditionalMonitorPage(
    {
      projectId,
      executionAllowed: false,
      workerLastSeenAt: runtime?.last_seen_at ?? null,
      monitor: row ? publicJob(row) : null,
      notices: results[2].results.map((r) => {
        const row = r as { id: string; createdAt: string; document: string };
        const notice = decodeMonitorNotice(JSON.parse(row.document), projectId);
        if (notice.id !== row.id || notice.observedAt !== row.createdAt)
          throw new Error('Stored notice identity differs.');
        if (Date.parse(notice.observedAt) > Date.now() + 1000)
          throw new Error('Notice observation is in the future.');
        for (const match of notice.matches) {
          const o = orders.get(match.orderId);
          if (
            !o ||
            match.revision !== 1 ||
            o.terms.projectRevision !== notice.projectRevision ||
            conditionalOrderSide(o) !== match.side ||
            o.terms.pair !== match.pair ||
            o.terms.direction !== match.direction ||
            Date.parse(o.createdAt) > Date.parse(notice.observedAt) ||
            (o.state === 'cancelled' &&
              Date.parse(o.updatedAt) < Date.parse(notice.observedAt))
          )
            throw new Error('Notice differs from its retained draft.');
          for (const l of match.levels) {
            const original = o.terms.levels.find((v) => v.level === l.level);
            if (
              !original ||
              original.targetUsd !== l.targetUsd ||
              original.unitsRaw !== l.unitsRaw
            )
              throw new Error('Notice amount differs from retained terms.');
          }
        }
        return notice;
      }),
    },
    projectId,
  );
}
export async function configureConditionalMonitor(
  db: D1Database,
  owner: string,
  input: {
    projectId: string;
    projectRevision: number;
    monitorRevision: number;
    enabled: boolean;
  },
) {
  await requireMonitorStorage(db);
  const p = await db
    .prepare(projectSQL)
    .bind(owner, input.projectId)
    .first<Project>();
  if (!p) return null;
  if (
    p.revision !== input.projectRevision ||
    (input.enabled && (p.archived || p.chain !== 'Solana'))
  )
    throw new MonitorConflict('Project changed or is archived.');
  if (input.enabled) {
    const orders = await db
      .prepare(ordersSQL)
      .bind(owner, input.projectId, p.revision)
      .all<OrderRow>();
    if (!orders.results.length || orders.results.length > 100)
      throw new MonitorConflict(
        'Save 1 to 100 current conditional drafts before monitoring.',
      );
    orders.results.forEach((r) => {
      const o = decodeConditionalOrder({ ...r, terms: JSON.parse(r.document) });
      if (
        o.terms.projectId !== input.projectId ||
        o.terms.projectRevision !== p.revision ||
        o.terms.mint !== p.address ||
        o.terms.decimals !== p.decimals
      )
        throw new Error('Conditional context differs.');
    });
  }
  const now = Date.now();
  const result = await db
    .prepare(`INSERT INTO conditional_monitor_jobs(owner_id,project_id,revision,project_revision,enabled,next_check_at,attempts,match_keys)
    SELECT ?,?,1,?,?,?,0,'[]' WHERE ?=0 AND EXISTS(SELECT 1 FROM imported_token_projects WHERE owner_id=? AND id=? AND revision=? AND (?=0 OR archived=0))
    ON CONFLICT(owner_id,project_id) DO NOTHING`)
    .bind(
      owner,
      input.projectId,
      p.revision,
      Number(input.enabled),
      now,
      input.monitorRevision,
      owner,
      input.projectId,
      p.revision,
      Number(input.enabled),
    )
    .run();
  if (!result.meta.changes) {
    const updated = await db
      .prepare(
        `UPDATE conditional_monitor_jobs SET revision=revision+1,project_revision=?,enabled=?,next_check_at=?,lease_token=NULL,lease_until=NULL,attempts=0,error=NULL,last_checked_at=NULL,last_run_id=NULL,match_keys='[]' WHERE owner_id=? AND project_id=? AND revision=? AND EXISTS(SELECT 1 FROM imported_token_projects WHERE owner_id=? AND id=? AND revision=? AND (?=0 OR archived=0))`,
      )
      .bind(
        p.revision,
        Number(input.enabled),
        now,
        owner,
        input.projectId,
        input.monitorRevision,
        owner,
        input.projectId,
        p.revision,
        Number(input.enabled),
      )
      .run();
    if (!updated.meta.changes)
      throw new MonitorConflict('Monitoring changed. Reload before saving.');
  }
  return readConditionalMonitor(db, owner, input.projectId);
}
function validatedJob(j: Job) {
  decodeConditionalMonitorPage(
    {
      projectId: j.project_id,
      monitor: publicJob(j),
      notices: [],
      executionAllowed: false,
      workerLastSeenAt: null,
    },
    j.project_id,
  );
  if (
    typeof j.owner_id !== 'string' ||
    !j.owner_id ||
    !Number.isInteger(j.attempts) ||
    j.attempts < 0 ||
    j.attempts > 20 ||
    (j.lease_token === null) !== (j.lease_until === null) ||
    (j.lease_token !== null &&
      (!UUID.test(j.lease_token) || !Number.isSafeInteger(j.lease_until)))
  )
    throw new Error('Invalid monitor lease.');
  const keys: unknown = JSON.parse(j.match_keys);
  if (
    !Array.isArray(keys) ||
    keys.length > 5000 ||
    keys.some(
      (k) =>
        typeof k !== 'string' ||
        !/^[-a-f0-9]{36}:[1-9]\d{0,8}:[1-9]\d?$/.test(k),
    ) ||
    new Set(keys).size !== keys.length
  )
    throw new Error('Invalid monitor match keys.');
  return keys as string[];
}
async function defer(
  db: D1Database,
  j: Job,
  token: string,
  error: NonNullable<Job['error']>,
  wait: number,
  pause = false,
) {
  await db
    .prepare(
      'UPDATE conditional_monitor_jobs SET enabled=?,next_check_at=?,lease_token=NULL,lease_until=NULL,error=?,attempts=MIN(attempts+1,20) WHERE owner_id=? AND project_id=? AND revision=? AND lease_token=?',
    )
    .bind(
      pause ? 0 : 1,
      Date.now() + wait,
      error,
      j.owner_id,
      j.project_id,
      j.revision,
      token,
    )
    .run();
}
export async function runConditionalMonitors(
  db: D1Database,
  fetcher: typeof fetch = fetch,
) {
  await requireMonitorStorage(db);
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO conditional_monitor_runtime(name,last_seen_at) VALUES ('conditional-market',?) ON CONFLICT(name) DO UPDATE SET last_seen_at=MAX(last_seen_at,excluded.last_seen_at)",
    )
    .bind(now)
    .run();
  const due = await db
    .prepare(
      'SELECT * FROM conditional_monitor_jobs WHERE enabled=1 AND next_check_at<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY next_check_at,owner_id,project_id LIMIT 4',
    )
    .bind(now, now)
    .all<Job>();
  let processed = 0,
    errors = 0;
  for (const j of due.results) {
    let previousKeys: string[];
    try {
      previousKeys = validatedJob(j);
    } catch {
      errors++;
      await db
        .prepare(
          "UPDATE conditional_monitor_jobs SET enabled=0,error='storage-unavailable',lease_token=NULL,lease_until=NULL,match_keys='[]' WHERE owner_id=? AND project_id=? AND revision=?",
        )
        .bind(j.owner_id, j.project_id, j.revision)
        .run();
      continue;
    }
    const token = crypto.randomUUID(),
      claimedAt = Date.now();
    const claimed = await db
      .prepare(
        'UPDATE conditional_monitor_jobs SET lease_token=?,lease_until=? WHERE owner_id=? AND project_id=? AND revision=? AND enabled=1 AND next_check_at<=? AND (lease_until IS NULL OR lease_until<=?)',
      )
      .bind(
        token,
        claimedAt + 20000,
        j.owner_id,
        j.project_id,
        j.revision,
        claimedAt,
        claimedAt,
      )
      .run();
    if (!claimed.meta.changes) continue;
    processed++;
    let failure = 'storage-unavailable';
    try {
      const p = await db
        .prepare(projectSQL)
        .bind(j.owner_id, j.project_id)
        .first<Project>();
      if (
        !p ||
        p.archived ||
        p.revision !== j.project_revision ||
        p.chain !== 'Solana'
      ) {
        await defer(db, j, token, 'context-changed', 60000, true);
        continue;
      }
      const rows = await db
        .prepare(ordersSQL)
        .bind(j.owner_id, j.project_id, p.revision)
        .all<OrderRow>();
      if (rows.results.length > 100)
        throw new Error('Too many conditional drafts.');
      if (!rows.results.length) {
        await defer(db, j, token, 'no-current-orders', 60000);
        continue;
      }
      const orders = rows.results.map((r) =>
        decodeConditionalOrder({ ...r, terms: JSON.parse(r.document) }),
      );
      if (
        orders.some(
          (o) =>
            o.terms.mint !== p.address ||
            o.terms.decimals !== p.decimals ||
            o.terms.projectId !== j.project_id ||
            o.terms.projectRevision !== p.revision,
        )
      )
        throw new Error('Conditional context differs.');
      const statuses = await db
        .prepare(
          `SELECT v.order_id AS id,v.level FROM conditional_level_reservations v JOIN conditional_sell_orders o ON o.owner_id=v.owner_id AND o.id=v.order_id WHERE v.owner_id=? AND o.project_id=? UNION ALL SELECT f.order_id AS id,f.level FROM conditional_level_fills f JOIN conditional_sell_orders o ON o.owner_id=f.owner_id AND o.id=f.order_id WHERE f.owner_id=? AND o.project_id=? LIMIT 5001`,
        )
        .bind(j.owner_id, j.project_id, j.owner_id, j.project_id)
        .all<{ id: string; level: number }>();
      if (statuses.results.length > 5000)
        throw new Error('Too many conditional reservations.');
      const unavailable = new Set(
        statuses.results.map((s) => `${s.id}:${s.level}`),
      );
      if (
        orders.every((o) =>
          o.terms.levels.every((l) => unavailable.has(`${o.id}:${l.level}`)),
        )
      ) {
        await defer(db, j, token, 'no-current-orders', 60000);
        continue;
      }
      const oldMarket = await db
        .prepare(
          'SELECT document FROM imported_market_observations WHERE owner_id=? AND project_id=?',
        )
        .bind(j.owner_id, j.project_id)
        .first<{ document: string }>();
      const gatedAt = Date.now(),
        gate = await db
          .prepare(
            'INSERT INTO market_read_gates(owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE market_read_gates.next_allowed_at<=?',
          )
          .bind(j.owner_id, gatedAt + 15000, gatedAt)
          .run();
      if (!gate.meta.changes) {
        const gateRow = await db
          .prepare(
            'SELECT next_allowed_at AS due FROM market_read_gates WHERE owner_id=?',
          )
          .bind(j.owner_id)
          .first<{ due: number }>();
        await defer(
          db,
          j,
          token,
          'rate-limited',
          Math.max(1000, (gateRow?.due ?? gatedAt + 15000) - Date.now()),
        );
        continue;
      }
      failure = 'provider-unavailable';
      const observation: SavedTokenMarket = {
        ...(await observeTokenMarket(
          validateTokenSource({ chain: p.chain, address: p.address }),
          AbortSignal.timeout(15000),
          fetcher,
        )),
        projectRevision: p.revision,
      };
      failure = 'storage-unavailable';
      const checkedAt = Date.now(),
        matches: MonitorMatch[] = [],
        keys: string[] = [],
        unknownOrders = new Set<string>();
      for (const o of orders) {
        const levels: MonitorMatch['levels'] = [];
        let cap = '';
        try {
          for (const l of o.terms.levels) {
            const review = reviewMarketTrigger(
              {
                pair: o.terms.pair,
                direction: o.terms.direction,
                targetUsd: l.targetUsd,
              },
              observation,
              { chain: p.chain, mint: p.address, revision: p.revision },
              checkedAt,
            );
            cap = review.observedMarketCapUsd;
            if (review.met && !unavailable.has(`${o.id}:${l.level}`)) {
              levels.push({
                level: l.level,
                targetUsd: l.targetUsd,
                unitsRaw: l.unitsRaw,
              });
              keys.push(key(o.id, o.revision, l.level));
            }
          }
        } catch {
          unknownOrders.add(o.id);
          continue;
        }
        if (levels.length)
          matches.push({
            orderId: o.id,
            revision: o.revision,
            side: conditionalOrderSide(o),
            pair: o.terms.pair,
            direction: o.terms.direction,
            observedMarketCapUsd: cap,
            levels,
          });
      }
      keys.push(
        ...previousKeys.filter((k) => unknownOrders.has(k.slice(0, 36))),
      );
      const priorKeys = new Set(previousKeys),
        entered = matches
          .map((m) => ({
            ...m,
            levels: m.levels.filter(
              (l) => !priorKeys.has(key(m.orderId, m.revision, l.level)),
            ),
          }))
          .filter((m) => m.levels.length);
      const notice: MonitorNotice = {
        id: crypto.randomUUID(),
        projectId: j.project_id,
        projectRevision: p.revision,
        monitorRevision: j.revision,
        observedAt: observation.observedAt,
        expiresAt: new Date(
          Date.parse(observation.observedAt) + 30000,
        ).toISOString(),
        source: observation.source,
        checkedOrders: orders.length,
        unavailableOrders: unknownOrders.size,
        matches: entered,
        executionAllowed: false,
      };
      if (entered.length) decodeMonitorNotice(notice, j.project_id);
      const prior: SavedTokenMarket[] = oldMarket
        ? JSON.parse(oldMarket.document)
        : [];
      if (
        prior[0] &&
        Date.parse(prior[0].observedAt) >= Date.parse(observation.observedAt)
      ) {
        await defer(db, j, token, 'context-changed', 15000);
        continue;
      }
      // Required immutable-order triggers bind these compact identities to the
      // validated documents, without duplicating large high-precision grids.
      const guardDocuments = JSON.stringify(
        rows.results.map((r) => ({
          id: r.id,
          revision: r.revision,
        })),
      );
      const complete = db
        .prepare(`UPDATE conditional_monitor_jobs SET last_run_id=?,last_checked_at=?,next_check_at=?,lease_token=NULL,lease_until=NULL,attempts=0,error=?,match_keys=? WHERE owner_id=? AND project_id=? AND revision=? AND enabled=1 AND lease_token=? AND lease_until>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
        AND EXISTS(SELECT 1 FROM imported_token_projects WHERE owner_id=? AND id=? AND revision=? AND archived=0 AND address=? AND chain='Solana' AND json_extract(document,'$.token.decimals')=?)
        AND (SELECT COUNT(*) FROM conditional_sell_orders o JOIN workspace_wallets w ON w.owner_id=o.owner_id AND w.address=json_extract(o.document,'$.wallet') AND w.chain='Solana' AND w.archived=0 AND w.revision=json_extract(o.document,'$.walletRevision') WHERE o.owner_id=? AND o.project_id=? AND o.state='draft' AND json_extract(o.document,'$.projectRevision')=?)=?
        AND NOT EXISTS(SELECT 1 FROM json_each(?) d WHERE NOT EXISTS(SELECT 1 FROM conditional_sell_orders o JOIN workspace_wallets w ON w.owner_id=o.owner_id AND w.address=json_extract(o.document,'$.wallet') AND w.chain='Solana' AND w.archived=0 AND w.revision=json_extract(o.document,'$.walletRevision') WHERE o.owner_id=? AND o.project_id=? AND o.id=json_extract(d.value,'$.id') AND o.revision=json_extract(d.value,'$.revision') AND o.state='draft'))
        AND NOT EXISTS(SELECT 1 FROM conditional_level_reservations v WHERE v.owner_id=? AND v.order_id IN (SELECT json_extract(value,'$.id') FROM json_each(?)) AND v.order_id||':'||v.level NOT IN (SELECT value FROM json_each(?)))
        AND NOT EXISTS(SELECT 1 FROM conditional_level_fills f WHERE f.owner_id=? AND f.order_id IN (SELECT json_extract(value,'$.id') FROM json_each(?)) AND f.order_id||':'||f.level NOT IN (SELECT value FROM json_each(?)))
        AND (?='' AND NOT EXISTS(SELECT 1 FROM imported_market_observations WHERE owner_id=? AND project_id=?) OR EXISTS(SELECT 1 FROM imported_market_observations WHERE owner_id=? AND project_id=? AND document=?)) AND julianday(?)>julianday('now')`)
        .bind(
          token,
          checkedAt,
          checkedAt + 60000,
          unknownOrders.size ? 'pool-unavailable' : null,
          JSON.stringify([...new Set(keys)]),
          j.owner_id,
          j.project_id,
          j.revision,
          token,
          j.owner_id,
          j.project_id,
          p.revision,
          p.address,
          p.decimals,
          j.owner_id,
          j.project_id,
          p.revision,
          orders.length,
          guardDocuments,
          j.owner_id,
          j.project_id,
          j.owner_id,
          guardDocuments,
          JSON.stringify([...unavailable]),
          j.owner_id,
          guardDocuments,
          JSON.stringify([...unavailable]),
          oldMarket?.document ?? '',
          j.owner_id,
          j.project_id,
          j.owner_id,
          j.project_id,
          oldMarket?.document ?? '',
          notice.expiresAt,
        );
      const statements = [
        complete,
        db
          .prepare(
            `INSERT INTO imported_market_observations(owner_id,project_id,document,observed_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM conditional_monitor_jobs WHERE owner_id=? AND project_id=? AND last_run_id=?) ON CONFLICT(owner_id,project_id) DO UPDATE SET document=excluded.document,observed_at=excluded.observed_at WHERE imported_market_observations.observed_at<excluded.observed_at`,
          )
          .bind(
            j.owner_id,
            j.project_id,
            JSON.stringify([observation, ...prior].slice(0, 20)),
            observation.observedAt,
            j.owner_id,
            j.project_id,
            token,
          ),
      ];
      if (entered.length)
        statements.push(
          db
            .prepare(
              `INSERT INTO conditional_monitor_notices(id,owner_id,project_id,document,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM conditional_monitor_jobs WHERE owner_id=? AND project_id=? AND last_run_id=?)`,
            )
            .bind(
              notice.id,
              j.owner_id,
              j.project_id,
              JSON.stringify(notice),
              observation.observedAt,
              j.owner_id,
              j.project_id,
              token,
            ),
        );
      const saved = await db.batch(statements);
      if (!saved[0].meta.changes)
        await defer(db, j, token, 'context-changed', 15000);
    } catch {
      errors++;
      await defer(
        db,
        j,
        token,
        failure,
        Math.min(300000, 15000 * 2 ** Math.min(j.attempts, 5)),
      );
    }
  }
  return { processed, errors, executionAllowed: false as const };
}
