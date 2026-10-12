import type { ConditionalSellOrder } from '@/lib/conditional-sell-order';
import type { ConditionalLevelReview } from '@/lib/conditional-level-review';
export function ConditionalLevelPreview({
  order,
  reviews,
  now,
}: {
  order: ConditionalSellOrder;
  reviews: ConditionalLevelReview[];
  now: number;
}) {
  const expired = Date.parse(reviews[0].expiresAt) <= now;
  return (
    <section
      aria-label="Saved level condition sample"
      className="min-w-0 space-y-2 break-words rounded-md border p-3"
    >
      <h6>Sampled conditions</h6>
      <p>
        Selected pool {reviews[0].pair}. Market cap $
        {reviews[0].observedMarketCapUsd}, sampled {reviews[0].observedAt} via{' '}
        {reviews[0].source}. Expires {reviews[0].expiresAt}.
      </p>
      {expired && (
        <output>
          Sample expired. Refresh selected-pool market data and review the saved
          conditions again.
        </output>
      )}
      <ul>
        {reviews.map((r, i) => (
          <li key={order.terms.levels[i].level}>
            Level {order.terms.levels[i].level}: ${r.targetUsd}{' '}
            {r.direction === 'at-or-above' ? 'at or above' : 'at or below'};{' '}
            {expired
              ? 'Expired sample'
              : r.met
                ? 'Met in this sample'
                : 'Not met in this sample'}
            . Exact sell amount {order.terms.levels[i].amount} tokens.
          </li>
        ))}
      </ul>
      <p>
        This sample does not reserve inventory or approve a trade. Preparation,
        signing review and submission check the condition again.
      </p>
    </section>
  );
}
