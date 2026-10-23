import { afterEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { warmupReconstructionFixture } from '../test/warmup-reconstruction-fixture';
import { advanceFamilyExclusionClock } from '../test/solana-family-exclusion-fixture';
import {
  retainWarmupExecutionProposal,
  readWarmupExecutionProposal,
} from './wallet-warmup-execution-proposal-storage';
import {
  retainWarmupExecutionApproval as retain,
  readWarmupExecutionApproval as read,
  warmupExecutionApprovalPacingBefore as pacingBefore,
  WarmupExecutionApprovalReadRace,
} from './wallet-warmup-execution-approval';
import { WARMUP_EXECUTION_ACKNOWLEDGEMENT } from './wallet-warmup-execution-terms';
import { reviewWalletWarmupExecutionPacing } from './wallet-warmup-execution-pacing';
import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { Miniflare } from 'miniflare';
import { createTursoDatabase } from '../db/turso';
import { warmupProposalSqlTokens } from './wallet-warmup-execution-proposal-schema';

const { controlled } = vi.hoisted(() => ({
  controlled: {
    fetcher: undefined as typeof fetch | undefined,
    now: undefined as (() => number) | undefined,
  },
}));
vi.mock('./wallet-rpc-pacing', () => ({
  paceWalletRpc: vi.fn(async () => {}),
}));
vi.mock('./wallet-warmup-execution-budget-review', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('./wallet-warmup-execution-budget-review')
    >();
  return {
    ...actual,
    reviewWarmupExecutionBudget: vi.fn(
      (
        db: D1Database,
        owner: string,
        value: unknown,
        signal: AbortSignal,
        dependencies?: { fetcher?: typeof fetch; now?: () => number },
      ) =>
        actual.reviewWarmupExecutionBudget(
          db,
          owner,
          value,
          signal,
          dependencies ?? controlled,
        ),
    ),
  };
});
const fixtures: Awaited<ReturnType<typeof warmupReconstructionFixture>>[] = [];
const prior = env.SOLANA_INDEXER_RPC_URL;
afterEach(() => {
  for (const f of fixtures.splice(0)) f.dispose();
  controlled.fetcher = undefined;
  controlled.now = undefined;
  vi.restoreAllMocks();
  if (prior === undefined) delete env.SOLANA_INDEXER_RPC_URL;
  else env.SOLANA_INDEXER_RPC_URL = prior;
});
const signal = () => new AbortController().signal;
type Hook = (sql: string, op: string) => void | Promise<void>;
async function fixture(publish = true, tightPacing = false) {
  const f = await warmupReconstructionFixture(
    'none',
    false,
    tightPacing ? { intervalSeconds: 10 } : {},
  );
  fixtures.push(f);
  env.SOLANA_INDEXER_RPC_URL = 'https://reconstruction.invalid/';
  controlled.fetcher = f.fetcher;
  controlled.now = f.clock;
  let hook: Hook | undefined, afterHook: Hook | undefined;
  const statements: string[] = [];
  const db = {
    prepare(sql: string) {
      statements.push(sql);
      const st = f.db.prepare(sql);
      const w = {
        bind(...v: unknown[]) {
          st.bind(
            ...v.map((x) => (x instanceof ArrayBuffer ? new Uint8Array(x) : x)),
          );
          return w;
        },
        async first<T>() {
          await hook?.(sql, 'first');
          return await st.first<T>();
        },
        async all<T>() {
          await hook?.(sql, 'all');
          return { ...(await st.all<T>()), success: true };
        },
        async run<T>() {
          await hook?.(sql, 'run');
          const r = { ...(await st.run<T>()), success: true };
          await afterHook?.(sql, 'run');
          return r;
        },
      };
      return w;
    },
  } as unknown as D1Database;
  const proposalRequest = {
    ...f.input,
    rootId: f.expected.id,
    consentId: f.expected.consentId,
    sessionExpiresAt: f.proposed.terms.intent.expiresAt,
    feeRentLimits: f.proposed.budget.feeRentLimits,
  };
  if (tightPacing) {
    const minimum = reviewWalletWarmupExecutionPacing(
      {
        actions: f.proposed.terms.intent.actions.map(({ id, scheduledAt }) => ({
          id,
          scheduledAt,
        })),
        sessionExpiresAt: f.proposed.terms.intent.expiresAt,
      },
      f.clock(),
    );
    proposalRequest.sessionExpiresAt = new Date(
      minimum.earliestLastStartEpochMs + 1000,
    ).toISOString();
  }
  if (!publish)
    hook = (sql, op) => {
      if (
        op === 'run' &&
        sql.startsWith(
          'INSERT INTO wallet_warmup_execution_proposal_publications',
        )
      )
        throw Error('hold staged fixture');
    };
  if (publish)
    await retainWarmupExecutionProposal(db, f.owner, proposalRequest, signal());
  else
    await expect(
      retainWarmupExecutionProposal(db, f.owner, proposalRequest, signal()),
    ).rejects.toThrow();
  hook = undefined;
  const proposal = await readWarmupExecutionProposal(
    db,
    f.owner,
    f.expected.id,
    signal(),
  );
  if (!proposal || proposal.status === 'incomplete')
    throw Error('Missing complete synthetic proposal');
  expect(proposal.status).toBe(publish ? 'published' : 'staged');
  const request = {
    proposalId: proposal.id,
    headerSha256: proposal.headerSha256,
    termsSha256: proposal.proposal.termsSha256,
    approved: true as const,
    acknowledgement: WARMUP_EXECUTION_ACKNOWLEDGEMENT,
  };
  return {
    ...f,
    db,
    proposal,
    request,
    statements,
    setHook: (h?: Hook) => {
      hook = h;
    },
    setAfterHook: (h?: Hook) => {
      afterHook = h;
    },
    save: () => retain(db, f.owner, request, signal()),
    read: () => read(db, f.owner, request.proposalId, signal()),
    sqlClock: () =>
      String(
        f
          .actual!.sqlite.prepare(
            "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS clock",
          )
          .get()!.clock,
      ),
  };
}

