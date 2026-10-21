import { afterEach, expect, it, vi } from 'vitest';
import { warmupSessionSettlementStorageFixture } from '@/test/warmup-session-settlement-storage-fixture';
import {
  retainWalletWarmupSessionActionBinding as retain,
  readWalletWarmupSessionActionBinding as read,
} from './wallet-warmup-session-action-binding';
import { retainWalletWarmupSessionSettlement as capture } from './wallet-warmup-session-settlement-storage';
vi.mock('@/lib/wallet-rpc-pacing', () => ({ paceWalletRpc: async () => {} }));
const signal = () => new AbortController().signal;
const clients: { close(): void }[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  vi.restoreAllMocks();
});
async function fixture() {
  const f = await warmupSessionSettlementStorageFixture('0.01', {
    reviewOnly: true,
  });
  clients.push(f.client);
  return f;
}
function input(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    journalId: f.journal.id,
    version: f.journal.version,
    headSha256: f.journal.headSha256,
    preparationId: f.packets.buy.preparation.id,
  };
}
async function count(db: D1Database) {
  return (
    await db
      .prepare(
        'SELECT count(*) AS n FROM wallet_warmup_session_action_bindings',
      )
      .first<{ n: number }>()
  )?.n;
}
function intercept(
  db: D1Database,
  onRun: (run: () => Promise<unknown>) => Promise<unknown>,
) {
  return {
    batch: db.batch.bind(db),
    prepare(sql: string) {
      const original = db.prepare(sql);
      if (!sql.startsWith('INSERT INTO wallet_warmup_session_action_bindings'))
        return original;
      return {
        bind(...args: unknown[]) {
          const bound = original.bind(...args);
          return { run: () => onRun(() => bound.run()) };
        },
      };
    },
  } as D1Database;
}
it('binds exactly one unsigned preparation during review and recovers it without another write after submission', async () => {
  const f = await fixture(),
    request = input(f);
  const saved = await retain(f.db, 'owner', request, signal(), f.clock);
  expect(saved).toMatchObject({
    owner_id: 'owner',
    journal_id: f.journal.id,
    preparation_id: f.packets.buy.preparation.id,
    packet_sha256: f.packets.buy.preparation.document.transaction.sha256,
  });
  await f.bindAction(f.packets.buy);
  await f.append('submitted', f.journal.snapshot.pending!.action.id);
  await f.installBuy();
  expect(await retain(f.db, 'owner', request, signal(), f.clock)).toEqual(
    saved,
  );
  expect(await count(f.db)).toBe(1);
  expect(
    await read(f.db, 'other', request.journalId, saved.action_id, signal()),
  ).toBeNull();
  const proof = await capture(
    f.db,
    'owner',
    f.request(),
    signal(),
    f.fetcher,
    f.clock,
  );
  expect(proof.record.mode).toBe('applied');
  expect(f.methods).toHaveLength(2);
});
it('rejects a pre-existing preparation even if its wallet, cycle and amount match', async () => {
  const f = await fixture();
  await f.db
    .prepare('UPDATE warmup_swap_preparations SET created_at=? WHERE id=?')
    .bind(new Date(f.clock() - 1).toISOString(), f.packets.buy.preparation.id)
    .run();
  await expect(
    retain(f.db, 'owner', input(f), signal(), f.clock),
  ).rejects.toThrow('binding');
  expect(await count(f.db)).toBe(0);
  expect(f.methods).toEqual([]);
});
it.each([
  'awaiting_signature',
  'signed',
  'submitted',
  'finalized',
  'failed',
  'cancelled',
])('never attaches an existing %s intent to a session', async (state) => {
  const f = await fixture(),
    p = f.packets.buy;
  await f.db
    .prepare(
      'INSERT INTO warmup_signing_intents(id,owner_id,preparation_id,wallet_address,document,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
    )
    .bind(
      p.approval.id,
      'owner',
      p.preparation.id,
      f.packets.wallet,
      JSON.stringify(p.approval),
      state,
      new Date(f.clock()).toISOString(),
      new Date(f.clock()).toISOString(),
    )
    .run();
  await expect(
    retain(f.db, 'owner', input(f), signal(), f.clock),
  ).rejects.toThrow('binding');
  expect(await count(f.db)).toBe(0);
});
it('cannot bind a receipt that already exists without an intent', async () => {
  const f = await fixture();
  await f.installBuy();
  await expect(
    retain(f.db, 'owner', input(f), signal(), f.clock),
  ).rejects.toThrow('binding');
  expect(await count(f.db)).toBe(0);
});
it('rejects extra caller facts and a substituted preparation', async () => {
  const f = await fixture();
  for (const extra of [
    { owner: 'owner' },
    { signature: f.packets.buy.signature },
    { packetSha256: '0'.repeat(64) },
  ])
    await expect(
      retain(f.db, 'owner', { ...input(f), ...extra }, signal(), f.clock),
    ).rejects.toThrow();
  await expect(
    retain(
      f.db,
      'owner',
      { ...input(f), preparationId: f.packets.sell.preparation.id },
      signal(),
      f.clock,
    ),
  ).rejects.toThrow();
  expect(await count(f.db)).toBe(0);
});
it.each([
  'amount',
  'wallet',
  'mint',
  'revision',
  'future-time',
  'plan-archived',
  'wallet-archived',
])('rejects unsigned preparation drift: %s', async (kind) => {
  const f = await fixture(),
    p = structuredClone(f.packets.buy.preparation);
  if (kind === 'amount') p.document.inAmountRaw = '999999';
  if (kind === 'wallet') p.document.wallet = '11111111111111111111111111111111';
  if (kind === 'mint')
    p.document.outputMint = '11111111111111111111111111111111';
  await f.db
    .prepare(
      'UPDATE warmup_swap_preparations SET document=?,wallet_revision=?,created_at=? WHERE id=?',
    )
    .bind(
      JSON.stringify(p.document),
      kind === 'revision' ? 2 : 1,
      new Date(f.clock() + (kind === 'future-time' ? 1 : 0)).toISOString(),
      p.id,
    )
    .run();
  if (kind === 'plan-archived')
    await f.db.prepare('UPDATE wallet_warmup_plans SET archived=1').run();
  if (kind === 'wallet-archived')
    await f.db.prepare('UPDATE workspace_wallets SET archived=1').run();
  await expect(
    retain(f.db, 'owner', input(f), signal(), f.clock),
  ).rejects.toThrow();
  expect(await count(f.db)).toBe(0);
});
it('refuses a changed head at the INSERT boundary and leaves no identity reservation', async () => {
  const f = await fixture();
  let writes = 0;
  const db = intercept(f.db, async (run) => {
    writes++;
    await f.append('stop');
    return run();
  });
  await expect(
    retain(db, 'owner', input(f), signal(), f.clock),
  ).rejects.toThrow('binding');
  expect(writes).toBe(1);
  expect(await count(f.db)).toBe(0);
});
it('recovers an unknown committed response with one INSERT and no repeat signing or RPC', async () => {
  const f = await fixture();
  let writes = 0;
  const db = intercept(f.db, async (run) => {
    writes++;
    await run();
    throw Error('response lost');
  });
  const saved = await retain(db, 'owner', input(f), signal(), f.clock);
  expect(saved.preparation_id).toBe(f.packets.buy.preparation.id);
  expect(writes).toBe(1);
  expect(f.methods).toEqual([]);
});
it('preserves the exact binding after cancellation of a response that already committed', async () => {
  const f = await fixture(),
    controller = new AbortController();
  const db = intercept(f.db, async (run) => {
    await run();
    controller.abort();
    return {};
  });
  await expect(
    retain(db, 'owner', input(f), controller.signal, f.clock),
  ).rejects.toThrow();
  expect(
    await read(
      f.db,
      'owner',
      f.journal.id,
      f.journal.snapshot.pending!.action.id,
      signal(),
    ),
  ).not.toBeNull();
  expect(await count(f.db)).toBe(1);
});
it('rejects updates, deletion and replacement of a bound action', async () => {
  const f = await fixture();
  await retain(f.db, 'owner', input(f), signal(), f.clock);
  for (const sql of [
    "UPDATE wallet_warmup_session_action_bindings SET packet_sha256='0'",
    'DELETE FROM wallet_warmup_session_action_bindings',
    'INSERT OR REPLACE INTO wallet_warmup_session_action_bindings SELECT * FROM wallet_warmup_session_action_bindings',
  ])
    await expect(f.db.prepare(sql).run()).rejects.toThrow();
  expect(await count(f.db)).toBe(1);
});
it('rejects a receipt before any RPC when the action has no pre-intent binding', async () => {
  const f = await warmupSessionSettlementStorageFixture('0.01', {
    bindBuy: false,
  });
  clients.push(f.client);
  await expect(
    capture(f.db, 'owner', f.request(), signal(), f.fetcher, f.clock),
  ).rejects.toThrow('exact preparation');
  expect(f.methods).toEqual([]);
});
it('does not allow changing the preparation during original binding recovery', async () => {
  const f = await fixture();
  await retain(f.db, 'owner', input(f), signal(), f.clock);
  await expect(
    retain(
      f.db,
      'owner',
      { ...input(f), preparationId: f.packets.sell.preparation.id },
      signal(),
      f.clock,
    ),
  ).rejects.toThrow();
  expect(await count(f.db)).toBe(1);
});

