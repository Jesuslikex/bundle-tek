import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { validateSolanaTrackedWallet as validateTrackedWallet } from '@/lib/tracked-wallet';
import {
  observeSignaturePage,
  signatureCursor,
} from '@/lib/tracked-signatures';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to browse wallet activity.' }, 401);
  let wallet, cursor, expectedUpdatedAt: string;
  try {
    const query = new URL(request.url).searchParams;
    wallet = validateTrackedWallet({
      address: query.get('address'),
      network: query.get('network'),
      label: '',
    });
    cursor = signatureCursor(query.get('cursor'));
    expectedUpdatedAt = query.get('expectedUpdatedAt') ?? '';
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
        expectedUpdatedAt,
      ) ||
      new Date(expectedUpdatedAt).toISOString() !== expectedUpdatedAt
    )
      throw new Error();
  } catch {
    return json(
      { error: 'Choose a valid tracked wallet, version and activity cursor.' },
      400,
    );
  }
  let db: D1Database;
  const version = () =>
    db
      .prepare(
        'SELECT updated_at FROM tracked_wallets WHERE owner_id=? AND network=? AND address=?',
      )
      .bind(user.userId, wallet.network, wallet.address)
      .first<{ updated_at: string }>();
  try {
    db = getD1();
    const owned = await version();
    if (!owned) return json({ error: 'Tracked wallet not found.' }, 404);
    if (owned.updated_at !== expectedUpdatedAt)
      return json({ error: 'Wallet changed. Reload the tracker first.' }, 409);
    const now = Date.now();
    const gate = await db
      .prepare(
        `INSERT INTO wallet_balance_gates(owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE wallet_balance_gates.next_allowed_at<=?`,
      )
      .bind(user.userId, now + 15000, now)
      .run();
    if (!gate.meta.changes)
      return json(
        { error: 'Wait 15 seconds between wallet provider reads.' },
        429,
      );
  } catch {
    return json({ error: 'Tracker storage temporarily unavailable.' }, 503);
  }
  let page;
  try {
    page = await observeSignaturePage(
      wallet.address,
      wallet.network,
      cursor,
      AbortSignal.any([request.signal, AbortSignal.timeout(25000)]),
    );
  } catch {
    return json(
      {
        error:
          'Activity provider unavailable or returned inconsistent history. Previous results remain available.',
      },
      502,
    );
  }
  try {
    const latest = await version();
    if (!latest || latest.updated_at !== expectedUpdatedAt)
      return json(
        { error: 'Wallet changed during the read. Reload the tracker first.' },
        409,
      );
  } catch {
    return json({ error: 'Tracker storage temporarily unavailable.' }, 503);
  }
  return json({ page, executionAllowed: false });
}
