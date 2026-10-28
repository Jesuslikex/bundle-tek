import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { operatorDraftId } from '@/lib/marketplace-operator-draft-view';
import { readMarketplaceReservation } from '@/lib/marketplace-reservation-storage';
import { openMarketplaceKey } from '@/lib/marketplace-key-delivery';

export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) => Response.json(body, { status });

// Delivery is the last step: only the buyer who paid and settled this exact
// reservation may read the sealed keys, and only once per request.
export async function GET(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user) return json({ error: 'Sign in to receive your keys.' }, 401);
    const params = new URL(request.url).searchParams;
    if (params.size !== 1 || !params.get('id'))
      return json({ error: 'Choose one reservation ID.' }, 400);
    const id = operatorDraftId.safeParse(params.get('id'));
    if (!id.success) return json({ error: 'Choose one reservation ID.' }, 400);
    const db = getD1();
    const reservation = await readMarketplaceReservation(
      db,
      user.userId,
      id.data,
      request.signal,
    );
    if (!reservation) return json({ error: 'Reservation not found.' }, 404);
    const paid = await db
      .prepare(
        'SELECT paid_at AS paidAt FROM marketplace_reservation_payments WHERE buyer_id=? AND reservation_id=?',
      )
      .bind(user.userId, id.data)
      .first<{ paidAt: string }>();
    if (!paid)
      return json(
        { error: 'Pay the reviewed total before receiving the keys.' },
        409,
      );
    const settled = await db
      .prepare(
        'SELECT settled_at AS settledAt FROM marketplace_reservation_settlements WHERE buyer_id=? AND reservation_id=?',
      )
      .bind(user.userId, id.data)
      .first<{ settledAt: string }>();
    if (!settled)
      return json({ error: 'Import the paid wallets first.' }, 409);

    const addresses = reservation.record.review.items.map(
      (e) => e.listing.address,
    );
    const rows = await db
      .prepare(
        `SELECT p.id AS publicationId, k.sealed FROM marketplace_publications p
         JOIN marketplace_listing_keys k ON k.publication_id = p.id
         WHERE p.id IN (SELECT value FROM json_each(?))`,
      )
      .bind(JSON.stringify(reservation.record.review.items.map((e) => e.id)))
      .all<{ publicationId: string; sealed: string }>();
    const sealedByPublication = new Map(
      rows.results.map((r) => [r.publicationId, r.sealed]),
    );
    const keys: { address: string; privateKey: string }[] = [];
    const missing: string[] = [];
    for (const item of reservation.record.review.items) {
      const sealed = sealedByPublication.get(item.id);
      if (!sealed) {
        missing.push(item.listing.address);
        continue;
      }
      keys.push({
        address: item.listing.address,
        privateKey: await openMarketplaceKey(sealed),
      });
    }
    return json({
      keys,
      missing,
      paidAt: paid.paidAt,
      settledAt: settled.settledAt,
    });
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'The keys could not be delivered.',
      },
      503,
    );
  }
}
