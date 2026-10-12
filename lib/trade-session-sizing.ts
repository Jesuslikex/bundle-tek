import { solanaTokenAtoms } from './solana-token-amount';
import { formatNativeBalance } from './wallet-balance-format';
export function sizeTradeSession(
  mode: 'total' | 'each',
  amount: string,
  count: number,
  decimals: number,
) {
  if (
    !['total', 'each'].includes(mode) ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 25
  )
    throw new Error('Select 1 to 25 session wallets first.');
  const raw = solanaTokenAtoms(amount, decimals);
  const base = mode === 'total' ? raw / BigInt(count) : raw;
  const remainder = mode === 'total' ? raw % BigInt(count) : 0n;
  if (base < 1n)
    throw new Error(
      'The total must provide at least one atomic unit per wallet.',
    );
  const amounts = Array.from({ length: count }, (_, i) =>
    formatNativeBalance(
      (base + (BigInt(i) < remainder ? 1n : 0n)).toString(),
      decimals,
    ),
  );
  return {
    amounts,
    totalRaw: (mode === 'total' ? raw : raw * BigInt(count)).toString(),
    remainderWallets: Number(remainder),
  };
}
export function summarizeSessionAmounts(amounts: string[], decimals: number) {
  if (!amounts.length || amounts.length > 25) return null;
  try {
    const total = amounts.reduce(
      (sum, amount) => sum + solanaTokenAtoms(amount, decimals),
      0n,
    );
    return {
      totalRaw: total.toString(),
      total: formatNativeBalance(total.toString(), decimals),
    };
  } catch {
    return null;
  }
}
