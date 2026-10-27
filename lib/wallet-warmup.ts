import { walletAddress, walletChain } from './wallet-workspace';
import { EVM_NETWORKS, evmChain } from './evm-network';
import {
  WARMUP_MAX_WALLETS,
  WARMUP_MAX_CYCLES,
} from './warmup-history-capacity';

export type WarmupPlatform = 'none' | 'axiom';
/** How wallets share the timeline. */
export type WarmupSchedule = 'staggered' | 'sequential';
export type WarmupInput = {
  chain: string;
  addresses: string[];
  tokens: string[];
  amount: string;
  /** Range mode: inclusive upper bound; `amount` is the lower bound. */
  amountMax?: string;
  /** Range mode: reviewed buy amount per wallet (input order) and cycle. */
  amounts?: string[][];
  /** Organic mode: reviewed cadence, hold, token and skip draws. */
  organic?: WarmupOrganic;
  /** Organic mode settings the draws were made from, kept for the form. */
  organicTerms?: WarmupOrganicTerms;
  /**
   * Alternative routing. `axiom` sends each swap through the Axiom terminal so
   * the history shows trading-platform use instead of bare wallet transfers.
   * Client-side evidence only: the capture cannot prove the backend route.
   */
  platform?: WarmupPlatform;
  /** `sequential` runs one wallet at a time, the way Proxima does. */
  schedule?: WarmupSchedule;
  feeReserve: string;
  cycles: number;
  /** Legacy whole-minute delay (15 to 10,080). */
  intervalMinutes?: number;
  /** Delay between cycles in seconds; takes precedence over intervalMinutes. */
  intervalSeconds?: number;
  startAt: string;
};

/**
 * Organic mode settings. The legacy schedule is a fixed metronome: every
 * wallet trades the same amount on the same beat, rotating tokens in order and
 * selling exactly half an interval later. Organic mode keeps the same budget
 * and ordering guarantees but draws a per-wallet cadence, hold time, token and
 * occasional skipped cycle, so the resulting history does not read as a
 * machine. Draws are made once at review and saved, so every later rebuild,
 * preparation and receipt check binds the exact reviewed schedule.
 */
export type WarmupOrganicTerms = {
  /** Cadence jitter as a percentage of the interval, 0 to 50. */
  jitterPercent: number;
  /** Shortest hold between a buy and its sell, in seconds (at least 30). */
  holdMinSeconds: number;
  holdMaxSeconds: number;
  /** Percent chance a wallet skips a cycle, 0 to 40. */
  skipPercent: number;
  /** Pick tokens at random instead of rotating them in order. */
  randomTokens: boolean;
};
export type WarmupOrganic = {
  /** Buy offset in seconds from the start, per wallet (input order) and cycle. */
  offsets: number[][];
  /** Hold in seconds between a buy and its sell, same shape as `offsets`. */
  holds: number[][];
  /** Token index per cycle. */
  tokenPicks: number[];
  /** Skipped cycles, same shape as `offsets`. */
  skips: boolean[][];
};
export type WarmupPlanField =
  | 'tokens'
  | 'amount'
  | 'amountMax'
  | 'organic'
  | 'platform'
  | 'schedule'
  | 'feeReserve'
  | 'cycles'
  | 'intervalMinutes'
  | 'intervalSeconds'
  | 'startAt';
export class WarmupPlanInputError extends Error {
  constructor(
    readonly field: WarmupPlanField,
    message: string,
  ) {
    super(message);
    this.name = 'WarmupPlanInputError';
  }
}
function validateField<T>(field: WarmupPlanField, validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new WarmupPlanInputError(field, error.message);
  }
}
export function nativeUnits(chain: string) {
  return chain === 'Solana'
    ? { symbol: 'SOL', decimals: 9 }
    : { symbol: EVM_NETWORKS[evmChain(chain)].currency, decimals: 18 };
}
export function warmupAtoms(
  value: unknown,
  decimals: number,
  allowZero = false,
) {
  if (typeof value !== 'string' || !/^\d{1,12}(?:\.\d{1,18})?$/.test(value))
    throw new Error('Enter a plain decimal amount.');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals)
    throw new Error(`Use at most ${decimals} decimal places.`);
  const result =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, '0'));
  if (!allowZero && result === 0n)
    throw new Error('Swap amount and fee reserve must be positive.');
  return result;
}
export function warmupDecimal(value: bigint, decimals: number) {
  const s = value.toString().padStart(decimals + 1, '0');
  const fraction = s.slice(-decimals).replace(/0+$/, '');
  return s.slice(0, -decimals) + (fraction ? '.' + fraction : '');
}
export const WARMUP_ORGANIC_LIMITS = {
  maxJitterPercent: 50,
  maxSkipPercent: 40,
  minHoldSeconds: 30,
} as const;

