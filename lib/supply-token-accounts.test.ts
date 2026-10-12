import { beforeEach, expect, it, vi } from 'vitest';
import { supplyScope, supplyWallet } from '../test/supply-history-fixture';
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./wallet-balances', () => ({
  balanceRpc: rpc,
  SOLANA_MAINNET_GENESIS: 'test-mainnet',
}));
import { observeSupplyTokenAccounts } from './supply-token-accounts';
const wallet = supplyScope.wallets[0].address;
const fixture = () => ({
  context: { slot: '200' },
  value: [
    {
      pubkey: supplyWallet(5),
      account: {
        owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        executable: false,
        data: {
          parsed: {
            type: 'account',
            info: {
              owner: wallet,
              mint: supplyScope.mint,
              state: 'initialized',
              tokenAmount: { amount: '0', decimals: '6' },
            },
          },
        },
      },
    },
  ],
});
beforeEach(() =>
  rpc
    .mockReset()
    .mockImplementation(async (_endpoint, method) =>
      method === 'getGenesisHash' ? 'test-mainnet' : fixture(),
    ),
);
const read = () =>
  observeSupplyTokenAccounts(
    wallet,
    supplyScope.mint,
    6,
    141,
    AbortSignal.timeout(1000),
  );
it('discovers zero-balance current token accounts at a finalized context covering the alert', async () => {
  expect((await read()).accounts).toEqual([supplyWallet(5)]);
  expect(rpc.mock.calls[1][2][2]).toEqual({
    encoding: 'jsonParsed',
    commitment: 'finalized',
    minContextSlot: 141,
  });
});
it.each([
  'wallet',
  'mint',
  'program',
  'slot',
  'duplicate',
  'precision',
  'amount',
  'limit',
])('rejects mismatched or unbounded %s account data', async (kind) => {
  const data = fixture();
  const info = data.value[0].account.data.parsed.info;
  if (kind === 'wallet') info.owner = supplyWallet(6);
  if (kind === 'mint') info.mint = supplyWallet(6);
  if (kind === 'program') data.value[0].account.owner = supplyWallet(6);
  if (kind === 'slot') data.context.slot = '140';
  if (kind === 'duplicate') data.value.push(data.value[0]);
  if (kind === 'precision') info.tokenAmount.decimals = '9';
  if (kind === 'amount') info.tokenAmount.amount = '18446744073709551616';
  if (kind === 'limit') data.value = Array(501).fill(data.value[0]);
  rpc.mockImplementation(async (_endpoint, method) =>
    method === 'getGenesisHash' ? 'test-mainnet' : data,
  );
  await expect(read()).rejects.toThrow();
});
it('rejects a different network before account enumeration', async () => {
  rpc.mockResolvedValueOnce('devnet');
  await expect(read()).rejects.toThrow('network');
  expect(rpc).toHaveBeenCalledTimes(1);
});
