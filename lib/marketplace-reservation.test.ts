import { expect, it } from 'vitest';
import { marketplacePublicationFixture } from '../test/marketplace-publication-fixture';
import { buildCartRequest, reviewMarketplaceCart } from './marketplace-cart';
import {
  makeReservationRequest,
  makeReservation,
  admitReservation,
  reservationState,
  RESERVATION_MS,
} from './marketplace-reservation';
const now = Date.parse('2026-10-20T12:00:00Z');
async function fixture() {
  const { catalog } = await marketplacePublicationFixture(now);
  const review = await reviewMarketplaceCart(
    await buildCartRequest(
      catalog,
      catalog.listings.map((e) => e.id),
      now,
    ),
    catalog,
    now,
  );
  return makeReservationRequest(crypto.randomUUID(), review, true);
}
it('binds exact independent consent to a five-minute non-financial hold and retains expired history', async () => {
  const input = await fixture(),
    record = await makeReservation(input, now);
  expect(Date.parse(record.expiresAt) - now).toBe(RESERVATION_MS);
  expect(reservationState(record, null, now + RESERVATION_MS - 1)).toBe('held');
  expect(reservationState(record, null, now + RESERVATION_MS)).toBe('expired');
  expect(
    reservationState(
      record,
      new Date(now + 1).toISOString(),
      now + RESERVATION_MS,
    ),
  ).toBe('released');
  expect(await admitReservation(record, input, now + RESERVATION_MS)).toEqual(
    record,
  );
  expect(() => makeReservationRequest(input.id, input.review, false)).toThrow();
  await expect(makeReservation(input, now + 60000)).rejects.toThrow();
});
it.each([
  'price',
  'expiry',
  'payment',
  'reserved',
  'consent',
  'hash',
  'count',
] as const)('refuses altered retained %s evidence', async (kind) => {
  const input = await fixture(),
    record = await makeReservation(input, now);
  if (kind === 'price') record.review.askingPriceLamports = '1';
  if (kind === 'expiry')
    record.expiresAt = new Date(now + RESERVATION_MS + 1).toISOString();
  if (kind === 'payment') Object.assign(record, { paymentEnabled: true });
  if (kind === 'reserved') Object.assign(record, { reserved: false });
  if (kind === 'consent') Object.assign(record, { acknowledgement: '' });
  if (kind === 'hash') record.contextSha256 = '0'.repeat(64);
  if (kind === 'count') record.review.count = 2;
  await expect(admitReservation(record, input, now)).rejects.toThrow();
});
it('refuses changed request IDs, future evidence and impossible cancellation timestamps', async () => {
  const input = await fixture(),
    record = await makeReservation(input, now);
  await expect(
    admitReservation(record, { ...input, id: crypto.randomUUID() }, now),
  ).rejects.toThrow();
  await expect(admitReservation(record, undefined, now - 1)).rejects.toThrow();
  expect(() =>
    reservationState(record, new Date(now - 1).toISOString(), now),
  ).toThrow();
  expect(() =>
    reservationState(record, new Date(now + 1).toISOString(), now),
  ).toThrow();
});
