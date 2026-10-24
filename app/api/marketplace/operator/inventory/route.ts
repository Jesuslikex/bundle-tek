import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { isMarketplaceOperator } from '@/lib/marketplace-operator-policy';
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
      return json({ error: 'Sign in to open the seller console.' }, 401);
    if (!isMarketplaceOperator(user.userId))
      return json(
        { error: 'Seller access is limited to configured Bundle operators.' },
        403,
      );
    if (new URL(request.url).search)
      return json(
        { error: 'Operator inventory accepts no query parameters.' },
        400,
      );
    if (request.signal.aborted)
      return json({ error: 'Operator inventory read cancelled.' }, 408);
    return json(
      await readMarketplaceOwnedInventory(getD1(), user.userId, request.signal),
    );
  } catch (error) {
    if (
      !request.signal.aborted &&
      error instanceof MarketplaceInventoryCapacityError
    )
      return json(marketplaceInventoryCapacityBody(error), 409);
    return request.signal.aborted
      ? json({ error: 'Operator inventory read cancelled.' }, 408)
      : json(
          { error: 'Operator inventory unavailable. Nothing was published.' },
          503,
        );
  }
}
