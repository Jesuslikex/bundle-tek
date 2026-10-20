import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletRequest } from '@/lib/wallet-request';
import { isMarketplaceOperator } from '@/lib/marketplace-operator-policy';
import { readMarketplaceOwnedInventory } from '@/lib/marketplace-owned-inventory-server';
import { operatorListingSelection } from '@/lib/marketplace-operator-review';
import {
  inspectMarketplaceSaleWallet,
  MarketplaceSaleInspectionChangedError,
} from '@/lib/marketplace-sale-inspection';
import { WalletRpcError } from '@/lib/wallet-balances';
import { walletWarmupSessionDigest as digest } from '@/lib/wallet-warmup-session-digest';
export const dynamic = 'force-dynamic';
class AccessChanged extends Error {}
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...(status === 429 ? { 'retry-after': '15' } : {}),
    },
  });
export async function POST(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user)
      return json({ error: 'Sign in to inspect a seller wallet.' }, 401);
    if (!isMarketplaceOperator(user.userId))
      return json(
        {
          error:
            'Only configured Bundle operators can inspect seller accounts.',
        },
        403,
      );
    if (new URL(request.url).search)
      return json({ error: 'Inspection accepts no query parameters.' }, 400);
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
      if (request.signal.aborted) throw error;
      const large =
        error instanceof Error && error.message === 'Wallet request too large.';
      return json(
        {
          error: large
            ? 'Request too large.'
            : 'Choose one wallet revision and a positive SOL asking price.',
        },
        large ? 413 : 400,
      );
    }
    request.signal.throwIfAborted();
    const db = getD1();
    const key = 'marketplace-sale-inspection:' + (await digest(user.userId));
    request.signal.throwIfAborted();
    const at = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
    const gate = await db
      .prepare(
        `INSERT INTO market_read_gates(owner_id,next_allowed_at) VALUES(?,${at}+15000) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE market_read_gates.next_allowed_at<=${at}`,
      )
      .bind(key)
      .run();
    if (!gate.meta.changes)
      return json(
        { error: 'Wait 15 seconds before another account inspection.' },
        429,
      );
    async function checkAccess() {
      request.signal.throwIfAborted();
      const current = await getChatGPTUser();
      if (
        !current ||
        current.userId !== user!.userId ||
        !isMarketplaceOperator(current.userId)
      )
        throw new AccessChanged();
    }
    const inspection = await inspectMarketplaceSaleWallet(
      async () => {
        await checkAccess();
        return readMarketplaceOwnedInventory(db, user.userId, request.signal);
      },
      selection,
      { signal: request.signal },
    );
    await checkAccess();
    return json({ inspection });
  } catch (error) {
    if (request.signal.aborted)
      return json({ error: 'Account inspection cancelled.' }, 408);
    if (error instanceof AccessChanged)
      return json({ error: 'Seller access changed. Sign in again.' }, 403);
    if (error instanceof MarketplaceSaleInspectionChangedError)
      return json(
        { error: 'Seller wallet evidence changed. Reload seller inventory.' },
        409,
      );
    if (error instanceof WalletRpcError && error.status === 429)
      return json(
        {
          error:
            'Account provider is rate limited. Wait before another inspection.',
        },
        429,
      );
    return json(
      {
        error:
          'Account inspection unavailable. No sale or payment was authorized.',
      },
      503,
    );
  }
}
