// The marketplace has one seller: the operator. The payout address is
// deployment configuration, not per-listing data, so it lives in the
// environment and is validated on every read rather than trusted from the
// client.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const MARKETPLACE_SELLER_WALLET_ENV = 'MARKETPLACE_SELLER_WALLET';

export function marketplaceSellerWallet(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const value = env[MARKETPLACE_SELLER_WALLET_ENV]?.trim();
  return value && BASE58.test(value) ? value : null;
}
