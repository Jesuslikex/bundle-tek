'use client';
import type { SwapInstructionReview as Review } from '@/lib/swap-instruction-review';
export function SwapInstructionReview({
  review,
  lookupObservation,
}: {
  review?: Review;
  lookupObservation?: {
    slot: number;
    recheckSlot: number;
    tables: { address: string; sha256: string; lastExtendedSlot: string }[];
  } | null;
}) {
  if (!review)
    return <p>Instruction breakdown unavailable for this preparation.</p>;
  return (
    <section aria-label="Unsigned swap instruction review">
      <h6>Instruction review</h6>
      <p>
        {review.instructions.length} top-level instructions ·{' '}
        {review.unrecognizedInstructionCount} unrecognized ·{' '}
        {review.unresolvedAccountCount} unresolved lookup accounts ·{' '}
        {review.authorityActionCount} authority actions.
      </p>
      <p>{review.limitations}</p>
      {lookupObservation && (
        <details>
          <summary>Address-table observations</summary>
          <p>
            Read slot {lookupObservation.slot} · rechecked slot{' '}
            {lookupObservation.recheckSlot}.
          </p>
          {lookupObservation.tables.map((table) => (
            <p className="warmup-address" key={table.address}>
              Table: {table.address}
              <br />
              Data fingerprint: {table.sha256}
              <br />
              Last extension slot: {table.lastExtendedSlot}
            </p>
          ))}
        </details>
      )}
      <details>
        <summary>Review transaction instructions</summary>
        {review.instructions.map((instruction) => (
          <article key={instruction.index}>
            <strong>
              Instruction {instruction.index + 1}: {instruction.action}
            </strong>
            <p className="warmup-address">
              Program:{' '}
              {instruction.program.address ||
                `Unresolved lookup: ${instruction.program.lookup}`}
              {instruction.program.address && instruction.program.lookup && (
                <>
                  <br />
                  Lookup: {instruction.program.lookup}
                </>
              )}
            </p>
            {instruction.amountRaw !== null && (
              <p>
                Raw amount: {instruction.amountRaw}
                {instruction.action === 'Native SOL transfer'
                  ? ' lamports'
                  : ' token units'}
                {instruction.decimals !== null
                  ? ` · instruction decimals: ${instruction.decimals}`
                  : ''}
              </p>
            )}
            {instruction.authorityType !== null && (
              <p>
                {
                  [
                    'Minting authority',
                    'Freezing authority',
                    'Account owner',
                    'Close-account authority',
                  ][instruction.authorityType]
                }{' '}
                · new authority: {instruction.newAuthority ?? 'removed'}
              </p>
            )}
            <ol>
              {instruction.accounts.map((account, index) => (
                <li className="warmup-address" key={index}>
                  {account.role} (account {account.index}):{' '}
                  {account.address || `Unresolved lookup: ${account.lookup}`} ·{' '}
                  {account.signer ? 'signer' : 'not a signer'} ·{' '}
                  {account.writable ? 'writable' : 'read-only'}
                  {account.address && account.lookup && (
                    <> · lookup: {account.lookup}</>
                  )}
                </li>
              ))}
            </ol>
            <details>
              <summary>
                Instruction data ({instruction.dataBytes} bytes)
              </summary>
              <code className="warmup-address">
                {instruction.dataHex || '(empty)'}
              </code>
            </details>
          </article>
        ))}
      </details>
    </section>
  );
}