/** Strict validation of organic mode settings. */
export function warmupOrganicTerms(value: unknown): WarmupOrganicTerms {
  const input = value as Record<string, unknown> | null;
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Choose organic settings.');
  const keys = Object.keys(input).sort().join(',');
  if (keys !== 'holdMaxSeconds,holdMinSeconds,jitterPercent,randomTokens,skipPercent')
    throw new Error('Organic settings contain unknown fields.');
  const int = (raw: unknown, min: number, max: number, label: string) => {
    if (!Number.isSafeInteger(raw) || (raw as number) < min || (raw as number) > max)
      throw new Error(`Choose ${label} between ${min} and ${max}.`);
    return raw as number;
  };
  const jitterPercent = int(input.jitterPercent, 0, WARMUP_ORGANIC_LIMITS.maxJitterPercent, 'cadence jitter as a percentage');
  const holdMinSeconds = int(input.holdMinSeconds, WARMUP_ORGANIC_LIMITS.minHoldSeconds, 604800, 'a shortest hold in seconds');
  const holdMaxSeconds = int(input.holdMaxSeconds, holdMinSeconds, 604800, 'a longest hold at or above the shortest');
  const skipPercent = int(input.skipPercent, 0, WARMUP_ORGANIC_LIMITS.maxSkipPercent, 'a skip chance as a percentage');
  if (typeof input.randomTokens !== 'boolean')
    throw new Error('Choose whether tokens are picked at random.');
  return { jitterPercent, holdMinSeconds, holdMaxSeconds, skipPercent, randomTokens: input.randomTokens };
}

/**
 * Validates reviewed organic draws against the current shape and interval.
 * Every draw is checked, so a tampered or stale schedule cannot silently
 * produce a different history than the one that was reviewed.
 */
export function warmupOrganic(
  organic: unknown,
  terms: unknown,
  shape: { wallets: number; cycles: number; tokens: number; intervalSeconds: number },
): WarmupOrganic | undefined {
  if (organic === undefined) {
    if (terms !== undefined) throw new Error('Review the plan again to draw an organic schedule.');
    return undefined;
  }
  const settings = warmupOrganicTerms(terms);
  const input = organic as Record<string, unknown> | null;
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Review the plan again to draw an organic schedule.');
  const keys = Object.keys(input).sort().join(',');
  if (keys !== 'holds,offsets,skips,tokenPicks')
    throw new Error('Organic schedule contains unknown fields.');
  const grid = (raw: unknown, label: string, check: (value: unknown) => boolean) => {
    if (!Array.isArray(raw) || raw.length !== shape.wallets)
      throw new Error(`Review the plan again to draw organic ${label}.`);
    return raw.map((row) => {
      if (!Array.isArray(row) || row.length !== shape.cycles)
        throw new Error(`Review the plan again to draw organic ${label}.`);
      if (!row.every(check))
        throw new Error(`An organic ${label} value is out of range.`);
      return row as number[];
    });
  };
  const seconds = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
  const offsets = grid(input.offsets, 'cadence', seconds);
  const holds = grid(input.holds, 'hold', (value) => seconds(value) && (value as number) >= WARMUP_ORGANIC_LIMITS.minHoldSeconds && (value as number) <= shape.intervalSeconds);
  const skips = grid(input.skips, 'skip', (value) => typeof value === 'boolean') as unknown as boolean[][];
  const horizon = shape.cycles * shape.intervalSeconds;
  for (let wallet = 0; wallet < shape.wallets; wallet++) {
    let previous = -1;
    for (let cycle = 0; cycle < shape.cycles; cycle++) {
      const offset = offsets[wallet][cycle];
      if (offset >= horizon) throw new Error('An organic cadence falls outside the plan window.');
      if (skips[wallet][cycle]) continue;
      if (offset <= previous) throw new Error('Organic cycles must stay in order for each wallet.');
      previous = offset + holds[wallet][cycle];
    }
    if (previous < 0) throw new Error('Every wallet needs at least one organic cycle.');
  }
  if (!Array.isArray(input.tokenPicks) || input.tokenPicks.length !== shape.cycles)
    throw new Error('Review the plan again to draw organic tokens.');
  const tokenPicks = input.tokenPicks.map((pick) => {
    if (!Number.isSafeInteger(pick) || (pick as number) < 0 || (pick as number) >= shape.tokens)
      throw new Error('An organic token pick is out of range.');
    return pick as number;
  });
  return { offsets, holds, tokenPicks, skips };
}

