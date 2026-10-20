import { z } from 'zod';
import {
  operatorDraftId,
  admitOperatorDraft,
  operatorDraftCanonical as canonical,
  type OperatorDraftRecord,
} from './marketplace-operator-draft-view';
import {
  operatorListingSelection,
  MARKETPLACE_OPERATOR_DISCLOSURE,
} from './marketplace-operator-review';
import {
  admitMarketplaceOwnedInventory,
  marketplaceOwnedInventoryResult,
  type MarketplaceOwnedInventory,
} from './marketplace-owned-inventory';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
const timestamp = z.iso.datetime(),
  sha = z.string().regex(/^[a-f0-9]{64}$/);
export const PUBLICATION_ACK =
  'Publish this wallet address, asking price and historical evidence to signed-in Bundle customers. This does not authorize purchase, payment, signing or key delivery.';
export const WITHDRAWAL_ACK =
  'Withdraw this exact listing from the Bundle catalog. This does not delete its publication history.';
export const publicWalletListing = z
  .object({
    address:
      marketplaceOwnedInventoryResult.shape.wallets.element.shape.address,
    priceLamports: operatorListingSelection.shape.priceLamports,
    oldestRecordedActivityAt: timestamp.nullable(),
    historicalBalance: z
      .object({
        observedAt: timestamp,
        balanceLamports: z.string().regex(/^(0|[1-9]\d{0,19})$/),
        sampleCount: z.number().int().min(0).max(50),
        successfulSampleCount: z.number().int().min(0).max(50),
      })
      .strict()
      .nullable(),
    savedHistoryChecks: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    warmupUniqueSignatures: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER),
    disclosure: z.literal(MARKETPLACE_OPERATOR_DISCLOSURE),
  })
  .strict();
export const publicationPreview = z
  .object({
    format: z.literal('bundle-publication-review-v1'),
    draftId: operatorDraftId,
    draftSha256: sha,
    reviewedAt: timestamp,
    expiresAt: timestamp,
    listing: publicWalletListing,
    purchaseEnabled: z.literal(false),
    deliveryEnabled: z.literal(false),
    signingAllowed: z.literal(false),
    contextSha256: sha,
  })
  .strict();
export type PublicationPreview = z.infer<typeof publicationPreview>;
export const publicationRequest = z
  .object({
    id: operatorDraftId,
    draftId: operatorDraftId,
    reviewedAt: timestamp,
    contextSha256: sha,
    acknowledgement: z.literal(PUBLICATION_ACK),
  })
  .strict();
export type PublicationRequest = z.infer<typeof publicationRequest>;
export const publicationRecord = z
  .object({
    format: z.literal('bundle-publication-v1'),
    id: operatorDraftId,
    publishedAt: timestamp,
    preview: publicationPreview,
    acknowledgement: z.literal(PUBLICATION_ACK),
    withdrawnAt: timestamp.nullable(),
  })
  .strict();
export type PublicationRecord = z.infer<typeof publicationRecord>;
export const withdrawalRequest = z
  .object({
    id: operatorDraftId,
    contextSha256: sha,
    acknowledgement: z.literal(WITHDRAWAL_ACK),
  })
  .strict();
