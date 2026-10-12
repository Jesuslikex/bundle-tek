import { expect, it } from 'vitest';
import {
  sizeTradeSession,
  summarizeSessionAmounts,
} from './trade-session-sizing';
import { solanaTokenAtoms } from './solana-token-amount';
import { formatNativeBalance } from './wallet-balance-format';
it('preserves exact SOL budgets with deterministic remainder units', () => {
  const result = sizeTradeSession('total', '0.00000001', 3, 9);
  expect(result.amounts).toEqual(['0.000000004', '0.000000003', '0.000000003']);
  expect(result.totalRaw).toBe('10');
  expect(result.remainderWallets).toBe(1);
  expect(summarizeSessionAmounts(result.amounts, 9)?.total).toBe('0.00000001');
});
it('uses token precision and keeps every applied entry positive and bounded', () => {
  for (const decimals of [0, 6, 9, 255])
    for (const count of [1, 2, 25]) {
      const result = sizeTradeSession(
        'total',
        formatNativeBalance('123', decimals),
        count,
        decimals,
      );
      expect(result.amounts).toHaveLength(count);
      expect(
        result.amounts
          .reduce((sum, amount) => sum + solanaTokenAtoms(amount, decimals), 0n)
          .toString(),
      ).toBe(result.totalRaw);
    }
  expect(sizeTradeSession('total', '0.000003', 2, 6).amounts).toEqual([
    '0.000002',
    '0.000001',
  ]);
  expect(() => sizeTradeSession('total', '0.000001', 2, 6)).toThrow(
    'at least one',
  );
});
it('supports same-input totals beyond one wallet u64 without rounding', () => {
  const amount = ((1n << 64n) - 1n).toString();
  const result = sizeTradeSession('each', amount, 25, 0);
  expect(result.amounts.every((a) => a === amount)).toBe(true);
  expect(result.totalRaw).toBe((BigInt(amount) * 25n).toString());
  expect(summarizeSessionAmounts(result.amounts, 0)?.totalRaw).toBe(
    result.totalRaw,
  );
});
it('rejects bad counts, excessive precision and partial totals', () => {
  for (const count of [0, 26, 1.5])
    expect(() => sizeTradeSession('total', '1', count, 9)).toThrow();
  for (const amount of ['0', '-1', '1e2', '0.0000000001'])
    expect(() => sizeTradeSession('total', amount, 2, 9)).toThrow();
  expect(summarizeSessionAmounts(['1', ''], 9)).toBeNull();
  expect(summarizeSessionAmounts([], 9)).toBeNull();
});
