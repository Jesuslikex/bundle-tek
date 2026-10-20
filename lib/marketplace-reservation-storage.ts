import { readBundleCatalog } from './marketplace-publication-storage';
import { reviewMarketplaceCart } from './marketplace-cart';
import {
  operatorDraftId,
  operatorDraftCanonical as canonical,
} from './marketplace-operator-draft-view';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import {
  admitReservationHistory,
  reservationHistoryCursor,
  HOLD_HISTORY_PAGE_SIZE,
  type ReservationHistoryCursor,
} from './marketplace-reservation-history';
import {
  reservationRequest,
  reservationCancel,
  makeReservation,
  admitReservationReview,
  admitReservation,
  reservationState,
  type ReservationRequest,
} from './marketplace-reservation';
export class MarketplaceReservationError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
function ownerId(owner: string) {
  if (!owner || owner.length > 256)
    throw new MarketplaceReservationError('Verified buyer required.', 403);
}
async function installed(db: D1Database) {
  const row = await db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('marketplace_reservations_insert','marketplace_reservations_no_update','marketplace_reservations_no_delete','marketplace_reservation_releases_insert','marketplace_reservation_releases_no_update','marketplace_reservation_releases_no_delete')",
    )
    .first<{ n: number }>();
  if (row?.n !== 6)
    throw new MarketplaceReservationError(
      'Reservation storage is not installed.',
      503,
    );
}
const selectReservation =
  'SELECT r.*,c.released_at,c.context_sha256 AS release_sha,c.acknowledgement AS release_ack FROM marketplace_reservations r';
const joinRelease =
  ' LEFT JOIN marketplace_reservation_releases c ON c.buyer_id=r.buyer_id AND c.reservation_id=r.id';
