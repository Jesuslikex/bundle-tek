import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletRequest } from '@/lib/wallet-request';
import {
  cartRequest,
  reviewMarketplaceCart,
  MarketplaceCartError,
} from '@/lib/marketplace-cart';
import { readBundleCatalog } from '@/lib/marketplace-publication-storage';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function POST(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user)
      return json({ error: 'Sign in to review selected wallets.' }, 401);
    if (request.headers.get('origin') !== new URL(request.url).origin)
      return json({ error: 'Same-origin request required.' }, 403);
    if (
      request.headers
        .get('content-type')
        ?.split(';')[0]
        .trim()
        .toLowerCase() !== 'application/json'
    )
      return json({ error: 'JSON required.' }, 415);
    let selection;
    try {
      selection = cartRequest.parse(await walletRequest(request, 32768));
    } catch (error) {
      if (request.signal.aborted) throw error;
      const large =
        error instanceof Error && error.message === 'Wallet request too large.';
      return json(
        {
          error: large
            ? 'Request too large.'
            : 'Choose 1 to 200 distinct Solana listings with their exact public fingerprints.',
        },
        large ? 413 : 400,
      );
    }
    request.signal.throwIfAborted();
    const catalog = await readBundleCatalog(getD1(), request.signal),
      review = await reviewMarketplaceCart(selection, catalog);
    request.signal.throwIfAborted();
    if (Date.now() >= Date.parse(review.expiresAt))
      return json(
        { error: 'Cart review expired. Refresh inventory and review again.' },
        409,
      );
    return json({ review });
  } catch (error) {
    if (request.signal.aborted)
      return json(
        {
          error: 'Cart review cancelled. No reservation or purchase was sent.',
        },
        408,
      );
    if (error instanceof MarketplaceCartError)
      return json({ error: error.message }, error.status);
    return json(
      {
        error:
          'Cart review is unavailable. No reservation or purchase was authorized.',
      },
      503,
    );
  }
}
