import type { ConditionalPreparation } from '@/lib/conditional-preparation-server';
export function ConditionalSigningReview({
  conditional: c,
}: {
  conditional: ConditionalPreparation;
}) {
  const buy = c.format === 'conditional-preparation-v2';
  return (
    <section
      aria-label="Conditional level approval terms"
      className="warmup-address space-y-2 rounded-md border p-3"
    >
      <h6>
        Conditional {buy ? 'buy' : 'sell'}: level {c.level}
      </h6>
      <p>
        Order {c.orderId}, revision {c.orderRevision}.{' '}
        {buy ? 'Buy with' : 'Sell'} {c.unitsRaw} atomic{' '}
        {buy ? 'SOL input units' : 'token units'} when sampled market cap is{' '}
        {c.direction === 'at-or-above' ? 'at or above' : 'at or below'} $
        {c.targetUsd}.
      </p>
      {buy && (
        <p>
          Input: SOL with {c.inputDecimals} decimals. Target mint {c.outputMint}{' '}
          with {c.outputDecimals} decimals. The swap review sets the minimum
          token output; the SOL budget is not a promised token quantity.
        </p>
      )}
      <p>
        Selected pool: {c.pair}. Captured market cap: ${c.observedMarketCapUsd},
        observed {c.observedAt} via {c.source}. Condition capture expires{' '}
        {c.expiresAt}.
      </p>
      <p className="warmup-address">Saved terms fingerprint: {c.termsSha256}</p>
      <p>
        This approval reserves this level and wallet. Submission rechecks a
        fresh met condition. Each level requires your signature and separate
        submission; no background trades or guaranteed fills.
      </p>
    </section>
  );
}
