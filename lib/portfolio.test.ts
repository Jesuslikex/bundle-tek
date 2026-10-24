import bs58 from 'bs58';
import { describe, expect, it, vi } from 'vitest';
import {
  holdingUsd,
  summarizePortfolio,
  type PortfolioHoldings,
} from './portfolio';
import { readPortfolioHoldings, savedPrice } from './portfolio-holdings';

const key = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const holdings = (priceUsd: number | null): PortfolioHoldings => ({
  observedAt: '2026-10-24T00:00:00.000Z',
  walletCount: 2,
  walletsOmitted: 0,
  projectsOmitted: 0,
  solLamports: '3000000000',
  holdings: [
    {
      projectId: 'p1',
      name: 'Cat',
      symbol: 'CAT',
      mint: key(50),
      decimals: 6,
      heldRaw: '2000000',
      walletCount: 1,
      priceUsd,
      priceObservedAt: null,
    },
  ],
});

describe('portfolio summary', () => {
  it('values holdings, subtracts open cost and adds realized results', () => {
    expect(holdingUsd('2500000', 6, 2)).toBe(5);
    const s = summarizePortfolio(
      holdings(50),
      [
        {
          kind: 'Imported trades',
          id: 'p1',
          unallocatedCostLamports: '400000000',
          linkedResultLamports: '100000000',
        },
        {
          kind: 'Warmup',
          id: 'w',
          unallocatedCostLamports: '0',
          linkedResultLamports: '-20000000',
        },
      ],
      100,
    );
    // 2 CAT x $50 = $100 = 1 SOL at $100.
    expect(s.holdingsValueLamports).toBe(1_000_000_000n);
    expect(s.rows[0].unrealizedLamports).toBe(600_000_000n);
    expect(s.realizedLamports).toBe(80_000_000n);
    expect(s.totalLamports).toBe(680_000_000n);
  });
  it('leaves unpriced holdings out of totals and counts them', () => {
    const s = summarizePortfolio(holdings(null), [], 100);
    expect(s.unpricedCount).toBe(1);
    expect(s.holdingsValueLamports).toBe(0n);
    expect(summarizePortfolio(holdings(5), [], null).unpricedCount).toBe(1);
  });
});

describe('portfolio holdings', () => {
  it('reads the deepest saved price', () => {
    expect(
      savedPrice(
        JSON.stringify([
          {
            observedAt: 't',
            pairs: [
              { priceUsd: '1', liquidityUsd: 5 },
              { priceUsd: '2', liquidityUsd: 50 },
            ],
          },
        ]),
      ),
    ).toEqual({ priceUsd: 2, observedAt: 't' });
    expect(savedPrice(null).priceUsd).toBeNull();
  });
  it('sums both token programs over proven wallets with read-only calls', async () => {
    const a = key(7),
      b = key(8),
      mint = key(50);
    const db = {
      prepare: (sql: string) => ({
        bind: () => ({
          all: async () => ({
            results: sql.includes('workspace_wallets w')
              ? [{ address: a }, { address: b }]
              : [
                  {
                    id: 'p1',
                    document: JSON.stringify({
                      token: {
                        address: mint,
                        symbol: 'CAT',
                        name: 'Cat',
                        decimals: 6,
                      },
                    }),
                    market: null,
                  },
                ],
          }),
        }),
      }),
    } as unknown as D1Database;
    const token = (owner: string, amount: string) => ({
      data: { parsed: { info: { mint, owner, tokenAmount: { amount } } } },
    });
    const rpc = vi.fn(async (_m: string, params: unknown[]) => {
      const keys = params[0] as string[];
      if (keys[0] === a) return { value: [{ lamports: 5 }, { lamports: 7 }] };
      return { value: [token(a, '10'), null, null, token(b, '3')] };
    });
    const result = await readPortfolioHoldings(db, 'owner', rpc);
    expect(result.solLamports).toBe('12');
    expect(result.holdings[0]).toMatchObject({
      heldRaw: '13',
      walletCount: 2,
      priceUsd: null,
    });
    expect(new Set(rpc.mock.calls.map((c) => c[0]))).toEqual(
      new Set(['getMultipleAccounts']),
    );
  });
});
