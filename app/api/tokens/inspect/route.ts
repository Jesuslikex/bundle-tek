import { getChatGPTUser } from '@/app/chatgpt-auth';
import { inspectToken, validateTokenSource } from '@/lib/token-import';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  if (!(await getChatGPTUser()))
    return json({ error: 'Sign in to look up a token.' }, 401);
  const params = new URL(request.url).searchParams;
  let input;
  try {
    input = validateTokenSource({
      chain: params.get('chain'),
      address: params.get('address'),
    });
  } catch (error) {
    return json({ error: (error as Error).message }, 400);
  }
  try {
    return json({ token: await inspectToken(input) });
  } catch {
    return json(
      {
        error:
          'Token lookup unavailable. Check the network and address, or retry after a public RPC rate limit. Solana requires an initialized mint with Metaplex or linked mint-side Token-2022 metadata.',
      },
      502,
    );
  }
}
