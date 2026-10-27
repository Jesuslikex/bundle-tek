import { z } from 'zod';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletRequest } from '@/lib/wallet-request';
import { operatorDraftId } from '@/lib/marketplace-operator-draft-view';
import { walletWarmupSessionDigest as digest } from '@/lib/wallet-warmup-session-digest';
import {
  reservationRequest,
  reservationCancel,
} from '@/lib/marketplace-reservation';
import { MarketplaceCartError } from '@/lib/marketplace-cart';
import { OperatorDraftStorageError } from '@/lib/marketplace-operator-draft-storage';
import {
  MarketplaceReservationError,
  readMarketplaceReservation,
  reserveMarketplaceCart,
  releaseMarketplaceReservation,
  readMarketplaceReservationHistory,
} from '@/lib/marketplace-reservation-storage';
import { reservationHistoryCursor } from '@/lib/marketplace-reservation-history';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200, retry = false) =>
  Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...(retry ? { 'retry-after': '15' } : {}),
    },
  });
const actions = z.discriminatedUnion('action', [
  reservationRequest.extend({ action: z.literal('reserve') }),
  reservationCancel.extend({ action: z.literal('release') }),
  z.object({ action: z.literal('settle'), id: operatorDraftId }).strict(),
]);
function failure(error: unknown, request: Request) {
  if (request.signal.aborted)
    return json(
      {
        error:
          'Stopped waiting. Recover this exact reservation ID before another write.',
      },
      408,
    );
  if (
    error instanceof MarketplaceReservationError ||
    error instanceof MarketplaceCartError ||
    error instanceof OperatorDraftStorageError
  )
    return json({ error: error.message }, error.status, error.status === 429);
  return json(
    {
      error:
        'Reservation unavailable. Recover the same reservation ID before another write.',
    },
    503,
  );
}
export async function GET(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user)
      return json({ error: 'Sign in to recover your reservation.' }, 401);
    const params = new URL(request.url).searchParams,
      id = params.get('id');
    if (params.get('history') === '1') {
      const keys = [...params.keys()],
        createdAt = params.get('beforeCreatedAt'),
        beforeId = params.get('beforeId');
      if (
        keys.some(
          (k) => !['history', 'beforeCreatedAt', 'beforeId'].includes(k),
        ) ||
        new Set(keys).size !== keys.length ||
        !(
          (keys.length === 1 && createdAt === null && beforeId === null) ||
          (keys.length === 3 && createdAt !== null && beforeId !== null)
        )
      )
        return json({ error: 'Choose one saved-hold history page.' }, 400);
      const parsed =
        createdAt === null
          ? null
          : reservationHistoryCursor.safeParse({ createdAt, id: beforeId });
      if (parsed && !parsed.success)
        return json({ error: 'Choose a valid saved-hold cursor.' }, 400);
      return json({
        history: await readMarketplaceReservationHistory(
          getD1(),
          user.userId,
          parsed?.success ? parsed.data : null,
          request.signal,
        ),
      });
    }
    if (
      [...params.keys()].length !== 1 ||
      !operatorDraftId.safeParse(id).success
    )
      return json({ error: 'Choose one reservation ID.' }, 400);
    const reservation = await readMarketplaceReservation(
      getD1(),
      user.userId,
      id!,
      request.signal,
    );
    return reservation
      ? json({ reservation })
      : json({ error: 'Reservation not found for this buyer.' }, 404);
  } catch (error) {
    return failure(error, request);
  }
}
export async function POST(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user)
      return json({ error: 'Sign in to reserve or release wallets.' }, 401);
    if (request.headers.get('origin') !== new URL(request.url).origin)
      return json({ error: 'Same-origin request required.' }, 403);
    if (
      request.headers
        .get('content-type')
        ?.split(';')[0]
        .trim()
        .toLowerCase() !== 'application/json'
    )
      return json({ error: 'JSON required.' }, 415);
    let input;
    try {
      input = actions.parse(await walletRequest(request, 524288));
    } catch (error) {
      if (request.signal.aborted) throw error;
      const large =
        error instanceof Error && error.message === 'Wallet request too large.';
      return json(
        {
          error: large
            ? 'Request too large.'
            : 'Choose the exact cart or reservation and its separate acknowledgement.',
        },
        large ? 413 : 400,
      );
    }
    request.signal.throwIfAborted();
    const db = getD1(),
      { action, ...payload } = input;
    if (action === 'release')
      return json({
        reservation: await releaseMarketplaceReservation(
          db,
          user.userId,
          payload,
          request.signal,
        ),
      });
    if (action === 'settle') {
      const reservation = await readMarketplaceReservation(
        db,
        user.userId,
        payload.id,
        request.signal,
      );
      if (!reservation)
        return json({ error: 'Reservation not found.' }, 404);
      const settled = await db
        .prepare(
          'SELECT settled_at AS settledAt,wallet_count AS walletCount FROM marketplace_reservation_settlements WHERE buyer_id=? AND reservation_id=?',
        )
        .bind(user.userId, payload.id)
        .first<{ settledAt: string; walletCount: number }>();
      if (settled) return json({ settled });
      const released = await db
        .prepare(
          'SELECT released_at AS releasedAt FROM marketplace_reservation_releases WHERE buyer_id=? AND reservation_id=?',
        )
        .bind(user.userId, payload.id)
        .first<{ releasedAt: string }>();
      if (released)
        return json({ error: 'This reservation was released.' }, 409);
      if (Date.parse(reservation.record.expiresAt) <= Date.now())
        return json({ error: 'This reservation expired.' }, 409);
      const addresses = reservation.record.review.items.map(
        (e) => e.listing.address,
      );
      const now = new Date().toISOString();
      const entries = addresses.map((address, index) => ({
        address,
        label: `Purchased ${index + 1}`,
        role: 'Recipient',
        tags: ['purchased'],
      }));
      const inserted = await db
        .prepare(
          `WITH incoming AS (SELECT json_extract(value,'$.address') AS address,json_extract(value,'$.label') AS label,json_extract(value,'$.role') AS role,json_extract(value,'$.tags') AS tags FROM json_each(?))
          INSERT INTO workspace_wallets (owner_id,chain,address,folder_id,folder_ids,label,role,tags,archived,revision,updated_at)
          SELECT ?,?,address,'','[]',label,role,tags,0,1,? FROM incoming
          WHERE NOT EXISTS (SELECT 1 FROM workspace_wallets w WHERE w.owner_id=? AND w.chain='Solana' AND w.address=incoming.address)`,
        )
        .bind(JSON.stringify(entries), user.userId, 'Solana', now, user.userId)
        .run();
      const walletCount = inserted.meta.changes ?? 0;
      await db
        .prepare(
          'INSERT OR IGNORE INTO marketplace_reservation_settlements(buyer_id,reservation_id,settled_at,wallet_count) VALUES(?,?,?,?)',
        )
        .bind(user.userId, payload.id, new Date().toISOString(), addresses.length)
        .run();
      const settlement = await db
        .prepare(
          'SELECT settled_at, wallet_count FROM marketplace_reservation_settlements WHERE buyer_id = ? AND reservation_id = ?',
        )
        .bind(user.userId, payload.id)
        .first<{ settled_at: string; wallet_count: number }>();
      return json({
        settled: {
          settledAt: settlement?.settled_at ?? now,
          walletCount: settlement?.wallet_count ?? addresses.length,
        },
      });
    }
    // Existing IDs recover even during the new-hold cooldown. GET and release
    // remain available, so a lost response never forces a different ID or retry.
    if (
      !(await readMarketplaceReservation(
        db,
        user.userId,
        input.id,
        request.signal,
      ))
    ) {
      const active = await db
        .prepare(
          "SELECT 1 AS found FROM marketplace_reservations r WHERE r.buyer_id=? AND julianday(r.expires_at)>julianday('now') AND NOT EXISTS(SELECT 1 FROM marketplace_reservation_releases released WHERE released.buyer_id=r.buyer_id AND released.reservation_id=r.id) LIMIT 1",
        )
        .bind(user.userId)
        .first();
      if (active)
        return json(
          {
            error:
              'Recover or release your current wallet hold before creating another.',
          },
          409,
        );
      const key = 'marketplace-reservation:' + (await digest(user.userId));
      request.signal.throwIfAborted();
      const at = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
      const gated = await db
        .prepare(
          `INSERT INTO market_read_gates(owner_id,next_allowed_at) VALUES(?,${at}+15000) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE market_read_gates.next_allowed_at<=${at}`,
        )
        .bind(key)
        .run();
      if (!gated.meta.changes)
        return json(
          {
            error:
              'Wait 15 seconds before requesting a new hold. Recover or release the existing reservation meanwhile.',
          },
          429,
          true,
        );
    }
    return json({
      reservation: await reserveMarketplaceCart(
        db,
        user.userId,
        payload,
        request.signal,
      ),
    });
  } catch (error) {
    return failure(error, request);
  }
}
