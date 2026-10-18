import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { ExchangeFundingError } from '@/lib/exchange-funding-quote';
import { ExchangePayoutError } from '@/lib/exchange-payout-receipt';
import {
  listOwnedExchangeOrderHistory,
  readOwnedExchangeOrderHistory,
} from '@/lib/exchange-order-history-service';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to read saved exchange orders.' }, 401);
  const params = new URL(request.url).searchParams;
  try {
    if (params.size === 1 && params.has('id'))
      return json({
        order: await readOwnedExchangeOrderHistory(
          getD1(),
          user.userId,
          params.get('id')!,
        ),
      });
    if (
      (params.size === 1 || (params.size === 2 && params.has('before'))) &&
      params.has('planId')
    )
      return json(
        await listOwnedExchangeOrderHistory(
          getD1(),
          user.userId,
          params.get('planId')!,
          params.get('before') ?? undefined,
        ),
      );
    return json(
      {
        error: 'Choose one saved order or a funding draft and history cursor.',
      },
      400,
    );
  } catch (error) {
    if (
      error instanceof ExchangeFundingError ||
      error instanceof ExchangePayoutError
    )
      return json({ error: error.message }, error.status);
    return json(
      {
        error:
          'Saved exchange order history is unavailable. Reload after storage is available.',
      },
      503,
    );
  }
}
