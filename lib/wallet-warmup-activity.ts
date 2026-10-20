import type { SavedWarmup } from './wallet-warmup-storage';
import type { WarmupCycleProgress } from './warmup-cycle-progress';
import type { WarmupLotPerformance } from './warmup-lot-performance';
import {
  WARMUP_HISTORY_LIMIT,
  WARMUP_MAX_CYCLES,
  WARMUP_MAX_WALLETS,
} from './warmup-history-capacity';

const units = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,24})$/.test(value))
    throw new Error('Invalid recorded wallet volume.');
  return BigInt(value);
};
const count = (value: unknown): number => {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > WARMUP_HISTORY_LIMIT
  )
    throw new Error('Invalid recorded wallet transaction count.');
  return value;
};

/** Receipt-only summary. It does not infer current balances, pending transactions or an active runner. */
export function walletWarmupActivity(
  plan: SavedWarmup,
  progress: WarmupCycleProgress,
  performance: WarmupLotPerformance,
) {
  const { addresses, cycles, tokens } = plan.document;
  const fail = () => {
    throw new Error('Recorded wallet activity scope differs.');
  };
  if (
    !Array.isArray(addresses) ||
    !addresses.length ||
    addresses.length > WARMUP_MAX_WALLETS ||
    new Set(addresses).size !== addresses.length ||
    !Number.isSafeInteger(cycles) ||
    cycles < 1 ||
    cycles > WARMUP_MAX_CYCLES ||
    !Array.isArray(tokens) ||
    !tokens.length ||
    progress.planId !== plan.id ||
    progress.revision !== plan.revision ||
    progress.archived !== plan.archived ||
    progress.executionAllowed !== false ||
    typeof progress.includeEarlier !== 'boolean' ||
    !Array.isArray(progress.steps) ||
    progress.steps.length !== cycles * addresses.length ||
    !Array.isArray(performance.lots) ||
    performance.lots.length > WARMUP_HISTORY_LIMIT ||
    performance.lotCount !== performance.lots.length
  )
    fail();
  const lots = new Map(performance.lots.map((lot) => [lot.buyId, lot]));
  if (lots.size !== performance.lots.length) fail();
  const used = new Set<string>();
  const rows = addresses.map((wallet) => ({
    wallet,
    completedCycles: 0,
    totalCycles: cycles,
    buyTransactions: 0,
    sellTransactions: 0,
    transactionCount: 0,
    buyVolume: 0n,
    sellVolume: 0n,
    recoveryCount: 0,
  }));
  const seenSteps = new Set<string>();
  const recoveries = new Map<string, number>();
  for (const step of progress.steps) {
    if (
      !Number.isSafeInteger(step.cycle) ||
      step.cycle < 1 ||
      step.cycle > cycles ||
      step.mint !== tokens[(step.cycle - 1) % tokens.length]
    )
      fail();
    const row = rows.find((value) => value.wallet === step.wallet);
    const key = `${step.cycle}:${step.wallet}`;
    if (
      !row ||
      seenSteps.has(key) ||
      !Array.isArray(step.buyIds) ||
      step.buyIds.length !== step.buyCount
    )
      fail();
    seenSteps.add(key);
    const current = row!;
    const recoveryCount = count(step.recoveryCount);
    if (
      recoveries.has(step.wallet) &&
      recoveries.get(step.wallet) !== recoveryCount
    )
      fail();
    recoveries.set(step.wallet, recoveryCount);
    current.recoveryCount = recoveryCount;
    let remaining = 0n;
    for (const id of step.buyIds) {
      const lot = lots.get(id);
      if (
        !lot ||
        used.has(id) ||
        lot.wallet !== step.wallet ||
        lot.mint !== step.mint ||
        lot.decimals !== step.decimals
      )
        fail();
      used.add(id);
      const record = lot!;
      const buyVolume = units(record.buyVolumeLamports),
        sellVolume = units(record.sellVolumeLamports),
        sellCount = count(record.sellCount);
      const acquired = units(record.acquiredRaw),
        sold = units(record.soldRaw),
        left = units(record.remainingRaw);
      if (
        acquired === 0n ||
        sold + left !== acquired ||
        buyVolume === 0n ||
        (sellCount === 0
          ? sellVolume !== 0n || sold !== 0n
          : sellVolume === 0n || sold === 0n)
      )
        fail();
      remaining += left;
      current.buyTransactions++;
      current.sellTransactions += sellCount;
      current.buyVolume += buyVolume;
      current.sellVolume += sellVolume;
    }
    if (remaining !== units(step.remainingRaw)) fail();
    const expected =
      step.recoveryCount > 0
        ? 'Recovery required'
        : !step.buyIds.length
          ? 'Not bought'
          : remaining > 0n
            ? 'Tokens remaining'
            : 'Recorded lots sold';
    if (step.state !== expected) fail();
    if (step.state === 'Recorded lots sold') current.completedCycles++;
  }
  if (
    used.size !== lots.size ||
    progress.completedSteps !==
      rows.reduce((sum, row) => sum + row.completedCycles, 0)
  )
    fail();
  return rows.map(({ buyVolume, sellVolume, ...row }) => ({
    ...row,
    transactionCount: row.buyTransactions + row.sellTransactions,
    buyVolumeLamports: buyVolume.toString(),
    sellVolumeLamports: sellVolume.toString(),
    volumeLamports: (buyVolume + sellVolume).toString(),
    state:
      row.recoveryCount > 0
        ? 'Recovery required'
        : row.completedCycles === cycles
          ? 'Recorded loops complete'
          : row.buyTransactions > 0
            ? 'Partially recorded'
            : 'No recorded trades',
  }));
}
export type WalletWarmupActivity = ReturnType<typeof walletWarmupActivity>;