it('records exact owner-request metadata and an independently bound root with real SQL timestamps, without provider calls or execution authority', async () => {
  const f = await fixture(),
    calls = f.providerCalls();
  expect(await f.read()).toBeNull();
  const saved = await f.save();
  expect(saved).toMatchObject({
    status: 'root-recorded',
    ownerApprovalRecorded: true,
    humanApprovalVerified: false,
    signingAllowed: false,
    executionAllowed: false,
    automaticExecutionAllowed: false,
  });
  expect(saved.approval.approvedAt).toBe(f.sqlClock());
  expect(saved.rootCreatedAt).toBe(f.sqlClock());
  expect(saved.approval.approvedAt >= f.proposal.publishedAt!).toBe(true);
  expect(saved.rootSha256).not.toBe(saved.manifestSha256);
  expect(saved.consentSha256).not.toBe(saved.termsSha256);
  expect(await f.read()).toEqual(saved);
  expect(await f.save()).toEqual(saved);
  expect(f.providerCalls()).toBe(calls);
});

it.each([
  'approved',
  'acknowledgement',
  'headerSha256',
  'termsSha256',
  'timestamp',
  'evidence',
] as const)(
  'refuses changed or missing %s before any approval write',
  async (field) => {
    const f = await fixture(),
      body: Record<string, unknown> = { ...f.request };
    if (field === 'approved') body.approved = false;
    if (field === 'acknowledgement') body.acknowledgement = 'yes';
    if (field === 'headerSha256' || field === 'termsSha256')
      body[field] = '0'.repeat(64);
    if (field === 'timestamp') body.approvedAt = f.sqlClock();
    if (field === 'evidence')
      body.verifierEvidence = f.proposed.verifierEvidence;
    f.statements.length = 0;
    const calls = f.providerCalls();
    await expect(retain(f.db, f.owner, body, signal())).rejects.toThrow();
    expect(
      f.statements.some((s) =>
        s.startsWith('INSERT INTO wallet_warmup_execution_approvals'),
      ),
    ).toBe(false);
    expect(f.providerCalls()).toBe(calls);
  },
);