type ReservationRow = {
  id: string;
  document: string;
  context_sha256: string;
  request_sha256: string;
  created_at: string;
  expires_at: string;
  released_at: string | null;
  release_sha: string | null;
  release_ack: string | null;
};
async function read(db: D1Database, owner: string, id: string) {
  const row = await db
    .prepare(selectReservation + joinRelease + ' WHERE r.buyer_id=? AND r.id=?')
    .bind(owner, id)
    .first<ReservationRow>();
  if (!row) return null;
  return decodeReservation(row);
}
async function decodeReservation(row: ReservationRow, now = Date.now()) {
  try {
    if (new TextEncoder().encode(row.document).byteLength > 524288)
      throw Error('Capacity');
    const record = await admitReservation(
      JSON.parse(row.document),
      undefined,
      now,
    );
    if (
      record.id !== row.id ||
      record.contextSha256 !== row.context_sha256 ||
      record.requestSha256 !== row.request_sha256 ||
      record.createdAt !== row.created_at ||
      record.expiresAt !== row.expires_at
    )
      throw Error('Binding');
    if (row.released_at !== null)
      reservationCancel.parse({
        id: row.id,
        contextSha256: row.release_sha,
        acknowledgement: row.release_ack,
      });
    if (row.released_at !== null && row.release_sha !== record.contextSha256)
      throw Error('Release differs');
    return {
      record,
      releasedAt: row.released_at,
      state: reservationState(record, row.released_at, now),
    };
  } catch {
    throw new MarketplaceReservationError(
      'Stored reservation is unavailable or inconsistent.',
      503,
    );
  }
}
export async function readMarketplaceReservationHistory(
  db: D1Database,
  owner: string,
  cursor: ReservationHistoryCursor | null,
  signal: AbortSignal,
) {
  ownerId(owner);
  if (cursor) reservationHistoryCursor.parse(cursor);
  signal.throwIfAborted();
  await installed(db);
  const found = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='marketplace_reservations_buyer_history'",
    )
    .first();
  if (!found)
    throw new MarketplaceReservationError(
      'Reservation history storage is not installed.',
      503,
    );
  const query =
    selectReservation +
    ' INDEXED BY marketplace_reservations_buyer_history' +
    joinRelease +
    ' WHERE r.buyer_id=?' +
    (cursor ? ' AND (r.created_at,r.id)<(?,?)' : '') +
    ' ORDER BY r.created_at DESC,r.id DESC LIMIT ?';
  const args: unknown[] = [
    owner,
    ...(cursor ? [cursor.createdAt, cursor.id] : []),
    HOLD_HISTORY_PAGE_SIZE + 1,
  ];
  const rows = (
      await db
        .prepare(query)
        .bind(...args)
        .all<ReservationRow>()
    ).results,
    now = Date.now(),
    entries = [];
  for (const row of rows.slice(0, HOLD_HISTORY_PAGE_SIZE)) {
    signal.throwIfAborted();
    const { record, releasedAt, state } = await decodeReservation(row, now);
    entries.push({
      id: record.id,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      releasedAt,
      state,
      count: record.review.count,
      askingPriceLamports: record.review.askingPriceLamports,
      contextSha256: record.contextSha256,
    });
  }
  signal.throwIfAborted();
  const last = entries.at(-1);
  return admitReservationHistory(
    {
      history: {
        format: 'bundle-reservation-history-v1',
        chain: 'Solana',
        seller: 'Bundle',
        observedAt: new Date(now).toISOString(),
        entries,
        nextCursor:
          rows.length > HOLD_HISTORY_PAGE_SIZE && last
            ? { createdAt: last.createdAt, id: last.id }
            : null,
        reserveAllowed: false,
        releaseAllowed: false,
        purchaseEnabled: false,
        paymentEnabled: false,
        deliveryEnabled: false,
        signingAllowed: false,
      },
    },
    cursor,
  );
}
export async function readMarketplaceReservation(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
) {
  ownerId(owner);
  operatorDraftId.parse(id);
  signal.throwIfAborted();
  await installed(db);
  const result = await read(db, owner, id);
  signal.throwIfAborted();
  return result;
}
/** One immutable whole-cart insert. The database refuses overlapping live addresses atomically. */
export async function reserveMarketplaceCart(
  db: D1Database,
  owner: string,
  value: unknown,
  signal: AbortSignal,
) {
  ownerId(owner);
  const input = reservationRequest.parse(value);
  signal.throwIfAborted();
  await installed(db);
  const expectedHash = await digest(canonical(input)),
    prior = await read(db, owner, input.id);
  signal.throwIfAborted();
  if (prior) {
    if (prior.record.requestSha256 !== expectedHash)
      throw new MarketplaceReservationError(
        'This reservation ID belongs to another cart.',
      );
    // Recovery never renews a lease or rechecks a historical review as new authority.
    return prior;
  }
  const selection = await admitReservationReview(input.review),
    catalog = await readBundleCatalog(db, signal);
  await reviewMarketplaceCart(selection, catalog);
  const record = await makeReservation(input);
  signal.throwIfAborted();
  if (Date.now() >= Date.parse(record.review.expiresAt))
    throw new MarketplaceReservationError(
      'Cart review expired. Request a new review.',
    );
  try {
    await db
      .prepare(
        'INSERT INTO marketplace_reservations(id,buyer_id,context_sha256,request_sha256,document,created_at,expires_at) VALUES(?,?,?,?,?,?,?)',
      )
      .bind(
        record.id,
        owner,
        record.contextSha256,
        record.requestSha256,
        canonical(record),
        record.createdAt,
        record.expiresAt,
      )
      .run();
  } catch (error) {
    const recovered = await read(db, owner, input.id);
    if (recovered?.record.requestSha256 === expectedHash) return recovered;
    const conflict =
      error instanceof Error &&
      /constraint|already reserved|reservation source changed|Invalid marketplace reservation/i.test(
        error.message,
      );
    throw new MarketplaceReservationError(
      conflict
        ? 'A selected wallet changed or is already held. Recover this reservation ID before reviewing again.'
        : 'Reservation outcome is unknown. Recover this exact ID; do not reserve again.',
      conflict ? 409 : 503,
    );
  }
  signal.throwIfAborted();
  const saved = await read(db, owner, input.id);
  if (!saved)
    throw new MarketplaceReservationError(
      'Reservation outcome is unknown. Recover this exact ID.',
      503,
    );
  return saved;
}
export async function releaseMarketplaceReservation(
  db: D1Database,
  owner: string,
  value: unknown,
  signal: AbortSignal,
) {
  ownerId(owner);
  const input = reservationCancel.parse(value);
  signal.throwIfAborted();
  await installed(db);
  const current = await read(db, owner, input.id);
  signal.throwIfAborted();
  if (!current)
    throw new MarketplaceReservationError(
      'Reservation not found for this buyer.',
      404,
    );
  if (current.record.contextSha256 !== input.contextSha256)
    throw new MarketplaceReservationError(
      'Release the exact saved reservation.',
    );
  if (current.state !== 'held') return current;
  try {
    await db
      .prepare(
        'INSERT INTO marketplace_reservation_releases(buyer_id,reservation_id,context_sha256,released_at,acknowledgement) VALUES(?,?,?,?,?)',
      )
      .bind(
        owner,
        input.id,
        input.contextSha256,
        new Date().toISOString(),
        input.acknowledgement,
      )
      .run();
  } catch {
    const recovered = await read(db, owner, input.id);
    if (recovered?.state === 'released') return recovered;
    throw new MarketplaceReservationError(
      'Release outcome is unknown. Recover this exact reservation ID.',
      503,
    );
  }
  signal.throwIfAborted();
  const saved = await read(db, owner, input.id);
  if (!saved || saved.state !== 'released')
    throw new MarketplaceReservationError(
      'Release outcome is unknown. Recover this exact reservation ID.',
      503,
    );
  return saved;
}
export type { ReservationRequest };
