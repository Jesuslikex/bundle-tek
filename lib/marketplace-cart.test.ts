import { expect, it } from 'vitest';
import bs58 from 'bs58';
import { marketplacePublicationFixture } from '../test/marketplace-publication-fixture';
import {
  buildCartRequest,
  reviewMarketplaceCart,
  admitMarketplaceCart,
  selectedAskingPrice,
  cartRequest,
} from './marketplace-cart';
const now = Date.parse('2026-10-20T12:00:00Z');
async function fixture() {
  const f = await marketplacePublicationFixture(now);
  const second = {
    ...f.catalog.listings[0],
    id: crypto.randomUUID(),
    listing: {
      ...f.catalog.listings[0].listing,
      address: f.source.b,
      priceLamports: '25000001',
    },
  };
  f.catalog.listings.push(second);
  return f;
}
it('binds exact listings, asking prices, explicit Solana units and false financial authority without netting historical balances', async () => {
  const f = await fixture(),
    ids = f.catalog.listings.map((x) => x.id),
    request = await buildCartRequest(f.catalog, [...ids].reverse(), now),
    review = await reviewMarketplaceCart(request, f.catalog, now);
  expect(review.askingPriceLamports).toBe('75000001');
  expect(selectedAskingPrice(f.catalog, ids)).toBe('75000001');
  expect(review).toMatchObject({
    chain: 'Solana',
    seller: 'Bundle',
    count: 2,
    networkFeeLamports: null,
    reserved: false,
    purchaseEnabled: false,
    paymentEnabled: false,
    deliveryEnabled: false,
    signingAllowed: false,
  });
  expect(request.items.map((x) => x.id)).toEqual(
    [...ids].sort((a, b) => a.localeCompare(b)),
  );
  expect(await admitMarketplaceCart(review, f.catalog, request, now)).toEqual(
    review,
  );
});
it.each(['missing', 'price', 'evidence', 'published-time'] as const)(
  'refuses a changed current catalog: %s',
  async (kind) => {
    const f = await fixture(),
      request = await buildCartRequest(
        f.catalog,
        f.catalog.listings.map((x) => x.id),
        now,
      ),
      current = structuredClone(f.catalog);
    if (kind === 'missing') current.listings.pop();
    if (kind === 'price') current.listings[0].listing.priceLamports = '1';
    if (kind === 'evidence') current.listings[0].listing.savedHistoryChecks++;
    if (kind === 'published-time')
      current.listings[0].publishedAt = new Date(now - 1).toISOString();
    await expect(reviewMarketplaceCart(request, current, now)).rejects.toThrow(
      /changed|unavailable/,
    );
  },
);
it.each([
  'price',
  'count',
  'entry',
  'fee',
  'reserved',
  'payment',
  'hash',
  'chain',
  'time',
  'extra',
] as const)('refuses an altered review: %s', async (kind) => {
  const f = await fixture(),
    input = await buildCartRequest(
      f.catalog,
      f.catalog.listings.map((x) => x.id),
      now,
    ),
    review = await reviewMarketplaceCart(input, f.catalog, now);
  if (kind === 'price') review.askingPriceLamports = '1';
  if (kind === 'count') review.count = 1;
  if (kind === 'entry') review.items[0].listing.savedHistoryChecks++;
  if (kind === 'fee') Object.assign(review, { networkFeeLamports: '0' });
  if (kind === 'reserved') Object.assign(review, { reserved: true });
  if (kind === 'payment') Object.assign(review, { paymentEnabled: true });
  if (kind === 'hash') review.contextSha256 = '0'.repeat(64);
  if (kind === 'chain') Object.assign(review, { chain: 'Ethereum' });
  if (kind === 'time') review.expiresAt = new Date(now + 61000).toISOString();
  if (kind === 'extra') Object.assign(review, { authorization: 'forbidden' });
  await expect(
    admitMarketplaceCart(review, f.catalog, input, now),
  ).rejects.toThrow();
});
it('rejects empty, duplicate, unknown, wrong-chain and oversized selections, but supports exactly 200', async () => {
  const f = await fixture();
  for (const ids of [
    [],
    [f.catalog.listings[0].id, f.catalog.listings[0].id],
    [crypto.randomUUID()],
  ])
    await expect(buildCartRequest(f.catalog, ids, now)).rejects.toThrow();
  const request = await buildCartRequest(
    f.catalog,
    [f.catalog.listings[0].id],
    now,
  );
  expect(() => cartRequest.parse({ ...request, chain: 'EVM' })).toThrow();
  expect(() => cartRequest.parse({ ...request, ownerId: 'other' })).toThrow();
  for (let i = 3; i <= 201; i++)
    f.catalog.listings.push({
      ...f.catalog.listings[0],
      id: crypto.randomUUID(),
      listing: {
        ...f.catalog.listings[0].listing,
        address: bs58.encode(new Uint8Array(32).fill(i)),
      },
    });
  expect(
    (
      await buildCartRequest(
        f.catalog,
        f.catalog.listings.slice(0, 200).map((x) => x.id),
        now,
      )
    ).items,
  ).toHaveLength(200);
  await expect(
    buildCartRequest(
      f.catalog,
      f.catalog.listings.map((x) => x.id),
      now,
    ),
  ).rejects.toThrow();
});
it('refuses total overflow instead of rounding or subtracting retained balances', async () => {
  const f = await fixture();
  for (const e of f.catalog.listings)
    e.listing.priceLamports = '18446744073709551615';
  const input = await buildCartRequest(
    f.catalog,
    f.catalog.listings.map((x) => x.id),
    now,
  );
  await expect(reviewMarketplaceCart(input, f.catalog, now)).rejects.toThrow(
    'exceeds',
  );
  expect(() =>
    selectedAskingPrice(
      f.catalog,
      f.catalog.listings.map((x) => x.id),
    ),
  ).toThrow('exceeds');
});
it('accepts a newer server catalog read, but refuses expiry and a read older than the selected snapshot', async () => {
  const f = await fixture(),
    input = await buildCartRequest(
      f.catalog,
      f.catalog.listings.map((x) => x.id),
      now,
    ),
    newer = {
      ...f.catalog,
      observedAt: new Date(now + 1000).toISOString(),
      expiresAt: new Date(now + 61000).toISOString(),
    },
    review = await reviewMarketplaceCart(input, newer, now + 1000);
  expect(
    await admitMarketplaceCart(review, f.catalog, input, now + 1001),
  ).toEqual(review);
  await expect(
    admitMarketplaceCart(review, f.catalog, input, now + 61000),
  ).rejects.toThrow();
  const old = await reviewMarketplaceCart(input, f.catalog, now);
  await expect(
    admitMarketplaceCart(old, newer, input, now + 1001),
  ).rejects.toThrow('older');
});
