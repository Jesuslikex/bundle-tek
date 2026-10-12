import { beforeEach, describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { writeFileSync } from 'node:fs';
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./wallet-balances', () => ({
  balanceRpc: rpc,
  SOLANA_MAINNET_GENESIS: 'mainnet-test-genesis',
}));
import { observeSupplyPartition } from './supply-partition';
const key = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const mint = key(9),
  scope = {
    mint,
    wallets: [
      { address: key(1), group: 'team' },
      { address: key(2), group: 'external' },
      { address: key(3), group: 'pool' },
    ],
  };
type TestRow = {
  context: { slot: string };
  value: {
    pubkey: string;
    account: {
      owner: string;
      executable: boolean;
      data: {
        parsed: {
          type: string;
          info: {
            owner: string;
            mint: string;
            state: string;
            tokenAmount: { amount: string; decimals: string };
          };
        };
      };
    };
  }[];
};
let change: (row: TestRow, index: number) => void;
beforeEach(() => {
  change = () => {};
  rpc
    .mockReset()
    .mockImplementation(
      async (_endpoint: string, method: string, params: unknown[]) => {
        if (method === 'getGenesisHash') return 'mainnet-test-genesis';
        if (method === 'getTokenSupply')
          return {
            context: { slot: '100' },
            value: { amount: '1000000', decimals: '6' },
          };
        const i = scope.wallets.findIndex((w) => w.address === params[0]);
        const row = {
          context: { slot: String(101 + i) },
          value: [
            {
              pubkey: key(20 + i),
              account: {
                owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                executable: false,
                data: {
                  parsed: {
                    type: 'account',
                    info: {
                      owner: scope.wallets[i].address,
                      mint,
                      state: 'initialized',
                      tokenAmount: {
                        amount: String((i + 1) * 100000),
                        decimals: '6',
                      },
                    },
                  },
                },
              },
            },
          ],
        };
        change(row, i);
        return row;
      },
    );
});
describe('classified supply partition reads', () => {
  it('partitions exact units, counts team only once and exposes the confirmed slot window', async () => {
    const result = await observeSupplyPartition(scope);
    expect(result.parts.team.raw).toBe('100000');
    expect(result.parts.external.raw).toBe('200000');
    expect(result.parts.pool.raw).toBe('300000');
    expect(result.parts.unclassified.raw).toBe('400000');
    expect(result.parts.outsideTeam.raw).toBe('900000');
    expect(result.minSlot).toBe(100);
    expect(result.maxSlot).toBe(103);
    expect(result.wallets[2].amount).toBe('0.3');
    expect(rpc.mock.calls[2][2][2].minContextSlot).toBe(100);
    if (process.env.SUPPLY_PARTITION_QA_EXPORT)
      writeFileSync(
        process.env.SUPPLY_PARTITION_QA_EXPORT,
        JSON.stringify(result),
      );
  });
  it.each([
    'owner',
    'mint',
    'precision',
    'duplicate',
    'drift',
    'old',
    'overflow',
    'program',
    'negative',
  ])(
    'rejects provider %s inconsistencies without publishing totals',
    async (kind) => {
      change = (row) => {
        const info = row.value[0].account.data.parsed.info;
        if (kind === 'owner') info.owner = key(8);
        if (kind === 'mint') info.mint = key(8);
        if (kind === 'precision') info.tokenAmount.decimals = '9';
        if (kind === 'duplicate') row.value[0].pubkey = key(20);
        if (kind === 'drift') row.context.slot = '133';
        if (kind === 'old') row.context.slot = '99';
        if (kind === 'overflow') info.tokenAmount.amount = '1000001';
        if (kind === 'program') row.value[0].account.owner = key(8);
        if (kind === 'negative') info.tokenAmount.amount = '-1';
      };
      await expect(observeSupplyPartition(scope)).rejects.toThrow();
    },
  );
  it('refuses wrong networks before owner reads', async () => {
    rpc.mockResolvedValueOnce('devnet');
    await expect(observeSupplyPartition(scope)).rejects.toThrow('network');
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('rejects duplicate scope and excessive reads before contacting a provider', async () => {
    await expect(
      observeSupplyPartition({
        mint,
        wallets: [scope.wallets[0], scope.wallets[0]],
      }),
    ).rejects.toThrow('Duplicate');
    await expect(
      observeSupplyPartition({
        mint,
        wallets: Array(13).fill(scope.wallets[0]),
      }),
    ).rejects.toThrow('1 to 12');
    expect(rpc).not.toHaveBeenCalled();
  });
});
