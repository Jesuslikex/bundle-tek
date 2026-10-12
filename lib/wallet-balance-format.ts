import type { LaunchChain } from './launch-plan';
export type WalletBalance = {
  chain: LaunchChain;
  address: string;
  raw: string;
  amount: string;
  currency: string;
  decimals: number;
  blockNumber: number;
  blockHash: string | null;
  observedAt: string;
  snapshotId: string;
  source: string;
  commitment: string;
};
export type BalanceSnapshot = {
  chain: LaunchChain;
  items: WalletBalance[];
  total: string;
  currency: string;
  blockNumber: number;
  observedAt: string;
  snapshotId: string;
  source: string;
  commitment: string;
  blockHash: string | null;
};
export function formatNativeBalance(raw: string, decimals: number) {
  if (decimals === 0) return BigInt(raw).toString();
  const digits = BigInt(raw)
    .toString()
    .padStart(decimals + 1, '0');
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return `${digits.slice(0, -decimals)}${fraction ? `.${fraction}` : ''}`;
}
export function signedBalanceAmount(raw: string, decimals: number) {
  const amount = BigInt(raw);
  return (
    (amount < 0n ? '-' : amount > 0n ? '+' : '') +
    formatNativeBalance((amount < 0n ? -amount : amount).toString(), decimals)
  );
}
export function combinedWalletBalance(
  wallets: Array<{ chain: LaunchChain; address: string }>,
  observations: WalletBalance[],
) {
  const items = wallets.map((wallet) =>
    observations.find(
      (b) => b.chain === wallet.chain && b.address === wallet.address,
    ),
  );
  const first = items[0];
  if (!first || items.some((b) => !b || b.snapshotId !== first.snapshotId))
    return null;
  return {
    ...first,
    amount: formatNativeBalance(
      items.reduce((sum, b) => sum + BigInt(b!.raw), 0n).toString(),
      first.decimals,
    ),
    count: items.length,
  };
}
