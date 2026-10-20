import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletRequest } from '@/lib/wallet-request';
import { isMarketplaceOperator } from '@/lib/marketplace-operator-policy';
import { operatorListingSelection } from '@/lib/marketplace-operator-review';
import { readMarketplaceControlEvidence } from '@/lib/marketplace-control-evidence-server';
import { MarketplaceSaleInspectionChangedError } from '@/lib/marketplace-sale-inspection';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function POST(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user)
      return json({ error: 'Sign in to check saved control records.' }, 401);
    if (!isMarketplaceOperator(user.userId))
      return json(
        { error: 'Only configured Bundle operators can check seller records.' },
        403,
      );
    const url = new URL(request.url);
    if (url.search)
      return json({ error: 'Control checks accept no query parameters.' }, 400);
    if (request.headers.get('origin') !== url.origin)
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
    const evidence = await readMarketplaceControlEvidence(
      getD1(),
      user.userId,
      selection,
      url.origin,
      request.signal,
    );
    const current = await getChatGPTUser();
    request.signal.throwIfAborted();
    if (
      !current ||
      current.userId !== user.userId ||
      !isMarketplaceOperator(current.userId)
    )
      return json({ error: 'Seller access changed. Sign in again.' }, 403);
    return json({ evidence });
  } catch (error) {
    if (request.signal.aborted)
      return json({ error: 'Control record check cancelled.' }, 408);
    if (error instanceof MarketplaceSaleInspectionChangedError)
      return json(
        { error: 'Seller wallet changed. Reload seller inventory.' },
        409,
      );
    return json(
      { error: 'Saved control records unavailable. No sale was authorized.' },
      503,
    );
  }
}
