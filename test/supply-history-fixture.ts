import bs58 from 'bs58';
import { formatNativeBalance } from '../lib/wallet-balance-format';
import { percentOfSupply } from '../lib/supply-analysis';
import { canonicalSupplyScope } from '../lib/supply-history';
import type { SupplyPartition } from '../lib/supply-partition';
export const supplyWallet = (n: number) =>
  bs58.encode(new Uint8Array(32).fill(n));
export const supplyProject = 'supply-project-1';
export const supplyScope = canonicalSupplyScope({
  mint: supplyWallet(9),
  wallets: [
    { address: supplyWallet(1), group: 'team' },
    { address: supplyWallet(2), group: 'external' },
  ],
});
export function supplyFixture(index = 0, scope = supplyScope): SupplyPartition {
  const total = 1000000n,
    totals = { team: 0n, external: 0n, pool: 0n };
  const wallets = scope.wallets.map((w, i) => {
    const units = BigInt(
      i === 0 ? 100000 - index * 10000 : 200000 + index * 5000,
    );
    totals[w.group] += units;
    return {
      ...w,
      raw: units.toString(),
      amount: formatNativeBalance(units.toString(), 6),
      supplyPercent: percentOfSupply(units, total),
      slot: 100 + index * 40 + 1 + i,
    };
  });
  const parts = {
    ...totals,
    unclassified: total - totals.team - totals.external - totals.pool,
    outsideTeam: total - totals.team,
  };
  return {
    mint: scope.mint,
    decimals: 6,
    totalSupplyRaw: total.toString(),
    totalSupply: '1',
    wallets,
    parts: Object.fromEntries(
      Object.entries(parts).map(([g, units]) => [
        g,
        {
          raw: units.toString(),
          amount: formatNativeBalance(units.toString(), 6),
          supplyPercent: percentOfSupply(units, total),
        },
      ]),
    ) as SupplyPartition['parts'],
    minSlot: 100 + index * 40,
    maxSlot: 102 + index * 40,
    observedAt: new Date(
      Date.parse('2026-10-11T12:00:00Z') + index * 30000,
    ).toISOString(),
    source: 'fixture.test',
    commitment: 'confirmed',
  };
}
