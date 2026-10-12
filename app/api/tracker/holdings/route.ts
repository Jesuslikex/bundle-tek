import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletAddress } from '@/lib/wallet-workspace';
import { observeWalletHoldings } from '@/lib/wallet-holdings';

export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
function addressFor(value: unknown, network: unknown) {
  if (network !== 'mainnet') throw new Error('Mainnet required.');
  return walletAddress(value, 'Solana');
}
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to view tracked holdings.' }, 401);
  let address: string;
  try {
    const query = new URL(request.url).searchParams;
    address = addressFor(query.get('address'), query.get('network'));
  } catch {
    return json(
      { error: 'Choose a valid mainnet Solana tracked wallet.' },
      400,
    );
  }
  try {
    const row = await getD1()
      .prepare(`SELECT w.updated_at, h.document, h.wallet_updated_at
      FROM tracked_wallets w LEFT JOIN tracked_wallet_holdings h
        ON h.owner_id=w.owner_id AND h.network=w.network AND h.address=w.address
      WHERE w.owner_id=? AND w.network='mainnet' AND w.address=?`)
      .bind(user.userId, address)
      .first<{
        updated_at: string;
        document: string | null;
        wallet_updated_at: string | null;
      }>();
    if (!row) return json({ error: 'Tracked wallet not found.' }, 404);
    return json({
      snapshot: row.document ? JSON.parse(row.document) : null,
      capturedUpdatedAt: row.wallet_updated_at,
      currentUpdatedAt: row.updated_at,
      stale: Boolean(row.document && row.wallet_updated_at !== row.updated_at),
    });
  } catch {
    return json(
      { error: 'Tracked holdings storage temporarily unavailable.' },
      503,
    );
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to refresh tracked holdings.' }, 401);
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin)
    return json({ error: 'Cross-origin request rejected.' }, 403);
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  )
    return json({ error: 'JSON required.' }, 415);
  let address: string, expectedUpdatedAt: string;
  try {
    const text = await request.text();
    if (text.length > 1000)
      return json({ error: 'Holdings request too large.' }, 413);
    const body = JSON.parse(text);
    address = addressFor(body.address, body.network);
    expectedUpdatedAt = body.expectedUpdatedAt;
    if (
      typeof expectedUpdatedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
        expectedUpdatedAt,
      ) ||
      !Number.isFinite(Date.parse(expectedUpdatedAt)) ||
      new Date(expectedUpdatedAt).toISOString() !== expectedUpdatedAt
    )
      throw new Error('Invalid revision.');
  } catch {
    return json(
      {
        error:
          'Choose a valid mainnet tracked wallet and reload its latest version.',
      },
      400,
    );
  }
  let db: D1Database;
  try {
    db = getD1();
    const wallet = await db
      .prepare(`SELECT updated_at FROM tracked_wallets
      WHERE owner_id=? AND network='mainnet' AND address=? AND archived=0`)
      .bind(user.userId, address)
      .first<{ updated_at: string }>();
    if (!wallet)
      return json({ error: 'Active tracked wallet not found.' }, 404);
    if (wallet.updated_at !== expectedUpdatedAt)
      return json(
        { error: 'Tracked wallet changed. Reload the tracker first.' },
        409,
      );
    const now = Date.now();
    const gate = await db
      .prepare(`INSERT INTO wallet_balance_gates (owner_id,next_allowed_at) VALUES (?,?)
      ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at
      WHERE wallet_balance_gates.next_allowed_at<=?`)
      .bind(user.userId, now + 15000, now)
      .run();
    if (!gate.meta.changes)
      return json(
        {
          error:
            'Wait 15 seconds between native balance or token holdings refreshes.',
        },
        429,
      );
  } catch {
    return json({ error: 'Tracker storage temporarily unavailable.' }, 503);
  }
  let snapshot;
  try {
    snapshot = await observeWalletHoldings(
      address,
      AbortSignal.any([request.signal, AbortSignal.timeout(25000)]),
    );
  } catch {
    return json(
      {
        error:
          'Token holdings provider unavailable or returned incomplete data. Previous observations are retained.',
      },
      502,
    );
  }
  try {
    const result = await db
      .prepare(`INSERT INTO tracked_wallet_holdings
      (owner_id,network,address,document,wallet_updated_at,max_slot)
      SELECT ?,'mainnet',?,?,?,?
      WHERE EXISTS (SELECT 1 FROM tracked_wallets WHERE owner_id=? AND network='mainnet'
        AND address=? AND updated_at=? AND archived=0)
      AND NOT EXISTS (SELECT 1 FROM tracked_wallet_holdings WHERE owner_id=? AND network='mainnet'
        AND address=? AND max_slot>?)
      ON CONFLICT(owner_id,network,address) DO UPDATE SET document=excluded.document,
        wallet_updated_at=excluded.wallet_updated_at,max_slot=excluded.max_slot`)
      .bind(
        user.userId,
        address,
        JSON.stringify(snapshot),
        expectedUpdatedAt,
        snapshot.maxSlot,
        user.userId,
        address,
        expectedUpdatedAt,
        user.userId,
        address,
        snapshot.minSlot,
      )
      .run();
    if (!result.meta.changes)
      return json(
        {
          error:
            'Tracked wallet changed or newer holdings arrived during refresh. Reload and try again.',
        },
        409,
      );
    return json({
      snapshot,
      capturedUpdatedAt: expectedUpdatedAt,
      currentUpdatedAt: expectedUpdatedAt,
      stale: false,
    });
  } catch {
    return json(
      {
        error:
          'Could not retain tracked holdings. Previous observations are retained.',
      },
      503,
    );
  }
}
