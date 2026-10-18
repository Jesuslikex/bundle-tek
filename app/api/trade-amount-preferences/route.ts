import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletRequest } from '@/lib/wallet-request';
import { presetKeys } from '@/lib/trade-amount-preferences';
import {
  readTradeAmountPreferences,
  saveTradeAmountPreferences,
  TradePreferenceError,
} from '@/lib/trade-amount-preferences-server';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const failure = (e: unknown) =>
  e instanceof TradePreferenceError
    ? json({ error: e.message }, e.status)
    : json(
        {
          error:
            'Saved presets are unavailable. No trade or wallet state changed.',
        },
        503,
      );
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to load saved presets.' }, 401);
  if (new URL(request.url).search)
    return json(
      { error: 'Use the saved preset endpoint without query fields.' },
      400,
    );
  try {
    return json(await readTradeAmountPreferences(getD1(), user.userId));
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to save presets.' }, 401);
  let body: Record<string, unknown>;
  try {
    if (
      !request.headers
        .get('content-type')
        ?.toLowerCase()
        .startsWith('application/json')
    )
      throw Error();
    body = await walletRequest(request, 4096);
    presetKeys(body, 'ownerId,preferences,revision');
    if (
      !Number.isSafeInteger(body.revision) ||
      typeof body.ownerId !== 'string'
    )
      throw Error();
  } catch {
    return json(
      { error: 'Choose current presets and their exact revision.' },
      400,
    );
  }
  if (body.ownerId !== user.userId)
    return json(
      { error: 'The signed-in account changed. Reload presets before saving.' },
      409,
    );
  try {
    return json(
      await saveTradeAmountPreferences(
        getD1(),
        user.userId,
        Number(body.revision),
        body.preferences,
      ),
    );
  } catch (e) {
    return failure(e);
  }
}