it('refuses staged content that has not actually been published', async () => {
  const f = await fixture(false);
  await expect(f.save()).rejects.toThrow();
  expect(await f.read()).toBeNull();
});

it('does not expose or approve another owner or fall back to a newer ID', async () => {
  const f = await fixture();
  await f.save();
  expect(
    await read(f.db, 'other-owner', f.request.proposalId, signal()),
  ).toBeNull();
  expect(await read(f.db, f.owner, crypto.randomUUID(), signal())).toBeNull();
  await expect(
    retain(f.db, 'other-owner', f.request, signal()),
  ).rejects.toThrow();
});

it('recovers the original root after expiry and archive with no provider, clock renewal or writes', async () => {
  const f = await fixture(),
    saved = await f.save(),
    calls = f.providerCalls();
  advanceFamilyExclusionClock(f.actual!.sqlite, 70000);
  f.actual!.sqlite.prepare(
    'UPDATE wallet_warmup_plans SET archived=1 WHERE owner_id=? AND id=?',
  ).run(f.owner, f.actual!.planId);
  f.statements.length = 0;
  expect(await f.read()).toEqual(saved);
  expect(await f.save()).toEqual(saved);
  expect(f.providerCalls()).toBe(calls);
  expect(f.statements.some((s) => /INSERT|UPDATE|DELETE/.test(s))).toBe(false);
});

it.each([-1, 0] as const)(
  'uses the original exclusive asset deadline at offset %s ms',
  async (offset) => {
    const f = await fixture();
    advanceFamilyExclusionClock(
      f.actual!.sqlite,
      Date.parse(f.proposal.proposalExpiresAt) -
        Date.parse(f.sqlClock()) +
        offset,
    );
    if (offset === -1) expect((await f.save()).status).toBe('root-recorded');
    else {
      await expect(f.save()).rejects.toThrow();
      expect(await f.read()).toBeNull();
    }
  },
);

it('retains approval without inventing a root after an interrupted root write, then resumes exactly once', async () => {
  const f = await fixture();
  f.setHook((sql, op) => {
    if (
      op === 'run' &&
      sql.startsWith('INSERT INTO wallet_warmup_execution_roots')
    )
      throw Error('pause before root');
  });
  await expect(f.save()).rejects.toThrow();
  f.setHook();
  const partial = await f.read();
  expect(partial?.status).toBe('approval-recorded');
  expect(partial?.root).toBeNull();
  const calls = f.providerCalls(),
    saved = await f.save();
  expect(saved.approval).toEqual(partial!.approval);
  expect(saved.status).toBe('root-recorded');
  expect(f.providerCalls()).toBe(calls);
});

it('never renews an approval to publish a root after the original window expires', async () => {
  const f = await fixture();
  f.setHook((sql, op) => {
    if (
      op === 'run' &&
      sql.startsWith('INSERT INTO wallet_warmup_execution_roots')
    )
      throw Error('hold root');
  });
  await expect(f.save()).rejects.toThrow();
  f.setHook();
  const before = await f.read();
  advanceFamilyExclusionClock(f.actual!.sqlite, 25001);
  await expect(f.save()).rejects.toThrow();
  expect(await f.read()).toEqual(before);
});

it.each(['approval', 'root'] as const)(
  'closes the final source race before %s insertion in SQL',
  async (phase) => {
    const f = await fixture();
    let changed = false;
    f.setHook((sql, op) => {
      if (
        op === 'run' &&
        sql.startsWith(
          `INSERT INTO wallet_warmup_execution_${phase === 'approval' ? 'approvals' : 'roots'}`,
        )
      ) {
        f.actual!.sqlite.prepare(
          'UPDATE wallet_warmup_plans SET archived=1 WHERE owner_id=? AND id=?',
        ).run(f.owner, f.actual!.planId);
        changed = true;
      }
    });
    await expect(f.save()).rejects.toThrow();
    expect(changed).toBe(true);
    f.setHook();
    expect((await f.read())?.status ?? null).toBe(
      phase === 'approval' ? null : 'approval-recorded',
    );
  },
);

