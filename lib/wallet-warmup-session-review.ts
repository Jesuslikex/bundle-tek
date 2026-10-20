import { buildWarmupPlan, warmupAtoms } from './wallet-warmup';
import type { SavedWarmup } from './wallet-warmup-storage';
import type { WarmupCycleProgress } from './warmup-cycle-progress';
import type { WarmupLotPerformance } from './warmup-lot-performance';
import { walletWarmupActivity } from './wallet-warmup-activity';

type ActionContext = {
  id: string;
  wallet: string;
  walletRevision: number;
  cycle: number;
  mint: string;
  scheduledAt: string;
};
function recordedLamports(value: string, signed = false) {
  if (
    typeof value !== 'string' ||
    !(signed ? /^(0|-?[1-9]\d{0,24})$/ : /^(0|[1-9]\d{0,24})$/).test(value)
  )
    throw new Error('Recorded session costs are unavailable.');
  return BigInt(value);
}
export type WarmupSessionAction = ActionContext &
  (
    | { side: 'Buy'; inputLamports: string }
    | {
        side: 'Sell';
        source:
          | { kind: 'session-buy'; actionId: string }
          | {
              kind: 'saved-buy';
              buyReceiptId: string;
              remainingRaw: string;
              decimals: number;
            };
      }
  );

