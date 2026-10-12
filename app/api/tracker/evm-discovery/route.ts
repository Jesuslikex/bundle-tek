import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { validateTrackedWallet } from '@/lib/tracked-wallet';
import { evmChain } from '@/lib/evm-network';
import { trackerTimestamp } from '@/lib/tracked-transaction-history';
import {
  discoverEvmTransactions,
  olderDiscoveryAnchor,
  appendDiscovery,
} from '@/lib/evm-transaction-discovery';
import type { EvmDiscovery } from '@/lib/evm-transaction-discovery';
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
    LEFT JOIN tracked_evm_discovery s ON s.owner_id=w.owner_id AND s.network=w.network AND s.address=w.address
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
      discovery: row.document ? JSON.parse(row.document) : null,
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
  let wallet,
    action: 'latest' | 'older',
    expectedObservedAt: string | undefined,
    includeTokenEvents = false;
  try {
    const text = await request.text();
    if (text.length > 500) return json({ error: 'Request too large.' }, 413);
    const body = JSON.parse(text);
    wallet = input(body);
    action = body.action ?? 'latest';
    if (body.expectedDiscoveryObservedAt !== undefined)
      expectedObservedAt = trackerTimestamp(body.expectedDiscoveryObservedAt);
    if (
      body.includeTokenEvents !== undefined &&
      typeof body.includeTokenEvents !== 'boolean'
    )
      throw new Error('Invalid event selection.');
    includeTokenEvents = body.includeTokenEvents === true;
    if (action !== 'latest' && action !== 'older')
      throw new Error('Invalid scan action.');
  } catch {
    return json({ error: 'Choose a valid EVM tracked wallet revision.' }, 400);
  }
  let db: D1Database,
    row: Row,
    previous: EvmDiscovery | undefined,
    anchor: ReturnType<typeof olderDiscoveryAnchor> | undefined;
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
    if (
      expectedObservedAt &&
      (!row.document ||
        (JSON.parse(row.document) as EvmDiscovery).observedAt !==
          expectedObservedAt)
    )
      return json(
        { error: 'Saved discovery changed. Reload before restarting.' },
        409,
      );
    if (action === 'older') {
      try {
        if (!row.document) throw new Error('No saved scan.');
        previous = JSON.parse(row.document) as EvmDiscovery;
        if (
          previous.chain !== wallet.network ||
          previous.address !== wallet.address
        )
          throw new Error('Saved scan context mismatch.');
        anchor = olderDiscoveryAnchor(previous);
        includeTokenEvents = previous.includesTokenEvents === true;
      } catch {
        return json(
          {
            error:
              'Saved scan cannot continue. Start a latest scan, or the 20-page / 100-match limit has been reached.',
          },
          409,
        );
      }
    }
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
  let discovery: EvmDiscovery;
  try {
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(25000),
    ]);
    const page = includeTokenEvents
      ? await discoverEvmTransactions(
          wallet.network,
          wallet.address,
          signal,
          fetch,
          anchor,
          true,
        )
      : anchor
        ? await discoverEvmTransactions(
            wallet.network,
            wallet.address,
            signal,
            fetch,
            anchor,
          )
        : await discoverEvmTransactions(wallet.network, wallet.address, signal);
    discovery = previous ? appendDiscovery(previous, page) : page;
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error &&
          error.message ===
            'Too many discovery matches. Narrower indexing is required.'
            ? 'This window exceeds the 100-transaction match limit. Saved discovery retained. This address requires a dedicated history indexer.'
            : 'EVM provider unavailable or returned an inconsistent block. Saved discovery retained.',
      },
      502,
    );
  }
  try {
    const result = await db
      .prepare(`INSERT INTO tracked_evm_discovery(owner_id,network,address,document,wallet_updated_at,observed_at)
    SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM tracked_wallets WHERE owner_id=? AND network=? AND address=? AND archived=0 AND updated_at=?)
    AND (?='' AND NOT EXISTS(SELECT 1 FROM tracked_evm_discovery WHERE owner_id=? AND network=? AND address=?) OR EXISTS(SELECT 1 FROM tracked_evm_discovery WHERE owner_id=? AND network=? AND address=? AND document=?))
    ON CONFLICT(owner_id,network,address) DO UPDATE SET document=excluded.document,wallet_updated_at=excluded.wallet_updated_at,observed_at=excluded.observed_at WHERE tracked_evm_discovery.observed_at<excluded.observed_at`)
      .bind(
        user.userId,
        wallet.network,
        wallet.address,
        JSON.stringify(discovery),
        wallet.expectedUpdatedAt,
        discovery.observedAt,
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
            'Wallet or discovery changed during the read. Reload before retrying.',
        },
        409,
      );
    return json({
      discovery,
      capturedUpdatedAt: wallet.expectedUpdatedAt,
      currentUpdatedAt: wallet.expectedUpdatedAt,
      stale: false,
      executionAllowed: false,
    });
  } catch {
    return json(
      { error: 'EVM discovery could not be saved. Previous record retained.' },
      503,
    );
  }
}