/**
 * Draws one organic schedule. Cadence is jittered around the interval and
 * pushed forward so a wallet never opens a second cycle before its previous
 * sell, holds are drawn inside the reviewed range, tokens are picked at random
 * when asked, and cycles are skipped at the reviewed chance. The first cycle of
 * every wallet is always kept so no wallet is left with an empty history.
 */
export function drawWarmupOrganic(
  terms: WarmupOrganicTerms,
  wallets: number,
  cycles: number,
  tokenCount: number,
  intervalSeconds: number,
  random: (bound: bigint) => bigint = cryptoBelow,
) {
  const settings = warmupOrganicTerms(terms);
  if (settings.holdMaxSeconds > intervalSeconds)
    throw new Error('The longest hold must fit inside the cycle delay.');
  const draw = (min: number, max: number) =>
    max <= min ? min : min + Number(random(BigInt(max - min + 1)));
  const spread = Math.floor((intervalSeconds * settings.jitterPercent) / 100);
  const offsets: number[][] = [];
  const holds: number[][] = [];
  const skips: boolean[][] = [];
  for (let wallet = 0; wallet < wallets; wallet++) {
    const rowOffsets: number[] = [];
    const rowHolds: number[] = [];
    const rowSkips: boolean[] = [];
    let previous = -1;
    for (let cycle = 0; cycle < cycles; cycle++) {
      const hold = draw(settings.holdMinSeconds, settings.holdMaxSeconds);
      let offset = cycle * intervalSeconds + draw(-spread, spread);
      if (offset <= previous) offset = previous + 1;
      if (offset >= cycles * intervalSeconds) offset = cycles * intervalSeconds - 1;
      const skip = cycle > 0 && draw(0, 99) < settings.skipPercent;
      rowOffsets.push(offset);
      rowHolds.push(hold);
      rowSkips.push(skip);
      previous = offset + hold;
    }
    offsets.push(rowOffsets);
    holds.push(rowHolds);
    skips.push(rowSkips);
  }
  const tokenPicks = Array.from({ length: cycles }, (_, cycle) =>
    settings.randomTokens && tokenCount > 0
      ? Number(random(BigInt(tokenCount)))
      : cycle % Math.max(1, tokenCount),
  );
  return { offsets, holds, tokenPicks, skips };
}

