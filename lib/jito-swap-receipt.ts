import type { WarmupSigningReview } from './warmup-signing';
const WRAPPED = 'So11111111111111111111111111111111111111112';
export function matchingJitoSwapReceipt(
  value: unknown,
  projectId: string,
  review: WarmupSigningReview,
  signature: string,
  slot: number,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as {
    projectId?: unknown;
    preparationId?: unknown;
    document?: unknown;
  };
  if (
    receipt.projectId !== projectId ||
    receipt.preparationId !== review.preparationId ||
    !receipt.document ||
    typeof receipt.document !== 'object' ||
    Array.isArray(receipt.document)
  )
    return false;
  const d = receipt.document as Record<string, unknown>;
  const side =
    review.inputMint === WRAPPED
      ? 'Buy'
      : review.outputMint === WRAPPED
        ? 'Sell'
        : null;
  return (
    side !== null &&
    d.side === side &&
    d.network === 'mainnet' &&
    d.commitment === 'finalized' &&
    d.signatureVerified === true &&
    d.signature === signature &&
    d.wallet === review.wallet &&
    d.preparationSha256 === review.sha256 &&
    Number.isSafeInteger(slot) &&
    slot > 0 &&
    d.slot === slot &&
    d.mint === (side === 'Buy' ? review.outputMint : review.inputMint)
  );
}
