import { afterEach, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { walletFundingTimeFixture } from '@/test/wallet-funding-time-fixture';
import { readWalletFundingTimes as read } from './wallet-funding-time-server';
const clients: { close(): void }[] = [];
async function fixture() {
  const f = await walletFundingTimeFixture();
  clients.push(f.sqlite);
  return f;
}
const signal = () => new AbortController().signal;
afterEach(() => {
  clients.splice(0).forEach((c) => c.close());
  vi.unstubAllGlobals();
});
it('uses block time from a real-parser retained receipt, not observation time or metadata', async () => {
  const f = await fixture(),
    selection = f.wallet();
  const { receipt } = await f.seed();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No external reads');
    }),
  );
  const result = await read(f.db, 'owner', { wallets: [selection] }, signal());
  expect(result.wallets[0].funding).toEqual({
    signature: receipt.signature,
    slot: receipt.slot,
    blockTime: receipt.blockTime,
  });
  expect(result.executionAllowed).toBe(false);
  expect(result.scope).toBe('most-recently-saved-native-transfer');
  expect(f.queries.every((q) => q.startsWith('SELECT'))).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain('transaction');
});
it('keeps absent, null-block-time and malformed latest evidence unknown without inferring first funding', async () => {
  const f = await fixture(),
    selection = f.wallet();
  expect(
    (await read(f.db, 'owner', { wallets: [selection] }, signal())).wallets[0],
  ).toMatchObject({ funding: null, reason: 'no-retained-receipt' });
  await f.seed(undefined, null);
  expect(
    (await read(f.db, 'owner', { wallets: [selection] }, signal())).wallets[0],
  ).toMatchObject({ funding: null, reason: 'unavailable-evidence' });
  f.sqlite.prepare('UPDATE native_withdrawals SET receipt=?').run('{bad');
  expect(
    (await read(f.db, 'owner', { wallets: [selection] }, signal())).wallets[0]
      .funding,
  ).toBeNull();
});
it('does not reveal another owner receipt or accept missing, archived or changed wallets', async () => {
  const f = await fixture(),
    selection = f.wallet();
  await f.seed(undefined, undefined, 'other');
  expect(
    (await read(f.db, 'owner', { wallets: [selection] }, signal())).wallets[0]
      .funding,
  ).toBeNull();
  for (const sql of [
    'UPDATE workspace_wallets SET archived=1',
    'UPDATE workspace_wallets SET archived=0,revision=2',
    'DELETE FROM workspace_wallets',
  ]) {
    f.sqlite.exec(sql);
    await expect(
      read(f.db, 'owner', { wallets: [selection] }, signal()),
    ).rejects.toMatchObject({ status: 409 });
  }
});
it('refuses selection drift during the saved read and aborts before any database work', async () => {
  const f = await fixture(),
    selection = f.wallet();
  f.afterRead(() => {
    if (f.queries.length === 2)
      f.sqlite.exec('UPDATE workspace_wallets SET revision=2');
  });
  await expect(
    read(f.db, 'owner', { wallets: [selection] }, signal()),
  ).rejects.toMatchObject({ status: 409 });
  f.queries.length = 0;
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    read(f.db, 'owner', { wallets: [selection] }, aborted.signal),
  ).rejects.toThrow();
  expect(f.queries).toHaveLength(0);
});
it('reads two independently decoded recipient packets and retains their exact gap', async () => {
  const f = await fixture(),
    a = f.wallet(),
    b = f.wallet(bs58.encode(new Uint8Array(32).fill(9)));
  const start = Math.floor(Date.now() / 1000) - 7200;
  await f.seed(a.address, start);
  await f.seed(b.address, start + 1474);
  const result = await read(f.db, 'owner', { wallets: [a, b] }, signal());
  expect(result.wallets.map((w) => w.funding?.blockTime)).toEqual([
    start,
    start + 1474,
  ]);
});
it('does not fall back to old known evidence when the most recently saved receipt is corrupt', async () => {
  const f = await fixture(),
    selection = f.wallet();
  await f.seed();
  f.sqlite
    .prepare(
      `INSERT INTO native_withdrawals SELECT 'bad-latest',owner_id,wallet_address,wallet_revision,state,signature,document,'{bad',created_at,? FROM native_withdrawals`,
    )
    .run(new Date(Date.now() + 1000).toISOString());
  const result = await read(f.db, 'owner', { wallets: [selection] }, signal());
  expect(result.wallets[0]).toMatchObject({
    funding: null,
    reason: 'unavailable-evidence',
  });
});
it.each([
  { network: 'devnet' },
  { amountRaw: '1' },
  { slot: -1 },
  { blockTime: Math.floor(Date.now() / 1000) + 86400 },
])(
  'keeps mismatched or future receipt evidence unknown: %j',
  async (changed) => {
    const f = await fixture(),
      selection = f.wallet();
    const saved = await f.seed();
    f.sqlite
      .prepare('UPDATE native_withdrawals SET receipt=?')
      .run(JSON.stringify({ ...saved.receipt, ...changed }));
    expect(
      (await read(f.db, 'owner', { wallets: [selection] }, signal())).wallets[0]
        .funding,
    ).toBeNull();
  },
);
it('covers all 100 selected wallets with three SELECTs and explicit unknowns', async () => {
  const f = await fixture();
  const wallets = Array.from({ length: 100 }, (_, i) =>
    f.wallet(bs58.encode(new Uint8Array(32).fill(i + 1))),
  );
  const result = await read(f.db, 'owner', { wallets }, signal());
  expect(result.wallets).toHaveLength(100);
  expect(result.wallets.every((w) => w.funding === null)).toBe(true);
  expect(f.queries).toHaveLength(3);
  expect(f.bindingCounts).toEqual([2, 2, 2]);
});
it('treats an explicitly null token marker as native rather than skipping its recorded funding', async () => {
  const f = await fixture(),
    selection = f.wallet();
  const saved = await f.seed();
  f.sqlite
    .prepare('UPDATE native_withdrawals SET document=?')
    .run(JSON.stringify({ ...saved.review, token: null }));
  expect(
    (await read(f.db, 'owner', { wallets: [selection] }, signal())).wallets[0]
      .funding?.blockTime,
  ).toBe(saved.receipt.blockTime);
});