it('cancellation after approval commit recovers its exact timestamp without automatically publishing a root', async () => {
  const f = await fixture(),
    c = new AbortController();
  f.setAfterHook((sql, op) => {
    if (
      op === 'run' &&
      sql.startsWith('INSERT INTO wallet_warmup_execution_approvals')
    )
      c.abort(Error('caller left'));
  });
  await expect(retain(f.db, f.owner, f.request, c.signal)).rejects.toThrow(
    'caller left',
  );
  f.setAfterHook();
  const kept = await f.read();
  expect(kept?.status).toBe('approval-recorded');
  expect((await f.save()).approval).toEqual(kept!.approval);
});

it('recovers a lost committed root response without another write or provider read', async () => {
  const f = await fixture();
  let fired = false;
  f.setAfterHook((sql, op) => {
    if (
      !fired &&
      op === 'run' &&
      sql.startsWith('INSERT INTO wallet_warmup_execution_roots')
    ) {
      fired = true;
      throw Error('lost root response');
    }
  });
  const saved = await f.save();
  expect(fired).toBe(true);
  expect(saved.status).toBe('root-recorded');
  f.setAfterHook();
  const calls = f.providerCalls();
  f.statements.length = 0;
  expect(await f.save()).toEqual(saved);
  expect(f.providerCalls()).toBe(calls);
  expect(f.statements.some((s) => /INSERT|UPDATE|DELETE/.test(s))).toBe(false);
});

it.each(['approvals', 'roots'] as const)(
  'refuses UPDATE, DELETE and OR REPLACE for %s',
  async (table) => {
    const f = await fixture();
    await f.save();
    const name = 'wallet_warmup_execution_' + table;
    f.actual!.sqlite.exec('PRAGMA recursive_triggers=OFF');
    expect(() =>
      f.actual!.sqlite.exec(
        `UPDATE ${name} SET terms_sha256='${'0'.repeat(64)}'`,
      ),
    ).toThrow('immutable');
    expect(() => f.actual!.sqlite.exec(`DELETE FROM ${name}`)).toThrow(
      'immutable',
    );
    expect(() =>
      f.actual!.sqlite.exec(
        `INSERT OR REPLACE INTO ${name} SELECT * FROM ${name}`,
      ),
    ).toThrow('refused');
  },
);

it('refuses a missing or weakened original review immutability guard', async () => {
  const f = await fixture();
  f.actual!.sqlite.exec('DROP TRIGGER wallet_warmup_session_reviews_no_update');
  f.actual!.sqlite.exec(
    'CREATE TRIGGER wallet_warmup_session_reviews_no_update BEFORE UPDATE ON wallet_warmup_session_reviews BEGIN SELECT 1; END',
  );
  await expect(f.save()).rejects.toThrow();
  expect(
    f
      .actual!.sqlite.prepare(
        'SELECT count(*) AS n FROM wallet_warmup_execution_approvals',
      )
      .get()!.n,
  ).toBe(0);
});

it('matches the exact pacing boundary and refuses impossible fixed schedules (schedule-only model vectors)', async () => {
  const f = await fixture();
  const t = structuredClone(f.proposal.proposal.terms),
    at = Date.parse(t.intent.createdAt),
    count = t.intent.actions.length;
  for (const a of t.intent.actions) a.scheduledAt = t.intent.createdAt;
  t.intent.expiresAt = new Date(at + (count - 1) * 30000 + 1000).toISOString();
  const before = pacingBefore(t);
  expect(before).toBe(new Date(at + 1000).toISOString());
  const selected = {
    actions: t.intent.actions.map(({ id, scheduledAt }) => ({
      id,
      scheduledAt,
    })),
    sessionExpiresAt: t.intent.expiresAt,
  };
  expect(
    reviewWalletWarmupExecutionPacing(selected, Date.parse(before) - 1)
      .fitsMinimumPacing,
  ).toBe(true);
  expect(
    reviewWalletWarmupExecutionPacing(selected, Date.parse(before))
      .fitsMinimumPacing,
  ).toBe(false);
  t.intent.actions.at(-1)!.scheduledAt = t.intent.expiresAt;
  expect(() => pacingBefore(t)).toThrow();
});

