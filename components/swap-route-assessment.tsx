'use client';
import type { JupiterRouteAssessment } from '@/lib/jupiter-route-assessment';
import type { SwapTokenAccountBindings } from '@/lib/swap-token-account-bindings';
const labels: Record<string, string> = {
  inputAmount: 'Input amount',
  quotedOutput: 'Quoted output',
  slippage: 'Slippage limit',
  minimumOutput: 'Minimum output protection',
  walletAuthority: 'Wallet authority',
  sourceWritable: 'Writable source',
  destinationWritable: 'Writable destination',
  inputMint: 'Input mint',
  outputMint: 'Output mint',
  platformFee: 'Platform fee matches the quote and limit',
  noPositiveSlippageFee: 'No positive slippage fee',
  tokenPrograms: 'Standard token programs',
  tokenDestination: 'Wallet token destination',
};
export function SwapRouteAssessment({
  assessment,
  bindings,
}: {
  assessment?: JupiterRouteAssessment;
  bindings?: SwapTokenAccountBindings;
}) {
  if (!assessment) return null;
  return (
    <section aria-label="Swap route field comparison">
      <h6>Swap route comparison</h6>
      <p>{assessment.status}</p>
      {assessment.issues.map((issue) => (
        <p key={issue}>{issue}</p>
      ))}
      {assessment.decoded && (
        <>
          <p>
            Declared input: {assessment.decoded.inAmountRaw} atomic units.
            Quoted output: {assessment.decoded.quotedOutRaw}. Minimum output
            lower bound: {assessment.decoded.minimumOutLowerBoundRaw}.
          </p>
          <p>
            Slippage: {assessment.decoded.slippageBps} bps · platform fee:{' '}
            {assessment.decoded.platformFeeBps} bps.
          </p>
          <details>
            <summary>Review compared route fields</summary>
            <ul>
              {Object.entries(assessment.checks).map(([field, value]) => (
                <li key={field}>
                  {labels[field] ?? field}:{' '}
                  {value === null
                    ? 'not encoded'
                    : value
                      ? 'matches'
                      : 'mismatch'}
                </li>
              ))}
            </ul>
            <p className="warmup-address">
              Authority: {assessment.decoded.authority}
              <br />
              Source account: {assessment.decoded.sourceAccount}
              <br />
              Destination account: {assessment.decoded.destinationAccount}
              <br />
              Input mint: {assessment.decoded.inputMint ?? 'not encoded'}
              <br />
              Output mint: {assessment.decoded.outputMint}
            </p>
            <ol>
              {assessment.decoded.steps.map((step, index) => (
                <li key={index}>
                  {step.venue} · {step.percent}% · token index {step.inputIndex}{' '}
                  to {step.outputIndex}
                </li>
              ))}
            </ol>
          </details>
        </>
      )}
      <p>{assessment.limitations}</p>
      {bindings && (
        <section aria-label="Route token account bindings">
          <h6>Token account bindings</h6>
          <p>
            {bindings.status}
            {bindings.slot === null ? '' : ` · observed slot ${bindings.slot}`}
          </p>
          <details>
            <summary>Review observed account ownership</summary>
            {bindings.accounts.map((account) => (
              <div key={account.role}>
                <p>
                  {account.role}: {account.status}. {account.reason}
                </p>
                <p className="warmup-address">
                  Account: {account.address}
                  <br />
                  Expected mint: {account.expectedMint}
                  <br />
                  Observed mint: {account.mint ?? 'unavailable'}
                  <br />
                  Wallet owner: {account.walletOwner ?? 'unavailable'}
                  <br />
                  State: {account.state ?? 'unavailable'}
                  <br />
                  Delegate:{' '}
                  {account.delegate ??
                    (account.state === null ? 'unavailable' : 'none observed')}
                  <br />
                  Delegated atomic units:{' '}
                  {account.delegatedAmountRaw ?? 'unavailable'}
                  <br />
                  Close authority:{' '}
                  {account.closeAuthority ??
                    (account.state === null ? 'unavailable' : 'none observed')}
                </p>
              </div>
            ))}
          </details>
          <p>{bindings.limitations}</p>
        </section>
      )}
    </section>
  );
}
