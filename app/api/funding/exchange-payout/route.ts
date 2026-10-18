import { z } from 'zod';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { getSolanaRpcEndpoint } from '@/lib/solana-rpc';
import { ExchangeFundingError } from '@/lib/exchange-funding-quote';
import { ExchangePayoutError } from '@/lib/exchange-payout-receipt';
import { verifyOwnedExchangePayout } from '@/lib/exchange-payout-service';
import { readOwnedExchangeOrder } from '@/lib/exchange-order-service';
import { readOwnedExchangeOrderHistory } from '@/lib/exchange-order-history-service';
import {
  cancelExchangePayoutRead,
  createExchangePayoutRpc,
} from '@/lib/exchange-payout-rpc';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...(status === 429 ? { 'retry-after': '15' } : {}),
    },
  });
const selection = z
  .object({ id: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
async function body(request: Request) {
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5000)]);
  const reader = request.body?.getReader();
  if (!reader) throw new ExchangePayoutError('JSON required.', 400);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await cancelExchangePayoutRead(reader.read(), signal);
      if (result.done) break;
      total += result.value.byteLength;
      if (total > 2048) {
        void reader.cancel().catch(() => {});
        throw new ExchangePayoutError('Request too large.', 413);
      }
      chunks.push(result.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return selection.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
  } catch {
    throw new ExchangePayoutError(
      'Choose one exact saved exchange order.',
      400,
    );
  }
}
/** Verifies a retained historical credit. Never creates orders, deposits or distribution authority. */
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to verify an exchange payout.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return json({ error: 'Same-origin request required.' }, 403);
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  )
    return json({ error: 'JSON required.' }, 415);
  try {
    const input = await body(request),
      db = getD1();
    const order = await readOwnedExchangeOrder(db, user.userId, input.id);
    if (order.sha256 !== input.sha256)
      throw new ExchangePayoutError(
        'Saved order differs. Reload it before verifying.',
      );
    if (order.payoutReceipt)
      return json({
        order: await readOwnedExchangeOrderHistory(db, user.userId, input.id),
      });
    const signal = AbortSignal.any([
        request.signal,
        AbortSignal.timeout(30000),
      ]),
      rpc = createExchangePayoutRpc(getSolanaRpcEndpoint('mainnet'));
    let admitted = false;
    await verifyOwnedExchangePayout(
      db,
      user.userId,
      input.id,
      signal,
      async (method, params, readSignal) => {
        readSignal.throwIfAborted();
        if (!admitted) {
          const now = Date.now();
          const gate = await db
            .prepare(
              'INSERT INTO wallet_balance_gates(owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE wallet_balance_gates.next_allowed_at<=?',
            )
            .bind('exchange-payout-verify-v1:' + user.userId, now + 15000, now)
            .run();
          if (!gate.meta.changes)
            throw new ExchangePayoutError(
              'Wait before another payout verification. Reloading saved evidence needs no provider read.',
              429,
            );
          admitted = true;
        }
        return rpc(method, params, readSignal);
      },
    );
    return json({
      order: await readOwnedExchangeOrderHistory(db, user.userId, input.id),
    });
  } catch (error) {
    if (
      error instanceof ExchangePayoutError ||
      error instanceof ExchangeFundingError
    )
      return json({ error: error.message }, error.status);
    return json(
      {
        error:
          'Payout verification is unavailable. Reload saved order evidence; no payment or distribution was authorized.',
      },
      503,
    );
  }
}