it('concurrent exact requests share the original approval timestamp and single root without provider work', async () => {
  const f = await fixture(),
    calls = f.providerCalls();
  let arrivals = 0,
    rootArrivals = 0,
    releaseRoot!: () => void,
    release!: () => void;
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  const rootBarrier = new Promise<void>((r) => {
    releaseRoot = r;
  });
  f.setHook(async (sql, op) => {
    if (
      op === 'run' &&
      sql.startsWith('INSERT INTO wallet_warmup_execution_roots')
    ) {
      if (++rootArrivals === 2) releaseRoot();
      await rootBarrier;
    }
    if (
      op === 'run' &&
      sql.startsWith('INSERT INTO wallet_warmup_execution_approvals')
    ) {
      if (++arrivals === 2) release();
      await barrier;
    }
  });
  const [a, b] = await Promise.all([f.save(), f.save()]);
  f.setHook();
  expect(arrivals).toBe(2);
  expect(rootArrivals).toBe(2);
  expect(a).toEqual(b);
  expect(
    f
      .actual!.sqlite.prepare(
        'SELECT count(*) AS n FROM wallet_warmup_execution_approvals',
      )
      .get()!.n,
  ).toBe(1);
  expect(
    f
      .actual!.sqlite.prepare(
        'SELECT count(*) AS n FROM wallet_warmup_execution_roots',
      )
      .get()!.n,
  ).toBe(1);
  expect(f.providerCalls()).toBe(calls);
});

it('does not accept a new model request under an already recorded root ID', async () => {
  const f = await fixture(),
    saved = await f.save();
  f.statements.length = 0;
  await expect(
    retain(
      f.db,
      f.owner,
      { ...f.request, headerSha256: '0'.repeat(64) },
      signal(),
    ),
  ).rejects.toThrow();
  expect(f.statements.some((s) => s.startsWith('INSERT'))).toBe(false);
  expect(await f.read()).toEqual(saved);
});

it('SQL independently refuses approval at the exclusive pacing deadline', async () => {
  const f = await fixture();
  expect(() =>
    f
      .actual!.sqlite.prepare(
        `INSERT INTO wallet_warmup_execution_approvals VALUES(?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?,?,?)`,
      )
      .run(
        f.owner,
        f.request.proposalId,
        f.proposal.consentId,
        f.proposal.reviewId,
        f.request.headerSha256,
        f.request.termsSha256,
        '0'.repeat(64),
        f.proposal.proposal.terms.intent.expiresAt,
        f.sqlClock(),
        WARMUP_EXECUTION_ACKNOWLEDGEMENT,
      ),
  ).toThrow('approval refused');
});

it.each([-1, 0] as const)(
  'enforces a genuine source-derived approval pacing bound at offset %s before the later asset expiry',
  async (offset) => {
    const f = await fixture(true, true),
      before = pacingBefore(f.proposal.proposal.terms);
    expect(before < f.proposal.proposalExpiresAt).toBe(true);
    advanceFamilyExclusionClock(
      f.actual!.sqlite,
      Date.parse(before) - Date.parse(f.sqlClock()) + offset,
    );
    if (offset === -1) expect((await f.save()).status).toBe('root-recorded');
    else {
      await expect(f.save()).rejects.toThrow();
      expect(await f.read()).toBeNull();
    }
  },
);

it('refuses a root reaching the actual pacing bound after an otherwise timely exact approval', async () => {
  const f = await fixture(true, true),
    before = pacingBefore(f.proposal.proposal.terms);
  let advanced = false;
  f.setHook((sql, op) => {
    if (
      op === 'run' &&
      sql.startsWith('INSERT INTO wallet_warmup_execution_roots')
    ) {
      advanceFamilyExclusionClock(
        f.actual!.sqlite,
        Date.parse(before) - Date.parse(f.sqlClock()),
      );
      advanced = true;
    }
  });
  await expect(f.save()).rejects.toThrow();
  f.setHook();
  expect(advanced).toBe(true);
  expect((await f.read())?.status).toBe('approval-recorded');
  expect(f.sqlClock() < f.proposal.proposalExpiresAt).toBe(true);
});

