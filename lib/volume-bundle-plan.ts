import bs58 from 'bs58';
import { VOLUME_LIMITS, volumeRandom, rawToDecimal } from './volume-bot-plan';

/** Independent planning format. Never accepted by the scheduled swap runner. */
export type VolumeBundleTerms = {
  targetVolumeLamports: string;
  buyLamports: string;
  durationSeconds: number;
  delayMinMs: number;
  delayMaxMs: number;
  tipBudgetLamports: string;
  wallets: string[];
};
const fail = (message: string): never => {
  throw new Error(message);
};
const money = (value: unknown, label: string) => {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value))
    return fail(`Enter an exact positive ${label}.`);
  return BigInt(value);
};
const integer = (value: number, min: number, max: number, label: string) => {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    fail(`${label} must be between ${min} and ${max}.`);
};
export function planVolumeBundles(input: VolumeBundleTerms, seed: string) {
  if (
    !input ||
    Object.keys(input).sort().join(',') !==
      'buyLamports,delayMaxMs,delayMinMs,durationSeconds,targetVolumeLamports,tipBudgetLamports,wallets'
  )
    fail('Bundle settings contain unknown or missing fields.');
  const terms = structuredClone(input);
  const target = money(terms.targetVolumeLamports, 'volume target');
  const buy = money(terms.buyLamports, 'buy amount');
  const budget = money(terms.tipBudgetLamports, 'session tip budget');
  if (
    buy < VOLUME_LIMITS.minTradeLamports ||
    buy > VOLUME_LIMITS.maxTradeLamports
  )
    fail('Choose a buy amount from 0.001 to 1,000 SOL.');
  integer(terms.durationSeconds, 60, 86_400, 'Duration in seconds');
  integer(terms.delayMinMs, 1000, 600_000, 'Minimum delay in milliseconds');
  integer(
    terms.delayMaxMs,
    terms.delayMinMs,
    600_000,
    'Maximum delay in milliseconds',
  );
  if (
    !Array.isArray(terms.wallets) ||
    !terms.wallets.length ||
    terms.wallets.length > 25 ||
    new Set(terms.wallets).size !== terms.wallets.length ||
    terms.wallets.some((w) => {
      try {
        return typeof w !== 'string' || bs58.decode(w).length !== 32;
      } catch {
        return true;
      }
    })
  )
    fail('Choose one to 25 distinct Solana wallets.');
  const count = (target + 2n * buy - 1n) / (2n * buy);
  if (count > 250n)
    fail(
      'This target needs more than 250 bundles. Raise the buy amount or lower the target.',
    );
  // The cap is a maximum, not an instruction to spend the whole budget.
  const perBundle = budget / count;
  if (perBundle < 1000n || perBundle > 10_000_000n)
    fail(
      `For ${count} bundles, choose a session tip budget from ${rawToDecimal(count * 1000n, 9)} to ${rawToDecimal(count * 10_000_000n, 9)} SOL.`,
    );
  const random = volumeRandom(seed);
  let offsetMs = 0;
  const rounds = Array.from({ length: Number(count) }, (_, index) => {
    if (index) offsetMs += random.int(terms.delayMinMs, terms.delayMaxMs);
    return {
      index,
      wallet: terms.wallets[index % terms.wallets.length],
      offsetMs,
      buyLamports: buy.toString(),
      tipCapLamports: perBundle.toString(),
      orderedLegs: ['Buy', 'Sell'] as const,
      sellSource: 'this-round-buy-output-only' as const,
    };
  });
  if (offsetMs > terms.durationSeconds * 1000)
    fail(
      `These bundles need ${Math.ceil(offsetMs / 1000)} seconds. Lengthen the duration or shorten delays.`,
    );
  const allocated = perBundle * count;
  return {
    format: 'volume-bundle-plan-v1' as const,
    mode: 'same-block' as const,
    terms,
    seed,
    rounds,
    estimate: {
      bundles: Number(count),
      trades: Number(count) * 2,
      // Buy notional counted twice. Sell proceeds and actual volume are unknown.
      nominalVolumeLamports: (2n * buy * count).toString(),
      scheduledSeconds: Math.ceil(offsetMs / 1000),
      tipBudgetLamports: budget.toString(),
      allocatedTipCapLamports: allocated.toString(),
      unallocatedTipLamports: (budget - allocated).toString(),
      networkFeesLamports: (
        count *
        (2n * VOLUME_LIMITS.feePerTradeLamports + 5000n)
      ).toString(),
    },
    planningOnly: true as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
export type VolumeBundlePlan = ReturnType<typeof planVolumeBundles>;

/** Reconstruct before a future budget/storage consumer uses any derived cap. */
export function requireVolumeBundlePlan(plan: VolumeBundlePlan) {
  const rebuilt = planVolumeBundles(plan?.terms, plan?.seed);
  if (JSON.stringify(rebuilt) !== JSON.stringify(plan))
    fail('Bundle plan changed. Preview it again.');
  return rebuilt;
}
