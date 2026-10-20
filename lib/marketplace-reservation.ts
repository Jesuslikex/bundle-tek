import { z } from 'zod';
import {
  cartReview,
  admitMarketplaceCart,
  buildCartRequest,
  type CartReview,
} from './marketplace-cart';
import {
  operatorDraftId,
  operatorDraftCanonical as canonical,
} from './marketplace-operator-draft-view';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
export const RESERVATION_MS = 300000;
export const RESERVATION_ACK =
  'Hold these exact wallets and asking prices for five minutes. This does not authorize payment, purchase, signing or key delivery. Bundle is the seller; previous private-key copies may exist.';
export const RESERVATION_CANCEL_ACK =
  'Release this exact wallet reservation. This does not send or refund a payment.';
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const reservationRequest = z
  .object({
    id: operatorDraftId,
    review: cartReview,
    acknowledgement: z.literal(RESERVATION_ACK),
  })
  .strict();
export type ReservationRequest = z.infer<typeof reservationRequest>;
export const reservationRecord = z
  .object({
    format: z.literal('bundle-reservation-v1'),
    id: operatorDraftId,
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    requestSha256: sha,
    contextSha256: sha,
    review: cartReview,
    acknowledgement: z.literal(RESERVATION_ACK),
    reserved: z.literal(true),
    purchaseEnabled: z.literal(false),
    paymentEnabled: z.literal(false),
    deliveryEnabled: z.literal(false),
    signingAllowed: z.literal(false),
  })
  .strict();
export type ReservationRecord = z.infer<typeof reservationRecord>;
export const reservationCancel = z
  .object({
    id: operatorDraftId,
    contextSha256: sha,
    acknowledgement: z.literal(RESERVATION_CANCEL_ACK),
  })
  .strict();
/** Replays content and freshness, without treating a digest as payment authority. */
export async function admitReservationReview(
  review: CartReview,
  now = Date.now(),
) {
  const catalog = {
    format: 'bundle-catalog-v1' as const,
    seller: 'Bundle' as const,
    observedAt: review.catalogObservedAt,
    expiresAt: review.expiresAt,
    purchaseEnabled: false as const,
    deliveryEnabled: false as const,
    signingAllowed: false as const,
    listings: review.items,
  };
  const input = await buildCartRequest(
    catalog,
    review.items.map((e) => e.id),
    now,
  );
  await admitMarketplaceCart(review, catalog, input, now);
  return input;
}
export function makeReservationRequest(
  id: string,
  review: CartReview,
  acknowledged: boolean,
): ReservationRequest {
  if (acknowledged !== true)
    throw Error('Separately acknowledge this exact reservation.');
  return reservationRequest.parse({
    id,
    review,
    acknowledgement: RESERVATION_ACK,
  });
}
export async function makeReservation(
  value: unknown,
  now = Date.now(),
): Promise<ReservationRecord> {
  const input = reservationRequest.parse(value);
  await admitReservationReview(input.review, now);
  const base = {
    format: 'bundle-reservation-v1',
    id: input.id,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + RESERVATION_MS).toISOString(),
    requestSha256: await digest(canonical(input)),
    review: input.review,
    acknowledgement: input.acknowledgement,
    reserved: true,
    purchaseEnabled: false,
    paymentEnabled: false,
    deliveryEnabled: false,
    signingAllowed: false,
  };
  return reservationRecord.parse({
    ...base,
    contextSha256: await digest(canonical(base)),
  });
}
export async function admitReservation(
  value: unknown,
  expected?: ReservationRequest,
  now = Date.now(),
) {
  const record = reservationRecord.parse(value),
    created = Date.parse(record.createdAt);
  if (
    !Number.isSafeInteger(now) ||
    created > now ||
    Date.parse(record.expiresAt) - created !== RESERVATION_MS
  )
    throw Error('Reservation time differs.');
  const request = reservationRequest.parse({
    id: record.id,
    review: record.review,
    acknowledgement: record.acknowledgement,
  });
  const replay = await makeReservation(request, created);
  if (
    canonical(replay) !== canonical(record) ||
    (expected && canonical(expected) !== canonical(request))
  )
    throw Error('Reservation differs from the exact approved cart.');
  return record;
}
export function reservationState(
  record: ReservationRecord,
  cancelledAt: string | null,
  now = Date.now(),
) {
  if (!Number.isSafeInteger(now) || Date.parse(record.createdAt) > now)
    throw Error('Invalid reservation clock.');
  if (cancelledAt !== null) {
    const cancelled = Date.parse(cancelledAt);
    if (
      !Number.isFinite(cancelled) ||
      cancelled < Date.parse(record.createdAt) ||
      cancelled > now
    )
      throw Error('Invalid reservation cancellation.');
    return 'released' as const;
  }
  return now >= Date.parse(record.expiresAt)
    ? ('expired' as const)
    : ('held' as const);
}