it('rejects root/manifest hash domain substitution even after exact guard restoration', async () => {
  const f = await fixture();
  await f.save();
  const guard = f
    .actual!.sqlite.prepare(
      "SELECT sql FROM sqlite_master WHERE name='warmup_execution_root_no_update'",
    )
    .get()!.sql as string;
  f.actual!.sqlite.exec('DROP TRIGGER warmup_execution_root_no_update');
  f.actual!.sqlite.exec(
    'UPDATE wallet_warmup_execution_roots SET root_sha256=manifest_sha256',
  );
  f.actual!.sqlite.exec(guard);
  await expect(f.read()).rejects.toThrow();
});

it('performs no global provider fetch while recording or recovering approval', async () => {
  const f = await fixture();
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw Error('no provider on approval path');
  });
  const kept = await f.save();
  expect(await f.read()).toEqual(kept);
  expect(fetcher).not.toHaveBeenCalled();
});

it('preserves all twenty committed source/owner/family guards for both new insertion phases', () => {
  const original = readFileSync(
    'drizzle/0139_wallet_warmup_execution_proposals.sql',
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((s) =>
      s.includes('CREATE TRIGGER warmup_proposal_publication_current_'),
    );
  const newer = readFileSync(
    'drizzle/0140_wallet_warmup_execution_approvals.sql',
    'utf8',
  ).split('--> statement-breakpoint');
  expect(original).toHaveLength(20);
  for (const phase of ['approval', 'root']) {
    const actual = newer.filter((s) =>
      s.includes(`CREATE TRIGGER warmup_execution_${phase}_current_`),
    );
    expect(actual).toHaveLength(20);
    const table =
      phase === 'approval'
        ? 'wallet_warmup_execution_approvals'
        : 'wallet_warmup_execution_roots';
    expect(actual.map(warmupProposalSqlTokens)).toEqual(
      original.map((s) =>
        warmupProposalSqlTokens(
          s
            .replaceAll(
              'warmup_proposal_publication_current_',
              `warmup_execution_${phase}_current_`,
            )
            .replace(
              'BEFORE INSERT ON wallet_warmup_execution_proposal_publications',
              'BEFORE INSERT ON ' + table,
            ),
        ),
      ),
    );
  }
});

it.each(['turso', 'd1'] as const)(
  'records exact approval and root and recovers without providers on actual disposable %s',
  async (platform) => {
    const client =
      platform === 'turso' ? createClient({ url: 'file::memory:' }) : null;
    const mf =
      platform === 'd1'
        ? new Miniflare({
            telemetry: { enabled: false },
            workers: [
              {
                config: {
                  name: 'warmup-approval-only',
                  type: 'worker',
                  compatibilityDate: '2026-09-01',
                  manifest: {
                    mainModule: 'index.js',
                    modules: {
                      'index.js': {
                        type: 'esm',
                        contents:
                          'export default {fetch(){return new Response("local fixture only")}}',
                      },
                    },
                  },
                  env: { DB: { type: 'd1', id: 'warmup-approval-only' } },
                },
              },
            ],
          })
        : null;
    try {
      const db = client
        ? createTursoDatabase(client)
        : ((await mf!.getD1Database(
            'DB',
            'warmup-approval-only',
          )) as unknown as D1Database);
      const journal = JSON.parse(
        readFileSync('drizzle/meta/_journal.json', 'utf8'),
      ) as { entries: { tag: string }[] };
      for (const e of journal.entries)
        await db.batch(
          readFileSync(`drizzle/${e.tag}.sql`, 'utf8')
            .split('--> statement-breakpoint')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => db.prepare(s)),
        );
      const f = await fixture();
      for (const table of [
        'workspace_wallets',
        'wallet_warmup_plans',
        'wallet_warmup_session_reviews',
      ]) {
        for (const row of f
          .actual!.sqlite.prepare(`SELECT * FROM ${table} WHERE owner_id=?`)
          .all(f.owner)) {
          const keys = Object.keys(row);
          await db
            .prepare(
              `INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`,
            )
            .bind(...keys.map((k) => row[k]))
            .run();
        }
      }
      const proposed = await retainWarmupExecutionProposal(
        db,
        f.owner,
        {
          ...f.input,
          rootId: f.expected.id,
          consentId: f.expected.consentId,
          sessionExpiresAt: f.proposed.terms.intent.expiresAt,
          feeRentLimits: f.proposed.budget.feeRentLimits,
        },
        signal(),
      );
      if (!proposed || proposed.status !== 'published')
        throw Error('Missing real-adapter proposal');
      const request = {
        ...f.request,
        headerSha256: proposed.headerSha256,
        termsSha256: proposed.proposal.termsSha256,
      };
      const calls = f.providerCalls(),
        wallBefore = Date.now(),
        saved = await retain(db, f.owner, request, signal()),
        wallAfter = Date.now();
      expect(Date.parse(saved.approval.approvedAt)).toBeGreaterThanOrEqual(
        wallBefore,
      );
      expect(Date.parse(saved.rootCreatedAt!)).toBeLessThanOrEqual(wallAfter);
      const sqliteNow = await db
        .prepare(
          "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS a, strftime('%Y-%m-%dT%H:%M:%fZ','now') AS b",
        )
        .first<{ a: string; b: string }>();
      expect(sqliteNow!.a).toBe(sqliteNow!.b);
      expect(Date.parse(sqliteNow!.a)).toBeGreaterThanOrEqual(wallBefore);
      expect(saved.status).toBe('root-recorded');
      expect(await read(db, f.owner, request.proposalId, signal())).toEqual(
        saved,
      );
      expect(await retain(db, f.owner, request, signal())).toEqual(saved);
      expect(f.providerCalls()).toBe(calls);
      expect(
        (await db.prepare('PRAGMA foreign_key_check').all()).results,
      ).toHaveLength(0);
    } finally {
      client?.close();
      await mf?.dispose();
    }
  },
);

