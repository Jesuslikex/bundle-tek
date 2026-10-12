import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletAddress } from '@/lib/wallet-workspace';
import { validatedWithdrawalActivity } from '@/lib/withdrawal-activity';
import type { NativeWithdrawal } from '@/lib/native-withdrawal';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to view withdrawal activity.' }, 401);
  const params = new URL(request.url).searchParams,
    cursor = params.get('cursor');
  let wallet: string | null;
  try {
    wallet = params.has('wallet')
      ? walletAddress(params.get('wallet'), 'Solana')
      : null;
    if (
      cursor !== null &&
      (!/^[1-9]\d{0,15}$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))
    )
      throw new Error();
  } catch {
    return json({ error: 'Invalid withdrawal activity context.' }, 400);
  }
  try {
    const db = getD1();
    const anchor = cursor
      ? await db
          .prepare(
            'SELECT sequence,created_at AS createdAt FROM native_withdrawal_events WHERE owner_id=? AND sequence=? AND (? IS NULL OR wallet_address=?)',
          )
          .bind(user.userId, Number(cursor), wallet, wallet)
          .first<{ sequence: number; createdAt: string }>()
      : null;
    if (cursor && !anchor)
      return json({ error: 'Withdrawal activity cursor unavailable.' }, 400);
    const result = await db
      .prepare(
        'SELECT e.sequence,e.created_at AS eventCreatedAt,e.state,e.signature,e.failure_receipt AS failureReceipt,w.id,w.wallet_address AS wallet,w.wallet_revision AS walletRevision,w.document,w.receipt,w.created_at AS createdAt FROM native_withdrawal_events e JOIN native_withdrawals w ON w.id=e.intent_id AND w.owner_id=e.owner_id AND w.wallet_address=e.wallet_address WHERE e.owner_id=? AND (? IS NULL OR e.wallet_address=?) AND (? IS NULL OR e.created_at<? OR (e.created_at=? AND e.sequence<?)) ORDER BY e.created_at DESC,e.sequence DESC LIMIT 51',
      )
      .bind(
        user.userId,
        wallet,
        wallet,
        anchor?.createdAt ?? null,
        anchor?.createdAt ?? '',
        anchor?.createdAt ?? '',
        anchor?.sequence ?? 0,
      )
      .all<
        Omit<
          NativeWithdrawal,
          'updatedAt' | 'document' | 'receipt' | 'failureReceipt'
        > & {
          sequence: number;
          eventCreatedAt: string;
          document: string;
          receipt: string | null;
          failureReceipt: string | null;
        }
      >();
    const events = await Promise.all(
      result.results.slice(0, 50).map((row) =>
        validatedWithdrawalActivity({
          sequence: row.sequence,
          createdAt: row.eventCreatedAt,
          withdrawal: {
            id: row.id,
            wallet: row.wallet,
            walletRevision: row.walletRevision,
            state: row.state,
            signature: row.signature,
            document: JSON.parse(row.document),
            receipt:
              row.state === 'finalized' ? JSON.parse(row.receipt!) : null,
            failureReceipt: row.failureReceipt
              ? JSON.parse(row.failureReceipt)
              : null,
            createdAt: row.createdAt,
            updatedAt: row.eventCreatedAt,
          },
        }),
      ),
    );
    return json({
      events,
      nextCursor:
        result.results.length > 50 ? String(events.at(-1)!.sequence) : null,
    });
  } catch {
    return json({ error: 'Withdrawal activity unavailable.' }, 503);
  }
}
