import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { validateTrackedWallet } from '@/lib/tracked-wallet';
import { evmChain } from '@/lib/evm-network';
import { trackerTimestamp } from '@/lib/tracked-transaction-history';
import { observeWarmupHistory } from '@/lib/wallet-warmup-history';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
function input(body: Record<string, unknown>) {
  const wallet = validateTrackedWallet({ ...body, label: '' });
  const network = evmChain(wallet.network);
  return {
    address: wallet.address,
    network,
    expectedUpdatedAt: trackerTimestamp(body.expectedUpdatedAt),
  };
}
type Row = {
  updated_at: string;
  archived: number;
  document: string | null;
  wallet_updated_at: string | null;
};
function context(
  db: D1Database,
  owner: string,
  wallet: ReturnType<typeof input>,
) {
  return db
    .prepare(`SELECT w.updated_at,w.archived,s.document,s.wallet_updated_at FROM tracked_wallets w
    LEFT JOIN tracked_evm_snapshots s ON s.owner_id=w.owner_id AND s.network=w.network AND s.address=w.address
    WHERE w.owner_id=? AND w.network=? AND w.address=?`)
    .bind(owner, wallet.network, wallet.address)
    .first<Row>();
}
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to view EVM observations.' }, 401);
  let wallet;
  try {
    wallet = input(Object.fromEntries(new URL(request.url).searchParams));
  } catch {
    return json({ error: 'Choose a valid EVM tracked wallet revision.' }, 400);
  }
  try {
    const row = await context(getD1(), user.userId, wallet);
    if (!row) return json({ error: 'Tracked wallet not found.' }, 404);
    if (row.updated_at !== wallet.expectedUpdatedAt)
      return json({ error: 'Wallet changed. Reload the tracker.' }, 409);
    return json({
      snapshot: row.document ? JSON.parse(row.document) : null,
      capturedUpdatedAt: row.wallet_updated_at,
      currentUpdatedAt: row.updated_at,
      stale: Boolean(row.document && row.wallet_updated_at !== row.updated_at),
      executionAllowed: false,
    });
  } catch {
    return json(
      { error: 'EVM observation storage temporarily unavailable.' },
      503,
    );
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to refresh EVM observations.' }, 401);
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return json({ error: 'Cross-origin write rejected.' }, 403);
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  )
    return json({ error: 'JSON required.' }, 415);
  let wallet;
  try {
    const text = await request.text();
    if (text.length > 500) return json({ error: 'Request too large.' }, 413);
    wallet = input(JSON.parse(text));
  } catch {
    return json({ error: 'Choose a valid EVM tracked wallet revision.' }, 400);
  }
  let db: D1Database, row: Row;
  try {
    db = getD1();
    const owned = await context(db, user.userId, wallet);
    if (!owned) return json({ error: 'Tracked wallet not found.' }, 404);
    if (owned.archived || owned.updated_at !== wallet.expectedUpdatedAt)
      return json(
        { error: 'Wallet changed or is archived. Reload the tracker.' },
        409,
      );
    row = owned;
    const now = Date.now();
    const gate = await db
      .prepare(
        'INSERT INTO tracker_evm_read_gates(owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE tracker_evm_read_gates.next_allowed_at<=?',
      )
      .bind(user.userId, now + 15000, now)
      .run();
    if (!gate.meta.changes)
      return json({ error: 'Wait 15 seconds between EVM tracker reads.' }, 429);
  } catch {
    return json(
      { error: 'EVM observation storage temporarily unavailable.' },
      503,
    );
  }
  let snapshot;
  try {
    snapshot = await observeWarmupHistory(
      wallet.network,
      wallet.address,
      AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
    );
  } catch {
    return json(
      {
        error:
          'EVM provider unavailable or returned an inconsistent block. Saved snapshot retained.',
      },
      502,
    );
  }
  try {
    const result = await db
      .prepare(`INSERT INTO tracked_evm_snapshots(owner_id,network,address,document,wallet_updated_at,observed_at)
    SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM tracked_wallets WHERE owner_id=? AND network=? AND address=? AND archived=0 AND updated_at=?)
    AND (?='' AND NOT EXISTS(SELECT 1 FROM tracked_evm_snapshots WHERE owner_id=? AND network=? AND address=?) OR EXISTS(SELECT 1 FROM tracked_evm_snapshots WHERE owner_id=? AND network=? AND address=? AND document=?))
    ON CONFLICT(owner_id,network,address) DO UPDATE SET document=excluded.document,wallet_updated_at=excluded.wallet_updated_at,observed_at=excluded.observed_at WHERE tracked_evm_snapshots.observed_at<excluded.observed_at`)
      .bind(
        user.userId,
        wallet.network,
        wallet.address,
        JSON.stringify(snapshot),
        wallet.expectedUpdatedAt,
        snapshot.observedAt,
        user.userId,
        wallet.network,
        wallet.address,
        wallet.expectedUpdatedAt,
        row.document ?? '',
        user.userId,
        wallet.network,
        wallet.address,
        user.userId,
        wallet.network,
        wallet.address,
        row.document ?? '',
      )
      .run();
    if (!result.meta.changes)
      return json(
        {
          error:
            'Wallet or snapshot changed during the read. Reload before retrying.',
        },
        409,
      );
    return json({
      snapshot,
      capturedUpdatedAt: wallet.expectedUpdatedAt,
      currentUpdatedAt: wallet.expectedUpdatedAt,
      stale: false,
      executionAllowed: false,
    });
  } catch {
    return json(
      { error: 'EVM snapshot could not be saved. Previous record retained.' },
      503,
    );
  }
}
