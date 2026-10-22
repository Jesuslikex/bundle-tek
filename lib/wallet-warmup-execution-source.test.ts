import { afterEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { warmupExecutionSourceFixture } from '../test/warmup-execution-source-fixture';
import {
  familyWithdrawal,
  reserveFamily,
  advanceFamilyExclusionClock,
} from '../test/solana-family-exclusion-fixture';
import { readWalletWarmupSessionReview } from './wallet-warmup-session-storage';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import {
  readWarmupExecutionSource,
  WarmupExecutionSourceError,
} from './wallet-warmup-execution-source';

const fixtures: Awaited<ReturnType<typeof warmupExecutionSourceFixture>>[] = [];
async function fixture(
  history: 'none' | 'buy' | 'sold' = 'none',
  options: { acquiredRaw?: string } = {},
) {
  const f = await warmupExecutionSourceFixture(history, options);
  fixtures.push(f);
  return f;
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.sqlite.close();
});
const signal = () => new AbortController().signal;
const read = (f: Awaited<ReturnType<typeof fixture>>, db = f.db) =>
  readWarmupExecutionSource(db, f.owner, f.input, signal(), f.clock);

it.each(['none', 'buy', 'sold'] as const)(
  'replays the owned retained source and checks current %s history in the unchanged full schema',
  async (history) => {
    const f = await fixture(history);
    const result = await read(f);
    expect(result).toMatchObject({
      ownerId: f.owner,
      retainedReview: f.kept,
      scope: 'retained-source-currentness-only',
      signingAllowed: false,
      executionAllowed: false,
      automaticExecutionAllowed: false,
    });
    expect(result.sourceSha256).toBe(await digest(result.sourceDocument));
    expect(result.reviewDocumentSha256).toBe(
      await digest(result.reviewDocument),
    );
    expect(result.reviewDocumentSha256).not.toBe(f.kept.reviewSha256);
    f.advance(1);
    expect((await read(f)).sourceSnapshotSha256).toBe(
      result.sourceSnapshotSha256,
    );
    expect(
      (
        f.sqlite.prepare('PRAGMA integrity_check').get() as {
          integrity_check: string;
        }
      ).integrity_check,
    ).toBe('ok');
  },
);

it('keeps historical review reads valid but refuses new work after a manual captured buy or sell', async () => {
  const empty = await fixture();
  empty.buy();
  expect(
    await readWalletWarmupSessionReview(empty.db, empty.owner, empty.kept.id),
  ).toEqual(empty.kept);
  await expect(read(empty)).rejects.toBeInstanceOf(WarmupExecutionSourceError);
  const bought = await fixture('buy');
  bought.sell();
  expect(
    await readWalletWarmupSessionReview(
      bought.db,
      bought.owner,
      bought.kept.id,
    ),
  ).toEqual(bought.kept);
  await expect(read(bought)).rejects.toBeInstanceOf(WarmupExecutionSourceError);
});

it.each(['revision', 'archived', 'document', 'updated_at'])(
  'refuses changed plan %s without replacing historical review',
  async (field) => {
    const f = await fixture();
    const sql =
      field === 'revision'
        ? 'revision=revision+1'
        : field === 'archived'
          ? 'archived=1'
          : field === 'document'
            ? "document=json_set(document,'$.name','Changed')"
            : "updated_at='2026-10-22T00:00:00.000Z'";
    f.sqlite
      .prepare(
        `UPDATE wallet_warmup_plans SET ${sql} WHERE owner_id=? AND id=?`,
      )
      .run(f.owner, f.planId);
    await expect(read(f)).rejects.toBeInstanceOf(WarmupExecutionSourceError);
    expect(
      await readWalletWarmupSessionReview(f.db, f.owner, f.kept.id),
    ).toEqual(f.kept);
  },
);

it.each(['revision', 'archived', 'missing'])(
  'refuses a %s captured wallet',
  async (kind) => {
    const f = await fixture();
    const sql =
      kind === 'missing'
        ? 'DELETE FROM workspace_wallets WHERE owner_id=?'
        : `UPDATE workspace_wallets SET ${kind === 'revision' ? 'revision=revision+1' : 'archived=1'} WHERE owner_id=?`;
    f.sqlite.prepare(sql).run(f.owner);
    await expect(read(f)).rejects.toBeInstanceOf(WarmupExecutionSourceError);
  },
);

