import { marketplaceOwnedFixture } from './marketplace-owned-fixture';
import { buildMarketplaceOwnedInventory } from '@/lib/marketplace-owned-inventory';
import { reviewOperatorListing } from '@/lib/marketplace-operator-review';
import {
  operatorDraftRequest,
  operatorDraftCanonical,
  type OperatorDraftRecord,
} from '@/lib/marketplace-operator-draft-view';
import { walletWarmupSessionDigest } from '@/lib/wallet-warmup-session-digest';
import {
  reviewPublication,
  PUBLICATION_ACK,
  type PublicationRecord,
  type BundleCatalog,
  type PublicationRequest,
} from '@/lib/marketplace-publication';
export async function marketplacePublicationFixture(now = Date.now()) {
  const source = marketplaceOwnedFixture(now),
    inventory = buildMarketplaceOwnedInventory(source.sources, now),
    review = await reviewOperatorListing(
      inventory,
      {
        address: inventory.wallets[0].address,
        walletRevision: 2,
        priceLamports: '50000000',
      },
      now,
    ),
    input = operatorDraftRequest(crypto.randomUUID(), review, true);
  const draft: OperatorDraftRecord = {
    format: 'bundle-operator-draft-v1',
    id: input.id,
    createdAt: new Date(now).toISOString(),
    sourceObservedAt: new Date(now).toISOString(),
    acknowledgement: input.acknowledgement,
    review,
    reviewSha256: await walletWarmupSessionDigest(
      operatorDraftCanonical(review),
    ),
    publicationAllowed: false,
    paymentAllowed: false,
    deliveryAllowed: false,
    signingAllowed: false,
  };
  const preview = await reviewPublication(draft, inventory, now);
  const request: PublicationRequest = {
    id: crypto.randomUUID(),
    draftId: draft.id,
    reviewedAt: preview.reviewedAt,
    contextSha256: preview.contextSha256,
    acknowledgement: PUBLICATION_ACK,
  };
  const record: PublicationRecord = {
    format: 'bundle-publication-v1',
    id: request.id,
    publishedAt: new Date(now).toISOString(),
    preview,
    acknowledgement: PUBLICATION_ACK,
    withdrawnAt: null,
  };
  const catalog: BundleCatalog = {
    format: 'bundle-catalog-v1',
    seller: 'Bundle',
    observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
    purchaseEnabled: false,
    deliveryEnabled: false,
    signingAllowed: false,
    listings: [
      {
        id: record.id,
        publishedAt: record.publishedAt,
        listing: preview.listing,
      },
    ],
  };
  return { source, inventory, draft, preview, request, record, catalog };
}
