import styles from './warmup-transaction-progress.module.css';
const stages = [
  ['prepare', 'Prepare & simulate'],
  ['review', 'Review eligibility'],
  ['sign', 'Approve & sign'],
  ['submit', 'Submit once'],
  ['receipt', 'Verify receipt'],
] as const;
export type WarmupTransactionStage = (typeof stages)[number][0] | 'complete';
export function warmupApprovalStateLabel(state: string) {
  const labels: Record<string, string> = {
    awaiting_signature: 'Waiting for signature',
    signed: 'Signed, not sent',
    submitted: 'Submitted, awaiting finalization',
    recovery_required: 'Outcome unknown; recover the original signature',
    finalized: 'Finalized receipt verified',
    cancelled: 'Cancelled',
    failed: 'Finalized execution failed',
  };
  return labels[state] ?? 'Not yet reviewed';
}
export function WarmupTransactionProgress({
  stage,
}: {
  stage: WarmupTransactionStage;
}) {
  const current =
    stage === 'complete'
      ? stages.length
      : stages.findIndex(([id]) => id === stage);
  return (
    <ol className={styles.steps} aria-label="Warmup transaction steps">
      {stages.map(([id, label], index) => (
        <li
          key={id}
          aria-current={index === current ? 'step' : undefined}
          data-state={
            index < current ? 'done' : index === current ? 'current' : 'next'
          }
        >
          <span>
            {index + 1}. {label}
          </span>
          <small>
            {index < current
              ? 'Done'
              : index === current
                ? 'Current step'
                : 'Next'}
          </small>
        </li>
      ))}
    </ol>
  );
}