it.each([
  'plan_revision',
  'wallet_revision',
  'cycle',
  'wallet_address',
  'signature',
  'document',
  'remaining_raw',
  'id',
])('refuses a same-count changed buy %s', async (field) => {
  const f = await fixture('buy');
  const sql = ['plan_revision', 'wallet_revision', 'cycle'].includes(field)
    ? `${field}=${field}+1`
    : field === 'document'
      ? "document=json_set(document,'$.observedAt','changed')"
      : field === 'remaining_raw'
        ? "remaining_raw='100'"
        : `${field}='changed'`;
  f.sqlite
    .prepare(`UPDATE warmup_buy_receipts SET ${sql} WHERE owner_id=?`)
    .run(f.owner);
  await expect(read(f)).rejects.toBeInstanceOf(WarmupExecutionSourceError);
});

it.each(['buy_receipt_id', 'consumed_raw', 'signature', 'document', 'id'])(
  'refuses a same-count changed sell %s',
  async (field) => {
    const f = await fixture('sold');
    const sql =
      field === 'document'
        ? "document=json_set(document,'$.observedAt','changed')"
        : `${field}='changed'`;
    f.sqlite
      .prepare(`UPDATE warmup_sell_receipts SET ${sql} WHERE owner_id=?`)
      .run(f.owner);
    await expect(read(f)).rejects.toBeInstanceOf(WarmupExecutionSourceError);
  },
);

it('preserves the actual COALESCE remaining-lot projection instead of treating a legacy NULL as zero', async () => {
  const f = await fixture('buy');
  f.sqlite.prepare('UPDATE warmup_buy_receipts SET remaining_raw=NULL').run();
  expect((await read(f)).retainedReview.id).toBe(f.kept.id);
});

it.each(['cleanup', 'supply', 'organic', 'volume'] as const)(
  'refuses a selected wallet held by %s without altering its hold',
  async (family) => {
    const f = await fixture();
    reserveFamily(f.sqlite, family, f.packets.wallet, f.owner);
    await expect(read(f)).rejects.toBeInstanceOf(WarmupExecutionSourceError);
    expect(
      (
        f.sqlite
          .prepare(
            'SELECT count(*) AS n FROM solana_wallet_family_holds WHERE owner_id=?',
          )
          .get(f.owner) as { n: number }
      ).n,
    ).toBeGreaterThan(0);
  },
);

it('refuses unresolved native withdrawal work through the shared reservation', async () => {
  const f = await fixture();
  familyWithdrawal(f.sqlite, f.packets.wallet, f.owner);
  await expect(read(f)).rejects.toBeInstanceOf(WarmupExecutionSourceError);
});

it('does not confuse another owner or another retained-review selection with the authenticated scope', async () => {
  const f = await fixture();
  await expect(
    readWarmupExecutionSource(
      f.db,
      'different-owner',
      f.input,
      signal(),
      f.clock,
    ),
  ).rejects.toBeInstanceOf(WarmupExecutionSourceError);
  await expect(
    readWarmupExecutionSource(
      f.db,
      f.owner,
      { ...f.input, reviewSha256: 'f'.repeat(64) },
      signal(),
      f.clock,
    ),
  ).rejects.toBeInstanceOf(WarmupExecutionSourceError);
  reserveFamily(f.sqlite, 'cleanup', f.packets.wallet, 'different-owner');
  expect((await read(f)).ownerId).toBe(f.owner);
});

it.each([-2, 59999])(
  'refuses a source outside its original review window (%i)',
  async (delta) => {
    const f = await fixture();
    f.advance(delta);
    await expect(read(f)).rejects.toBeInstanceOf(WarmupExecutionSourceError);
  },
);

