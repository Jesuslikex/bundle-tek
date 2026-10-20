import { marketplaceOwnedFixture } from './marketplace-owned-fixture';
import { ownershipMessage } from '@/lib/wallet-ownership-message';
import { buildMarketplaceOwnedInventory } from '@/lib/marketplace-owned-inventory';
/** Public synthetic server-record metadata. This is not an ownership signature or current custody proof. */
export function marketplaceControlFixture(now = Date.now()) {
  const source = marketplaceOwnedFixture(now),
    site = 'https://bundle.test';
  const id = '11111111-1111-4111-8111-111111111111',
    verifiedAt = new Date(now - 15000).toISOString(),
    issuedAt = new Date(now - 60000).toISOString(),
    expiresAt = new Date(now + 240000).toISOString();
  source.sources.proofs = [{ address: source.a, verifiedAt }];
  const inventory = buildMarketplaceOwnedInventory(source.sources, now),
    selection = {
      address: source.a,
      walletRevision: 2,
      priceLamports: '50000000',
    };
  const row = {
    address: source.a,
    revision: 2,
    walletUpdatedAt: inventory.wallets[0].updatedAt,
    proofVerifiedAt: verifiedAt as string | null,
    proofChallengeId: id as string | null,
    challengeId: id as string | null,
    message: ownershipMessage(
      site,
      'Solana',
      source.a,
      id,
      issuedAt,
      expiresAt,
    ) as string | null,
    challengeExpiresAt: expiresAt as string | null,
    usedAt: verifiedAt as string | null,
    claimId: '22222222-2222-4222-8222-222222222222' as string | null,
  };
  return {
    source,
    site,
    id,
    verifiedAt,
    issuedAt,
    expiresAt,
    inventory,
    selection,
    row,
  };
}
