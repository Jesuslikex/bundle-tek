import { z } from 'zod';
import {
  operatorListingReview,
  operatorListingSelection,
  reviewOperatorListing,
  OPERATOR_REVIEW_WINDOW_MS,
  type OperatorListingReview,
} from './marketplace-operator-review';
import { marketplaceOwnedInventoryResult } from './marketplace-owned-inventory';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';

export const OPERATOR_DRAFT_ACK =
  'Save this exact unpublished draft. This does not publish a listing, accept payment or authorize key delivery.';
export const operatorDraftId = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase());
export const operatorDraftSave = z
  .object({
    id: operatorDraftId,
    selection: operatorListingSelection,
    reviewedAt: z.iso.datetime(),
    requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    acknowledgement: z.literal(OPERATOR_DRAFT_ACK),
  })
  .strict();
export type OperatorDraftSave = z.infer<typeof operatorDraftSave>;
export function operatorDraftRequest(
  id: string,
  review: OperatorListingReview,
  acknowledged: boolean,
): OperatorDraftSave {
  if (acknowledged !== true)
    throw Error('Acknowledge saving this exact unpublished draft.');
  return operatorDraftSave.parse({
    id,
    selection: review.selection,
    reviewedAt: review.reviewedAt,
    requestSha256: review.requestSha256,
    evidenceSha256: review.evidenceSha256,
    acknowledgement: OPERATOR_DRAFT_ACK,
  });
}
export const operatorDraftRecord = z
  .object({
    format: z.literal('bundle-operator-draft-v1'),
    id: operatorDraftId,
    createdAt: z.iso.datetime(),
    sourceObservedAt: z.iso.datetime(),
    acknowledgement: z.literal(OPERATOR_DRAFT_ACK),
    review: operatorListingReview,
    reviewSha256: z.string().regex(/^[a-f0-9]{64}$/),
    publicationAllowed: z.literal(false),
    paymentAllowed: z.literal(false),
    deliveryAllowed: z.literal(false),
    signingAllowed: z.literal(false),
  })
  .strict();
export type OperatorDraftRecord = z.infer<typeof operatorDraftRecord>;
export function operatorDraftCanonical(value: unknown): string {
  return JSON.stringify(value, (_k, node: unknown) =>
    node && typeof node === 'object' && !Array.isArray(node)
      ? Object.fromEntries(
          Object.entries(node).sort(([a], [b]) => a.localeCompare(b)),
        )
      : node,
  );
}
/** Admit historical saved evidence at its original capture time, never as a fresh listing review. */
export async function admitOperatorDraft(
  value: unknown,
  expected?: OperatorDraftSave,
  now = Date.now(),
): Promise<OperatorDraftRecord> {
  const record = operatorDraftRecord.parse(value),
    review = record.review;
  const at = Date.parse(review.reviewedAt),
    observed = Date.parse(record.sourceObservedAt),
    created = Date.parse(record.createdAt);
  if (
    !Number.isSafeInteger(now) ||
    at > observed ||
    observed > created ||
    created > now ||
    created >= at + OPERATOR_REVIEW_WINDOW_MS ||
    Date.parse(review.reviewExpiresAt) !== at + OPERATOR_REVIEW_WINDOW_MS
  )
    throw Error(
      'Saved listing draft chronology differs. ' +
        `now=${now} reviewedAt=${review.reviewedAt} ` +
        `sourceObservedAt=${record.sourceObservedAt} createdAt=${record.createdAt} ` +
        `reviewExpiresAt=${review.reviewExpiresAt} window=${OPERATOR_REVIEW_WINDOW_MS}`,
    );
  // Only derived age is rebased. Historical wallet, proof and activity timestamps remain unchanged.
  const evidence = {
    ...review.evidence,
    observedActivityAgeSeconds:
      review.evidence.oldestRecordedActivityAt === null
        ? null
        : Math.floor(
            (observed - Date.parse(review.evidence.oldestRecordedActivityAt)) /
              1000,
          ),
  };
  const inventory = marketplaceOwnedInventoryResult.parse({
    format: 'bundle-owned-wallet-inventory-v1',
    chain: 'Solana',
    observedAt: record.sourceObservedAt,
    listingEnabled: false,
    purchaseEnabled: false,
    deliveryEnabled: false,
    wallets: [evidence],
  });
  const rebuilt = await reviewOperatorListing(
    inventory,
    review.selection,
    observed,
    at,
  );
  if (
    operatorDraftCanonical(rebuilt) !== operatorDraftCanonical(review) ||
    (await digest(operatorDraftCanonical(review))) !== record.reviewSha256
  )
    throw Error('Saved listing draft evidence differs.');
  if (
    expected &&
    (record.id !== expected.id ||
      operatorDraftCanonical(operatorDraftRequest(record.id, review, true)) !==
        operatorDraftCanonical(operatorDraftSave.parse(expected)))
  )
    throw Error('Saved draft does not match this exact save request.');
  return record;
}
