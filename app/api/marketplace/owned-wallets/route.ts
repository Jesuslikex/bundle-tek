import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { readMarketplaceOwnedInventory } from '@/lib/marketplace-owned-inventory-server';
import {
  MarketplaceInventoryCapacityError,
  marketplaceInventoryCapacityBody,
} from '@/lib/marketplace-owned-inventory';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user)
      return json(
        { error: 'Sign in to view your saved wallet inventory.' },
        401,
      );
    if (new URL(request.url).search)
      return json(
        { error: 'This inventory accepts no query parameters.' },
        400,
      );
    if (request.signal.aborted)
      return json({ error: 'Inventory read cancelled.' }, 408);
    const result = await readMarketplaceOwnedInventory(
      getD1(),
      user.userId,
      request.signal,
    );
    return json(result);
  } catch (error) {
    if (
      !request.signal.aborted &&
      error instanceof MarketplaceInventoryCapacityError
    )
      return json(marketplaceInventoryCapacityBody(error), 409);
    return request.signal.aborted
      ? json({ error: 'Inventory read cancelled.' }, 408)
      : json(
          {
            error:
              'Saved wallet inventory evidence is unavailable or inconsistent. Nothing was listed for sale.',
          },
          503,
        );
  }
}
