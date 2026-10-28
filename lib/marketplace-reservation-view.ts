import { z } from 'zod';
import {
  admitReservation,
  reservationRecord,
  reservationState,
  type ReservationRequest,
} from './marketplace-reservation';
const response = z
  .object({
    reservation: z
      .object({
        record: reservationRecord,
        releasedAt: z.iso.datetime().nullable(),
        state: z.enum(['held', 'released', 'expired']),
      })
      .strict(),
    // Optional: only present when a seller payout address is configured.
    payment: z
      .object({
        sellerWallet: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
        lamports: z.string().regex(/^[1-9]\d{0,19}$/),
        paidAt: z.iso.datetime().nullable(),
        // Only the single-reservation read prepares a packet.
        transaction: z.string().optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
export type BuyerReservation = z.infer<typeof response>['reservation'];
export async function admitBuyerReservation(
  value: unknown,
  id: string,
  expected?: ReservationRequest,
  now = Date.now(),
): Promise<BuyerReservation> {
  const { reservation } = response.parse(value);
  await admitReservation(reservation.record, expected, now);
  if (
    reservation.record.id !== id ||
    reservationState(reservation.record, reservation.releasedAt, now) !==
      reservation.state
  )
    throw Error('Reservation identity or current state differs.');
  return reservation;
}
