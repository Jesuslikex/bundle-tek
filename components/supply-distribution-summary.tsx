import { supplyDistribution } from '@/lib/supply-distribution';
import type { SupplyPartition } from '@/lib/supply-partition';
import styles from './supply-distribution-summary.module.css';

/** Receives the validated snapshot from saved history, with disjoint groups. */
export function SupplyDistributionSummary({
  snapshot,
}: {
  snapshot: SupplyPartition;
}) {
  const { segments, external } = supplyDistribution(snapshot);
  return (
    <section className={styles.summary} aria-label="Saved supply distribution">
      <figure>
        {/* oxlint-disable jsx-a11y/prefer-tag-over-role -- SVG supply proportions have an accessible text legend. */}
        <svg
          role="img"
          aria-label="Supply split across watched team, external and pool wallets, and unobserved supply"
          viewBox="0 0 1000 30"
          width="100%"
          height="30"
          preserveAspectRatio="none"
        >
          <title>Saved supply distribution</title>
          {segments.map((segment) => (
            <rect
              key={segment.key}
              x={segment.start}
              y="0"
              width={segment.width}
              height="30"
              fill={segment.color}
            >
              <title>
                {segment.label}: {segment.part.supplyPercent.toFixed(4)}%
              </title>
            </rect>
          ))}
        </svg>
        <figcaption>
          Total supply: {snapshot.totalSupply} tokens. This saved watchlist
          covers {snapshot.wallets.length} selected wallets. Unobserved supply
          can include other team wallets, holders and pools.
        </figcaption>
      </figure>
      <dl className={styles.legend}>
        {segments.map((segment) => (
          <div key={segment.key}>
            <dt>
              <span
                aria-hidden="true"
                className={styles.dot}
                style={{ backgroundColor: segment.color }}
              />
              {segment.label}
            </dt>
            <dd>
              <strong>{segment.part.supplyPercent.toFixed(4)}%</strong>
              <span>{segment.part.amount} tokens</span>
            </dd>
          </div>
        ))}
      </dl>
      <details>
        <summary>Watched external wallets ({external.length})</summary>
        <p>
          Ranked within this saved watchlist. This is not a global holder
          ranking or a complete Top 10.
        </p>
        {external.length > 0 ? (
          <ol className={styles.wallets}>
            {external.map((wallet) => (
              <li key={wallet.address}>
                <code>{wallet.address}</code>
                <span>
                  {wallet.supplyPercent.toFixed(4)}% · {wallet.amount} tokens
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p>No external wallets were selected for this observation.</p>
        )}
      </details>
    </section>
  );
}
