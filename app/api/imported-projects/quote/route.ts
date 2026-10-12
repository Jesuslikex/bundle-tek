import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  quoteSolanaBuy,
  quoteSolanaSell,
  WarmupQuoteError,
  WRAPPED_SOL,
} from '@/lib/warmup-swap-quote';
import { warmupAtoms } from '@/lib/wallet-warmup';
import { solanaTokenAtoms } from '@/lib/solana-token-amount';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to quote an imported token.' }, 401);
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return json({ error: 'Cross-origin request rejected.' }, 403);
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  )
    return json({ error: 'JSON required.' }, 415);
  let input: {
    id: string;
    revision: number;
    amount: string;
    side?: 'Buy' | 'Sell';
  };
  try {
    const text = await request.text();
    if (text.length > 500) return json({ error: 'Request too large.' }, 413);
    input = JSON.parse(text);
    if (
      !input ||
      typeof input.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        input.id,
      ) ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 1 ||
      (input.side !== undefined &&
        input.side !== 'Buy' &&
        input.side !== 'Sell') ||
      typeof input.amount !== 'string' ||
      input.amount.length > 277 ||
      ((input.side ?? 'Buy') === 'Buy' &&
        warmupAtoms(input.amount, 9) > (1n << 64n) - 1n)
    )
      throw new Error();
  } catch {
    return json(
      {
        error:
          'Choose a current imported project revision and positive SOL amount with at most 9 decimals.',
      },
      400,
    );
  }
  try {
    const db = getD1();
    const read = () =>
      db
        .prepare(
          'SELECT chain,address,revision,archived,document FROM imported_token_projects WHERE owner_id=? AND id=?',
        )
        .bind(user.userId, input.id)
        .first<{
          chain: string;
          address: string;
          revision: number;
          archived: number;
          document: string;
        }>();
    const project = await read();
    if (!project) return json({ error: 'Imported project not found.' }, 404);
    if (project.archived || project.revision !== input.revision)
      return json(
        { error: 'Project changed or is archived. Reload its details.' },
        409,
      );
    if (project.chain !== 'Solana')
      return json(
        { error: 'Imported swap quotes currently support Solana.' },
        400,
      );
    if (project.address === WRAPPED_SOL)
      return json(
        { error: 'Choose a token other than wrapped SOL for a swap.' },
        400,
      );
    const side = input.side ?? 'Buy';
    let decimals: number;
    try {
      decimals = (
        JSON.parse(project.document) as { token: { decimals: number } }
      ).token.decimals;
      if (side === 'Sell') solanaTokenAtoms(input.amount, decimals);
    } catch {
      return json(
        {
          error:
            'Use a positive token amount within the saved mint decimals and Solana limits.',
        },
        400,
      );
    }
    const key = (env as unknown as Record<string, unknown>).JUPITER_API_KEY;
    if (typeof key !== 'string' || !key.trim())
      return json({ error: 'Swap quote service is not configured.' }, 503);
    const now = Date.now();
    const gate = await db
      .prepare(
        'INSERT INTO imported_token_project_gates(owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE imported_token_project_gates.next_allowed_at<=?',
      )
      .bind(user.userId, now + 15000, now)
      .run();
    if (!gate.meta.changes)
      return json(
        { error: 'Wait 15 seconds between imported-token reads.' },
        429,
      );
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(12000),
    ]);
    const quote =
      side === 'Buy'
        ? await quoteSolanaBuy(
            { outputMint: project.address, amount: input.amount },
            key,
            signal,
          )
        : await quoteSolanaSell(
            { inputMint: project.address, amount: input.amount, decimals },
            key,
            signal,
          );
    const current = await read();
    if (
      !current ||
      current.archived ||
      current.revision !== input.revision ||
      current.chain !== project.chain ||
      current.address !== project.address
    )
      return json(
        {
          error:
            'Imported project changed during the quote. Reload its details.',
        },
        409,
      );
    if (Date.parse(quote.expiresAt) <= Date.now())
      return json(
        {
          error: 'Quote expired. Request a fresh quote.',
          code: 'QUOTE_EXPIRED',
        },
        409,
      );
    return json({ id: input.id, revision: input.revision, quote });
  } catch (e) {
    return json(
      {
        code: e instanceof WarmupQuoteError ? e.code : 'QUOTE_UNAVAILABLE',
        error:
          e instanceof WarmupQuoteError
            ? e.message
            : 'Imported-token quote unavailable. No execution clearance.',
      },
      502,
    );
  }
}
