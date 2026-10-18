import { z } from 'zod';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  ExchangeFundingError,
  readOwnedExchangeFundingQuote,
} from '@/lib/exchange-funding-quote';
import {
  exchangeOrderReviewInput,
  exchangeRefundAddress,
} from '@/lib/exchange-order-review';
import { prepareOwnedExchangeOrderReview } from '@/lib/exchange-order-service';
import { readOwnedExchangeOrderHistory } from '@/lib/exchange-order-history-service';
import { exchangeUiRequest } from '@/lib/exchange-ui-request';

export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
const unavailable = () =>
  json(
    {
      error:
        'The review save outcome is unavailable. Reload the saved review for this quote before retrying. No provider order or payment was requested.',
    },
    503,
  );
async function body(request: Request) {
  return exchangeUiRequest(
    request.signal,
    async (signal) => {
      const reader = request.body?.getReader();
      if (!reader) throw new ExchangeFundingError('JSON required.', 400);
      const chunks: Uint8Array[] = [];
      let total = 0;
      const cancel = () => {
        void reader.cancel().catch(() => {});
      };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        while (true) {
          signal.throwIfAborted();
          const part = await reader.read();
          if (part.done) break;
          total += part.value.byteLength;
          if (total > 2048)
            throw new ExchangeFundingError('Request too large.', 413);
          chunks.push(part.value);
        }
        signal.throwIfAborted();
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        try {
          return exchangeOrderReviewInput.parse(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
          );
        } catch {
          throw new ExchangeFundingError(
            'Choose one saved quote and exact refund wallet revision.',
            400,
          );
        }
      } finally {
        signal.removeEventListener('abort', cancel);
        cancel();
        reader.releaseLock();
      }
    },
    5000,
  );
}
/** Saves review terms only. No provider transport, consent, order attempt or signing. */
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to prepare an exchange review.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return json({ error: 'Same-origin request required.' }, 403);
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  )
    return json({ error: 'JSON required.' }, 415);
  try {
    const input = await body(request);
    request.signal.throwIfAborted();
    const db = getD1();
    try {
      exchangeRefundAddress(input.refund.address);
    } catch {
      throw new ExchangeFundingError(
        'Choose a canonical Solana refund wallet.',
        400,
      );
    }
    const quote = await readOwnedExchangeFundingQuote(
      db,
      user.userId,
      input.quoteId,
    );
    if (input.refund.address === quote.funder)
      throw new ExchangeFundingError(
        'Choose a refund wallet separate from the receiving funder.',
        400,
      );
    request.signal.throwIfAborted();
    const saved = await prepareOwnedExchangeOrderReview(db, user.userId, input);
    return json({
      order: await readOwnedExchangeOrderHistory(
        db,
        user.userId,
        saved.terms.id,
      ),
    });
  } catch (error) {
    if (error instanceof ExchangeFundingError)
      return json({ error: error.message }, error.status);
    return unavailable();
  }
}
/** Recovers a saved review by its original quote, including after expiry, with no write or provider read. */
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to recover a saved exchange review.' }, 401);
  const params = new URL(request.url).searchParams;
  if (params.size !== 1 || !z.uuid().safeParse(params.get('quoteId')).success)
    return json({ error: 'Choose one exact saved quote.' }, 400);
  try {
    const db = getD1();
    const row = await db
      .prepare(
        'SELECT id FROM exchange_funding_order_reviews WHERE owner_id=? AND quote_id=?',
      )
      .bind(user.userId, params.get('quoteId'))
      .first<{ id: string }>();
    const order = row
      ? await readOwnedExchangeOrderHistory(db, user.userId, row.id)
      : null;
    if (order && order.quote.id !== params.get('quoteId')) return unavailable();
    return json({ order });
  } catch {
    return unavailable();
  }
}
