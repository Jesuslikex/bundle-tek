import { z } from 'zod';
import {
  marketplaceOwnedInventoryResult,
  admitMarketplaceOwnedInventory,
  type MarketplaceOwnedInventory,
} from './marketplace-owned-inventory';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
const price = z
  .string()
  .regex(/^[1-9]\d{0,19}$/)
  .refine((v) => BigInt(v) <= (1n << 64n) - 1n);
export const MARKETPLACE_OPERATOR_DISCLOSURE =
  'Bundle is the only seller. Historical control proofs do not prove exclusive custody; the seller may retain a copy of the key. Recorded activity does not establish wallet creation, first funding or organic trading.';
export const operatorListingSelection = z
  .object({
    address: z.string().min(32).max(44),
    walletRevision: z.number().int().min(1).max(1e9),
    priceLamports: price,
  })
  .strict();
export const operatorListingReview = z
  .object({
    format: z.literal('bundle-operator-listing-review-v1'),
    sellerModel: z.literal('bundle-operated'),
    reviewedAt: z.iso.datetime(),
    reviewExpiresAt: z.iso.datetime(),
    requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    selection: operatorListingSelection,
    evidence: marketplaceOwnedInventoryResult.shape.wallets.element,
    disclosure: z.literal(MARKETPLACE_OPERATOR_DISCLOSURE),
    listingAllowed: z.literal(false),
    paymentAllowed: z.literal(false),
    deliveryAllowed: z.literal(false),
    signingAllowed: z.literal(false),
  })
  .strict();
export type OperatorListingReview = z.infer<typeof operatorListingReview>;
function canonical(value: unknown) {
  return JSON.stringify(value, (_k, node: unknown) =>
    node && typeof node === 'object' && !Array.isArray(node)
      ? Object.fromEntries(
          Object.entries(node).sort(([a], [b]) => a.localeCompare(b)),
        )
      : node,
  );
}
export async function reviewOperatorListing(
  inventory: MarketplaceOwnedInventory,
  input: unknown,
  now = Date.now(),
  reviewedAt = now,
): Promise<OperatorListingReview> {
  if (
    !Number.isSafeInteger(reviewedAt) ||
    reviewedAt > now ||
    now - reviewedAt >= 60000
  )
    throw Error('Listing review expired. Request a fresh review.');
  const current = admitMarketplaceOwnedInventory(inventory, now),
    selection = operatorListingSelection.parse(input),
    captured = current.wallets.find(
      (w) =>
        w.address === selection.address &&
        w.revision === selection.walletRevision,
    );
  if (!captured)
    throw Error('Choose an active owned wallet at its current revision.');
  const evidence = {
    ...captured,
    observedActivityAgeSeconds:
      captured.oldestRecordedActivityAt === null
        ? null
        : Math.floor(
            (reviewedAt - Date.parse(captured.oldestRecordedActivityAt)) / 1000,
          ),
  };
  const requestSha256 = await digest(canonical(selection)),
    evidenceSha256 = await digest(canonical(evidence));
  return operatorListingReview.parse({
    format: 'bundle-operator-listing-review-v1',
    sellerModel: 'bundle-operated',
    reviewedAt: new Date(reviewedAt).toISOString(),
    reviewExpiresAt: new Date(reviewedAt + 60000).toISOString(),
    requestSha256,
    evidenceSha256,
    selection,
    evidence,
    disclosure: MARKETPLACE_OPERATOR_DISCLOSURE,
    listingAllowed: false,
    paymentAllowed: false,
    deliveryAllowed: false,
    signingAllowed: false,
  });
}
export async function admitOperatorListingReview(
  value: unknown,
  inventory: MarketplaceOwnedInventory,
  input: unknown,
  now = Date.now(),
): Promise<OperatorListingReview> {
  const actual = operatorListingReview.parse(value),
    at = Date.parse(actual.reviewedAt),
    expires = Date.parse(actual.reviewExpiresAt);
  if (
    !Number.isSafeInteger(now) ||
    expires - at !== 60000 ||
    expires <= now ||
    at > now
  )
    throw Error(
      'Listing review expired or differs. Refresh inventory and review again.',
    );
  const expected = await reviewOperatorListing(inventory, input, at);
  if (canonical(actual) !== canonical(expected))
    throw Error(
      'Listing review differs from the selected wallet, evidence or price.',
    );
  return expected;
}
