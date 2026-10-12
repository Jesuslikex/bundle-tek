import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import type { SavedSwapPreparation } from '@/lib/imported-swap-preparation-history';
import {
  restoreSavedSwapOrder,
  requireWarmupSigningReview,
} from '@/lib/warmup-signing';
import {
  simulateImportedSwap,
  SwapBlockhashExpiredError,
} from '@/lib/imported-swap-simulation';
import { UUID } from '@/lib/wallet-operation';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to inspect signing requirements.' }, 401);
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  )
    return json({ error: 'JSON required.' }, 415);
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return json({ error: 'Cross-origin request rejected.' }, 403);
  let input: { preparationId: string; transaction: string };
  try {
    const text = await request.text();
    if (text.length > 2200) return json({ error: 'Request too large.' }, 413);
    input = JSON.parse(text);
    if (
      !input ||
      !UUID.test(input.preparationId) ||
      typeof input.transaction !== 'string' ||
      input.transaction.length > 1644
    )
      throw new Error();
  } catch {
    return json({ error: 'Choose a saved unsigned preparation.' }, 400);
  }
  try {
    const db = getD1();
    const current = () =>
      db
        .prepare(
          `SELECT s.id,s.project_id AS projectId,s.project_revision AS projectRevision,s.wallet_revision AS walletRevision,s.created_at AS createdAt,s.document FROM imported_swap_preparations s JOIN imported_token_projects p ON p.owner_id=s.owner_id AND p.id=s.project_id AND p.revision=s.project_revision JOIN workspace_wallets w ON w.owner_id=s.owner_id AND w.chain='Solana' AND w.address=s.wallet_address AND w.revision=s.wallet_revision WHERE s.owner_id=? AND s.id=? AND p.chain='Solana' AND p.archived=0 AND w.archived=0 AND json_extract(s.document,'$.wallet')=s.wallet_address AND p.address=CASE json_extract(s.document,'$.side') WHEN 'Buy' THEN json_extract(s.document,'$.outputMint') WHEN 'Sell' THEN json_extract(s.document,'$.inputMint') END`,
        )
        .bind(user.userId, input.preparationId)
        .first<Omit<SavedSwapPreparation, 'document'> & { document: string }>();
    const row = await current();
    if (!row)
      return json(
        {
          error:
            'Current saved preparation unavailable. Reload the project and wallet.',
        },
        409,
      );
    const order = await restoreSavedSwapOrder(
      { ...row, document: JSON.parse(row.document) },
      input.transaction,
    );
    const now = Date.now();
    const gate = await db
      .prepare(
        'INSERT INTO wallet_balance_gates(owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE wallet_balance_gates.next_allowed_at<=?',
      )
      .bind(user.userId, now + 15000, now)
      .run();
    if (!gate.meta.changes) {
      const retained = await db
        .prepare(
          'SELECT next_allowed_at AS deadline FROM wallet_balance_gates WHERE owner_id=?',
        )
        .bind(user.userId)
        .first<{ deadline: number }>();
      return json(
        {
          error: 'Wait between wallet reads.',
          reviewWaitMs: Math.min(
            15000,
            Math.max(0, (retained?.deadline ?? now + 15000) - Date.now()),
          ),
        },
        429,
      );
    }
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(25000),
    ]);
    const simulation = await simulateImportedSwap(order, signal, fetch, true);
    const settlement = await requireWarmupSigningReview(order, simulation);
    const after = await current();
    if (
      !after ||
      after.document !== row.document ||
      Date.parse(order.expiresAt) <= Date.now()
    )
      return json(
        { error: 'Project, wallet or order changed. Prepare a fresh order.' },
        409,
      );
    return json({
      checks: {
        preparationId: row.id,
        projectId: row.projectId,
        projectRevision: row.projectRevision,
        walletRevision: row.walletRevision,
        wallet: order.preparation.wallet,
        sha256: order.preparation.sha256,
        side: order.side,
        expiresAt: order.expiresAt,
        observedAt: simulation.observedAt,
        source: simulation.source,
        networkFeeLamports: simulation.networkFeeLamports,
        settlement,
        executionAllowed: false,
        approvalCreated: false,
      },
    });
  } catch (error) {
    if (error instanceof SwapBlockhashExpiredError)
      return json(
        {
          error:
            'Prepared transaction blockhash expired. Prepare a fresh order.',
        },
        409,
      );
    return json(
      {
        error:
          'Signing requirements are not satisfied or could not be verified. No approval, signature or submission was created.',
      },
      502,
    );
  }
}
