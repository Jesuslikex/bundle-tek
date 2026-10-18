import type { WorkspaceWallet } from './wallet-workspace';
import type { WalletBalance } from './wallet-balance-format';

export type WalletRosterSort =
  | 'saved'
  | 'name'
  | 'balance-high'
  | 'balance-low';
export const WALLET_ROSTER_PAGE_SIZE = 50;
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Sort only saved observations; unknown balances stay unknown and sort last. */
export function sortWalletRoster(
  wallets: readonly WorkspaceWallet[],
  observations: readonly WalletBalance[],
  sort: WalletRosterSort,
) {
  const rows = [...wallets];
  if (sort === 'saved') return rows;
  const balances = new Map(
    observations
      .filter(
        (b) =>
          /^(0|[1-9]\d*)$/.test(b.raw) &&
          b.raw.length <= 78 &&
          Number.isInteger(b.decimals) &&
          b.decimals >= 0 &&
          b.decimals <= 18,
      )
      .map((b) => [b.chain + ':' + b.address, b]),
  );
  return rows.sort((a, b) => {
    let comparison = 0;
    if (sort === 'name')
      comparison = compareText(a.label.toLowerCase(), b.label.toLowerCase());
    else {
      const left = balances.get(a.chain + ':' + a.address),
        right = balances.get(b.chain + ':' + b.address);
      if (!left || !right)
        return left ? -1 : right ? 1 : compareText(a.address, b.address);
      const leftRaw = BigInt(left.raw) * 10n ** BigInt(right.decimals);
      const rightRaw = BigInt(right.raw) * 10n ** BigInt(left.decimals);
      comparison = leftRaw < rightRaw ? -1 : leftRaw > rightRaw ? 1 : 0;
      if (sort === 'balance-high') comparison = -comparison;
    }
    return comparison || compareText(a.address, b.address);
  });
}
