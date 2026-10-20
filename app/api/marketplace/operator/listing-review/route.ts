import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletRequest } from '@/lib/wallet-request';
import { isMarketplaceOperator } from '@/lib/marketplace-operator-policy';
import { readMarketplaceOwnedInventory } from '@/lib/marketplace-owned-inventory-server';
import {
  operatorListingSelection,
  reviewOperatorListing,
} from '@/lib/marketplace-operator-review';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function POST(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user)
      return json({ error: 'Sign in to review operator inventory.' }, 401);
    if (!isMarketplaceOperator(user.userId))
      return json(
        { error: 'Only configured Bundle operators can prepare listings.' },
        403,
      );
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
      selection = operatorListingSelection.parse(
        await walletRequest(request, 2048),
      );
    } catch (error) {
      return json(
        {
          error:
            error instanceof Error &&
            error.message === 'Wallet request too large.'
              ? 'Request too large.'
              : 'Choose one wallet revision and a positive integer SOL price in lamports.',
        },
        error instanceof Error && error.message === 'Wallet request too large.'
          ? 413
          : 400,
      );
    }
    if (request.signal.aborted)
      return json({ error: 'Listing review cancelled.' }, 408);
    const inventory = await readMarketplaceOwnedInventory(
      getD1(),
      user.userId,
      request.signal,
    );
    if (
      !inventory.wallets.some(
        (w) =>
          w.address === selection.address &&
          w.revision === selection.walletRevision,
      )
    )
      return json(
        { error: 'Wallet or revision changed. Refresh operator inventory.' },
        409,
      );
    const review = await reviewOperatorListing(inventory, selection);
    if (request.signal.aborted)
      return json({ error: 'Listing review cancelled.' }, 408);
    return json(review);
  } catch {
    return request.signal.aborted
      ? json({ error: 'Listing review cancelled.' }, 408)
      : json(
          {
            error:
              'Operator listing review unavailable. No listing, payment or delivery was authorized.',
          },
          503,
        );
  }
}
