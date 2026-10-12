import { beforeEach, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ token: vi.fn(), balances: vi.fn() }));
vi.mock('./token-import', () => ({ inspectToken: mocks.token }));
vi.mock('./wallet-balances', () => ({ observeWalletBalances: mocks.balances }));
import { inspectWarmupPreflight } from './wallet-warmup-preflight';
const address = '0x1111111111111111111111111111111111111111';
const doc = () => ({
  name: 'QA',
  chain: 'Base',
  addresses: [address],
  walletRevisions: [{ address, revision: 1 }],
  tokens: ['0x4200000000000000000000000000000000000006'],
  amount: '0.000000000000000001',
  feeReserve: '0.000000000000000002',
  cycles: 3,
  intervalMinutes: 60,
  startAt: new Date(Date.now() + 3600000).toISOString(),
  totalBudget: 'malicious',
});
beforeEach(() => {
  mocks.token.mockReset();
  mocks.balances.mockReset();
  mocks.token.mockResolvedValue({
    name: 'Wrapped Ether',
    symbol: 'WETH',
    decimals: 18,
    source: 'https://mainnet.base.org/path?key=secret',
    observedAt: new Date().toISOString(),
  });
  mocks.balances.mockResolvedValue({
    items: [{ address, raw: '5', amount: '0.000000000000000005' }],
    source: 'mainnet.base.org',
    blockNumber: 1,
    blockHash: 'hash',
    commitment: 'canonical',
    observedAt: new Date().toISOString(),
  });
});
it('rebuilds exact required budget and observes identity without execution clearance', async () => {
  const r = await inspectWarmupPreflight(doc(), AbortSignal.timeout(1000));
  expect(r.requiredPerWallet).toBe('0.000000000000000005');
  expect(r.wallets[0]).toMatchObject({ covered: true, shortfall: '0' });
  expect(r.status).toBe('Observed');
  expect(r.executionAllowed).toBe(false);
  expect(r.tokens[0].source).toBe('mainnet.base.org');
  expect(JSON.stringify(r)).not.toContain('secret');
});
it('reports exact shortfalls without crediting future sell proceeds', async () => {
  mocks.balances.mockResolvedValue({
    items: [{ address, raw: '4', amount: '0.000000000000000004' }],
  });
  const r = await inspectWarmupPreflight(doc(), AbortSignal.timeout(1000));
  expect(r.status).toBe('Hold');
  expect(r.wallets[0]).toMatchObject({
    covered: false,
    shortfall: '0.000000000000000001',
  });
});
it('sanitizes upstream errors and keeps unknown balance/identity held', async () => {
  mocks.balances.mockRejectedValue(new Error('private-provider-message'));
  mocks.token.mockRejectedValue(new Error('secret-token-provider'));
  const r = await inspectWarmupPreflight(doc(), AbortSignal.timeout(1000));
  expect(r.status).toBe('Hold');
  expect(r.wallets[0].covered).toBeNull();
  expect(r.tokens[0].error).toBeTruthy();
  expect(JSON.stringify(r)).not.toMatch(
    /private-provider-message|secret-token-provider/,
  );
});
it('allows inspection of an old saved plan but holds its stale timing', async () => {
  const r = await inspectWarmupPreflight(
    { ...doc(), startAt: new Date(Date.now() - 3600000).toISOString() },
    AbortSignal.timeout(1000),
  );
  expect(r.status).toBe('Hold');
  expect(r.issues).toContain(
    'Start time has passed. Update the saved schedule.',
  );
});
