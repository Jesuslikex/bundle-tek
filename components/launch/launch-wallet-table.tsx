'use client';

import { holdersBuyUnit } from '@/lib/launch-buy';
import type { LaunchPlanInput } from '@/lib/launch-plan';

function pct(value: number) {
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 3 })}%`;
}

/**
 * Proxima-style launch wallet table. It previews the planned supply split per
 * wallet (developer, then an even holder split); real wallets and exact
 * amounts are assigned in the reviewed funding plan.
 */
export function LaunchWalletTable({
  plan,
  onOpenWallets,
}: {
  plan: Pick<
    LaunchPlanInput,
    | 'developerBuy'
    | 'holdersBuy'
    | 'holdersBuyQuote'
    | 'holderCount'
    | 'mode'
    | 'scheduled'
    | 'launchpad'
    | 'currency'
  >;
  onOpenWallets: () => void;
}) {
  const holders = Math.max(0, Math.floor(plan.holderCount));
  const bySupply = holdersBuyUnit(plan) === 'supply';
  const quoteTotal = Number(plan.holdersBuyQuote ?? '');
  const holderAmount =
    holders === 0
      ? '—'
      : bySupply
        ? pct(plan.holdersBuy / holders)
        : Number.isFinite(quoteTotal) && quoteTotal > 0
          ? `${(quoteTotal / holders).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${plan.currency}`
          : '—';
  const rows: { role: string; amount: string }[] = [
    { role: 'Developer', amount: pct(plan.developerBuy) },
    ...Array.from({ length: holders }, () => ({
      role: 'Holder',
      amount: holderAmount,
    })),
  ];
  return (
    <section className="launch-wallet-table" aria-label="Launch wallets">
      <header>
        <h2>Wallets</h2>
        <button type="button" onClick={onOpenWallets}>
          Manage wallets
        </button>
      </header>
      <div className="launch-wallet-scroll">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Role</th>
              <th>Wallet</th>
              <th>Buy</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                <td>{index}</td>
                <td>{row.role}</td>
                <td className="launch-wallet-pending">Assigned at funding</td>
                <td>{row.amount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <footer>{rows.length} Wallets · preview, even holder split</footer>
    </section>
  );
}
