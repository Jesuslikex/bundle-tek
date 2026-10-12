import { getChatGPTUser } from '@/app/chatgpt-auth';
import { inspectToken, validateTokenSource } from '@/lib/token-import';
import {
  metadataGateway,
  readLinkedTokenMetadata,
} from '@/lib/token-linked-metadata';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  if (!(await getChatGPTUser()))
    return json({ error: 'Sign in to review linked token metadata.' }, 401);
  const params = new URL(request.url).searchParams;
  let input, expected;
  try {
    input = validateTokenSource({
      chain: params.get('chain'),
      address: params.get('address'),
    });
    if (input.chain !== 'Solana') throw new Error();
    expected = params.get('uri') ?? '';
    metadataGateway(expected);
  } catch {
    return json(
      {
        error:
          'Choose a Solana token with an IPFS, Arweave, Irys or public GitHub metadata URI.',
      },
      400,
    );
  }
  try {
    const token = await inspectToken(input);
    if (token.metadataUri !== expected)
      return json(
        { error: 'On-chain metadata changed. Look up the token again.' },
        409,
      );
    const metadata = await readLinkedTokenMetadata(
      token,
      AbortSignal.any([request.signal, AbortSignal.timeout(12000)]),
    );
    return json({ token, metadata });
  } catch {
    return json(
      {
        error:
          'Linked metadata unavailable or inconsistent with the mint. Your draft has not changed.',
      },
      502,
    );
  }
}
