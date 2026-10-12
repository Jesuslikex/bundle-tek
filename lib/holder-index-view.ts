import type { holderIndexSummary } from './holder-index';

type Holder = ReturnType<typeof holderIndexSummary>['holders'][number];
export type HolderSort = 'largest' | 'smallest' | 'owner' | 'accounts';

export function selectIndexedHolders(
  holders: Holder[],
  search: string,
  sort: HolderSort,
) {
  return holders
    .filter((holder) => holder.owner.includes(search.trim()))
    .toSorted((a, b) => {
      const address = a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0;
      if (sort === 'owner') return address;
      if (sort === 'accounts' && a.accountCount !== b.accountCount)
        return b.accountCount - a.accountCount;
      if (a.raw === b.raw) return address;
      const balance = a.raw > b.raw ? -1 : 1;
      return sort === 'smallest' ? -balance : balance;
    });
}

/** Truncate only for display; never convert on-chain units to Number. */
export function indexedHolderSupplyShare(raw: bigint, supply: string) {
  const total = BigInt(supply);
  if (total <= 0n || raw < 0n || raw > total) return 'Unavailable';
  if (raw === 0n) return '0.0000%';
  const units = (raw * 1_000_000n) / total;
  if (units === 0n) return '<0.0001%';
  return `${units / 10_000n}.${(units % 10_000n).toString().padStart(4, '0')}%`;
}
