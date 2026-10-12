import type { SupplyPartition } from './supply-partition';

const groups = [
  { key: 'team', label: 'Watched team', color: '#60a5fa' },
  { key: 'external', label: 'Watched external', color: '#a78bfa' },
  { key: 'pool', label: 'Watched pools', color: '#34d399' },
  { key: 'unclassified', label: 'Unobserved supply', color: '#64748b' },
] as const;

/** Layout only: the caller supplies a validated saved snapshot. */
export function supplyDistribution(snapshot: SupplyPartition) {
  const total = BigInt(snapshot.totalSupplyRaw);
  let cumulative = 0n;
  const segments = groups.map((group) => {
    const start = Number((cumulative * 1_000_000n) / total) / 1000;
    cumulative += BigInt(snapshot.parts[group.key].raw);
    const end = Number((cumulative * 1_000_000n) / total) / 1000;
    return {
      ...group,
      start,
      width: end - start,
      part: snapshot.parts[group.key],
    };
  });
  const external = snapshot.wallets
    .filter((wallet) => wallet.group === 'external')
    .toSorted((a, b) =>
      BigInt(a.raw) === BigInt(b.raw)
        ? a.address.localeCompare(b.address)
        : BigInt(a.raw) > BigInt(b.raw)
          ? -1
          : 1,
    );
  return { segments, external };
}