it('rejects a different preparation with the identical wallet, cycle, amount and packet', async () => {
  const f = await warmupSessionSettlementStorageFixture();
  clients.push(f.client);
  const replacement = crypto.randomUUID();
  await f.db
    .prepare(
      'INSERT INTO warmup_swap_preparations SELECT ?,owner_id,plan_id,plan_revision,cycle,wallet_address,wallet_revision,document,created_at FROM warmup_swap_preparations WHERE id=?',
    )
    .bind(replacement, f.packets.buy.preparation.id)
    .run();
  await f.db
    .prepare('UPDATE warmup_signing_intents SET preparation_id=? WHERE id=?')
    .bind(replacement, f.packets.buy.approval.id)
    .run();
  await f.db
    .prepare('UPDATE warmup_buy_receipts SET preparation_id=? WHERE id=?')
    .bind(replacement, f.packets.buy.receiptId)
    .run();
  await expect(
    capture(f.db, 'owner', f.request(), signal(), f.fetcher, f.clock),
  ).rejects.toThrow('exact preparation');
  expect(f.methods).toEqual([]);
});

it('rechecks action binding at settlement INSERT even if it disappeared after provider verification', async () => {
  const f = await warmupSessionSettlementStorageFixture();
  clients.push(f.client);
  f.setHook(async () => {
    await f.db
      .prepare('DROP TRIGGER wallet_warmup_session_action_bindings_no_delete')
      .run();
    await f.db
      .prepare('DELETE FROM wallet_warmup_session_action_bindings')
      .run();
  });
  await expect(
    capture(f.db, 'owner', f.request(), signal(), f.fetcher, f.clock),
  ).rejects.toThrow();
  expect(
    (
      await f.db
        .prepare('SELECT count(*) AS n FROM wallet_warmup_session_settlements')
        .first<{ n: number }>()
    )?.n,
  ).toBe(0);
  expect(f.methods).toHaveLength(2);
});

it('refuses a binding if its original review expires before the write', async () => {
  const f = await fixture();
  let ticks = 0;
  const now = f.clock();
  await expect(
    retain(f.db, 'owner', input(f), signal(), () =>
      ticks++ === 0 ? now : now + 120000,
    ),
  ).rejects.toThrow();
  expect(await count(f.db)).toBe(0);
});
