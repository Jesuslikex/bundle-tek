import {
  tradeSessionRequest,
  type TradeSessionRequest,
} from '@/lib/imported-trade-session';
import { captureTradeSession } from '@/lib/imported-trade-session-server';
import { ConditionalBuyStorageUnavailable } from '@/lib/conditional-buy-capability';
import { requireConditionalBuyOutputPrecision } from '@/lib/conditional-signing';
import { env } from '@/lib/server-env';
import { walletAddress } from '@/lib/wallet-workspace';
import {
  importedTradeSettings,
  type ImportedTokenDocument,
} from '@/lib/imported-token-project';
import { prepareSolanaSwap, WRAPPED_SOL } from '@/lib/warmup-swap-quote';
import { observeImportedSwapBalance } from '@/lib/imported-swap-balance';
import { simulateImportedSwap } from '@/lib/imported-swap-simulation';
import {
  captureImportedAcquisition,
  captureImportedAcquisitionBasket,
  type ImportedAcquisitionGuard,
  currentImportedAcquisition,
} from '@/lib/imported-acquisition-server';
import { solanaTokenAtoms } from '@/lib/solana-token-amount';
import { importedAcquisitionAllocations } from '@/lib/imported-acquisition';
import { UUID } from '@/lib/wallet-operation';
import {
  conditionalLevelRequest,
  captureConditionalPreparation,
  type ConditionalLevelRequest,
} from '@/lib/conditional-preparation-server';
import {
  saveSwapPreparation,
  swapPreparationSummary,
} from '@/lib/imported-swap-preparation-history';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function prepareOwnedImportedSwap(
  request: Request,
  owner: string,
  db: D1Database,
) {
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
    buyReceiptId?: string;
    buyAllocations?: unknown;
    conditional?: ConditionalLevelRequest;
    session?: TradeSessionRequest;
  };
  try {
    const text = await request.text();
    if (text.length > 2048) return json({ error: 'Request too large.' }, 413);
    input = JSON.parse(text);
    if (
      !input ||
      typeof input.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        input.id,
      ) ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 1 ||
      input.revision > 1000000000
    )
      throw new Error();
    if (
      input.buyAllocations !== undefined &&
      (input.side !== 'Sell' || input.buyReceiptId !== undefined)
    )
      throw new Error();
    if (input.session !== undefined)
      input.session = tradeSessionRequest(input.session);
    input.wallet = walletAddress(input.wallet, 'Solana');
    if (input.conditional !== undefined) {
      input.conditional = conditionalLevelRequest(input.conditional);
      if (!['Buy', 'Sell'].includes(input.side)) throw new Error();
    }
    if (
      input.buyReceiptId !== undefined &&
      (typeof input.buyReceiptId !== 'string' ||
        !UUID.test(input.buyReceiptId) ||
        input.side !== 'Sell')
    )
      throw new Error();
  } catch {
    return json(
      { error: 'Choose a current imported project and wallet.' },
      400,
    );
  }
  try {
    const read = () =>
      db
        .prepare(
          "SELECT p.document FROM imported_token_projects p WHERE p.owner_id=? AND p.id=? AND p.chain='Solana' AND p.revision=? AND p.archived=0 AND EXISTS (SELECT 1 FROM workspace_wallets w WHERE w.owner_id=p.owner_id AND w.chain='Solana' AND w.address=? AND w.revision=? AND w.archived=0)",
        )
        .bind(
          owner,
          input.id,
          input.revision,
          input.wallet,
          input.walletRevision ?? 0,
        )
        .first<{ document: string }>();
    // Validate the captured wallet revision before binding it to storage.
    if (
      !Number.isSafeInteger(input.walletRevision) ||
      input.walletRevision < 1 ||
      input.walletRevision > 1000000000
    )
      return json({ error: 'Choose a current wallet revision.' }, 400);
    const row = await read();
    if (!row)
      return json(
        {
          error:
            'Project or wallet changed or is unavailable. Reload their details.',
        },
        409,
      );
    const token = (JSON.parse(row.document) as ImportedTokenDocument).token;
    try {
      importedTradeSettings(input, token);
      if (token.address === WRAPPED_SOL) throw new Error();
    } catch {
      return json(
        { error: 'Choose a distinct mint and exact positive amount.' },
        400,
      );
    }
    let unitsRaw: string;
    try {
      unitsRaw = solanaTokenAtoms(
        input.amount,
        input.side === 'Buy' ? 9 : token.decimals,
      ).toString();
      if (input.buyAllocations !== undefined)
        input.buyAllocations = importedAcquisitionAllocations(
          input.buyAllocations,
          unitsRaw,
        );
    } catch {
      return json(
        {
          error:
            'Choose distinct acquisition sources whose exact units equal the sell input.',
        },
        400,
      );
    }
    let acquisition: ImportedAcquisitionGuard | undefined =
      input.buyAllocations !== undefined
        ? await captureImportedAcquisitionBasket(
            db,
            owner,
            input.id,
            input.wallet,
            token.address,
            token.decimals,
            input.buyAllocations,
            unitsRaw,
          )
        : input.buyReceiptId
          ? await captureImportedAcquisition(
              db,
              owner,
              input.id,
              input.wallet,
              token.address,
              token.decimals,
              input.buyReceiptId,
              solanaTokenAtoms(input.amount, token.decimals).toString(),
            )
          : undefined;
    const conditionContext = {
      projectId: input.id,
      projectRevision: input.revision,
      wallet: input.wallet,
      walletRevision: input.walletRevision,
      mint: token.address,
      decimals: token.decimals,
      side: input.side,
      unitsRaw,
    };
    let session;
    try {
      session = input.session
        ? await captureTradeSession(db, owner, input.session, conditionContext)
        : undefined;
    } catch (error) {
      return json(
        {
          error:
            error instanceof Error &&
            (error.message.startsWith('DCA market') ||
              error.message.startsWith('DCA supply'))
              ? error.message
              : error instanceof Error && error.message.includes('not due')
                ? 'Trade session entry is not due yet.'
                : error instanceof Error && error.message.includes('paused')
                  ? 'Trade session is paused. Resume it before preparation.'
                  : 'Trade session entry changed, filled or already has an approval.',
        },
        409,
      );
    }
    let conditional;
    try {
      conditional = input.conditional
        ? await captureConditionalPreparation(
            db,
            owner,
            input.conditional,
            conditionContext,
          )
        : undefined;
    } catch (error) {
      if (error instanceof ConditionalBuyStorageUnavailable)
        return json({ error: error.message }, 503);
      return json(
        {
          error:
            'Conditional level changed, is unavailable, or its fresh market-cap condition is not met.',
        },
        409,
      );
    }
    const key = (env as unknown as Record<string, unknown>).JUPITER_API_KEY;
    if (typeof key !== 'string' || !key.trim())
      return json(
        { error: 'Swap preparation service is not configured.' },
        503,
      );
    const retained = await db
      .prepare(
        'SELECT COUNT(*) AS count FROM imported_swap_preparations WHERE owner_id=? AND project_id=?',
      )
      .bind(owner, input.id)
      .first<{ count: number }>();
    if (!retained || retained.count >= 200)
      return json(
        {
          error:
            'Preparation history is full. New preparation is unavailable for this project.',
        },
        409,
      );
    const now = Date.now();
    const gate = await db
      .prepare(
        'INSERT INTO imported_token_project_gates(owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE imported_token_project_gates.next_allowed_at<=?',
      )
      .bind(owner, now + 15000, now)
      .run();
    if (!gate.meta.changes)
      return json(
        { error: 'Wait 15 seconds between imported-token reads.' },
        429,
      );
    const walletGate = await db
      .prepare(
        'INSERT INTO wallet_balance_gates(owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE wallet_balance_gates.next_allowed_at<=?',
      )
      .bind(owner, now + 15000, now)
      .run();
    if (!walletGate.meta.changes)
      return json({ error: 'Wait 15 seconds between wallet reads.' }, 429);
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(25000),
    ]);
    const balance = await observeImportedSwapBalance(
      token,
      input.wallet,
      input.side,
      input.amount,
      signal,
    );
    if (!(await read()) || Date.parse(balance.expiresAt) <= Date.now())
      return json(
        { error: 'Project, wallet or balance changed. Prepare again.' },
        409,
      );
    if (!balance.amountCovered)
      return json(
        { error: 'Current unfrozen input balance does not cover this amount.' },
        422,
      );
    if (!balance.preparationSupported)
      return json(
        {
          error:
            'Sell preparation requires supported mint and account extensions. Refresh inventory and review any blocked extensions.',
        },
        422,
      );
    const order = await prepareSolanaSwap(
      {
        tokenMint: token.address,
        decimals: token.decimals,
        side: input.side,
        amount: input.amount,
        wallet: input.wallet,
      },
      key,
      signal,
    );
    if (
      !(await read()) ||
      Date.parse(order.expiresAt) <= Date.now() ||
      Date.parse(balance.expiresAt) <= Date.now()
    )
      return json(
        { error: 'Project, wallet or order changed. Prepare again.' },
        409,
      );
    const simulation = await simulateImportedSwap(order, signal);
    requireConditionalBuyOutputPrecision(
      conditional?.selection,
      simulation.tokenChanges,
    );
    if (
      !(await read()) ||
      Date.parse(order.expiresAt) <= Date.now() ||
      Date.parse(balance.expiresAt) <= Date.now()
    )
      return json(
        { error: 'Project, wallet or order changed. Prepare again.' },
        409,
      );
    if (acquisition)
      acquisition = await currentImportedAcquisition(
        db,
        owner,
        acquisition.selection,
      );
    if (input.conditional) {
      try {
        conditional = await captureConditionalPreparation(
          db,
          owner,
          input.conditional,
          conditionContext,
        );
      } catch {
        return json(
          {
            error:
              'Conditional level or market observation changed during preparation. Refresh and review again.',
          },
          409,
        );
      }
    }
    if (input.session) {
      try {
        session = await captureTradeSession(
          db,
          owner,
          input.session,
          conditionContext,
        );
      } catch {
        return json(
          { error: 'Trade session entry changed during preparation.' },
          409,
        );
      }
    }
    const history = await saveSwapPreparation(
      db,
      owner,
      {
        projectId: input.id,
        projectRevision: input.revision,
        wallet: input.wallet,
        walletRevision: input.walletRevision,
      },
      {
        ...swapPreparationSummary(order, simulation, balance),
        ...(acquisition ? { acquisition: acquisition.selection } : {}),
        ...(conditional ? { conditional: conditional.selection } : {}),
        ...(session ? { session: session.selection } : {}),
      },
      acquisition,
      conditional,
      session,
    );
    if (!history)
      return json(
        {
          error:
            'Preparation history is full, expired or its project/wallet changed. Reload before preparing again.',
        },
        409,
      );
    if (
      Date.parse(order.expiresAt) <= Date.now() ||
      Date.parse(balance.expiresAt) <= Date.now() ||
      (conditional !== undefined &&
        Date.parse(conditional.selection.expiresAt) <= Date.now())
    )
      return json(
        { error: 'Saved preparation expired. Prepare a fresh order.' },
        409,
      );
    return json({
      id: input.id,
      revision: input.revision,
      walletRevision: input.walletRevision,
      order,
      simulation,
      balance,
      history,
      reviewWaitMs: Math.min(15000, Math.max(0, now + 15000 - Date.now())),
    });
  } catch {
    return json(
      {
        error:
          'Unsigned swap preparation unavailable. No transaction was signed or submitted.',
      },
      502,
    );
  }
}
