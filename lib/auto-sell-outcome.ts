import { importedApprovalPage } from './imported-approval-history';
import {
  validatedAutoSellOutcomeReference,
  type AutoSellOutcomeReference,
} from './auto-sell-outcome-reference';
const SOL = 'So11111111111111111111111111111111111111112';
/** Saved-state admission only. Does not query a chain, load a receipt or reconcile limits. */
export function savedAutoSellOutcome(
  value: unknown,
  reference: AutoSellOutcomeReference,
) {
  const ref = validatedAutoSellOutcomeReference(reference);
  const page = importedApprovalPage(value, ref.projectId);
  const row = page.intents[0];
  if (
    page.intents.length !== 1 ||
    page.nextCursor !== null ||
    row.id !== ref.intentId ||
    row.preparationId !== ref.preparationId ||
    row.projectRevision !== ref.projectRevision ||
    row.walletRevision !== ref.walletRevision ||
    row.wallet !== ref.wallet ||
    row.side !== 'Sell' ||
    row.document.inputMint !== ref.mint ||
    row.document.outputMint !== SOL ||
    row.document.inputRaw !== ref.inputRaw ||
    row.document.sha256 !== ref.preparationSha256 ||
    (row.signature !== null && row.signature !== ref.signature) ||
    typeof row.updatedAt !== 'string' ||
    row.updatedAt.length > 64 ||
    !Number.isFinite(Date.parse(row.updatedAt))
  )
    throw Error('Saved Auto Sell outcome context differs.');
  return Object.freeze({
    state: row.state,
    signature: row.signature,
    updatedAt: row.updatedAt,
    finalityVerified: false as const,
    signingAllowed: false as const,
    submissionAllowed: false as const,
  });
}
