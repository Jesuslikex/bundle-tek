import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { validateTrackedWallet } from '@/lib/tracked-wallet';
import { trackerTimestamp } from '@/lib/tracked-transaction-history';
import { evmChain } from '@/lib/evm-network';
import {
  evmTransactionHash,
  observeEvmTransaction,
} from '@/lib/tracked-evm-transaction';
import type { EvmTransactionObservation } from '@/lib/tracked-evm-transaction';
import { observeTransferIdentities } from '@/lib/evm-transfer-identity';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
function input(value: Record<string, unknown>) {
  const wallet = validateTrackedWallet({ ...value, label: '' });
  return {
    address: wallet.address,
    network: evmChain(wallet.network),
    expectedUpdatedAt: trackerTimestamp(value.expectedUpdatedAt),
  };
}
function owned(
  db: D1Database,
  owner: string,
  wallet: ReturnType<typeof input>,
) {
  return db
    .prepare(
      'SELECT updated_at,archived FROM tracked_wallets WHERE owner_id=? AND network=? AND address=?',
    )
    .bind(owner, wallet.network, wallet.address)
    .first<{ updated_at: string; archived: number }>();
}
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to read saved EVM transactions.' }, 401);
  let wallet;
  try {
    wallet = input(Object.fromEntries(new URL(request.url).searchParams));
  } catch {
    return json({ error: 'Choose a valid EVM tracked wallet version.' }, 400);
  }
  try {
    const db = getD1(),
      row = await owned(db, user.userId, wallet);
    if (!row) return json({ error: 'Tracked wallet not found.' }, 404);
    if (row.updated_at !== wallet.expectedUpdatedAt)
      return json({ error: 'Wallet changed. Reload the tracker.' }, 409);
    const rows = await db
      .prepare(
        'SELECT document,wallet_updated_at FROM tracked_evm_transactions WHERE owner_id=? AND network=? AND address=? ORDER BY observed_at DESC,hash DESC LIMIT 100',
      )
      .bind(user.userId, wallet.network, wallet.address)
      .all<{ document: string; wallet_updated_at: string }>();
    const latest = await owned(db, user.userId, wallet);
    if (latest?.updated_at !== row.updated_at)
      return json({ error: 'Wallet changed while reading transactions.' }, 409);
    return json({
      currentUpdatedAt: row.updated_at,
      executionAllowed: false,
      observations: rows.results.map((r) => ({
        transaction: JSON.parse(r.document),
        capturedUpdatedAt: r.wallet_updated_at,
        stale: r.wallet_updated_at !== row.updated_at,
      })),
    });
  } catch {
    return json({ error: 'Transaction storage unavailable.' }, 503);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to inspect EVM transactions.' }, 401);
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
  let wallet, hash, action: 'inspect' | 'identity';
  try {
    const text = await request.text();
    if (text.length > 600) return json({ error: 'Request too large.' }, 413);
    const value = JSON.parse(text);
    wallet = input(value);
    hash = evmTransactionHash(value.hash);
    action = value.action ?? 'inspect';
    if (action !== 'inspect' && action !== 'identity')
      throw new Error('Invalid action.');
  } catch {
    return json(
      { error: 'Choose a valid EVM wallet version and transaction hash.' },
      400,
    );
  }
  let db: D1Database, previous: string | null;
  try {
    db = getD1();
    const row = await owned(db, user.userId, wallet);
    if (!row) return json({ error: 'Tracked wallet not found.' }, 404);
    if (row.archived || row.updated_at !== wallet.expectedUpdatedAt)
      return json({ error: 'Wallet changed or is archived.' }, 409);
    previous =
      (
        await db
          .prepare(
            'SELECT document FROM tracked_evm_transactions WHERE owner_id=? AND network=? AND address=? AND hash=?',
          )
          .bind(user.userId, wallet.network, wallet.address, hash)
          .first<{ document: string }>()
      )?.document ?? null;
    if (action === 'identity' && !previous)
      return json(
        {
          error:
            'Save a transaction observation before reading token identities.',
        },
        409,
      );
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
    return json({ error: 'Transaction storage unavailable.' }, 503);
  }
  let transaction;
  try {
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(25000),
    ]);
    if (action === 'identity') {
      transaction = JSON.parse(previous!) as EvmTransactionObservation;
      if (
        transaction.chain !== wallet.network ||
        transaction.address !== wallet.address ||
        transaction.hash !== hash
      )
        throw new Error('Saved transaction context mismatch.');
      const report = await observeTransferIdentities(transaction, signal);
      if (!report.identities.length)
        return json(
          {
            error:
              'Historical token identities unavailable. Raw events and previous identities retained.',
          },
          502,
        );
      const old = transaction.tokenIdentity?.identities ?? [];
      report.identities.push(
        ...old.filter(
          (t) =>
            report.unavailable.includes(t.contract) &&
            t.blockHash === transaction!.blockHash &&
            String(t.blockNumber) === transaction!.blockNumber,
        ),
      );
      transaction = { ...transaction, tokenIdentity: report };
    } else
      transaction = await observeEvmTransaction(
        wallet.network,
        wallet.address,
        hash,
        signal,
      );
  } catch {
    return json(
      {
        error:
          'Provider unavailable or transaction evidence is inconsistent or unrelated. Saved observations retained.',
      },
      502,
    );
  }
  if (!transaction)
    return json(
      {
        error:
          'Mined transaction not found. Pending or unretained history is unavailable.',
      },
      404,
    );
  try {
    if (action === 'identity') {
      const write = await db
        .prepare(`UPDATE tracked_evm_transactions SET document=?,wallet_updated_at=?
        WHERE owner_id=? AND network=? AND address=? AND hash=? AND document=?
        AND EXISTS(SELECT 1 FROM tracked_wallets WHERE owner_id=? AND network=? AND address=? AND updated_at=? AND archived=0)`)
        .bind(
          JSON.stringify(transaction),
          wallet.expectedUpdatedAt,
          user.userId,
          wallet.network,
          wallet.address,
          hash,
          previous,
          user.userId,
          wallet.network,
          wallet.address,
          wallet.expectedUpdatedAt,
        )
        .run();
      if (!write.meta.changes)
        return json(
          {
            error:
              'Wallet or transaction changed during identity lookup. Previous record retained.',
          },
          409,
        );
      return json({
        transaction,
        capturedUpdatedAt: wallet.expectedUpdatedAt,
        stale: false,
        executionAllowed: false,
      });
    }
    const write = await db
      .prepare(`INSERT INTO tracked_evm_transactions(owner_id,network,address,hash,document,wallet_updated_at,observed_at)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM tracked_wallets WHERE owner_id=? AND network=? AND address=? AND archived=0 AND updated_at=?)
      AND (? IS NULL AND NOT EXISTS(SELECT 1 FROM tracked_evm_transactions WHERE owner_id=? AND network=? AND address=? AND hash=?) OR EXISTS(SELECT 1 FROM tracked_evm_transactions WHERE owner_id=? AND network=? AND address=? AND hash=? AND document=?))
      AND (EXISTS(SELECT 1 FROM tracked_evm_transactions WHERE owner_id=? AND network=? AND address=? AND hash=?) OR (SELECT COUNT(*) FROM tracked_evm_transactions WHERE owner_id=? AND network=? AND address=?)<100)
      ON CONFLICT(owner_id,network,address,hash) DO UPDATE SET document=excluded.document,wallet_updated_at=excluded.wallet_updated_at,observed_at=excluded.observed_at WHERE tracked_evm_transactions.observed_at<excluded.observed_at`)
      .bind(
        user.userId,
        wallet.network,
        wallet.address,
        hash,
        JSON.stringify(transaction),
        wallet.expectedUpdatedAt,
        transaction.observedAt,
        user.userId,
        wallet.network,
        wallet.address,
        wallet.expectedUpdatedAt,
        previous,
        user.userId,
        wallet.network,
        wallet.address,
        hash,
        user.userId,
        wallet.network,
        wallet.address,
        hash,
        previous,
        user.userId,
        wallet.network,
        wallet.address,
        hash,
        user.userId,
        wallet.network,
        wallet.address,
      )
      .run();
    if (!write.meta.changes)
      return json(
        {
          error:
            'Wallet or saved observation changed, a newer read arrived, or the 100-transaction limit was reached. Previous records retained.',
        },
        409,
      );
    return json({
      transaction,
      capturedUpdatedAt: wallet.expectedUpdatedAt,
      stale: false,
      executionAllowed: false,
    });
  } catch {
    return json(
      {
        error:
          'Transaction could not be retained. Previous records remain saved.',
      },
      503,
    );
  }
}
