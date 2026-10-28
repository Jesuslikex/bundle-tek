import { expect, it } from 'vitest';
import { marketplaceSellerWallet } from './marketplace-seller-wallet';
it('reads a valid payout address and rejects junk', () => {
  expect(
    marketplaceSellerWallet({
      MARKETPLACE_SELLER_WALLET: 'So11111111111111111111111111111111111111112',
    }),
  ).toBe('So11111111111111111111111111111111111111112');
  expect(marketplaceSellerWallet({ MARKETPLACE_SELLER_WALLET: 'nope' })).toBeNull();
  expect(marketplaceSellerWallet({})).toBeNull();
});