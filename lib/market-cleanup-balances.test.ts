import bs58 from 'bs58';
import { describe, expect, it, vi } from 'vitest';
import { readCleanupBalances } from './market-cleanup-balances';

const key = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const mint = key(50),
  a = key(7),
  b = key(8);
const token = (owner: string, amount: string, tokenMint = mint) => ({
  lamports: 2039280,
  data: {
    parsed: { info: { mint: tokenMint, owner, tokenAmount: { amount } } },
  },
});

describe('readCleanupBalances', () => {
  it('reads SOL and both token programs in one call', async () => {
    const rpc = vi.fn(async (_m: string, params: unknown[]) => {
      expect((params[0] as string[]).length).toBe(6);
      return {
        value: [
          { lamports: 5 },
          null,
          token(a, '100'),
          null,
          null,
          token(b, '7'),
        ],
      };
    });
    await expect(
      readCleanupBalances(rpc, mint, [a, b], new AbortController().signal),
    ).resolves.toEqual([
      { wallet: a, lamports: '5', tokenRaw: '100' },
      { wallet: b, lamports: '0', tokenRaw: '7' },
    ]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe('getMultipleAccounts');
  });
  it('refuses an account for another mint or owner', async () => {
    const rpc = async () => ({
      value: [{ lamports: 1 }, token(a, '1', key(51)), null],
    });
    await expect(
      readCleanupBalances(rpc, mint, [a], new AbortController().signal),
    ).rejects.toThrow(/differs/);
  });
});
