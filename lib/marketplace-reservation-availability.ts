/** Shared schema admission for catalog filtering and reservation storage. No writes. */
export async function requireMarketplaceReservations(db: D1Database) {
  const row = await db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('marketplace_reservations_insert','marketplace_reservations_no_update','marketplace_reservations_no_delete','marketplace_reservation_releases_insert','marketplace_reservation_releases_no_update','marketplace_reservation_releases_no_delete')",
    )
    .first<{ n: number }>();
  if (row?.n !== 6) throw Error('Reservation storage is not installed.');
}
/** Address-level exclusion also covers withdrawals followed by a new publication ID. */
export const unreservedMarketplaceWallet = `NOT EXISTS (
 SELECT 1 FROM marketplace_reservations held,json_each(held.document,'$.review.items') held_item
 WHERE json_extract(held_item.value,'$.listing.address')=p.wallet_address
 AND julianday(held.expires_at)>julianday('now')
 AND NOT EXISTS(SELECT 1 FROM marketplace_reservation_releases released WHERE released.buyer_id=held.buyer_id AND released.reservation_id=held.id)
)`;
