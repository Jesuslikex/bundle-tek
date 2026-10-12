import type { WarmupSigningReview } from '@/lib/warmup-signing';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { UUID } from '@/lib/wallet-operation';
import { transactionSignature } from '@/lib/tracked-wallet-transaction';
import type { SavedWarmupPreparation } from '@/lib/warmup-preparation-history';
import type { SavedWarmupBuyReceipt } from '@/lib/warmup-buy-receipt';
import {
  warmupReceiptCursor,
  warmupReceiptPage,
} from '@/lib/warmup-receipt-history';
import {
  observeWarmupSellReceipt,
  saveWarmupSellReceipt,
} from '@/lib/warmup-sell-receipt';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to view sell receipts.' }, 401);
  const url = new URL(request.url),
    id = url.searchParams.get('id');
  if (!id || !/^[a-zA-Z0-9-]{1,64}$/.test(id))
    return json({ error: 'Choose a saved warmup.' }, 400);
  let cursor;
  try {
    cursor = warmupReceiptCursor(url.searchParams.get('cursor'));
  } catch {
    return json({ error: 'Invalid sell receipt cursor.' }, 400);
  }
  try {
    const db = getD1();
    if (
      !(await db
        .prepare('SELECT id FROM wallet_warmup_plans WHERE owner_id=? AND id=?')
        .bind(user.userId, id)
        .first())
    )
      return json({ error: 'Warmup unavailable.' }, 404);
    const page = await warmupReceiptPage<{
      id: string;
      preparationId: string;
      planId: string;
      createdAt: string;
      document: string;
    }>(
      db,
      'sell',
      'id,preparation_id AS preparationId,plan_id AS planId,created_at AS createdAt,document',
      user.userId,
      id,
      cursor,
    );
    if (!page) return json({ error: 'Sell receipt cursor unavailable.' }, 400);
    return json({
      planId: id,
      receipts: page.rows.map((row) => ({
        ...row,
        document: JSON.parse(row.document),
      })),
      nextCursor: page.nextCursor,
    });
  } catch {
    return json({ error: 'Sell history unavailable.' }, 503);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to verify a sell.' }, 401);
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
  let preparationId: string, signature: string;
  try {
    const text = await request.text();
    if (text.length > 300) return json({ error: 'Request too large.' }, 413);
    const body = JSON.parse(text);
    if (!body || !UUID.test(body.preparationId)) throw new Error();
    preparationId = body.preparationId;
    signature = transactionSignature(body.signature);
  } catch {
    return json(
      { error: 'Choose a saved linked sell and its signature.' },
      400,
    );
  }
  try {
    const db = getD1();
    const prior = () =>
      db
        .prepare(
          'SELECT id,preparation_id AS preparationId,plan_id AS planId,created_at AS createdAt,signature,document FROM warmup_sell_receipts WHERE owner_id=? AND preparation_id=?',
        )
        .bind(user.userId, preparationId)
        .first<{
          id: string;
          preparationId: string;
          planId: string;
          createdAt: string;
          signature: string;
          document: string;
        }>();
    const existing = await prior();
    if (existing)
      return existing.signature === signature
        ? json({
            receipt: { ...existing, document: JSON.parse(existing.document) },
          })
        : json({ error: 'Sell already has a different receipt.' }, 409);
    const row = await db
      .prepare(
        'SELECT id,plan_id AS planId,plan_revision AS planRevision,cycle,wallet_revision AS walletRevision,created_at AS createdAt,document FROM warmup_swap_preparations WHERE owner_id=? AND id=?',
      )
      .bind(user.userId, preparationId)
      .first<Omit<SavedWarmupPreparation, 'document'> & { document: string }>();
    if (!row) return json({ error: 'Saved sell unavailable.' }, 404);
    const preparation = {
      ...row,
      document: JSON.parse(row.document),
    } as SavedWarmupPreparation;
    if (
      preparation.document.side !== 'Sell' ||
      !preparation.document.buyReceipt
    )
      return json({ error: 'Choose a buy-linked sell.' }, 409);
    const lot = await db
      .prepare(
        'SELECT id,preparation_id AS preparationId,plan_id AS planId,plan_revision AS planRevision,cycle,wallet_revision AS walletRevision,created_at AS createdAt,remaining_raw AS remainingRaw,document FROM warmup_buy_receipts WHERE owner_id=? AND id=?',
      )
      .bind(user.userId, preparation.document.buyReceipt.receiptId)
      .first<Omit<SavedWarmupBuyReceipt, 'document'> & { document: string }>();
    if (!lot) return json({ error: 'Matched buy unavailable.' }, 409);
    const buy = {
      ...lot,
      document: JSON.parse(lot.document),
    } as SavedWarmupBuyReceipt;
    const now = Date.now();
    const gate = await db
      .prepare(
        'INSERT INTO wallet_balance_gates(owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE wallet_balance_gates.next_allowed_at<=?',
      )
      .bind(user.userId, now + 15000, now)
      .run();
    if (!gate.meta.changes)
      return json({ error: 'Wait 15 seconds between wallet reads.' }, 429);
    const intent = await db
      .prepare(
        "SELECT document FROM warmup_signing_intents WHERE owner_id=? AND preparation_id=? AND signature=? AND state IN ('signed','submitted')",
      )
      .bind(user.userId, preparationId, signature)
      .first<{ document: string }>();
    const approval = intent
      ? (JSON.parse(intent.document) as WarmupSigningReview)
      : undefined;
    let document;
    try {
      document = await observeWarmupSellReceipt(
        preparation,
        buy,
        signature,
        AbortSignal.any([request.signal, AbortSignal.timeout(25000)]),
        fetch,
        approval,
      );
    } catch {
      return json(
        {
          error:
            'Finalized sell receipt unavailable or packet, token debit or native output differs from the saved review.',
        },
        502,
      );
    }
    const receipt = await saveWarmupSellReceipt(
      db,
      user.userId,
      preparation,
      buy,
      document,
    );
    if (receipt) return json({ receipt });
    const concurrent = await prior();
    if (concurrent?.signature === signature)
      return json({
        receipt: { ...concurrent, document: JSON.parse(concurrent.document) },
      });
    return json(
      {
        error:
          'Remaining buy units changed or signature was already recorded. Refresh receipts.',
      },
      409,
    );
  } catch {
    return json({ error: 'Sell receipt storage unavailable.' }, 503);
  }
}