export function buildWarmupPlan(input: WarmupInput, now = Date.now()) {
  const chain = walletChain(input.chain),
    unit = nativeUnits(chain);
  if (
    !Array.isArray(input.addresses) ||
    !input.addresses.length ||
    input.addresses.length > WARMUP_MAX_WALLETS
  )
    throw new Error('Select between 1 and 20 active wallets.');
  const addresses = input.addresses.map((a) => walletAddress(a, chain));
  if (new Set(addresses).size !== addresses.length)
    throw new Error('Remove duplicate wallets.');
  if (
    !Array.isArray(input.tokens) ||
    !input.tokens.length ||
    input.tokens.length > 10
  )
    throw new WarmupPlanInputError(
      'tokens',
      'Enter between 1 and 10 token addresses.',
    );
  const tokens = validateField('tokens', () =>
    input.tokens.map((a) => walletAddress(a, chain)),
  );
  if (
    new Set(tokens).size !== tokens.length ||
    tokens.some((t) => addresses.includes(t))
  )
    throw new WarmupPlanInputError(
      'tokens',
      'Use distinct token addresses, separate from wallet addresses.',
    );
  if (
    !Number.isSafeInteger(input.cycles) ||
    input.cycles < 1 ||
    input.cycles > WARMUP_MAX_CYCLES
  )
    throw new WarmupPlanInputError(
      'cycles',
      'Choose 1 to 20 buy/sell cycles per wallet.',
    );
  const legacyInterval = input.intervalSeconds === undefined;
  if (legacyInterval) {
    if (
      !Number.isSafeInteger(input.intervalMinutes) ||
      input.intervalMinutes! < 15 ||
      input.intervalMinutes! > 10080
    )
      throw new WarmupPlanInputError(
        'intervalMinutes',
        'Choose 15 minutes to 7 days between cycles.',
      );
  } else if (
    !Number.isSafeInteger(input.intervalSeconds) ||
    input.intervalSeconds! < WARMUP_MIN_DELAY_SECONDS ||
    input.intervalSeconds! > WARMUP_HARD_MAX_DELAY_SECONDS
  )
    throw new WarmupPlanInputError(
      'intervalSeconds',
      `Choose a delay from ${WARMUP_MIN_DELAY_SECONDS} second to ${WARMUP_HARD_MAX_DELAY_SECONDS} seconds.`,
    );
  const platform = input.platform ?? 'none';
  if (platform !== 'none' && platform !== 'axiom')
    throw new WarmupPlanInputError(
      'platform',
      'Choose no routing or Axiom routing.',
    );
  const schedule = input.schedule ?? 'staggered';
  if (schedule !== 'staggered' && schedule !== 'sequential')
    throw new WarmupPlanInputError(
      'schedule',
      'Choose a staggered or sequential schedule.',
    );
  const intervalSeconds = legacyInterval
    ? input.intervalMinutes! * 60
    : input.intervalSeconds!;
  const start = Date.parse(input.startAt);
  if (!Number.isFinite(start) || start < now || start > now + 30 * 86400000)
    throw new WarmupPlanInputError(
      'startAt',
      'Choose a start within the next 30 days.',
    );
  const amount = validateField('amount', () =>
      warmupAtoms(input.amount, unit.decimals),
    ),
    reserve = validateField('feeReserve', () =>
      warmupAtoms(input.feeReserve, unit.decimals),
    );
  const ranged = input.amountMax !== undefined;
  const amountMax = ranged
    ? validateField('amountMax', () => {
        const max = warmupAtoms(input.amountMax, unit.decimals);
        if (max <= amount)
          throw new Error('Range maximum must be above the minimum.');
        return max;
      })
    : amount;
  // Range amounts are drawn once at review and saved, so every later rebuild,
  // preparation and receipt check binds the exact reviewed per-cycle input.
  const amounts: bigint[][] = ranged
    ? validateField('amountMax', () => {
        if (
          !Array.isArray(input.amounts) ||
          input.amounts.length !== addresses.length ||
          input.amounts.some(
            (row) => !Array.isArray(row) || row.length !== input.cycles,
          )
        )
          throw new Error('Review the plan again to draw range amounts.');
        return input.amounts.map((row) =>
          row.map((value) => {
            const atoms = warmupAtoms(value, unit.decimals);
            if (atoms < amount || atoms > amountMax)
              throw new Error('A range amount is outside the reviewed range.');
            return atoms;
          }),
        );
      })
    : addresses.map(() => Array.from({ length: input.cycles }, () => amount));
  if (!ranged && input.amounts !== undefined)
    throw new WarmupPlanInputError(
      'amountMax',
      'Per-cycle amounts need a range maximum.',
    );
  const organic = validateField('organic', () =>
    warmupOrganic(input.organic, input.organicTerms, {
      wallets: addresses.length,
      cycles: input.cycles,
      tokens: tokens.length,
      intervalSeconds,
    }),
  );
  const interval = intervalSeconds * 1000;
  const actions = addresses
    .flatMap((address, walletIndex) =>
      Array.from({ length: input.cycles }, (_, cycle) => {
        if (organic?.skips[walletIndex][cycle]) return [];
        const token = organic
          ? tokens[organic.tokenPicks[cycle]]
          : tokens[cycle % tokens.length];
        // Sequential gives each wallet its own slot so only one wallet is live
        // at a time, which is how Proxima schedules the run. Staggered keeps
        // the legacy overlapping beat.
        const walletBase =
          schedule === 'sequential' ? start + walletIndex * input.cycles * interval : start;
        const buyAt = organic
          ? walletBase + organic.offsets[walletIndex][cycle] * 1000
          : walletBase +
            cycle * interval +
            (schedule === 'sequential'
              ? 0
              : Math.floor((walletIndex * interval) / (addresses.length * 4)));
        const sellAt = organic
          ? buyAt + organic.holds[walletIndex][cycle] * 1000
          : buyAt + interval / 2;
        return [
          {
            address,
            token,
            cycle: cycle + 1,
            side: 'Buy' as const,
            amount: warmupDecimal(amounts[walletIndex][cycle], unit.decimals),
            scheduledAt: new Date(buyAt).toISOString(),
          },
          {
            address,
            token,
            cycle: cycle + 1,
            side: 'Sell' as const,
            amount: '100% of tokens acquired in this cycle',
            scheduledAt: new Date(sellAt).toISOString(),
          },
        ];
      }).flat(),
    )
    .sort(
      (a, b) =>
        a.scheduledAt.localeCompare(b.scheduledAt) ||
        a.address.localeCompare(b.address),
    );
  const buyTotals = amounts.map((row, walletIndex) =>
    row.reduce(
      (total, value, cycle) =>
        organic?.skips[walletIndex][cycle] ? total : total + value,
      0n,
    ),
  );
  const walletBudgets = addresses.map((address, i) => ({
    address,
    required: warmupDecimal(buyTotals[i] + reserve, unit.decimals),
  }));
  const maxBuys = buyTotals.reduce((a, b) => (b > a ? b : a), 0n);
  const total =
    buyTotals.reduce((a, b) => a + b, 0n) + reserve * BigInt(addresses.length);
  return {
    format: 'pulseforge-warmup-plan-v1' as const,
    executionAllowed: false as const,
    chain,
    currency: unit.symbol,
    addresses,
    tokens,
    cycles: input.cycles,
    ...(legacyInterval ? { intervalMinutes: input.intervalMinutes! } : {}),
    intervalSeconds,
    platform,
    schedule,
    startAt: new Date(start).toISOString(),
    buyAmount: warmupDecimal(amount, unit.decimals),
    ...(ranged
      ? {
          buyAmountMax: warmupDecimal(amountMax, unit.decimals),
          buyAmounts: amounts.map((row) =>
            row.map((v) => warmupDecimal(v, unit.decimals)),
          ),
        }
      : {}),
    feeReserve: warmupDecimal(reserve, unit.decimals),
    ...(organic && input.organicTerms
      ? { organicTerms: warmupOrganicTerms(input.organicTerms), organic }
      : {}),
    buyBudgetPerWallet: warmupDecimal(maxBuys, unit.decimals),
    requiredPerWallet: warmupDecimal(maxBuys + reserve, unit.decimals),
    walletBudgets,
    totalBudget: warmupDecimal(total, unit.decimals),
    actions,
    createdAt: new Date(now).toISOString(),
    limitations:
      'Review plan only. No scheduler, quote, token verification or signing. Sell proceeds are not reused in the budget. Fees and sell output are unknown; the reserve is user-chosen. Activity does not prove wallet creation age or launch eligibility.' +
      (platform === 'axiom'
        ? ' Axiom routing is a declared intent: the capture shows the flag and its fee, not the backend route, so confirm it on chain.'
        : '') +
      (organic
        ? ' Organic mode only randomises timing, size, token order and skipped cycles. Every wallet is still funded and driven by the same operator, so the history is disguised, not independent.'
        : ''),
  };
}
export type WarmupPlan = ReturnType<typeof buildWarmupPlan>;
export const WARMUP_MIN_DELAY_SECONDS = 1;
/** Proxima's own cap. The UI recommends this; the hard ceiling is below. */
export const WARMUP_MAX_DELAY_SECONDS = 300;
/** Bundle warmups can run for days, so the hard ceiling stays at 7 days. */
export const WARMUP_HARD_MAX_DELAY_SECONDS = 604800;
/**
 * Per-loop, per-wallet fee floor in lamports, from Proxima's own estimate:
 * 50,000 lamports bare and 1,050,000 through Axiom, each scaled by its 13,000
 * basis-point balance multiplier. Real fees still come from each simulation.
 */
