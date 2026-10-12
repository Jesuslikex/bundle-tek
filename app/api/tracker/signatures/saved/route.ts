import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { validateSolanaTrackedWallet as validateTrackedWallet } from '@/lib/tracked-wallet';
import { trackerTimestamp } from '@/lib/tracked-transaction-history';
import { signatureCursor, type SignaturePage } from '@/lib/tracked-signatures';
import { GET as providerRead } from '../route';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
function context(query: URLSearchParams) {
  return {
    wallet: validateTrackedWallet({
      address: query.get('address'),
      network: query.get('network'),
      label: '',
    }),
    version: trackerTimestamp(query.get('expectedUpdatedAt')),
  };
}
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to read retained public activity.' }, 401);
  let input;
  try {
    input = context(new URL(request.url).searchParams);
  } catch {
    return json({ error: 'Invalid tracked wallet or version.' }, 400);
  }
  try {
    const db = getD1(),
      { wallet, version } = input;
    const owned = await db
      .prepare(
        'SELECT updated_at FROM tracked_wallets WHERE owner_id=? AND network=? AND address=?',
      )
      .bind(user.userId, wallet.network, wallet.address)
      .first<{ updated_at: string }>();
    if (!owned) return json({ error: 'Tracked wallet not found.' }, 404);
    if (owned.updated_at !== version)
      return json({ error: 'Wallet changed. Reload the tracker first.' }, 409);
    const snapshot = await db
      .prepare(
        'SELECT document,wallet_updated_at FROM tracked_signature_snapshots WHERE owner_id=? AND network=? AND address=?',
      )
      .bind(user.userId, wallet.network, wallet.address)
      .first<{ document: string; wallet_updated_at: string }>();
    const latest = await db
      .prepare(
        'SELECT updated_at FROM tracked_wallets WHERE owner_id=? AND network=? AND address=?',
      )
      .bind(user.userId, wallet.network, wallet.address)
      .first<{ updated_at: string }>();
    if (!latest || latest.updated_at !== version)
      return json({ error: 'Wallet changed. Reload the tracker first.' }, 409);
    return json({
      page: snapshot ? JSON.parse(snapshot.document) : null,
      stale: !!snapshot && snapshot.wallet_updated_at !== version,
      executionAllowed: false,
    });
  } catch {
    return json(
      { error: 'Retained activity storage temporarily unavailable.' },
      503,
    );
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to retain public activity.' }, 401);
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
  let input, cursor: string | null;
  try {
    const text = await request.text();
    if (text.length > 100) return json({ error: 'Request too large.' }, 413);
    const body = JSON.parse(text);
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length
    )
      throw new Error();
    const query = new URL(request.url).searchParams;
    input = context(query);
    cursor = query.get('cursor');
    signatureCursor(cursor);
  } catch {
    return json({ error: 'Invalid tracked wallet, version or cursor.' }, 400);
  }
  const { wallet, version } = input;
  let previous: {
    document: string;
    wallet_updated_at: string;
    observed_at: string;
  } | null;
  try {
    previous = await getD1()
      .prepare(
        'SELECT document,wallet_updated_at,observed_at FROM tracked_signature_snapshots WHERE owner_id=? AND network=? AND address=?',
      )
      .bind(user.userId, wallet.network, wallet.address)
      .first<typeof previous>();
    if (cursor) {
      const page = previous
        ? (JSON.parse(previous.document) as SignaturePage)
        : null;
      if (
        !page ||
        previous?.wallet_updated_at !== version ||
        page.nextCursor !== cursor
      )
        return json(
          {
            error:
              'Retained activity changed. Reload latest activity before continuing.',
          },
          409,
        );
      if (page.signatures.length >= 250)
        return json(
          {
            error:
              'Retained activity limit reached. Reload latest activity to start a new view.',
          },
          409,
        );
    }
  } catch {
    return json(
      { error: 'Retained activity storage temporarily unavailable.' },
      503,
    );
  }
  const url = new URL(request.url);
  url.pathname = '/api/tracker/signatures';
  const response = await providerRead(
    new Request(url, { signal: request.signal }),
  );
  if (!response.ok) return response;
  const data = (await response.json()) as { page: SignaturePage };
  let page = data.page;
  if (cursor && previous) {
    const prior = JSON.parse(previous.document) as SignaturePage;
    if (
      page.anchor !== prior.anchor ||
      page.signatures.some((r) =>
        prior.signatures.some((old) => old.signature === r.signature),
      )
    )
      return json(
        {
          error:
            'Provider returned repeated or inconsistent activity. Previous records retained.',
        },
        502,
      );
    page = { ...page, signatures: [...prior.signatures, ...page.signatures] };
  }
  if (page.signatures.length > 250)
    return json(
      {
        error:
          'Retained activity limit reached. Reload latest activity to start a new view.',
      },
      409,
    );
  try {
    const result = await getD1()
      .prepare(`INSERT INTO tracked_signature_snapshots(owner_id,network,address,document,wallet_updated_at,observed_at)
 SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM tracked_wallets WHERE owner_id=? AND network=? AND address=? AND updated_at=?)
 AND (?='' AND NOT EXISTS(SELECT 1 FROM tracked_signature_snapshots WHERE owner_id=? AND network=? AND address=?) OR EXISTS(SELECT 1 FROM tracked_signature_snapshots WHERE owner_id=? AND network=? AND address=? AND document=?))
 ON CONFLICT(owner_id,network,address) DO UPDATE SET document=excluded.document,wallet_updated_at=excluded.wallet_updated_at,observed_at=excluded.observed_at WHERE tracked_signature_snapshots.observed_at<=excluded.observed_at`)
      .bind(
        user.userId,
        wallet.network,
        wallet.address,
        JSON.stringify(page),
        version,
        page.observedAt,
        user.userId,
        wallet.network,
        wallet.address,
        version,
        previous?.document ?? '',
        user.userId,
        wallet.network,
        wallet.address,
        user.userId,
        wallet.network,
        wallet.address,
        previous?.document ?? '',
      )
      .run();
    if (!result.meta.changes)
      return json(
        {
          error:
            'Wallet or retained activity changed during the read. Reload before continuing.',
        },
        409,
      );
    return json({ page, stale: false, executionAllowed: false });
  } catch {
    return json(
      {
        error:
          'Activity could not be retained. Previous records remain available.',
      },
      503,
    );
  }
}
