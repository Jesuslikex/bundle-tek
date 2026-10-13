import type { SessionEntryOutcomes } from '@/lib/session-entry-outcomes';
import { sessionOutcomeSummary } from '@/lib/session-outcome-summary';
import { formatNativeBalance } from '@/lib/wallet-balance-format';

export function SessionOutcomeSummary({
  snapshot,
}: {
  snapshot: SessionEntryOutcomes;
}) {
  let summary: ReturnType<typeof sessionOutcomeSummary>;
  try {
    summary = sessionOutcomeSummary(snapshot);
  } catch {
    return (
      <p role="alert">
        Session progress cannot be reconciled with the retained evidence. Reload
        outcomes before relying on its totals.
      </p>
    );
  }
  const unit = snapshot.session.terms.side === 'Buy' ? 'SOL' : 'tokens';
  const decimals =
    snapshot.session.terms.side === 'Buy' ? 9 : snapshot.session.terms.decimals;
  const entries =
    snapshot.session.terms.strategy === 'DCA' ? 'cycles' : 'entries';
  const states = [
    ['Awaiting signature', summary.counts.awaitingSignature],
    [
      'Signed or submitted; awaiting settlement',
      summary.counts.awaitingSettlement,
    ],
    [
      'Finalized approval without matching receipt',
      summary.counts.finalizedWithoutReceipt,
    ],
    ['Failed or cancelled approval', summary.counts.failedOrCancelled],
    ['No retained approval record', summary.counts.noApprovalRecord],
    ['Approval state unknown', summary.counts.unknownApproval],
  ] as const;
  return (
    <section
      aria-label="Session progress"
      className="space-y-2 rounded-md border p-3"
    >
      <h6>Session progress</h6>
      <p>
        {summary.counts.verified} of {summary.entries} {entries} have matching
        finalized receipts.
      </p>
      <progress
        aria-label="Receipt-verified session entries"
        max={summary.entries}
        value={summary.counts.verified}
        className="h-2 w-full"
      />
      <dl className="grid gap-2 sm:grid-cols-2">
        <div>
          <dt>Input allocated to receipt-verified {entries}</dt>
          <dd>
            {formatNativeBalance(summary.verifiedInputRaw, decimals)} {unit} (
            {(summary.verifiedBudgetBasisPoints / 100).toFixed(2)}% of saved
            budget)
          </dd>
        </div>
        <div>
          <dt>Input allocation not receipt-verified</dt>
          <dd>
            {formatNativeBalance(summary.unverifiedInputRaw, decimals)} {unit}
          </dd>
        </div>
      </dl>
      <ul>
        {states
          .filter(([, count]) => count > 0)
          .map(([label, count]) => (
            <li key={label}>
              {label}: {count}
            </li>
          ))}
      </ul>
      <p className="text-sm text-muted-foreground">
        These are saved input allocations, not actual all-in spend, fees,
        available balance or P&amp;L. An unverified allocation may already have
        been submitted or settled. Missing records do not prove no attempt.
        Counts describe this sampled snapshot.
      </p>
    </section>
  );
}