export const WARMUP_FEE_PER_LOOP_LAMPORTS = {
  none: 65_000n,
  axiom: 1_365_000n,
} as const;
/** Suggested reserve for one wallet's whole run, as a decimal string. */
export function warmupSuggestedReserve(
  platform: WarmupPlatform,
  cycles: number,
  decimals: number,
) {
  return warmupDecimal(
    WARMUP_FEE_PER_LOOP_LAMPORTS[platform] * BigInt(cycles),
    decimals,
  );
}
/** Live totals for the form, mirroring buildWarmupPlan's schedule. */
export function estimateWarmupTotals(
  wallets: number,
  cycles: number,
  amount: string,
  reserve: string,
  delaySeconds: number,
  decimals: number,
  schedule: WarmupSchedule = 'staggered',
  platform: WarmupPlatform = 'none',
) {
  try {
    if (
      !Number.isSafeInteger(wallets) ||
      wallets < 1 ||
      wallets > WARMUP_MAX_WALLETS ||
      !Number.isSafeInteger(cycles) ||
      cycles < 1 ||
      cycles > WARMUP_MAX_CYCLES ||
      !Number.isSafeInteger(delaySeconds) ||
      delaySeconds < WARMUP_MIN_DELAY_SECONDS ||
      delaySeconds > WARMUP_HARD_MAX_DELAY_SECONDS
    )
      return null;
    const per = warmupAtoms(amount, decimals),
      fee = warmupAtoms(reserve, decimals);
    if (per <= 0n) return null;
    const ms = delaySeconds * 1000;
    const window =
      schedule === 'sequential'
        ? wallets * cycles * ms
        : (cycles - 1) * ms +
          Math.floor(((wallets - 1) * ms) / (wallets * 4)) +
          ms / 2;
    return {
      required: warmupDecimal(
        (per * BigInt(cycles) + fee) * BigInt(wallets),
        decimals,
      ),
      seconds: Math.ceil(window / 1000),
      suggestedReserve: warmupSuggestedReserve(platform, cycles, decimals),
    };
  } catch {
    return null;
  }
}
/** Exact reviewed buy input for one wallet and 1-based cycle of a saved plan. */
export function warmupBuyAmount(
  document: Pick<WarmupInput, 'addresses' | 'amount' | 'amounts'>,
  wallet: string,
  cycle: number,
) {
  if (!document.amounts) return document.amount;
  const value =
    document.amounts[document.addresses.indexOf(wallet)]?.[cycle - 1];
  if (typeof value !== 'string')
    throw new Error('Saved warmup amount unavailable for this wallet.');
  return value;
}
export function warmupDelaySeconds(
  document: Pick<WarmupInput, 'intervalMinutes' | 'intervalSeconds'>,
) {
  return document.intervalSeconds ?? (document.intervalMinutes ?? 0) * 60;
}
export function formatWarmupDelay(seconds: number) {
  const d = Math.floor(seconds / 86400),
    h = Math.floor((seconds % 86400) / 3600),
    m = Math.floor((seconds % 3600) / 60),
    s = seconds % 60;
  return (
    [d && `${d}d`, h && `${h}h`, m && `${m}m`, s && `${s}s`]
      .filter(Boolean)
      .join(' ') || '0s'
  );
}
/**
 * Draw one buy amount per wallet and cycle, uniformly on a 0.000001 grid
 * (or exact units for coarser assets) inside [min, max], using the browser's
 * cryptographic random source. The result is shown and saved for review.
 */
