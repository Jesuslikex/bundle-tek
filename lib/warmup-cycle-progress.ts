import type { SavedWarmup } from './wallet-warmup-storage';
import {
  WARMUP_HISTORY_LIMIT,
  WARMUP_MAX_CYCLES,
  WARMUP_MAX_WALLETS,
} from './warmup-history-capacity';
export type ProgressBuy = {
  id: string;
  planRevision: number;
  walletRevision: number;
  cycle: number;
  wallet: string;
  mint: string;
  acquiredRaw: string;
  remainingRaw: string;
  decimals: number;
  verified: number;
  commitment: string;
  network: string;
};
export type ProgressSell = {
  buyId: string;
  consumedRaw: string;
  verified: number;
  commitment: string;
  network: string;
};
export type ProgressApproval = { id: string; wallet: string; state: string };
const raw = (value: string) => {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n
  )
    throw new Error('Invalid recorded lot units.');
  return BigInt(value);
};
export function warmupCycleProgress(
  plan: SavedWarmup,
  buys: ProgressBuy[],
  sells: ProgressSell[],
  approvals: ProgressApproval[],
  includeEarlier: boolean,
) {
  if (
    !Number.isSafeInteger(plan.document.cycles) ||
    plan.document.cycles < 1 ||
    plan.document.cycles > WARMUP_MAX_CYCLES ||
    !plan.document.addresses.length ||
    plan.document.addresses.length > WARMUP_MAX_WALLETS ||
    !plan.document.tokens.length ||
    new Set(plan.document.addresses).size !== plan.document.addresses.length
  )
    throw new Error('Invalid saved cycle configuration.');
  if (buys.length > WARMUP_HISTORY_LIMIT || sells.length > WARMUP_HISTORY_LIMIT)
    throw new Error('Recorded receipt capacity exceeded.');
  const consumed = new Map<string, bigint>();
  for (const sell of sells) {
    if (
      sell.verified !== 1 ||
      sell.commitment !== 'finalized' ||
      sell.network !== 'mainnet' ||
      raw(sell.consumedRaw) === 0n
    )
      throw new Error('Incomplete finalized sell evidence.');
    consumed.set(
      sell.buyId,
      (consumed.get(sell.buyId) ?? 0n) + raw(sell.consumedRaw),
    );
  }
  const seen = new Set<string>();
  for (const buy of buys) {
    if (
      seen.has(buy.id) ||
      buy.verified !== 1 ||
      buy.commitment !== 'finalized' ||
      buy.network !== 'mainnet' ||
      raw(buy.acquiredRaw) === 0n ||
      !Number.isInteger(buy.decimals) ||
      buy.decimals < 0 ||
      buy.decimals > 18 ||
      !Number.isSafeInteger(buy.planRevision) ||
      buy.planRevision < 1 ||
      !Number.isSafeInteger(buy.walletRevision) ||
      buy.walletRevision < 1
    )
      throw new Error('Incomplete finalized buy evidence.');
    if (
      raw(buy.remainingRaw) + (consumed.get(buy.id) ?? 0n) !==
      raw(buy.acquiredRaw)
    )
      throw new Error('Recorded lot accounting differs.');
    seen.add(buy.id);
  }
  if ([...consumed.keys()].some((id) => !seen.has(id)))
    throw new Error('Recorded sell source unavailable.');
  const active = new Map<string, number>();
  for (const approval of approvals) {
    if (!['awaiting_signature', 'signed', 'submitted'].includes(approval.state))
      throw new Error('Invalid active approval state.');
    active.set(approval.wallet, (active.get(approval.wallet) ?? 0) + 1);
  }
  let includedBuys = 0;
  const steps = Array.from({ length: plan.document.cycles }, (_, index) =>
    plan.document.addresses.map((wallet) => {
      const cycle = index + 1,
        mint = plan.document.tokens[index % plan.document.tokens.length];
      const walletRevision = plan.document.walletRevisions.find(
        (row) => row.address === wallet,
      )?.revision;
      const lots = buys.filter(
        (buy) =>
          buy.cycle === cycle &&
          buy.wallet === wallet &&
          buy.mint === mint &&
          buy.planRevision <= plan.revision &&
          buy.walletRevision <= (walletRevision ?? 0) &&
          (includeEarlier ||
            (buy.planRevision === plan.revision &&
              buy.walletRevision === walletRevision)),
      );
      includedBuys += lots.length;
      const decimals = lots[0]?.decimals ?? null;
      if (lots.some((lot) => lot.decimals !== decimals))
        throw new Error('Recorded token decimals differ.');
      const remainingRaw = lots
        .reduce((sum, lot) => sum + raw(lot.remainingRaw), 0n)
        .toString();
      const recoveryCount = active.get(wallet) ?? 0;
      return {
        cycle,
        wallet,
        mint,
        decimals,
        buyCount: lots.length,
        buyIds: lots.map((lot) => lot.id),
        remainingRaw,
        recoveryCount,
        state: recoveryCount
          ? 'Recovery required'
          : !lots.length
            ? 'Not bought'
            : remainingRaw !== '0'
              ? 'Tokens remaining'
              : 'Recorded lots sold',
        historicalBuyCount: lots.filter(
          (lot) =>
            lot.planRevision !== plan.revision ||
            lot.walletRevision !== walletRevision,
        ).length,
      };
    }),
  ).flat();
  return {
    planId: plan.id,
    revision: plan.revision,
    archived: plan.archived,
    includeEarlier,
    executionAllowed: false as const,
    steps,
    excludedBuys: buys.length - includedBuys,
    completedSteps: steps.filter((step) => step.state === 'Recorded lots sold')
      .length,
    activeApprovals: approvals.length,
  };
}
export type WarmupCycleProgress = ReturnType<typeof warmupCycleProgress>;
