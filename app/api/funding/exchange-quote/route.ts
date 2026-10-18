import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { env } from '@/lib/server-env';
import {
  ExchangeFundingError,
  exchangeFundingSelection,
  previewOwnedExchangeFunding,
  readOwnedExchangeFundingQuote,
  readLatestOwnedExchangeFundingQuote,
} from '@/lib/exchange-funding-quote';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to read exchange funding reviews.' }, 401);
  try {
    const params = new URL(request.url).searchParams;
    if (params.toString() === 'status=1')
      return json({
        provider: 'ChangeNOW',
        quotesConfigured: Boolean(
          env.BUNDLE_EXCHANGE_QUOTES_ENABLED === 'true' &&
          env.CHANGENOW_API_KEY,
        ),
        orderCreationAllowed: false,
        fundingAllowed: false,
        signingAllowed: false,
        executionAllowed: false,
      });
    if (params.size === 1 && params.has('planId'))
      return json({
        quote: await readLatestOwnedExchangeFundingQuote(
          getD1(),
          user.userId,
          params.get('planId') ?? '',
        ),
      });
    if (params.size !== 1 || !params.has('id'))
      return json({ error: 'Choose one saved review or funding draft.' }, 400);
    return json({
      quote: await readOwnedExchangeFundingQuote(
        getD1(),
        user.userId,
        params.get('id') ?? '',
      ),
    });
  } catch (error) {
    return json(
      {
        error:
          error instanceof ExchangeFundingError
            ? error.message
            : 'Exchange funding history unavailable.',
      },
      error instanceof ExchangeFundingError ? error.status : 503,
    );
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to review exchange funding.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return json({ error: 'Same-origin request required.' }, 403);
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  )
    return json({ error: 'JSON required.' }, 415);
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 2048)
      return json({ error: 'Request too large.' }, 413);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return json({ error: 'Valid JSON required.' }, 400);
    }
    const input = exchangeFundingSelection(value);
    const quote = await previewOwnedExchangeFunding(
      getD1(),
      user.userId,
      input,
      request.signal,
      {
        key: env.CHANGENOW_API_KEY,
        enabled: env.BUNDLE_EXCHANGE_QUOTES_ENABLED === 'true',
      },
    );
    return json({ quote });
  } catch (error) {
    if (request.signal.aborted)
      return json({ error: 'Exchange quote cancelled.' }, 408);
    if (error instanceof ExchangeFundingError)
      return json({ error: error.message }, error.status);
    return json(
      {
        error:
          'Exchange funding review unavailable. Saved drafts are unchanged.',
      },
      503,
    );
  }
}
