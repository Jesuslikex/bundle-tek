import { currentStrategyReviewContext } from './strategy-review-capacity-server';
import type { StrategyCheckRequest } from './strategy-candidate-check-server';
import { strategyReviewCandidate } from './strategy-review-capacity';
import { buildStrategyCandidateCheck } from './strategy-candidate-check';
import { observeExactStrategyMarket } from './strategy-market-exact';
import {
  buildStrategyUnsignedPreview,
  requirePreviewCondition,
} from './strategy-unsigned-preview';
import { StrategyDraftError } from './strategy-session-drafts';
import { TOKEN_PROGRAMS } from './wallet-holdings';
import { observeImportedSwapBalance } from './imported-swap-balance';
import { prepareSolanaSwap } from './warmup-swap-quote';
import { simulateImportedSwap } from './imported-swap-simulation';
import { requireWarmupSigningReview } from './warmup-signing';
import { formatNativeBalance } from './wallet-balance-format';
import { env } from '@/lib/server-env';
export type StrategyPreviewRequest = StrategyCheckRequest & {
  conditionPool: string | null;
};

/** Independent transient inspection. No saved preparation, packet export or signer/submit consumer. */
export async function previewStrategyCandidate(
  db: D1Database,
  owner: string,
  input: StrategyPreviewRequest,
  signal: AbortSignal,
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const stop = new Promise<never>((_, reject) => {
    const refused = () =>
      reject(
        new StrategyDraftError(
          'Preview cancelled or timed out. No review slots changed.',
          502,
        ),
      );
    controller.signal.addEventListener('abort', refused, { once: true });
    if (controller.signal.aborted) refused();
    timer = setTimeout(cancel, 25000);
  });
  const run = async () => {
    const active = controller.signal;
    active.throwIfAborted();
    const context = () =>
      currentStrategyReviewContext(
        db,
        owner,
        input.projectId,
        input.draftId,
        input.revision,
        input.holdId,
      );
    const before = await context();
    const candidate = strategyReviewCandidate(
      before.draft.plan,
      before.hold.strategyId,
      before.hold.candidate,
    );
    const terms = before.draft.plan.input.strategies.find(
      (s) => s.id === candidate.strategyId,
    )!;
    const initialAt = Date.parse(before.databaseAt);
    if (
      initialAt < Date.parse(candidate.notBefore) ||
      (candidate.endsAt !== null &&
        initialAt >= Date.parse(candidate.endsAt)) ||
      (terms.kind === 'DCA'
        ? input.conditionPool !== null
        : typeof input.conditionPool !== 'string')
    )
      throw new StrategyDraftError(
        'Choose a currently met Limit pool, or a due DCA cycle.',
        409,
      );
    if (
      typeof before.tokenProgram !== 'string' ||
      !TOKEN_PROGRAMS.some((p) => p === before.tokenProgram)
    )
      throw new StrategyDraftError(
        'Refresh the saved token identity before preparing a preview.',
        409,
      );
    const token = {
      ...before.draft.plan.token,
      tokenProgram: before.tokenProgram,
    };
    // One preview per 15s, shared with wallet reads. Limit previews make exactly
    // two market observations, independently of the lightweight condition-check gate.
    const now = Date.parse(before.databaseAt);
    const gate = await db
      .prepare(
        'INSERT INTO wallet_balance_gates(owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE wallet_balance_gates.next_allowed_at<=?',
      )
      .bind(owner, now + 15000, now)
      .run();
    if (!gate.meta.changes)
      throw new StrategyDraftError(
        'Wait 15 seconds between wallet reads, then preview again.',
        429,
      );
    const freshCheck = async (ctx: typeof before) => {
      if (terms.kind === 'DCA')
        return buildStrategyCandidateCheck(
          ctx.draft,
          ctx.capacity,
          input.holdId,
          ctx.databaseAt,
          null,
        );
      const observed = await observeExactStrategyMarket(
        token.address,
        active,
        fetch,
      );
      const checked = await context();
      active.throwIfAborted();
      if (checked.fingerprint !== before.fingerprint)
        throw new StrategyDraftError(
          'Strategy context changed during the market read.',
          409,
        );
      return buildStrategyCandidateCheck(
        checked.draft,
        checked.capacity,
        input.holdId,
        checked.databaseAt,
        {
          source: 'api.dexscreener.com',
          chain: 'Solana',
          address: observed.market.address,
          observedAt: observed.market.observedAt,
          returnedPairCount: observed.market.returnedPairCount,
          quoteOnlyPairCount: observed.market.quoteOnlyPairCount,
          pairs: observed.market.pairs.map((p) => ({
            address: p.address,
            dex: p.dex,
            quoteSymbol: p.quoteSymbol,
            marketCapUsd: observed.caps[p.address],
          })),
        },
      );
    };
    const check = await freshCheck(before);
    try {
      requirePreviewCondition(check, input.conditionPool);
    } catch {
      throw new StrategyDraftError(
        'The selected condition is not currently met. No order was requested.',
        409,
      );
    }
    const amount = formatNativeBalance(
      check.unitsRaw,
      before.draft.plan.summary.inputDecimals,
    );
    const assertCurrent = async () => {
      active.throwIfAborted();
      const after = await context();
      active.throwIfAborted();
      if (
        after.fingerprint !== before.fingerprint ||
        after.databaseAt < before.databaseAt
      )
        throw new StrategyDraftError(
          'Draft, wallet or review slots changed. Reload before previewing.',
          409,
        );
      if (Date.parse(check.expiresAt) <= Date.parse(after.databaseAt))
        throw new StrategyDraftError(
          'Conditions expired during preparation. Check again.',
          409,
        );
      return after;
    };
    await assertCurrent();
    const balance = await observeImportedSwapBalance(
      token,
      check.wallet,
      check.side,
      amount,
      active,
    );
    await assertCurrent();
    if (
      balance.executionAllowed !== false ||
      balance.wallet !== check.wallet ||
      balance.mint !== token.address ||
      balance.side !== check.side ||
      balance.requestedRaw !== check.unitsRaw
    )
      throw Error('Balance identity differs.');
    if (!balance.amountCovered)
      throw new StrategyDraftError(
        'This wallet has insufficient input balance. No order was requested and the review slot is unchanged.',
        422,
      );
    if (!balance.preparationSupported)
      throw new StrategyDraftError(
        'This token has unsupported account or mint extensions. Refresh inventory before previewing.',
        422,
      );
    const key = (env as unknown as Record<string, unknown>).JUPITER_API_KEY;
    if (typeof key !== 'string' || !key.trim())
      throw new StrategyDraftError(
        'Unsigned preview service is unavailable. The saved draft and review slot are unchanged.',
        503,
      );
    const order = await prepareSolanaSwap(
      {
        tokenMint: token.address,
        side: check.side,
        amount,
        decimals: token.decimals,
        wallet: check.wallet,
      },
      key,
      active,
    );
    await assertCurrent();
    const simulation = await simulateImportedSwap(order, active, fetch, true);
    const settlement = await requireWarmupSigningReview(order, simulation);
    let after = await assertCurrent();
    const finalCheck = await freshCheck(after);
    after = await assertCurrent();
    try {
      requirePreviewCondition(finalCheck, input.conditionPool);
    } catch {
      throw new StrategyDraftError(
        'The selected condition changed during preparation. Check again.',
        409,
      );
    }
    if (
      BigInt(settlement.maximumNativeDebitLamports) > BigInt(balance.nativeRaw)
    )
      throw new StrategyDraftError(
        'The wallet does not cover the simulated SOL fees and account rent. No trade was approved.',
        422,
      );
    const preview = await buildStrategyUnsignedPreview(
      finalCheck,
      input.conditionPool,
      {
        quote: {
          sha256: order.preparation.sha256,
          inputMint: order.inputMint,
          outputMint: order.outputMint,
          inputRaw: order.inAmount,
          quotedOutputRaw: order.outAmount,
          minimumOutputRaw: order.minimumOutAmount,
          slippageBps: order.slippageBps,
          platformFeeBps: order.platformFee?.bps ?? 0,
          platformFeeMint: order.platformFee?.bps
            ? order.platformFee.mint
            : null,
          quotedAt: order.observedAt,
          expiresAt: order.expiresAt,
        },
        balance: {
          nativeRaw: balance.nativeRaw,
          observedAt: balance.observedAt,
          expiresAt: balance.expiresAt,
          nativeSlot: balance.nativeSlot!,
        },
        simulation: {
          observedAt: simulation.observedAt,
          slot: simulation.simulationSlot,
          networkFeeLamports: simulation.networkFeeLamports,
          maximumRentLamports: settlement.maximumRentLamports,
          maximumNativeDebitLamports: settlement.maximumNativeDebitLamports,
        },
      },
      after.databaseAt,
      before.databaseAt,
    );
    const last = await assertCurrent();
    if (Date.parse(preview.expiresAt) <= Date.parse(last.databaseAt))
      throw new StrategyDraftError(
        'Preview expired before completion. Check again.',
        409,
      );
    return preview;
  };
  try {
    return await Promise.race([stop, run()]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    controller.abort();
  }
}
