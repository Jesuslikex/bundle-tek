import { z } from 'zod';
import {
  operatorDraftId,
  operatorDraftCanonical as canonical,
} from './marketplace-operator-draft-view';
import { cartReview } from './marketplace-cart';
import { RESERVATION_MS } from './marketplace-reservation';
export const HOLD_HISTORY_PAGE_SIZE = 20;
const timestamp = z.iso
  .datetime()
  .refine(
    (v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v,
  );
export const reservationHistoryCursor = z
  .object({ createdAt: timestamp, id: operatorDraftId })
  .strict();
export type ReservationHistoryCursor = z.infer<typeof reservationHistoryCursor>;
export const reservationHistoryEntry = z
  .object({
    id: operatorDraftId,
    createdAt: timestamp,
    expiresAt: timestamp,
    releasedAt: timestamp.nullable(),
    state: z.enum(['held', 'released', 'expired']),
    count: z.number().int().min(1).max(200),
    askingPriceLamports: cartReview.shape.askingPriceLamports,
    contextSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const reservationHistoryPage = z
  .object({
    format: z.literal('bundle-reservation-history-v1'),
    chain: z.literal('Solana'),
    seller: z.literal('Bundle'),
    observedAt: timestamp,
    entries: z.array(reservationHistoryEntry).max(HOLD_HISTORY_PAGE_SIZE),
    nextCursor: reservationHistoryCursor.nullable(),
    reserveAllowed: z.literal(false),
    releaseAllowed: z.literal(false),
    purchaseEnabled: z.literal(false),
    paymentEnabled: z.literal(false),
    deliveryEnabled: z.literal(false),
    signingAllowed: z.literal(false),
  })
  .strict();
export type ReservationHistoryPage = z.infer<typeof reservationHistoryPage>;
function before(a: ReservationHistoryCursor, b: ReservationHistoryCursor) {
  return (
    a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id < b.id)
  );
}
/** Informational owner-scoped summaries only. Always recover the full receipt before an action. */
export function admitReservationHistory(
  value: unknown,
  cursor: ReservationHistoryCursor | null = null,
  now = Date.now(),
): ReservationHistoryPage {
  const { history } = z
      .object({ history: reservationHistoryPage })
      .strict()
      .parse(value),
    at = Date.parse(history.observedAt);
  if (!Number.isSafeInteger(now) || at > now || now - at >= 60000)
    throw Error('History snapshot expired or differs.');
  if (cursor) reservationHistoryCursor.parse(cursor);
  const ids = new Set<string>();
  for (let i = 0; i < history.entries.length; i++) {
    const entry = history.entries[i],
      created = Date.parse(entry.createdAt),
      expiry = Date.parse(entry.expiresAt),
      released =
        entry.releasedAt === null ? null : Date.parse(entry.releasedAt);
    if (
      ids.has(entry.id) ||
      created > at ||
      expiry - created !== RESERVATION_MS ||
      (released !== null && (released < created || released > at)) ||
      entry.state !==
        (released !== null ? 'released' : at >= expiry ? 'expired' : 'held') ||
      (cursor && !before(entry, cursor)) ||
      (i > 0 && !before(entry, history.entries[i - 1]))
    )
      throw Error('History row or pagination differs.');
    ids.add(entry.id);
  }
  if (history.nextCursor) {
    const last = history.entries.at(-1);
    if (
      history.entries.length !== HOLD_HISTORY_PAGE_SIZE ||
      !last ||
      canonical(history.nextCursor) !==
        canonical({ createdAt: last.createdAt, id: last.id })
    )
      throw Error('History cursor differs.');
  }
  return history;
}