export function publicListingFromDraft(draft: OperatorDraftRecord) {
  const e = draft.review.evidence;
  if (e.ownershipProofAt === null)
    throw Error(
      'A retained wallet control proof is required before publication.',
    );
  return publicWalletListing.parse({
    address: draft.review.selection.address,
    priceLamports: draft.review.selection.priceLamports,
    oldestRecordedActivityAt: e.oldestRecordedActivityAt,
    historicalBalance: e.latestHistory
      ? {
          observedAt: e.latestHistory.observedAt,
          balanceLamports: e.latestHistory.balanceLamports,
          sampleCount: e.latestHistory.sampleCount,
          successfulSampleCount: e.latestHistory.successfulSampleCount,
        }
      : null,
    savedHistoryChecks: e.savedHistoryChecks,
    warmupUniqueSignatures: e.warmupUniqueSignatures,
    disclosure: draft.review.disclosure,
  });
}
/** Reconstruct the public subset from an already admitted draft, without renewing its evidence timestamps. */
async function manifest(
  draft: OperatorDraftRecord,
  at: number,
): Promise<PublicationPreview> {
  const base = {
    format: 'bundle-publication-review-v1' as const,
    draftId: draft.id,
    draftSha256: draft.reviewSha256,
    reviewedAt: new Date(at).toISOString(),
    expiresAt: new Date(at + 60000).toISOString(),
    listing: publicListingFromDraft(draft),
    purchaseEnabled: false,
    deliveryEnabled: false,
    signingAllowed: false,
  };
  return publicationPreview.parse({
    ...base,
    contextSha256: await digest(canonical(base)),
  });
}
export async function reviewPublication(
  draft: OperatorDraftRecord,
  inventory: MarketplaceOwnedInventory,
  now = Date.now(),
  reviewedAt = now,
) {
  await admitOperatorDraft(draft, undefined, now);
  if (
    !Number.isSafeInteger(reviewedAt) ||
    reviewedAt < Date.parse(draft.createdAt) ||
    reviewedAt > now ||
    now - reviewedAt >= 60000
  )
    throw Error('Publication review expired or differs.');
  const current = admitMarketplaceOwnedInventory(inventory, now).wallets.find(
    (w) =>
      w.address === draft.review.selection.address &&
      w.revision === draft.review.selection.walletRevision,
  );
  if (
    !current ||
    now - Date.parse(inventory.observedAt) >= 60000 ||
    Date.parse(inventory.observedAt) > now
  )
    throw Error('Owned wallet or inventory changed.');
  const { observedActivityAgeSeconds: _old, ...old } = draft.review.evidence;
  const { observedActivityAgeSeconds: _current, ...latest } = current;
  if (canonical(old) !== canonical(latest))
    throw Error(
      'Wallet evidence changed. Save a fresh listing draft before publication.',
    );
  return manifest(draft, reviewedAt);
}
export async function admitPublicationPreview(
  value: unknown,
  draft: OperatorDraftRecord,
  now = Date.now(),
) {
  const actual = publicationPreview.parse(value),
    at = Date.parse(actual.reviewedAt);
  await admitOperatorDraft(draft, undefined, now);
  if (
    at < Date.parse(draft.createdAt) ||
    at > now ||
    now - at >= 60000 ||
    canonical(actual) !== canonical(await manifest(draft, at))
  )
    throw Error('Publication preview differs or expired.');
  return actual;
}
export async function admitPublicationRecord(
  value: unknown,
  draft: OperatorDraftRecord,
  expected?: PublicationRequest,
  now = Date.now(),
) {
  const record = publicationRecord.parse(value),
    at = Date.parse(record.preview.reviewedAt),
    published = Date.parse(record.publishedAt),
    withdrawn =
      record.withdrawnAt === null ? null : Date.parse(record.withdrawnAt);
  await admitOperatorDraft(draft, undefined, now);
  if (
    !Number.isSafeInteger(now) ||
    at < Date.parse(draft.createdAt) ||
    published < at ||
    published >= at + 60000 ||
    published > now ||
    (withdrawn !== null && (withdrawn < published || withdrawn > now)) ||
    canonical(record.preview) !== canonical(await manifest(draft, at))
  )
    throw Error('Publication record differs.');
  if (
    expected &&
    (record.id !== expected.id ||
      record.preview.draftId !== expected.draftId ||
      record.preview.reviewedAt !== expected.reviewedAt ||
      record.preview.contextSha256 !== expected.contextSha256 ||
      record.acknowledgement !== expected.acknowledgement)
  )
    throw Error('Publication does not match this exact approval.');
  return record;
}
export const bundleCatalogEntry = z
  .object({
    id: operatorDraftId,
    publishedAt: timestamp,
    listing: publicWalletListing,
  })
  .strict();
export const bundleCatalog = z
  .object({
    format: z.literal('bundle-catalog-v1'),
    seller: z.literal('Bundle'),
    observedAt: timestamp,
    expiresAt: timestamp,
    purchaseEnabled: z.literal(false),
    deliveryEnabled: z.literal(false),
    signingAllowed: z.literal(false),
    listings: z.array(bundleCatalogEntry).max(500),
  })
  .strict();
export type BundleCatalog = z.infer<typeof bundleCatalog>;
export function admitBundleCatalog(value: unknown, now = Date.now()) {
  const result = bundleCatalog.parse(value),
    at = Date.parse(result.observedAt);
  if (
    !Number.isSafeInteger(now) ||
    at > now ||
    now - at >= 60000 ||
    Date.parse(result.expiresAt) !== at + 60000 ||
    new Set(result.listings.map((x) => x.id)).size !== result.listings.length ||
    new Set(result.listings.map((x) => x.listing.address)).size !==
      result.listings.length
  )
    throw Error('Bundle catalog expired or differs.');
  for (const { publishedAt, listing } of result.listings) {
    if (
      Date.parse(publishedAt) > at ||
      (listing.oldestRecordedActivityAt !== null &&
        Date.parse(listing.oldestRecordedActivityAt) > at)
    )
      throw Error('Listing chronology differs.');
    const balance = listing.historicalBalance;
    if (
      balance &&
      (Date.parse(balance.observedAt) > at ||
        BigInt(balance.balanceLamports) > (1n << 64n) - 1n ||
        balance.successfulSampleCount > balance.sampleCount)
    )
      throw Error('Historical balance differs.');
  }
  return result;
}
