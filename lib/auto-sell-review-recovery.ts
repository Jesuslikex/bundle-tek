import { z } from 'zod';
import { importedApprovalPage } from './imported-approval-history';
const id = z
  .string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const schema = z
  .object({
    projectId: id,
    projectRevision: z.number().int().positive(),
    walletRevision: z.number().int().positive(),
    preparationId: id,
    wallet: address,
    mint: address,
    inputRaw: z
      .string()
      .regex(/^[1-9]\d{0,19}$/)
      .refine((v) => BigInt(v) <= (1n << 64n) - 1n),
    preparationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type AutoSellReviewReference = Readonly<z.infer<typeof schema>>;
export function validatedAutoSellReviewReference(
  value: unknown,
): AutoSellReviewReference {
  return Object.freeze(schema.parse(value));
}
/** No signature exists locally. This is lookup metadata, never permission to retry or release a reservation. */
export class AutoSellReviewRecoveryError extends Error {
  readonly reference: AutoSellReviewReference;
  constructor(
    reference: AutoSellReviewReference,
    readonly conflict = false,
  ) {
    super(
      'Auto Sell stopped because the approval review could not be confirmed. Read the original saved approval before starting again. This attempt did not register or submit a signed transaction.',
    );
    this.reference = validatedAutoSellReviewReference(reference);
  }
}
export function savedAutoSellReview(
  value: unknown,
  reference: AutoSellReviewReference,
) {
  const ref = validatedAutoSellReviewReference(reference);
  const page = importedApprovalPage(value, ref.projectId);
  if (page.nextCursor !== null || page.intents.length > 1)
    throw Error('Saved review context differs.');
  const row = page.intents[0];
  if (!row) return null;
  if (
    row.preparationId !== ref.preparationId ||
    row.projectRevision !== ref.projectRevision ||
    row.walletRevision !== ref.walletRevision ||
    row.wallet !== ref.wallet ||
    row.side !== 'Sell' ||
    row.document.inputMint !== ref.mint ||
    row.document.outputMint !== 'So11111111111111111111111111111111111111112' ||
    row.document.inputRaw !== ref.inputRaw ||
    row.document.sha256 !== ref.preparationSha256 ||
    typeof row.updatedAt !== 'string' ||
    row.updatedAt.length > 64 ||
    !Number.isFinite(Date.parse(row.updatedAt))
  )
    throw Error('Saved review context differs.');
  return Object.freeze({
    intentId: row.id,
    preparationId: row.preparationId,
    state: row.state,
    signature: row.signature,
    updatedAt: row.updatedAt,
    finalityVerified: false as const,
    signingAllowed: false as const,
    submissionAllowed: false as const,
  });
}
