import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { validateSolanaTrackedWallet as validateTrackedWallet } from '@/lib/tracked-wallet';
import {
  observeTrackedTransaction,
  transactionSignature,
} from '@/lib/tracked-wallet-transaction';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to inspect tracked transactions.' }, 401);
  let wallet, signature: string, expectedUpdatedAt: string;
  try {
    const query = new URL(request.url).searchParams;
    wallet = validateTrackedWallet({
      address: query.get('address'),
      network: query.get('network'),
      label: '',
    });
    signature = transactionSignature(query.get('signature'));
    expectedUpdatedAt = query.get('expectedUpdatedAt') ?? '';
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
        expectedUpdatedAt,
      ) ||
      !Number.isFinite(Date.parse(expectedUpdatedAt)) ||
      new Date(expectedUpdatedAt).toISOString() !== expectedUpdatedAt
    )
      throw new Error('Invalid wallet version.');
  } catch {
    return json(
      {
        error:
          'Choose a valid tracked wallet, version and transaction signature.',
      },
      400,
    );
  }
  let db: D1Database;
  const readVersion = (database: D1Database) =>
    database
      .prepare(
        `SELECT updated_at FROM tracked_wallets WHERE owner_id=? AND address=? AND network=?`,
      )
      .bind(user.userId, wallet.address, wallet.network)
      .first<{ updated_at: string }>();
  try {
    db = getD1();
    const row = await readVersion(db);
    if (!row) return json({ error: 'Tracked wallet not found.' }, 404);
    if (row.updated_at !== expectedUpdatedAt)
      return json({ error: 'Wallet changed. Reload the tracker first.' }, 409);
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
          'Transaction provider unavailable or returned incomplete data. Try again later.',
      },
      502,
    );
  }
  try {
    const latest = await readVersion(db);
    if (!latest || latest.updated_at !== expectedUpdatedAt)
      return json(
        {
          error:
            'Tracked wallet changed during inspection. Reload and try again.',
        },
        409,
      );
  } catch {
    return json({ error: 'Tracker storage temporarily unavailable.' }, 503);
  }
  if (!transaction)
    return json(
      {
        error:
          'Transaction not found at confirmed commitment. The provider may not retain this history.',
      },
      404,
    );
  return json({ transaction });
}