it('reuses the verified proposal and binding before root publication', async () => {
  const f = await fixture();
  f.statements.length = 0;
  expect((await f.save()).status).toBe('root-recorded');
  expect(
    f.statements.filter((s) => s.startsWith('SELECT chunk_index,length(data)')),
  ).toHaveLength(3);
});

it.each(['reader', 'writer'] as const)(
  'handles a deterministic real child append during a %s snapshot',
  async (kind) => {
    const f = await fixture();
    f.setHook((sql, op) => {
      if (
        op === 'run' &&
        sql.startsWith('INSERT INTO wallet_warmup_execution_roots')
      )
        throw Error('hold original root');
    });
    await expect(f.save()).rejects.toThrow();
    f.setHook();
    let reads = 0;
    f.setHook(async (sql, op) => {
      if (
        op === 'first' &&
        sql.includes(' FROM wallet_warmup_execution_roots WHERE')
      ) {
        reads++;
        if (reads === 2) {
          f.setHook();
          await f.save();
        }
      }
    });
    if (kind === 'reader')
      await expect(f.read()).rejects.toBeInstanceOf(
        WarmupExecutionApprovalReadRace,
      );
    else expect((await f.save()).status).toBe('root-recorded');
    expect(reads).toBe(2);
    expect((await f.read())!.status).toBe('root-recorded');
  },
);

it('refuses two deterministic inconsistent snapshots after only one saved reread and never writes', async () => {
  const f = await fixture();
  await f.save();
  let rootReads = 0,
    writes = 0;
  const db = {
    prepare(sql: string) {
      const statement = f.db.prepare(sql);
      const wrapped = {
        bind(...values: unknown[]) {
          statement.bind(...values);
          return wrapped;
        },
        all: () => statement.all(),
        run: () => {
          writes++;
          throw Error('no write allowed');
        },
        async first() {
          const row = await statement.first();
          if (
            sql.includes(' FROM wallet_warmup_execution_roots WHERE') &&
            ++rootReads % 2 === 1
          )
            return null;
          return row;
        },
      };
      return wrapped;
    },
  } as unknown as D1Database;
  const calls = f.providerCalls();
  await expect(retain(db, f.owner, f.request, signal())).rejects.toThrow();
  expect(rootReads).toBe(4);
  expect(writes).toBe(0);
  expect(f.providerCalls()).toBe(calls);
});
