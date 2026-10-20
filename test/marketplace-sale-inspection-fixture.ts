import { marketplaceOwnedFixture } from './marketplace-owned-fixture';
import { buildMarketplaceOwnedInventory } from '@/lib/marketplace-owned-inventory';
import type { SaleInspection } from '@/lib/marketplace-sale-inspection-view';
/** Public synthetic account metadata only; never a provider response or sale authorization. */
export function marketplaceSaleInspectionFixture(now = Date.now()) {
  const fixture = marketplaceOwnedFixture(now),
    inventory = buildMarketplaceOwnedInventory(fixture.sources, now);
  const selection = {
    address: fixture.a,
    walletRevision: 2,
    priceLamports: '50000000',
  };
  const inspection: SaleInspection = {
    format: 'bundle-sale-account-inspection-v1',
    chain: 'Solana',
    selection,
    startedAt: new Date(now).toISOString(),
    observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
    source: 'rpc.example',
    commitment: 'confirmed',
    floorSlot: 100,
    accountSlot: 101,
    finalSlot: 102,
    account: {
      kind: 'system-wallet',
      balanceLamports: '1000000000',
      owner: '11111111111111111111111111111111',
      executable: false,
      space: '0',
    },
    historicalControlProofAt: inventory.wallets[0].ownershipProofAt,
    historicalBalanceLamports: '1234567891',
    balanceDifferenceLamports: '-234567891',
    currentControlVerified: false,
    tokenInventoryChecked: false,
    provenanceVerified: false,
    saleQualified: false,
    paymentAllowed: false,
    deliveryAllowed: false,
    signingAllowed: false,
  };
  return { fixture, inventory, selection, inspection };
}
