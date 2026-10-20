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
