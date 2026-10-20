import { z } from 'zod';
import {
  admitBundleCatalog,
  bundleCatalogEntry,
  type BundleCatalog,
} from './marketplace-publication';
import {
  operatorDraftCanonical as canonical,
  operatorDraftId,
} from './marketplace-operator-draft-view';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const CART_MAX_WALLETS = 200;
export const cartRequest = z
  .object({
    chain: z.literal('Solana'),
    items: z
      .array(z.object({ id: operatorDraftId, entrySha256: sha }).strict())
      .min(1)
      .max(CART_MAX_WALLETS),
  })
  .strict()
  .refine(
    (v) =>
      v.items.every(
        (x, i) => i === 0 || v.items[i - 1].id.localeCompare(x.id) < 0,
      ),
    'Select distinct listings in canonical order.',
  );
export type CartRequest = z.infer<typeof cartRequest>;
export const cartReview = z
  .object({
    format: z.literal('bundle-cart-review-v1'),
    chain: z.literal('Solana'),
    seller: z.literal('Bundle'),
    selectionSha256: sha,
    contextSha256: sha,
    reviewedAt: z.iso.datetime(),
    catalogObservedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    count: z.number().int().min(1).max(CART_MAX_WALLETS),
    items: z.array(bundleCatalogEntry).min(1).max(CART_MAX_WALLETS),
    askingPriceLamports: z
      .string()
      .regex(/^[1-9]\d{0,19}$/)
      .refine((v) => BigInt(v) <= (1n << 64n) - 1n),
    networkFeeLamports: z.null(),
    reserved: z.literal(false),
    purchaseEnabled: z.literal(false),
    paymentEnabled: z.literal(false),
    deliveryEnabled: z.literal(false),
    signingAllowed: z.literal(false),
  })
  .strict();
export type CartReview = z.infer<typeof cartReview>;
export class MarketplaceCartError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
function entries(catalog: BundleCatalog, ids: string[]) {
  if (
    ids.length < 1 ||
    ids.length > CART_MAX_WALLETS ||
    new Set(ids).size !== ids.length
  )
    throw new MarketplaceCartError(
      'Choose between 1 and 200 distinct wallets.',
      400,
    );
  const map = new Map(catalog.listings.map((x) => [x.id, x]));
  return [...ids]
    .sort((a, b) => a.localeCompare(b))
    .map((id) => {
      const entry = map.get(id);
      if (!entry)
        throw new MarketplaceCartError(
          'A selected listing is unavailable. Refresh Bundle inventory and review again.',
        );
      return entry;
    });
}
export async function buildCartRequest(
  catalog: BundleCatalog,
  ids: string[],
  now = Date.now(),
): Promise<CartRequest> {
  const current = admitBundleCatalog(catalog, now),
    selected = entries(current, ids);
  const items = await Promise.all(
    selected.map(async (e) => ({
      id: e.id,
      entrySha256: await digest(canonical(e)),
    })),
  );
  return cartRequest.parse({ chain: 'Solana', items });
}
async function checkedEntries(catalog: BundleCatalog, input: CartRequest) {
  const selected = entries(
    catalog,
    input.items.map((x) => x.id),
  );
  const actual = await Promise.all(selected.map((e) => digest(canonical(e))));
  if (actual.some((hash, i) => hash !== input.items[i].entrySha256))
    throw new MarketplaceCartError(
      'Selected listing details changed. Refresh Bundle inventory and review again.',
    );
  return selected;
}
async function manifest(
  items: z.infer<typeof bundleCatalogEntry>[],
  input: CartRequest,
  reviewedAt: string,
  catalogObservedAt: string,
  expiresAt: string,
): Promise<CartReview> {
  const total = items.reduce(
    (sum, e) => sum + BigInt(e.listing.priceLamports),
    0n,
  );
  if (total > (1n << 64n) - 1n)
    throw new MarketplaceCartError(
      'The total asking price exceeds the supported SOL amount. Choose fewer wallets.',
    );
  const base = {
    format: 'bundle-cart-review-v1',
    chain: 'Solana',
    seller: 'Bundle',
    selectionSha256: await digest(canonical(input)),
    reviewedAt,
    catalogObservedAt,
    expiresAt,
    count: items.length,
    items,
    askingPriceLamports: total.toString(),
    networkFeeLamports: null,
    reserved: false,
    purchaseEnabled: false,
    paymentEnabled: false,
    deliveryEnabled: false,
    signingAllowed: false,
  };
  return cartReview.parse({
    ...base,
    contextSha256: await digest(canonical(base)),
  });
}
export async function reviewMarketplaceCart(
  input: unknown,
  catalog: BundleCatalog,
  now = Date.now(),
): Promise<CartReview> {
  const request = cartRequest.parse(input),
    current = admitBundleCatalog(catalog, now);
  return manifest(
    await checkedEntries(current, request),
    request,
    new Date(now).toISOString(),
    current.observedAt,
    current.expiresAt,
  );
}
/** Content verification only. A cart review is not a reservation, checkout token or financial approval. */
export async function admitMarketplaceCart(
  value: unknown,
  catalog: BundleCatalog,
  input: CartRequest,
  now = Date.now(),
): Promise<CartReview> {
  const actual = cartReview.parse(value),
    request = cartRequest.parse(input),
    at = Date.parse(actual.reviewedAt),
    source = Date.parse(actual.catalogObservedAt),
    expires = Date.parse(actual.expiresAt);
  if (
    !Number.isSafeInteger(now) ||
    source > at ||
    at > now ||
    expires - source !== 60000 ||
    expires <= now ||
    at >= expires
  )
    throw new MarketplaceCartError(
      'Cart review expired or differs. Request a fresh review.',
    );
  const current = admitBundleCatalog(catalog, now),
    selected = await checkedEntries(current, request);
  if (source < Date.parse(current.observedAt))
    throw new MarketplaceCartError(
      'The cart catalog read is older than the selected snapshot. Refresh and review again.',
    );
  const expected = await manifest(
    selected,
    request,
    actual.reviewedAt,
    actual.catalogObservedAt,
    actual.expiresAt,
  );
  if (canonical(actual) !== canonical(expected))
    throw new MarketplaceCartError(
      'Cart review differs from the exact selected listings or asking prices.',
    );
  return expected;
}
export function selectedAskingPrice(catalog: BundleCatalog, ids: string[]) {
  const total = entries(catalog, ids).reduce(
    (sum, e) => sum + BigInt(e.listing.priceLamports),
    0n,
  );
  if (total > (1n << 64n) - 1n)
    throw new MarketplaceCartError(
      'Choose fewer wallets; the asking-price total exceeds the supported SOL amount.',
    );
  return total.toString();
}
