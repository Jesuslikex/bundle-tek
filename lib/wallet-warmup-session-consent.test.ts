import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { createTursoDatabase } from '@/db/turso';
import { warmupSessionReviewFixture } from '@/test/warmup-session-review-fixture';
import { loadWalletWarmupProgress } from './wallet-warmup-progress-server';
import { reviewWalletWarmupSession } from './wallet-warmup-session-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import { retainWalletWarmupSessionReview } from './wallet-warmup-session-storage';
import {
  reviewWalletWarmupSessionConsent as review,
  retainWalletWarmupSessionConsent as retain,
  readWalletWarmupSessionConsent as read,
  WARMUP_SESSION_DEADLINE_GRACE_MS,
} from './wallet-warmup-session-consent';
let client: Client,
  db: D1Database,
  f: ReturnType<typeof warmupSessionReviewFixture>,
  input: {
    id: string;
    reviewId: string;
    reviewSha256: string;
    sessionExpiresAt: string;
    termsSha256: string;
  };
const signal = () => new AbortController().signal;
const total = async () =>
  (await db
    .prepare('SELECT count(*) AS n FROM wallet_warmup_session_consents')
    .first<{ n: number }>())!.n;
beforeEach(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No provider calls allowed');
    }),
  );
  client = createClient({ url: 'file::memory:', intMode: 'number' });
  db = createTursoDatabase(client);
  for (const sql of [
    'CREATE TABLE wallet_warmup_plans(owner_id TEXT,id TEXT,revision INTEGER,archived INTEGER,updated_at TEXT,document TEXT,PRIMARY KEY(owner_id,id))',
    'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER)',
    'CREATE TABLE warmup_buy_receipts(owner_id TEXT,plan_id TEXT,id TEXT,plan_revision INTEGER,wallet_revision INTEGER,cycle INTEGER,wallet_address TEXT,signature TEXT,remaining_raw TEXT,document TEXT)',
    'CREATE TABLE warmup_sell_receipts(owner_id TEXT,plan_id TEXT,id TEXT,buy_receipt_id TEXT,consumed_raw TEXT,signature TEXT,document TEXT)',
    'CREATE TABLE solana_swap_reservations(owner_id TEXT,intent_id TEXT,wallet_address TEXT,state TEXT)',
    'CREATE TABLE solana_execution_reservations(owner_id TEXT,wallet_address TEXT,state TEXT)',
  ])
    await db.prepare(sql).run();
  for (const name of [
    '0117_wallet_warmup_session_reviews',
    '0122_wallet_warmup_session_consents',
    '0123_wallet_warmup_session_consent_bounds',
  ])
    for (const sql of readFileSync(`drizzle/${name}.sql`, 'utf8')
      .split('--> statement-breakpoint')
      .map((x) => x.trim())
      .filter(Boolean))
      await db.prepare(sql).run();
  f = warmupSessionReviewFixture();
  await db
    .prepare('INSERT INTO wallet_warmup_plans VALUES(?,?,?,?,?,?)')
    .bind(
      'owner',
      f.plan.id,
      1,
      0,
      f.plan.updatedAt,
      JSON.stringify(f.plan.document),
    )
    .run();
  await db
    .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,?)')
    .bind('owner', 'Solana', f.plan.document.addresses[0], 1, 0)
    .run();
  const current = await loadWalletWarmupProgress(
      db,
      'owner',
      f.plan.id,
      1,
      false,
      true,
    ),
    at = Date.now(),
    body = reviewWalletWarmupSession(
      current.plan,
      current.progress,
      current.performance,
      at,
    );
  const kept = await retainWalletWarmupSessionReview(
    db,
    'owner',
    {
      id: crypto.randomUUID(),
      planId: f.plan.id,
      revision: 1,
      reviewedAt: body.reviewedAt,
      reviewSha256: await digest(body.contextKey),
    },
    true,
    signal(),
  );
  const selected = {
    reviewId: kept.id,
    reviewSha256: kept.reviewSha256,
    sessionExpiresAt: new Date(at + 120000).toISOString(),
  };
  const prepared = await review(db, 'owner', selected, signal());
  input = {
    ...selected,
    id: crypto.randomUUID(),
    termsSha256: prepared.termsSha256,
  };
});
afterEach(() => {
  client?.close();
  vi.unstubAllGlobals();
});
function selected() {
  const { id: _id, termsSha256: _hash, ...selection } = input;
  return selection;
}
function hook(callback: () => Promise<void>, lost = false): D1Database {
  return new Proxy(db, {
    get(target, key) {
      if (key !== 'prepare') {
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.startsWith('INSERT INTO wallet_warmup_session_consents'))
          return statement;
        const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
          new Proxy(s, {
            get(item, method) {
              if (method === 'bind')
                return (...values: unknown[]) => wrap(item.bind(...values));
              if (method === 'run')
                return async () => {
                  await callback();
                  const result = await item.run();
                  if (lost) throw Error('lost reply');
                  return result;
                };
              const value = Reflect.get(item, method);
              return typeof value === 'function' ? value.bind(item) : value;
            },
          });
        return wrap(statement);
      };
    },
  });
}
it('retains exact separate plan consent, original actions/budgets and an explicitly selected deadline without authority', async () => {
  const result = await retain(db, 'owner', input, true, signal());
  expect(result.terms).toMatchObject({
    ...selected(),
    executionAllowed: false,
    signingAllowed: false,
    automaticExecutionAllowed: false,
  });
  const original = JSON.parse(result.terms.reviewDocument);
  expect(original.actions).toHaveLength(4);
  expect(original.wallets[0].buySpendLamports).toBe('2000000');
  expect(original.wallets[0].remainingFeeReserveLamports).toBe('10000000');
  expect(await read(db, 'owner', input.id, signal())).toEqual(result);
  expect(fetch).not.toHaveBeenCalled();
  expect(await total()).toBe(1);
});
it('does not infer consent from a saved review or an unchecked approval', async () => {
  expect(await total()).toBe(0);
  await expect(retain(db, 'owner', input, false, signal())).rejects.toThrow(
    'separately',
  );
  expect(await total()).toBe(0);
});
it('binds approval to the exact terms hash including the chosen session deadline', async () => {
  await expect(
    retain(
      db,
      'owner',
      {
        ...input,
        sessionExpiresAt: new Date(Date.now() + 180000).toISOString(),
      },
      true,
      signal(),
    ),
  ).rejects.toThrow('terms changed');
  await expect(
    retain(
      db,
      'owner',
      { ...input, termsSha256: 'a'.repeat(64) },
      true,
      signal(),
    ),
  ).rejects.toThrow('terms changed');
  expect(await total()).toBe(0);
});
it('rejects extra owner/authority fields and cross-owner reviews', async () => {
  await expect(
    retain(db, 'owner', { ...input, owner: 'other' }, true, signal()),
  ).rejects.toThrow();
  await expect(
    review(db, 'owner', { ...selected(), signingAllowed: true }, signal()),
  ).rejects.toThrow();
  await expect(retain(db, 'other', input, true, signal())).rejects.toThrow(
    'exact retained',
  );
  expect(await read(db, 'other', input.id, signal())).toBeNull();
});
it('requires a deadline strictly after every reviewed action, without rebasing the schedule', async () => {
  await expect(
    review(
      db,
      'owner',
      { ...selected(), sessionExpiresAt: f.plan.document.startAt },
      signal(),
    ),
  ).rejects.toThrow('deadline');
});
it('refuses new consent after source preview expiry', async () => {
  await expect(
    retain(db, 'owner', input, true, signal(), () => Date.now() + 120000),
  ).rejects.toThrow('expired');
  expect(await total()).toBe(0);
});
it('recovers the identical consent after expiry and archival without creating a new approval', async () => {
  const saved = await retain(db, 'owner', input, true, signal());
  await db
    .prepare('UPDATE wallet_warmup_plans SET archived=1,revision=2')
    .run();
  expect(await read(db, 'owner', input.id, signal())).toEqual(saved);
  expect(
    await retain(db, 'owner', input, true, signal(), () => Date.now() + 999999),
  ).toEqual(saved);
  expect(await total()).toBe(1);
});
it('does not replace an identity or grant a second consent for the same retained review', async () => {
  await retain(db, 'owner', input, true, signal());
  await expect(
    retain(
      db,
      'owner',
      { ...input, termsSha256: 'b'.repeat(64) },
      true,
      signal(),
    ),
  ).rejects.toThrow('different terms');
  await expect(
    retain(db, 'owner', { ...input, id: crypto.randomUUID() }, true, signal()),
  ).rejects.toThrow('Recover the same');
  expect(await total()).toBe(1);
});
it('recovers one committed insert after a lost response without another write', async () => {
  let writes = 0;
  const saved = await retain(
    hook(async () => {
      writes++;
    }, true),
    'owner',
    input,
    true,
    signal(),
  );
  expect(saved.id).toBe(input.id);
  expect(writes).toBe(1);
  expect(await total()).toBe(1);
});
it.each([
  'plan',
  'wallet',
  'swap-reservation',
  'execution-reservation',
  'receipt-added',
] as const)('atomically refuses a stale consent baseline: %s', async (kind) => {
  const raced = hook(async () => {
    if (kind === 'plan')
      await db.prepare('UPDATE wallet_warmup_plans SET revision=2').run();
    if (kind === 'wallet')
      await db.prepare('UPDATE workspace_wallets SET revision=2').run();
    if (kind === 'swap-reservation')
      await db
        .prepare('INSERT INTO solana_swap_reservations VALUES(?,?,?,?)')
        .bind(
          'owner',
          'other-intent',
          f.plan.document.addresses[0],
          'submitted',
        )
        .run();
    if (kind === 'execution-reservation')
      await db
        .prepare('INSERT INTO solana_execution_reservations VALUES(?,?,?)')
        .bind('owner', f.plan.document.addresses[0], 'submitted')
        .run();
    if (kind === 'receipt-added')
      await db
        .prepare(
          "INSERT INTO warmup_buy_receipts(owner_id,plan_id,id,document) VALUES(?,?,?,'{}')",
        )
        .bind('owner', f.plan.id, 'added')
        .run();
  });
  await expect(retain(raced, 'owner', input, true, signal())).rejects.toThrow(
    'Recover the same',
  );
  expect(await total()).toBe(0);
});
it.each(['executionAllowed', 'signingAllowed', 'automaticExecutionAllowed'])(
  'rejects direct SQL activation: %s',
  async (flag) => {
    const prepared = await review(db, 'owner', selected(), signal());
    await expect(
      db
        .prepare(
          'INSERT INTO wallet_warmup_session_consents VALUES(?,?,?,?,?,?)',
        )
        .bind(
          'owner',
          input.id,
          input.reviewId,
          input.termsSha256,
          JSON.stringify({ ...prepared.terms, [flag]: true }),
          new Date().toISOString(),
        )
        .run(),
    ).rejects.toThrow('consent');
    expect(await total()).toBe(0);
  },
);
it('blocks UPDATE, DELETE and replacement of retained consent', async () => {
  await retain(db, 'owner', input, true, signal());
  await expect(
    db
      .prepare('UPDATE wallet_warmup_session_consents SET terms_sha256=?')
      .bind('a'.repeat(64))
      .run(),
  ).rejects.toThrow('immutable');
  await expect(
    db.prepare('DELETE FROM wallet_warmup_session_consents').run(),
  ).rejects.toThrow('immutable');
  await expect(
    db
      .prepare(
        'INSERT OR REPLACE INTO wallet_warmup_session_consents SELECT * FROM wallet_warmup_session_consents',
      )
      .run(),
  ).rejects.toThrow();
  expect(await total()).toBe(1);
});
it('refuses a cancelled operation before retaining consent', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    retain(db, 'owner', input, true, controller.signal),
  ).rejects.toThrow();
  expect(await total()).toBe(0);
});
it('refuses new writes if immutable database guards are unavailable', async () => {
  await db
    .prepare('DROP TRIGGER wallet_warmup_session_consents_no_update')
    .run();
  await expect(retain(db, 'owner', input, true, signal())).rejects.toThrow(
    'not installed',
  );
  expect(await total()).toBe(0);
});
it('returns the same consent under competing requests for the same identity', async () => {
  const saved = await Promise.all([
    retain(db, 'owner', input, true, signal()),
    retain(db, 'owner', input, true, signal()),
  ]);
  expect(saved[0]).toEqual(saved[1]);
  expect(await total()).toBe(1);
});
it('admits only one consent when two distinct identities race for the same review', async () => {
  const outcomes = await Promise.allSettled([
    retain(db, 'owner', input, true, signal()),
    retain(db, 'owner', { ...input, id: crypto.randomUUID() }, true, signal()),
  ]);
  expect(outcomes.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  expect(await total()).toBe(1);
});
it('rechecks source expiry immediately before insertion', async () => {
  let reads = 0;
  await expect(
    retain(
      db,
      'owner',
      input,
      true,
      signal(),
      () => Date.now() + (reads++ ? 120000 : 0),
    ),
  ).rejects.toThrow('expired');
  expect(await total()).toBe(0);
});
it('detects a corrupted consent digest even after an out-of-band update guard bypass', async () => {
  await retain(db, 'owner', input, true, signal());
  const trigger = await db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE name='wallet_warmup_session_consents_no_update'",
    )
    .first<{ sql: string }>();
  await db
    .prepare('DROP TRIGGER wallet_warmup_session_consents_no_update')
    .run();
  await db
    .prepare('UPDATE wallet_warmup_session_consents SET terms_sha256=?')
    .bind('a'.repeat(64))
    .run();
  await db.prepare(trigger!.sql).run();
  await expect(read(db, 'owner', input.id, signal())).rejects.toThrow(
    'unavailable or differs',
  );
});
it('accepts the exact maximum recorded deadline and refuses one millisecond beyond it', async () => {
  const original = await review(db, 'owner', selected(), signal());
  const doc = JSON.parse(original.terms.reviewDocument) as {
    actions: { scheduledAt: string }[];
  };
  const maximum =
    Math.max(...doc.actions.map((a) => Date.parse(a.scheduledAt))) +
    WARMUP_SESSION_DEADLINE_GRACE_MS;
  const exact = {
    ...selected(),
    sessionExpiresAt: new Date(maximum).toISOString(),
  };
  const prepared = await review(db, 'owner', exact, signal());
  const saved = await retain(
    db,
    'owner',
    { ...exact, id: input.id, termsSha256: prepared.termsSha256 },
    true,
    signal(),
  );
  expect(saved.terms.sessionExpiresAt).toBe(exact.sessionExpiresAt);
  await expect(
    review(
      db,
      'owner',
      { ...exact, sessionExpiresAt: new Date(maximum + 1).toISOString() },
      signal(),
    ),
  ).rejects.toThrow('five minutes');
});
it.each([
  'one-ms-over',
  'year-9999',
  'created-format',
  'deadline-format',
] as const)('rejects direct SQL deadline bypass: %s', async (kind) => {
  const prepared = await review(db, 'owner', selected(), signal());
  const doc = JSON.parse(prepared.terms.reviewDocument) as {
    actions: { scheduledAt: string }[];
  };
  const maximum =
    Math.max(...doc.actions.map((a) => Date.parse(a.scheduledAt))) +
    WARMUP_SESSION_DEADLINE_GRACE_MS;
  const terms = { ...prepared.terms };
  let createdAt = new Date(Date.now() + 1000).toISOString();
  if (kind === 'one-ms-over')
    terms.sessionExpiresAt = new Date(maximum + 1).toISOString();
  if (kind === 'year-9999') terms.sessionExpiresAt = '9999-12-31T23:59:59.999Z';
  if (kind === 'created-format')
    createdAt = createdAt.replace(/\.\d{3}Z$/, 'Z');
  if (kind === 'deadline-format')
    terms.sessionExpiresAt = new Date(
      Math.floor(Date.parse(terms.sessionExpiresAt) / 1000) * 1000,
    )
      .toISOString()
      .replace('.000Z', 'Z');
  await expect(
    db
      .prepare('INSERT INTO wallet_warmup_session_consents VALUES(?,?,?,?,?,?)')
      .bind(
        'owner',
        input.id,
        input.reviewId,
        input.termsSha256,
        JSON.stringify(terms),
        createdAt,
      )
      .run(),
  ).rejects.toThrow('deadline');
  expect(await total()).toBe(0);
});
it('requires the new deadline database guard before saving consent', async () => {
  await db.prepare('DROP TRIGGER wallet_warmup_session_consents_bounds').run();
  await expect(retain(db, 'owner', input, true, signal())).rejects.toThrow(
    'not installed',
  );
});
