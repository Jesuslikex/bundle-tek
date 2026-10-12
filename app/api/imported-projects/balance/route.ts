import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletAddress } from '@/lib/wallet-workspace';
import { observeImportedSwapBalance } from '@/lib/imported-swap-balance';
import { solanaTokenAtoms } from '@/lib/solana-token-amount';
import { warmupAtoms } from '@/lib/wallet-warmup';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to check a saved wallet.' }, 401);
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
    wallet: string;
    walletRevision: number;
    side: 'Buy' | 'Sell';
    amount: string;
  };
  try {
    const text = await request.text();
    if (text.length > 1000) return json({ error: 'Request too large.' }, 413);
    input = JSON.parse(text);
    if (
      !input ||
      typeof input.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        input.id,
      ) ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 1 ||
      !Number.isSafeInteger(input.walletRevision) ||
      input.walletRevision < 1 ||
      !['Buy', 'Sell'].includes(input.side)
    )
      throw new Error();
    input.wallet = walletAddress(input.wallet, 'Solana');
  } catch {
    return json(
      {
        error: 'Choose a current imported project and active wallet revision.',
      },
      400,
    );
  }
  try {
    const db = getD1();
    const read = () =>
      db
        .prepare(
          "SELECT p.document FROM imported_token_projects p WHERE p.owner_id=? AND p.id=? AND p.chain='Solana' AND p.revision=? AND p.archived=0 AND EXISTS (SELECT 1 FROM workspace_wallets w WHERE w.owner_id=p.owner_id AND w.chain='Solana' AND w.address=? AND w.revision=? AND w.archived=0)",
        )
        .bind(
          user.userId,
          input.id,
          input.revision,
          input.wallet,
          input.walletRevision,
        )
        .first<{ document: string }>();
    const row = await read();
    if (!row)
      return json(
        {
          error:
            'Project or wallet changed, is unavailable or is archived. Reload their details.',
        },
        409,
      );
    const token = (JSON.parse(row.document) as ImportedTokenProject['document'])
      .token;
    try {
      const raw =
        input.side === 'Buy'
          ? warmupAtoms(input.amount, 9)
          : solanaTokenAtoms(input.amount, token.decimals);
      if (raw > (1n << 64n) - 1n) throw new Error();
    } catch {
      return json(
        {
          error:
            'Use an exact positive amount within the input token decimals and Solana limits.',
        },
        400,
      );
    }
    const now = Date.now();
    const gate = await db
      .prepare(
        'INSERT INTO wallet_balance_gates(owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE wallet_balance_gates.next_allowed_at<=?',
      )
      .bind(user.userId, now + 15000, now)
      .run();
    if (!gate.meta.changes)
      return json({ error: 'Wait 15 seconds between wallet reads.' }, 429);
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(30000),
    ]);
    const report = await observeImportedSwapBalance(
      token,
      input.wallet,
      input.side,
      input.amount,
      signal,
    );
    if (!(await read()))
      return json(
        {
          error:
            'Project or wallet changed during the balance read. Reload their details.',
        },
        409,
      );
    return json({
      id: input.id,
      revision: input.revision,
      walletRevision: input.walletRevision,
      report,
    });
  } catch {
    return json(
      {
        error:
          'Fresh wallet balance check unavailable. No execution clearance.',
      },
      502,
    );
  }
}
