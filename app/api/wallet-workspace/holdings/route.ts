import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletAddress } from '@/lib/wallet-workspace';
import {
  observeWalletHoldings,
  HoldingsReadError,
} from '@/lib/wallet-holdings';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to view token holdings.' }, 401);
  let address: string;
  try {
    address = walletAddress(
      new URL(request.url).searchParams.get('address'),
      'Solana',
    );
  } catch {
    return json({ error: 'Choose a valid Solana wallet.' }, 400);
  }
  try {
    const db = getD1();
    const wallet = await db
      .prepare(
        "SELECT address FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND address=?",
      )
      .bind(user.userId, address)
      .first();
    if (!wallet) return json({ error: 'Saved wallet not found.' }, 404);
    const row = await db
      .prepare(
        "SELECT document FROM wallet_holdings_snapshots WHERE owner_id=? AND chain='Solana' AND address=?",
      )
      .bind(user.userId, address)
      .first<{ document: string }>();
    return json({ snapshot: row ? JSON.parse(row.document) : null });
  } catch {
    return json({ error: 'Holdings storage temporarily unavailable.' }, 503);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to refresh token holdings.' }, 401);
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return json({ error: 'Cross-origin request rejected.' }, 403);
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  )
    return json({ error: 'JSON required.' }, 415);
  let address: string;
  try {
    const text = await request.text();
    if (text.length > 1000)
      return json({ error: 'Holdings request too large.' }, 413);
    const body = JSON.parse(text);
    if (body.chain !== 'Solana')
      return json(
        { error: 'Token holdings discovery currently supports Solana.' },
        400,
      );
    address = walletAddress(body.address, 'Solana');
  } catch {
    return json({ error: 'Choose a valid Solana wallet.' }, 400);
  }
  let db: D1Database, revision: number;
  try {
    db = getD1();
    const row = await db
      .prepare(
        `SELECT w.revision FROM workspace_wallets w WHERE w.owner_id=? AND w.chain='Solana' AND w.address=? AND w.archived=0`,
      )
      .bind(user.userId, address)
      .first<{ revision: number }>();
    if (!row)
      return json(
        { error: 'Refresh only saved wallets in active folders.' },
        404,
      );
    revision = row.revision;
    const now = Date.now();
    const gate = await db
      .prepare(
        'INSERT INTO wallet_balance_gates (owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE wallet_balance_gates.next_allowed_at<=?',
      )
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
    return json({ error: 'Wallet storage temporarily unavailable.' }, 503);
  }
  const controller = new AbortController();
  let snapshot;
  try {
    snapshot = await observeWalletHoldings(
      address,
      AbortSignal.any([
        request.signal,
        controller.signal,
        AbortSignal.timeout(25000),
      ]),
    );
  } catch (error) {
    controller.abort();
    console.warn(
      'Holdings observation failed:',
      error instanceof HoldingsReadError
        ? { method: error.method, host: error.host, status: error.status }
        : 'invalid account data',
    );
    const accessDenied =
      error instanceof HoldingsReadError &&
      (error.status === 401 || error.status === 403);
    const rateLimited =
      error instanceof HoldingsReadError && error.status === 429;
    return json(
      {
        error: accessDenied
          ? 'The token holdings service was denied access by its data provider. Previous observations are retained.'
          : rateLimited
            ? 'The token holdings data provider is rate limiting requests. Try again later. Previous observations are retained.'
            : 'Token holdings provider unavailable or returned incomplete data. Previous observations are retained.',
        code: accessDenied
          ? 'HOLDINGS_PROVIDER_ACCESS_DENIED'
          : rateLimited
            ? 'HOLDINGS_PROVIDER_RATE_LIMITED'
            : 'HOLDINGS_PROVIDER_UNAVAILABLE',
      },
      502,
    );
  }
  try {
    const result = await db
      .prepare(`INSERT INTO wallet_holdings_snapshots (owner_id,chain,address,document,max_slot)
      SELECT ?,'Solana',?,?,? WHERE EXISTS (SELECT 1 FROM workspace_wallets w WHERE w.owner_id=? AND w.chain='Solana' AND w.address=? AND w.revision=? AND w.archived=0)
      AND NOT EXISTS (SELECT 1 FROM wallet_holdings_snapshots WHERE owner_id=? AND chain='Solana' AND address=? AND max_slot>?)
      ON CONFLICT(owner_id,chain,address) DO UPDATE SET document=excluded.document,max_slot=excluded.max_slot`)
      .bind(
        user.userId,
        address,
        JSON.stringify(snapshot),
        snapshot.maxSlot,
        user.userId,
        address,
        revision,
        user.userId,
        address,
        snapshot.minSlot,
      )
      .run();
    if (!result.meta.changes)
      return json(
        {
          error:
            'Wallet changed or newer holdings arrived during refresh. Reload and try again.',
        },
        409,
      );
    return json({ snapshot });
  } catch {
    return json(
      {
        error: 'Could not retain holdings. Previous observations are retained.',
      },
      503,
    );
  }
}
