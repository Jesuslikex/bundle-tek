import { walletAddress, walletChain } from './wallet-workspace';
import { EVM_NETWORKS, evmChain } from './evm-network';
import {
  WARMUP_MAX_WALLETS,
  WARMUP_MAX_CYCLES,
} from './warmup-history-capacity';

export type WarmupInput = {
  chain: string;
  addresses: string[];
  tokens: string[];
  amount: string;
  /** Range mode: inclusive upper bound; `amount` is the lower bound. */
  amountMax?: string;
  /** Range mode: reviewed buy amount per wallet (input order) and cycle. */
  amounts?: string[][];
  feeReserve: string;
  cycles: number;
  /** Legacy whole-minute delay (15 to 10,080). */
  intervalMinutes?: number;
  /** Delay between cycles in seconds; takes precedence over intervalMinutes. */
  intervalSeconds?: number;
  startAt: string;
};
export type WarmupPlanField =
  | 'tokens'
  | 'amount'
  | 'amountMax'
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
    input.intervalSeconds! > 604800
  )
    throw new WarmupPlanInputError(
      'intervalSeconds',
      `Choose a delay from ${WARMUP_MIN_DELAY_SECONDS} seconds to 7 days.`,
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
  const interval = intervalSeconds * 1000;
  const actions = addresses
    .flatMap((address, walletIndex) =>
      Array.from({ length: input.cycles }, (_, cycle) => {
        const token = tokens[cycle % tokens.length];
        // Fixed, disclosed staggering keeps review reproducible. No fake organic activity.
        const buyAt =
          start +
          cycle * interval +
          Math.floor((walletIndex * interval) / (addresses.length * 4));
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
            scheduledAt: new Date(buyAt + interval / 2).toISOString(),
          },
        ];
      }).flat(),
    )
    .sort(
      (a, b) =>
        a.scheduledAt.localeCompare(b.scheduledAt) ||
        a.address.localeCompare(b.address),
    );
  const buyTotals = amounts.map((row) => row.reduce((a, b) => a + b, 0n));
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
    buyBudgetPerWallet: warmupDecimal(maxBuys, unit.decimals),
    requiredPerWallet: warmupDecimal(maxBuys + reserve, unit.decimals),
    walletBudgets,
    totalBudget: warmupDecimal(total, unit.decimals),
    actions,
    createdAt: new Date(now).toISOString(),
    limitations:
      'Review plan only. No scheduler, quote, token verification or signing. Sell proceeds are not reused in the budget. Fees and sell output are unknown; the reserve is user-chosen. Activity does not prove wallet creation age or launch eligibility.',
  };
}
export type WarmupPlan = ReturnType<typeof buildWarmupPlan>;
export const WARMUP_MIN_DELAY_SECONDS = 10;
/** Live totals for the form, mirroring buildWarmupPlan's schedule. */
export function estimateWarmupTotals(
  wallets: number,
  cycles: number,
  amount: string,
  reserve: string,
  delaySeconds: number,
  decimals: number,
) {
  try {
    if (!wallets || !Number.isSafeInteger(cycles) || cycles < 1) return null;
    const per = warmupAtoms(amount, decimals),
      fee = warmupAtoms(reserve, decimals);
    const ms = delaySeconds * 1000;
    const window =
      (cycles - 1) * ms +
      Math.floor(((wallets - 1) * ms) / (wallets * 4)) +
      ms / 2;
    return {
      required: warmupDecimal(
        (per * BigInt(cycles) + fee) * BigInt(wallets),
        decimals,
      ),
      seconds: Math.ceil(window / 1000),
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
