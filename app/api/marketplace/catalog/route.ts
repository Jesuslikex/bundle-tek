import { getChatGPTUser } from '@/app/chatgpt-auth';
import { marketplaceFilters } from '@/lib/marketplace-catalog';
import {
  MarketplaceError,
  readMarketplaceCatalog,
} from '@/lib/marketplace-provider';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...(status === 429 ? { 'retry-after': '15' } : {}),
    },
  });
export async function GET(request: Request) {
  let user;
  try {
    user = await getChatGPTUser();
  } catch {
    return json(
      {
        error: 'Bundle sign-in is temporarily unavailable.',
        code: 'AUTH_UNAVAILABLE',
      },
      503,
    );
  }
  if (!user) return json({ error: 'Sign in to browse wallet inventory.' }, 401);
  const params = new URL(request.url).searchParams;
  if (
    params.toString().length > 2048 ||
    [...params.keys()].some((key) => params.getAll(key).length !== 1)
  )
    return json({ error: 'Use one value per catalog filter.' }, 400);
  const filters = marketplaceFilters.safeParse(Object.fromEntries(params));
  if (!filters.success)
    return json({ error: 'Choose valid wallet catalog filters.' }, 400);
  try {
    return json(await readMarketplaceCatalog(filters.data, request.signal));
  } catch (error) {
    if (error instanceof MarketplaceError)
      return json({ error: error.message }, error.status);
    return json({ error: 'Wallet catalog temporarily unavailable.' }, 503);
  }
}