export function drawWarmupAmounts(
  min: string,
  max: string,
  decimals: number,
  wallets: number,
  cycles: number,
  random: (bound: bigint) => bigint = cryptoBelow,
) {
  const lo = warmupAtoms(min, decimals),
    hi = warmupAtoms(max, decimals);
  if (hi <= lo) throw new Error('Range maximum must be above the minimum.');
  let step = decimals > 6 ? 10n ** BigInt(decimals - 6) : 1n;
  let first = (lo + step - 1n) / step,
    last = hi / step;
  if (last < first) {
    step = 1n;
    first = lo;
    last = hi;
  }
  return Array.from({ length: wallets }, () =>
    Array.from({ length: cycles }, () =>
      warmupDecimal((first + random(last - first + 1n)) * step, decimals),
    ),
  );
}
function cryptoBelow(bound: bigint) {
  if (bound < 1n || bound > 1n << 64n) throw new Error('Range is too wide.');
  // Rejection sampling over 64-bit words avoids modulo bias.
  const limit = (1n << 64n) - ((1n << 64n) % bound);
  const word = new BigUint64Array(1);
  for (;;) {
    crypto.getRandomValues(word);
    if (word[0] < limit) return word[0] % bound;
  }
}
export type WarmupHistory = {
  address: string;
  chain: string;
  observedAt: string;
  source: string;
  nativeBalance: string;
  currency: string;
  block: string;
  blockHash?: string;
  outgoingTransactions: string | null;
  sampleCount: number | null;
  successfulSampleCount: number | null;
  oldestObservedAt: string | null;
  latestObservedAt: string | null;
  coverage: string;
};
