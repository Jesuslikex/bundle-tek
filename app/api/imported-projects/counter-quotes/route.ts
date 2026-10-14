import { env } from '@/lib/server-env';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { UUID } from '@/lib/wallet-operation';
import { warmupAtoms } from '@/lib/wallet-warmup';
import { decodeCounterPlan } from '@/lib/counter-trade-store';
import { quoteCounterBuyProposal } from '@/lib/counter-buy-quote';
import { WarmupQuoteError } from '@/lib/warmup-swap-quote';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to price a Counter proposal.' }, 401);
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
    projectId: string;
    projectRevision: number;
    planId: string;
    planRevision: number;
    decisionIdentity: string;
    maximumSolAmount: string;
  };
  let budget: string;
  try {
    const text = await request.text();
    if (text.length > 2048) return json({ error: 'Request too large.' }, 413);
    input = JSON.parse(text);
    if (
      !input ||
      Object.keys(input).sort().join(',') !==
        'decisionIdentity,maximumSolAmount,planId,planRevision,projectId,projectRevision' ||
      !UUID.test(input.projectId) ||
      !UUID.test(input.planId) ||
      !Number.isSafeInteger(input.projectRevision) ||
      input.projectRevision < 1 ||
      !Number.isSafeInteger(input.planRevision) ||
      input.planRevision < 1 ||
      typeof input.decisionIdentity !== 'string' ||
      !input.decisionIdentity ||
      input.decisionIdentity.length > 512 ||
      typeof input.maximumSolAmount !== 'string' ||
      input.maximumSolAmount.length > 30
    )
      throw new Error();
    const raw = warmupAtoms(input.maximumSolAmount, 9);
    if (raw < 1n || raw > (1n << 64n) - 1n) throw new Error();
    budget = raw.toString();
  } catch {
    return json(
      {
        error:
          'Choose a saved Counter Buy proposal and positive maximum swap-input SOL amount.',
      },
      400,
    );
  }
  try {
    const db = getD1();
    const read = async () => {
      const row = await db
        .prepare(
          "SELECT c.id AS planId,c.revision AS planRevision,c.state AS planState,c.document AS planDocument,p.address,p.revision,p.archived,p.document FROM counter_trade_plans c JOIN imported_token_projects p ON p.owner_id=c.owner_id AND p.id=c.project_id WHERE c.owner_id=? AND c.project_id=? AND c.id=? AND p.chain='Solana'",
        )
        .bind(user.userId, input.projectId, input.planId)
        .first<{
          planId: string;
          planRevision: number;
          planState: string;
          planDocument: string;
          address: string;
          revision: number;
          archived: number;
          document: string;
        }>();
      if (!row) return { plan: null, project: null };
      const plan = decodeCounterPlan(JSON.parse(row.planDocument));
      if (
        plan.id !== row.planId ||
        plan.projectId !== input.projectId ||
        plan.revision !== row.planRevision ||
        plan.state !== row.planState
      )
        throw new Error('Counter stored context differs.');
      return {
        plan,
        project: {
          address: row.address,
          revision: row.revision,
          archived: row.archived,
          document: row.document,
        },
      };
    };
    const original = await read(),
      plan = original.plan,
      project = original.project;
    if (!plan || !project)
      return json({ error: 'Owned Counter proposal unavailable.' }, 404);
    const token = (
      JSON.parse(project.document) as {
        token?: { chain?: unknown; address?: unknown; decimals?: unknown };
      }
    ).token;
    if (
      !token ||
      token.chain !== 'Solana' ||
      token.address !== project.address ||
      token.decimals !== plan.ledger.scope.decimals
    )
      return json(
        { error: 'Counter mint identity or precision changed.' },
        409,
      );
    const decision = plan.ledger.decisions.find(
      (d) => d.identity === input.decisionIdentity,
    );
    if (
      plan.state !== 'active' ||
      plan.rules.responseSide !== 'Buy' ||
      plan.revision !== input.planRevision ||
      project.archived ||
      project.revision !== input.projectRevision ||
      plan.ledger.scope.revision !== project.revision ||
      plan.ledger.scope.mint !== project.address ||
      plan.projectDocument !== project.document ||
      decision?.outcome !== 'proposal' ||
      decision.proposalTokenRaw === null
    )
      return json(
        {
          error:
            'Counter proposal or project context changed. Reload retained history.',
        },
        409,
      );
    const key = (env as unknown as Record<string, unknown>).JUPITER_API_KEY;
    if (typeof key !== 'string' || !key.trim())
      return json({ error: 'Counter quote service is not configured.' }, 503);
    const now = Date.now();
    const gate = await db
      .prepare(
        'INSERT INTO imported_token_project_gates(owner_id,next_allowed_at) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE imported_token_project_gates.next_allowed_at<=?',
      )
      .bind(user.userId, now + 15000, now)
      .run();
    if (!gate.meta.changes)
      return json(
        { error: 'Wait 15 seconds between quote provider checks.' },
        429,
      );
    const snapshot = JSON.stringify(plan);
    const quote = await quoteCounterBuyProposal(
      plan,
      input.decisionIdentity,
      budget,
      key,
      AbortSignal.any([request.signal, AbortSignal.timeout(20000)]),
    );
    const current = await read();
    if (
      !current.plan ||
      JSON.stringify(current.plan) !== snapshot ||
      !current.project ||
      current.project.archived ||
      current.project.revision !== project.revision ||
      current.project.address !== project.address ||
      current.project.document !== project.document
    )
      return json(
        {
          error:
            'Counter or project changed during pricing. Reload history before requesting another preview.',
        },
        409,
      );
    if (request.signal.aborted || Date.parse(quote.expiresAt) <= Date.now())
      return json(
        {
          error:
            'Counter quote expired or was cancelled. Request a fresh preview.',
        },
        409,
      );
    return json({ quote, executionAllowed: false });
  } catch (e) {
    return json(
      {
        error:
          e instanceof WarmupQuoteError
            ? e.message
            : 'Counter quote temporarily unavailable.',
        code: e instanceof WarmupQuoteError ? e.code : 'QUOTE_UNAVAILABLE',
      },
      503,
    );
  }
}