/** Public planning data only. It cannot authorize a signature, submission or timer. */
export function reviewWalletWarmupSession(
  saved: SavedWarmup,
  progress: WarmupCycleProgress,
  performance: WarmupLotPerformance,
  now = Date.now(),
) {
  const plan = structuredClone(saved);
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !plan.id ||
    !Number.isSafeInteger(plan.revision) ||
    plan.revision < 1 ||
    plan.archived ||
    plan.document.chain !== 'Solana'
  )
    throw new Error('Choose an active saved Solana plan.');
  if (progress.includeEarlier !== false)
    throw new Error(
      'Automatic session review requires the current saved plan and wallet revisions.',
    );
  const activity = walletWarmupActivity(plan, progress, performance);
  if (progress.excludedBuys !== 0)
    throw new Error(
      'Review excluded receipt history manually before planning an automatic session.',
    );
  if (
    progress.activeApprovals !== 0 ||
    activity.some((wallet) => wallet.recoveryCount !== 0)
  )
    throw new Error(
      'Recover every active approval before reviewing an automatic session.',
    );
  const revisions = plan.document.walletRevisions;
  if (
    !Array.isArray(revisions) ||
    revisions.length !== plan.document.addresses.length ||
    new Set(revisions.map((wallet) => wallet.address)).size !==
      revisions.length ||
    revisions.some(
      (wallet) =>
        !plan.document.addresses.includes(wallet.address) ||
        !Number.isSafeInteger(wallet.revision) ||
        wallet.revision < 1,
    )
  )
    throw new Error('The saved wallet revision capture differs.');
  const originalStart = Date.parse(plan.document.startAt);
  if (!Number.isFinite(originalStart))
    throw new Error('The saved start time is invalid.');
  // Old scheduled times are never backfilled. The rebased schedule itself is part of this review.
  const effectiveStart = Math.max(now, originalStart);
  const rebuilt = buildWarmupPlan(
    { ...plan.document, startAt: new Date(effectiveStart).toISOString() },
    now,
  );
  if (rebuilt.totalBudget !== plan.document.totalBudget)
    throw new Error(
      'The saved plan budget differs. Review and save the plan again.',
    );
  const actions: WarmupSessionAction[] = [];
  const lots = new Map(performance.lots.map((lot) => [lot.buyId, lot]));
  const buySpend = new Map(
    plan.document.addresses.map((wallet) => [wallet, 0n]),
  );
  for (const action of rebuilt.actions) {
    const step = progress.steps.find(
      (step) => step.cycle === action.cycle && step.wallet === action.address,
    )!;
    if (step.state === 'Recorded lots sold') continue;
    const context = {
      wallet: action.address,
      walletRevision: revisions.find(
        (wallet) => wallet.address === action.address,
      )!.revision,
      cycle: action.cycle,
      mint: action.token,
      scheduledAt: action.scheduledAt,
    };
    const buyId = `Buy:${action.cycle}:${action.address}`;
    if (action.side === 'Buy') {
      if (step.state !== 'Not bought') continue;
      const amount = warmupAtoms(action.amount, 9);
      buySpend.set(action.address, buySpend.get(action.address)! + amount);
      actions.push({
        ...context,
        id: buyId,
        side: 'Buy',
        inputLamports: amount.toString(),
      });
    } else if (step.state === 'Not bought') {
      actions.push({
        ...context,
        id: `Sell:${action.cycle}:${action.address}`,
        side: 'Sell',
        source: { kind: 'session-buy', actionId: buyId },
      });
    } else if (step.state === 'Tokens remaining') {
      for (const id of step.buyIds) {
        const lot = lots.get(id)!;
        if (lot.remainingRaw === '0') continue;
        if (
          !/^[1-9]\d{0,19}$/.test(lot.remainingRaw) ||
          BigInt(lot.remainingRaw) > (1n << 64n) - 1n ||
          !Number.isSafeInteger(lot.decimals) ||
          lot.decimals < 0 ||
          lot.decimals > 18
        )
          throw new Error(
            'Saved buy units are unavailable for session review.',
          );
        actions.push({
          ...context,
          id: `Sell:${action.cycle}:${action.address}:${id}`,
          side: 'Sell',
          source: {
            kind: 'saved-buy',
            buyReceiptId: id,
            remainingRaw: lot.remainingRaw,
            decimals: lot.decimals,
          },
        });
      }
    }
  }
  const wallets = plan.document.addresses.map((wallet) => {
    const buys = buySpend.get(wallet)!;
    const active = actions.some((action) => action.wallet === wallet);
    const reserve = warmupAtoms(plan.document.feeReserve, 9);
    const prior = performance.lots.filter((lot) => lot.wallet === wallet);
    const recordedBuySpend = prior.reduce(
      (sum, lot) => sum + recordedLamports(lot.buyVolumeLamports),
      0n,
    );
    const recordedFees = prior.reduce(
      (sum, lot) => sum + recordedLamports(lot.networkFeeLamports),
      0n,
    );
    const recordedRent = prior.reduce(
      (sum, lot) => sum + recordedLamports(lot.rentChangeLamports, true),
      0n,
    );
    const priorCosts = recordedFees + (recordedRent > 0n ? recordedRent : 0n);
    const originalBuyBudget = rebuilt.actions.reduce(
      (sum, action) =>
        sum +
        (action.side === 'Buy' && action.address === wallet
          ? warmupAtoms(action.amount, 9)
          : 0n),
      0n,
    );
    if (recordedBuySpend + buys > originalBuyBudget)
      throw new Error(
        'Recorded and remaining buys exceed the saved wallet budget. Review the receipt history and plan.',
      );
    if (priorCosts > reserve)
      throw new Error(
        'Recorded fees and rent exceed the saved fee reserve. Review the plan before another session.',
      );
    const remainingReserve = reserve - priorCosts;
    if (active && remainingReserve === 0n)
      throw new Error(
        'The saved fee reserve is exhausted. Review the plan before another session.',
      );
    return {
      wallet,
      walletRevision: revisions.find((row) => row.address === wallet)!.revision,
      buySpendLamports: buys.toString(),
      feeReserveLamports: reserve.toString(),
      recordedBuySpendLamports: recordedBuySpend.toString(),
      recordedNetworkFeesLamports: recordedFees.toString(),
      recordedRentChangeLamports: recordedRent.toString(),
      remainingFeeReserveLamports: remainingReserve.toString(),
      maximumNativeSpendLamports: (active
        ? buys + remainingReserve
        : 0n
      ).toString(),
    };
  });
  const review = {
    planId: plan.id,
    planRevision: plan.revision,
    reviewedAt: new Date(now).toISOString(),
    originalStartAt: plan.document.startAt,
    effectiveStartAt: new Date(effectiveStart).toISOString(),
    actions,
    wallets,
    totalMaximumNativeSpendLamports: wallets
      .reduce(
        (sum, wallet) => sum + BigInt(wallet.maximumNativeSpendLamports),
        0n,
      )
      .toString(),
    completedRecordedLoops: progress.completedSteps,
    status: actions.length
      ? ('Review required' as const)
      : ('Recorded loops complete' as const),
    executionAllowed: false as const,
    signingAllowed: false as const,
    automaticExecutionAllowed: false as const,
  };
  // Exact public context, not a cryptographic capability or server authorization.
  return {
    ...review,
    contextKey: JSON.stringify([plan, progress, performance, review]),
  };
}
export type WalletWarmupSessionReview = ReturnType<
  typeof reviewWalletWarmupSession
>;
