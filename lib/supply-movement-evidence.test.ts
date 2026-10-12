import { beforeEach, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import {
  captureSupply,
  supplyScopeId,
  type SupplyHistoryRow,
} from './supply-history';
import { supplyFixture, supplyScope } from '../test/supply-history-fixture';
const mocks = vi.hoisted(() => ({
  page: vi.fn(),
  transaction: vi.fn(),
  accounts: vi.fn(),
}));
vi.mock('./supply-token-accounts', () => ({
  observeSupplyTokenAccounts: mocks.accounts,
}));
vi.mock('./tracked-signatures', async (original) => ({
  ...(await original<typeof import('./tracked-signatures')>()),
  observeSignaturePage: mocks.page,
}));
vi.mock('./tracked-wallet-transaction', () => ({
  observeTrackedTransaction: mocks.transaction,
}));
import { observeSupplyMovementEvidence } from './supply-movement-evidence';
const wallet = supplyScope.wallets[0].address;
const signature = (n: number) => bs58.encode(new Uint8Array(64).fill(n));
let previous: SupplyHistoryRow, current: SupplyHistoryRow;
const entry = (n: number, slot: number, failed = false) => ({
  signature: signature(n),
  slot,
  failed,
  blockTime: null,
});
const page = (
  signatures: ReturnType<typeof entry>[],
  nextCursor: string | null = null,
) => ({
  address: wallet,
  network: 'mainnet',
  anchor: 200,
  signatures,
  nextCursor,
});
const tx = (n: number, slot: number) => ({
  address: wallet,
  network: 'mainnet',
  signature: signature(n),
  slot,
  failed: false,
  tokensComplete: true,
  blockTime: null,
  source: 'fixture.test',
  tokenChanges: [
    {
      mint: supplyScope.mint,
      decimals: 6,
      beforeRaw: '100000',
      afterRaw: '90000',
      changeRaw: '-10000',
    },
  ],
});
beforeEach(async () => {
  const scopeId = await supplyScopeId(supplyScope);
  previous = {
    id: 'first',
    sequence: 1,
    scopeId,
    document: captureSupply(supplyFixture(), supplyScope, 1, null),
  };
  current = {
    id: 'second',
    sequence: 2,
    scopeId,
    document: captureSupply(supplyFixture(1), supplyScope, 1, previous),
  };
  mocks.page.mockReset();
  mocks.accounts.mockReset();
  mocks.transaction.mockReset();
});
const read = () =>
  observeSupplyMovementEvidence(
    current,
    previous,
    wallet,
    null,
    AbortSignal.timeout(1000),
  );
it('finds token-account-only signatures while decoding the original wallet and mint', async () => {
  const account = supplyScope.wallets[1].address;
  mocks.accounts.mockResolvedValue({ accounts: [account], slot: 200 });
  mocks.page.mockResolvedValue({ ...page([entry(1, 130)]), address: account });
  const decoded = tx(1, 130);
  mocks.transaction.mockResolvedValue({
    ...decoded,
    tokenChanges: decoded.tokenChanges.map((t) => ({
      ...t,
      accounts: [account],
    })),
  });
  const result = await observeSupplyMovementEvidence(
    current,
    previous,
    wallet,
    null,
    AbortSignal.timeout(1000),
    account,
  );
  expect(result.indexedAddress).toBe(account);
  expect(result.accountObservedSlot).toBe(200);
  expect(result.transactions).toHaveLength(1);
  expect(mocks.page.mock.calls[0][0]).toBe(account);
  expect(mocks.transaction.mock.calls[0][0]).toBe(wallet);
});
it('rejects a token account absent from verified current ownership before reading signatures', async () => {
  mocks.accounts.mockResolvedValue({ accounts: [], slot: 200 });
  await expect(
    observeSupplyMovementEvidence(
      current,
      previous,
      wallet,
      null,
      AbortSignal.timeout(1000),
      supplyScope.wallets[1].address,
    ),
  ).rejects.toThrow('currently owned');
  expect(mocks.page).not.toHaveBeenCalled();
});
it('decodes only matching mint changes in the saved interval and stops at its older boundary', async () => {
  mocks.page.mockResolvedValue(
    page([entry(1, 180), entry(2, 130), entry(3, 120, true), entry(4, 100)]),
  );
  mocks.transaction.mockResolvedValue(tx(2, 130));
  const result = await read();
  expect(result.transactions.map((t) => t.changeRaw)).toEqual(['-10000']);
  expect(result.completeThroughBoundary).toBe(true);
  expect(result.failedSignatures).toBe(1);
  expect(result.nextCursor).toBeNull();
  expect(mocks.transaction).toHaveBeenCalledTimes(1);
});
it('caps transaction fetches at five and resumes after the last inspected signature', async () => {
  mocks.page.mockResolvedValue(
    page(Array.from({ length: 10 }, (_, i) => entry(i + 1, 140 - i))),
  );
  mocks.transaction.mockImplementation(async (_a, _n, sig) =>
    tx(
      Array.from({ length: 10 }, (_, i) => i + 1).find(
        (i) => signature(i) === sig,
      )!,
      140 -
        Array.from({ length: 10 }, (_, i) => i + 1).find(
          (i) => signature(i) === sig,
        )! +
        1,
    ),
  );
  const result = await read();
  expect(mocks.transaction).toHaveBeenCalledTimes(5);
  expect(result.transactions).toHaveLength(5);
  expect(result.completeThroughBoundary).toBe(false);
  expect(JSON.parse(result.nextCursor!).signature).toBe(signature(5));
});
it('reports unavailable decodes without inventing movements and distinguishes exhausted signature coverage', async () => {
  mocks.page.mockResolvedValue(page([entry(1, 130), entry(2, 120)]));
  mocks.transaction
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ ...tx(2, 120), tokensComplete: false });
  const result = await read();
  expect(result.unavailableTransactions).toBe(2);
  expect(result.transactions).toEqual([]);
  expect(result.completeThroughBoundary).toBe(true);
});
it.each(['slot', 'signature', 'address', 'network', 'failed', 'precision'])(
  'rejects mismatched transaction %s',
  async (kind) => {
    mocks.page.mockResolvedValue(page([entry(1, 130)]));
    const value = tx(1, 130);
    if (kind === 'slot') value.slot++;
    if (kind === 'signature') value.signature = signature(2);
    if (kind === 'address') value.address = supplyScope.wallets[1].address;
    if (kind === 'network') value.network = 'devnet';
    if (kind === 'failed') value.failed = true;
    if (kind === 'precision') value.tokenChanges[0].decimals = 9;
    mocks.transaction.mockResolvedValue(value);
    await expect(read()).rejects.toThrow();
  },
);
it('rejects a finalized anchor behind the observation and an unrelated wallet before transaction reads', async () => {
  mocks.page.mockResolvedValue({ ...page([]), anchor: 139 });
  await expect(read()).rejects.toThrow('finalized');
  await expect(
    observeSupplyMovementEvidence(
      previous,
      previous,
      wallet,
      null,
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow('saved wallet alert');
  expect(mocks.transaction).not.toHaveBeenCalled();
});
