import bs58 from 'bs58';
import type { MarketplaceInventory } from '../lib/marketplace-catalog';
export function marketplaceFixture(now = Date.now()): MarketplaceInventory {
  return {
    format: 'bundle-wallet-catalog-v1',
    chain: 'Solana',
    provider: 'Fixture inventory',
    observedAt: new Date(now).toISOString(),
    coverage: 'partial',
    listings: [1, 2, 3].map((value, index) => ({
      id: `wallet-${value}`,
      address: bs58.encode(new Uint8Array(32).fill(value)),
      source: index === 2 ? 'Exchange' : 'Classic',
      tier: 'light-history',
      fundedAt: new Date(now - 3 * 86400000 - index * 3600000).toISOString(),
      balanceLamports: '1000000000',
      purchasePriceLamports: String(1100000000 + index),
      transactionCount: 12,
    })),
  };
}