function intercept(
  db: D1Database,
  hook: (sql: string, row: unknown) => unknown,
) {
  return new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
            new Proxy(statement, {
              get(target, key) {
                if (key === 'bind')
                  return (...args: unknown[]) => wrap(target.bind(...args));
                if (key === 'first')
                  return async (
                    ...args: Parameters<D1PreparedStatement['first']>
                  ) => hook(sql, await target.first(...args));
                if (key === 'run')
                  return () => {
                    throw Error('Source reader must never write');
                  };
                const value = Reflect.get(target, key);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            });
          return wrap(target.prepare(sql));
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
const rawRead = (sql: string) => sql.startsWith('SELECT owner_id,id,plan_id');

it('does not claim the review exists before its recorded creation time', async () => {
  const f = await fixture();
  f.advance(-1);
  await expect(read(f)).rejects.toBeInstanceOf(WarmupExecutionSourceError);
});

it('refuses database-clock expiry even if the server clock still reports an earlier time', async () => {
  const f = await fixture();
  advanceFamilyExclusionClock(f.sqlite, 60000);
  await expect(read(f)).rejects.toBeInstanceOf(WarmupExecutionSourceError);
  expect(await readWalletWarmupSessionReview(f.db, f.owner, f.kept.id)).toEqual(
    f.kept,
  );
});

it('captures request identity before awaiting the first read', async () => {
  const f = await fixture();
  const id = f.kept.id;
  const db = intercept(f.db, (sql, row) => {
    if (rawRead(sql)) f.input.reviewId = crypto.randomUUID();
    return row;
  });
  expect((await read(f, db)).retainedReview.id).toBe(id);
});

it('refuses a source changed during retained replay before the currentness query', async () => {
  const f = await fixture();
  let changed = false;
  const db = intercept(f.db, (sql, row) => {
    if (
      sql.startsWith('SELECT * FROM wallet_warmup_session_reviews') &&
      !changed
    ) {
      changed = true;
      f.sqlite
        .prepare(
          'UPDATE workspace_wallets SET revision=revision+1 WHERE owner_id=?',
        )
        .run(f.owner);
    }
    return row;
  });
  await expect(read(f, db)).rejects.toBeInstanceOf(WarmupExecutionSourceError);
});

it('ties the raw review bytes to the separately replayed retained review', async () => {
  const f = await fixture();
  const db = intercept(f.db, (sql, row) => {
    if (!rawRead(sql)) return row;
    const value = { ...(row as Record<string, unknown>) };
    const doc = JSON.parse(value.document as string);
    doc.totalMaximumNativeSpendLamports = 'private-corruption';
    return { ...value, document: canonical(doc) };
  });
  await expect(read(f, db)).rejects.toMatchObject({
    message:
      'Execution source is unavailable or changed. Request a fresh review.',
  });
});

it('does not substitute self-consistent but non-stored raw source bytes with a newly computed hash', async () => {
  const f = await fixture();
  const db = intercept(f.db, async (sql, row) => {
    if (!rawRead(sql)) return row;
    const value = { ...(row as Record<string, unknown>) };
    const src = JSON.parse(value.source as string);
    src.extra = 'not-original-source';
    const source = canonical(src),
      sha = await digest(source);
    const doc = JSON.parse(value.document as string);
    doc.sourceSha256 = sha;
    return { ...value, source, source_sha256: sha, document: canonical(doc) };
  });
  await expect(read(f, db)).rejects.toBeInstanceOf(WarmupExecutionSourceError);
});

it('refuses a changed final raw read rather than publishing a mixed snapshot', async () => {
  const f = await fixture();
  let raw = 0;
  const db = intercept(f.db, (sql, row) =>
    rawRead(sql) && ++raw === 2
      ? { ...(row as object), created_at: new Date(f.at + 2).toISOString() }
      : row,
  );
  await expect(read(f, db)).rejects.toBeInstanceOf(WarmupExecutionSourceError);
});

it('cancels before starting another SQL operation after a non-cooperative read completes', async () => {
  const f = await fixture();
  const abort = new AbortController();
  let calls = 0;
  const db = intercept(f.db, (_sql, row) => {
    calls++;
    abort.abort();
    return row;
  });
  await expect(
    readWarmupExecutionSource(db, f.owner, f.input, abort.signal, f.clock),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(calls).toBe(1);
});

it('refuses expiry during the currentness query', async () => {
  const f = await fixture();
  const db = intercept(f.db, (sql, row) => {
    if (sql.includes('AS current')) f.advance(60000);
    return row;
  });
  await expect(read(f, db)).rejects.toBeInstanceOf(WarmupExecutionSourceError);
});

it('bounds raw snapshot UTF8 bytes before replaying or hashing them', async () => {
  const f = await fixture();
  let calls = 0;
  const db = intercept(f.db, (sql, row) => {
    calls++;
    return rawRead(sql)
      ? { ...(row as object), source: 'é'.repeat(600000) }
      : row;
  });
  await expect(read(f, db)).rejects.toBeInstanceOf(WarmupExecutionSourceError);
  expect(calls).toBe(1);
});

it('performs no writes, reserves nothing and never changes the historical review', async () => {
  const f = await fixture('sold');
  const changes = () =>
    (f.sqlite.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  const before = changes();
  const db = intercept(f.db, (sql, row) => {
    expect(sql.trimStart().startsWith('SELECT')).toBe(true);
    return row;
  });
  await read(f, db);
  expect(changes()).toBe(before);
  expect(await readWalletWarmupSessionReview(f.db, f.owner, f.kept.id)).toEqual(
    f.kept,
  );
});

const maximumRaw = '18446744073709551615';
it('preserves maximum uint64 lot units as text through the full native schema and source replay', async () => {
  const f = await fixture('buy', { acquiredRaw: maximumRaw });
  expect(
    (
      f.sqlite
        .prepare(
          'SELECT typeof(remaining_raw) AS kind FROM warmup_buy_receipts',
        )
        .get() as { kind: string }
    ).kind,
  ).toBe('text');
  const result = await read(f);
  expect(JSON.parse(result.sourceDocument).buys[0].remainingRaw).toBe(
    maximumRaw,
  );
  const sell = result.retainedReview.document.actions.find(
    (a) => a.side === 'Sell',
  );
  expect(
    sell?.side === 'Sell' &&
      sell.source.kind === 'saved-buy' &&
      sell.source.remainingRaw,
  ).toBe(maximumRaw);
});

it.each(['sold', 'maximum-buy'] as const)(
  'runs the exact %s source predicate on disposable D1 with all unchanged migrations',
  async (history) => {
    const mf = new Miniflare({
      telemetry: { enabled: false },
      workers: [
        {
          config: {
            name: 'execution-source-full-schema',
            type: 'worker',
            compatibilityDate: '2026-09-01',
            manifest: {
              mainModule: 'index.js',
              modules: {
                'index.js': {
                  type: 'esm',
                  contents:
                    'export default {fetch(){return new Response("fixture only")}}',
                },
              },
            },
            env: { DB: { type: 'd1', id: 'execution-source-full-schema' } },
          },
        },
      ],
    });
    try {
      const db = (await mf.getD1Database(
        'DB',
        'execution-source-full-schema',
      )) as unknown as D1Database;
      const journal = JSON.parse(
        readFileSync('drizzle/meta/_journal.json', 'utf8'),
      ) as { entries: { tag: string }[] };
      for (const entry of journal.entries) {
        const statements = readFileSync(`drizzle/${entry.tag}.sql`, 'utf8')
          .split('--> statement-breakpoint')
          .map((s) => s.trim())
          .filter(Boolean);
        await db.batch(statements.map((s) => db.prepare(s)));
      }
      const f = await fixture(
        history === 'sold' ? 'sold' : 'buy',
        history === 'sold' ? {} : { acquiredRaw: maximumRaw },
      );
      for (const table of [
        'workspace_wallets',
        'wallet_warmup_plans',
        'warmup_buy_receipts',
        'warmup_sell_receipts',
        'wallet_warmup_session_reviews',
      ]) {
        const rows = f.sqlite.prepare(`SELECT * FROM ${table}`).all();
        for (const row of rows) {
          const keys = Object.keys(row);
          await db
            .prepare(
              `INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`,
            )
            .bind(...keys.map((k) => row[k]))
            .run();
        }
      }
      const result = await read(f, db);
      expect(result.sourceSnapshotSha256).toBe(
        (await read(f)).sourceSnapshotSha256,
      );
      if (history === 'maximum-buy')
        expect(JSON.parse(result.sourceDocument).buys[0].remainingRaw).toBe(
          maximumRaw,
        );
      await db
        .prepare(
          history === 'sold'
            ? 'UPDATE warmup_sell_receipts SET consumed_raw=? WHERE owner_id=?'
            : 'UPDATE warmup_buy_receipts SET remaining_raw=? WHERE owner_id=?',
        )
        .bind('100', f.owner)
        .run();
      await expect(read(f, db)).rejects.toBeInstanceOf(
        WarmupExecutionSourceError,
      );
      expect(
        await readWalletWarmupSessionReview(db, f.owner, f.kept.id),
      ).toEqual(f.kept);
    } finally {
      await mf.dispose();
    }
  },
);

it('does not start any SQL for an already aborted read', async () => {
  const f = await fixture();
  const abort = new AbortController();
  abort.abort();
  const db = {
    prepare() {
      throw Error('SQL must not start');
    },
  } as unknown as D1Database;
  await expect(
    readWarmupExecutionSource(db, f.owner, f.input, abort.signal, f.clock),
  ).rejects.toMatchObject({ name: 'AbortError' });
});
