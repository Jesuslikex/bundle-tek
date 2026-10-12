import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  observeWalletBalances,
  validateBalanceRequest,
} from '@/lib/wallet-balances';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to refresh wallet balances.' }, 401);
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  )
    return json({ error: 'JSON required.' }, 415);
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return json({ error: 'Cross-origin request rejected.' }, 403);
  let input;
  try {
    const text = await request.text();
    if (text.length > 15000)
      return json({ error: 'Balance request too large.' }, 413);
    input = validateBalanceRequest(JSON.parse(text));
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : 'Invalid balance request.' },
      400,
    );
  }
  let db: D1Database;
  const owner = user.userId;
  let wallets: Array<{ address: string; revision: number }>;
  try {
    db = getD1();
    const result = await db
      .prepare(`SELECT w.address,w.revision FROM workspace_wallets w
      WHERE w.owner_id=? AND w.chain=? AND w.archived=0 AND w.address IN (SELECT value FROM json_each(?))`)
      .bind(owner, input.chain, JSON.stringify(input.addresses))
      .all<{ address: string; revision: number }>();
    wallets = result.results;
    if (wallets.length !== input.addresses.length)
      return json(
        { error: 'Refresh only saved wallets in active folders.' },
        404,
      );
    const now = Date.now();
    const gate = await db
      .prepare(
        `INSERT INTO wallet_balance_gates (owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE wallet_balance_gates.next_allowed_at<=?`,
      )
      .bind(owner, now + 15000, now)
      .run();
    if (!gate.meta.changes)
      return json({ error: 'Wait 15 seconds between balance refreshes.' }, 429);
  } catch {
    return json({ error: 'Wallet storage temporarily unavailable.' }, 503);
  }
  let snapshot;
  const controller = new AbortController();
  const signal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(25000),
    controller.signal,
  ]);
  try {
    snapshot = await observeWalletBalances(
      input.chain,
      input.addresses,
      signal,
    );
  } catch (e) {
    controller.abort();
    return json(
      {
        error:
          e instanceof Error
            ? e.message
            : 'Balance provider unavailable. Previous observations are retained.',
      },
      502,
    );
  }
  try {
    const entries = snapshot.items.map((balance) => ({
      balance,
      revision: wallets.find((w) => w.address === balance.address)!.revision,
    }));
    const result = await db
      .prepare(`WITH incoming AS (SELECT json_extract(value,'$.balance.address') AS address,json_extract(value,'$.revision') AS revision,json_extract(value,'$.balance') AS document FROM json_each(?)),
      eligible AS (SELECT i.address,i.document FROM incoming i JOIN workspace_wallets w ON w.address=i.address AND w.revision=i.revision
      WHERE w.owner_id=? AND w.chain=? AND w.archived=0 AND NOT EXISTS (SELECT 1 FROM wallet_balance_snapshots s WHERE s.owner_id=w.owner_id AND s.chain=w.chain AND s.address=w.address AND s.block_number>?))
      INSERT INTO wallet_balance_snapshots (owner_id,chain,address,document,block_number) SELECT ?,?,address,document,? FROM eligible WHERE (SELECT COUNT(*) FROM eligible)=(SELECT COUNT(*) FROM incoming)
      ON CONFLICT(owner_id,chain,address) DO UPDATE SET document=excluded.document,block_number=excluded.block_number`)
      .bind(
        JSON.stringify(entries),
        owner,
        input.chain,
        snapshot.blockNumber,
        owner,
        input.chain,
        snapshot.blockNumber,
      )
      .run();
    if (result.meta.changes !== entries.length)
      return json(
        {
          error:
            'Wallets changed or newer balances arrived during refresh. Reload and try again.',
        },
        409,
      );
    return json({ snapshot });
  } catch {
    return json(
      {
        error: 'Could not retain this balance snapshot. Reload and try again.',
      },
      503,
    );
  }
}
