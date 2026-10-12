import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { validateSolanaTrackedWallet as validateTrackedWallet } from '@/lib/tracked-wallet';
import {
  observeTrackedTransaction,
  transactionSignature,
} from '@/lib/tracked-wallet-transaction';
import { trackerTimestamp } from '@/lib/tracked-transaction-history';
import type { TrackedTransactionSummary } from '@/lib/tracked-transaction-history';
type HistoryRow = Omit<
  TrackedTransactionSummary,
  'failed' | 'stale' | 'tokensComplete'
> & { failed: number; tokensComplete: number };
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
function context(body: Record<string, unknown>) {
  return {
    wallet: validateTrackedWallet({ ...body, label: '' }),
    expectedUpdatedAt: trackerTimestamp(body.expectedUpdatedAt),
  };
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to save transaction observations.' }, 401);
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
  let input, signature: string;
  try {
    const text = await request.text();
    if (text.length > 1500)
      return json({ error: 'Transaction request too large.' }, 413);
    const body = JSON.parse(text);
    input = context(body);
    signature = transactionSignature(body.signature);
  } catch {
    return json(
      { error: 'Choose a valid tracked wallet, version and signature.' },
      400,
    );
  }
  const { wallet, expectedUpdatedAt } = input;
  let db: D1Database;
  try {
    db = getD1();
    const row = await db
      .prepare(
        'SELECT updated_at FROM tracked_wallets WHERE owner_id=? AND network=? AND address=?',
      )
      .bind(user.userId, wallet.network, wallet.address)
      .first<{ updated_at: string }>();
    if (!row) return json({ error: 'Tracked wallet not found.' }, 404);
    if (row.updated_at !== expectedUpdatedAt)
      return json(
        { error: 'Tracked wallet changed. Reload the tracker first.' },
        409,
      );
  } catch {
    return json({ error: 'Tracker storage temporarily unavailable.' }, 503);
  }
  let transaction;
  try {
    transaction = await observeTrackedTransaction(
      wallet.address,
      wallet.network,
      signature,
      AbortSignal.any([request.signal, AbortSignal.timeout(25000)]),
    );
  } catch {
    return json(
      {
        error:
          'Transaction provider unavailable or returned incomplete data. Previous observations are retained.',
      },
      502,
    );
  }
  if (!transaction)
    return json(
      {
        error:
          'Transaction not found at confirmed commitment. Previous observations are retained.',
      },
      404,
    );
  try {
    const write = await db
      .prepare(`INSERT INTO tracked_wallet_transactions
      (owner_id,network,address,signature,document,wallet_updated_at,slot,observed_at)
      SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM tracked_wallets WHERE owner_id=? AND network=? AND address=? AND updated_at=?)
      ON CONFLICT(owner_id,network,address,signature) DO UPDATE SET document=excluded.document,
      wallet_updated_at=excluded.wallet_updated_at,observed_at=excluded.observed_at
      WHERE tracked_wallet_transactions.slot=excluded.slot AND tracked_wallet_transactions.observed_at<=excluded.observed_at`)
      .bind(
        user.userId,
        wallet.network,
        wallet.address,
        signature,
        JSON.stringify(transaction),
        expectedUpdatedAt,
        transaction.slot,
        transaction.observedAt,
        user.userId,
        wallet.network,
        wallet.address,
        expectedUpdatedAt,
      )
      .run();
    if (!write.meta.changes)
      return json(
        {
          error:
            'Wallet changed, a newer observation arrived, or the transaction confirmation slot changed. Previous observation retained; reload before retrying.',
        },
        409,
      );
    return json({
      transaction,
      capturedUpdatedAt: expectedUpdatedAt,
      stale: false,
    });
  } catch {
    return json(
      {
        error:
          'Could not retain transaction. Previous observations are retained.',
      },
      503,
    );
  }
}
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json(
      { error: 'Sign in to view saved transaction observations.' },
      401,
    );
  let input,
    signature: string | null,
    cursor: { observedAt: string; signature: string } | null = null;
  try {
    const params = new URL(request.url).searchParams;
    input = context(Object.fromEntries(params));
    signature = params.has('signature')
      ? transactionSignature(params.get('signature'))
      : null;
    if (params.has('cursor')) {
      const parsed = JSON.parse(params.get('cursor') ?? '');
      cursor = {
        observedAt: trackerTimestamp(parsed.observedAt),
        signature: transactionSignature(parsed.signature),
      };
    }
    if (signature && cursor) throw new Error('Conflicting query.');
  } catch {
    return json(
      { error: 'Invalid tracked wallet, signature or history cursor.' },
      400,
    );
  }
  const { wallet, expectedUpdatedAt } = input;
  try {
    const db = getD1();
    const version = () =>
      db
        .prepare(
          'SELECT updated_at FROM tracked_wallets WHERE owner_id=? AND network=? AND address=?',
        )
        .bind(user.userId, wallet.network, wallet.address)
        .first<{ updated_at: string }>();
    const row = await version();
    if (!row) return json({ error: 'Tracked wallet not found.' }, 404);
    if (row.updated_at !== expectedUpdatedAt)
      return json(
        { error: 'Tracked wallet changed. Reload the tracker first.' },
        409,
      );
    const query = signature
      ? db
          .prepare(
            'SELECT document,wallet_updated_at FROM tracked_wallet_transactions WHERE owner_id=? AND network=? AND address=? AND signature=?',
          )
          .bind(user.userId, wallet.network, wallet.address, signature)
          .first<{ document: string; wallet_updated_at: string }>()
      : db
          .prepare(`SELECT signature,slot,observed_at AS observedAt,wallet_updated_at AS capturedUpdatedAt,
        json_extract(document,'$.failed') AS failed,json_extract(document,'$.feeRaw') AS feeRaw,
        json_extract(document,'$.nativeChangeRaw') AS nativeChangeRaw,
        json_array_length(document,'$.tokenChanges') AS tokenChangeCount,json_extract(document,'$.tokensComplete') AS tokensComplete
        FROM tracked_wallet_transactions WHERE owner_id=? AND network=? AND address=?
        AND (? IS NULL OR observed_at<? OR (observed_at=? AND signature<?))
        ORDER BY observed_at DESC,signature DESC LIMIT 21`)
          .bind(
            user.userId,
            wallet.network,
            wallet.address,
            cursor?.observedAt ?? null,
            cursor?.observedAt ?? null,
            cursor?.observedAt ?? null,
            cursor?.signature ?? null,
          )
          .all();
    const result = await query;
    const latest = await version();
    if (!latest || latest.updated_at !== expectedUpdatedAt)
      return json(
        {
          error:
            'Tracked wallet changed while reading history. Reload and try again.',
        },
        409,
      );
    if (signature) {
      const saved = result as {
        document: string;
        wallet_updated_at: string;
      } | null;
      if (!saved)
        return json({ error: 'Saved transaction observation not found.' }, 404);
      return json({
        transaction: JSON.parse(saved.document),
        capturedUpdatedAt: saved.wallet_updated_at,
        stale: saved.wallet_updated_at !== expectedUpdatedAt,
      });
    }
    const rows = (result as D1Result<HistoryRow>).results;
    const items = rows.slice(0, 20).map((r) => ({
      ...r,
      failed: Boolean(r.failed),
      tokensComplete: Boolean(r.tokensComplete),
      stale: r.capturedUpdatedAt !== expectedUpdatedAt,
    }));
    const last = items.at(-1);
    return json({
      items,
      nextCursor:
        rows.length > 20 && last
          ? JSON.stringify({
              observedAt: last.observedAt,
              signature: last.signature,
            })
          : null,
    });
  } catch {
    return json(
      { error: 'Transaction history storage temporarily unavailable.' },
      503,
    );
  }
}
