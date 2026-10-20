// Proxima-style Auto Sell (Counter Trading, DCA, Limit Orders) rules and pure
// evaluation.
// Everything here is deterministic apart from the injected random draw, so
// the browser runner and its tests share the same arithmetic.
import {
  AUTO_SELL_SOL_QUOTE,
  autoSellQuoteAtLeast,
} from './auto-sell-quote-trigger';

export type AutoSellTrigger =
  | { kind: 'rate'; percent: string }
  | { kind: 'min-sol'; amount: string }
  | { kind: 'min-token'; amount: string };

export type AutoSellMode = 'counter' | 'dca' | 'limit';

export type AutoSellLimitOrder = {
  id: string;
  /** Amount to sell in the strategy's amount unit. */
  amount: string;
  /** Market cap in USD at which this row sells once. */
  marketCapUsd: string;
};

export type AutoSellStrategy = {
  id: string;
  name: string;
  mode: AutoSellMode;
  /** Percent of each outside buy (token amount) to sell back. */
  replicationPercent: string;
  trigger: AutoSellTrigger;
  /** Optional: buffer until this % of total supply is owed, then sell. */
  minSupplyPercentPerSell: string;
  /** Market cap range in USD; empty means unbounded. */
  marketCapMinUsd: string;
  marketCapMaxUsd: string;
  /** End conditions; empty means none. */
  endMaxSupplyPercent: string;
  endDurationSeconds: number;
  /** Buyers to ignore (never counter-sold). */
  whitelist: string[];
  /** DCA and Limit Orders amounts: percent of supply or token amount. */
  amountUnit: 'supply' | 'tokens';
  /** DCA: false sells `dcaAmount` each time, true draws in [min, max]. */
  dcaRandomized: boolean;
  dcaAmount: string;
  dcaMinAmount: string;
  dcaMaxAmount: string;
  /** DCA: seconds between sells (10 seconds to 24 hours). */
  dcaIntervalSeconds: number;
  /** Limit Orders: rows with strictly rising market cap targets. */
  limitOrders: AutoSellLimitOrder[];
};

export type AutoSellObservedTrade = {
  id: string;
  sender: string;
  side: 'Buy' | 'Sell';
  /** Decimal token amount as reported by the trade feed. */
  tokenAmount: string;
  /** Decimal quote amount (SOL for SOL pools). */
  quoteAmount: string;
  /** Verified pool quote mint. Missing units cannot authorize a Min. SOL response. */
  quoteMint?: string;
  priceUsd: string;
};

export type AutoSellStrategyState = {
  status: 'running' | 'ended' | 'stopped';
  endedReason: string | null;
  startedAt: number;
  /** Raw token units owed but not yet sold. */
  bufferedRaw: bigint;
  /** Raw token units sold (submitted) so far. */
  soldRaw: bigint;
  /** Raw token units currently being sold, counted against the end cap. */
  inFlightRaw: bigint;
  responses: number;
  skipped: number;
  /** DCA: earliest time of the next sell. */
  nextDcaAt: number;
  /** Limit Orders: rows already queued (each sells once). */
  filledLimitIds: string[];
};

const PERCENT = /^(0|[1-9]\d{0,2})(?:\.\d{1,6})?$/;
const DECIMAL = /^\d{1,30}(?:\.\d{1,30})?$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Percent string to parts-per-100,000,000 (6 decimal places of a percent). */
export function percentUnits(value: string) {
  if (!PERCENT.test(value)) throw new Error('Invalid percentage.');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}
const HUNDRED = 100_000_000n;

/** Decimal string to raw atomic units, truncating extra precision. */
export function decimalToRaw(value: string, decimals: number) {
  if (!DECIMAL.test(value)) throw new Error('Invalid decimal amount.');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole + fraction.slice(0, decimals).padEnd(decimals, '0'));
}

export function rawToDecimal(raw: bigint, decimals: number) {
  if (decimals === 0) return raw.toString();
  const digits = raw.toString().padStart(decimals + 1, '0');
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return `${digits.slice(0, -decimals)}${fraction ? `.${fraction}` : ''}`;
}

export function percentOfRaw(total: bigint, percent: string) {
  return (total * percentUnits(percent)) / HUNDRED;
}

function newId(prefix: string) {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const AUTO_SELL_MODE_NAMES: Record<AutoSellMode, string> = {
  counter: 'Counter',
  dca: 'DCA',
  limit: 'Limit Orders',
};

export function newLimitOrder(): AutoSellLimitOrder {
  return { id: newId('limit'), amount: '', marketCapUsd: '' };
}

/** Switches mode, renaming default-named strategies to match. */
export function withAutoSellMode(
  s: AutoSellStrategy,
  mode: AutoSellMode,
): AutoSellStrategy {
  const match = /^(Counter|DCA|Limit Orders)( \d+)?$/.exec(s.name);
  return {
    ...s,
    mode,
    name: match ? `${AUTO_SELL_MODE_NAMES[mode]}${match[2] ?? ''}` : s.name,
    limitOrders:
      mode === 'limit' && s.limitOrders.length === 0
        ? [newLimitOrder()]
        : s.limitOrders,
  };
}

export function newAutoSellStrategy(index: number): AutoSellStrategy {
  return {
    id: newId('strategy'),
    name: index === 0 ? 'Counter' : `Counter ${index + 1}`,
    mode: 'counter',
    replicationPercent: '',
    trigger: { kind: 'rate', percent: '100' },
    minSupplyPercentPerSell: '',
    marketCapMinUsd: '',
    marketCapMaxUsd: '',
    endMaxSupplyPercent: '',
    endDurationSeconds: 0,
    whitelist: [],
    amountUnit: 'supply',
    dcaRandomized: false,
    dcaAmount: '',
    dcaMinAmount: '',
    dcaMaxAmount: '',
    dcaIntervalSeconds: 0,
    limitOrders: [],
  };
}

const MAX_LIMIT_ORDERS = 10;

function amountError(s: AutoSellStrategy, value: string, label: string) {
  if (!value) return `${label} is required`;
  if (s.amountUnit === 'supply') {
    if (
      !PERCENT.test(value) ||
      percentUnits(value) === 0n ||
      percentUnits(value) > HUNDRED
    )
      return `${label} must be between 0 and 100% supply`;
  } else if (!DECIMAL.test(value) || !/[1-9]/.test(value))
    return `${label} must be a token amount above 0`;
  return null;
}

/** Compares two amounts in the same unit (exact, no float rounding). */
function amountUnits(s: AutoSellStrategy, value: string) {
  return s.amountUnit === 'supply'
    ? percentUnits(value)
    : decimalToRaw(value, 30);
}

/** Converts a strategy amount to raw token units. */
export function amountToRaw(
  s: AutoSellStrategy,
  value: string,
  totalSupplyRaw: bigint,
  decimals: number,
) {
  return s.amountUnit === 'supply'
    ? percentOfRaw(totalSupplyRaw, value)
    : decimalToRaw(value, decimals);
}

function modeError(s: AutoSellStrategy): string | null {
  if (s.mode === 'dca') {
    if (s.dcaRandomized) {
      const min = amountError(s, s.dcaMinAmount, 'Min Amount');
      if (min) return min;
      const max = amountError(s, s.dcaMaxAmount, 'Max Amount');
      if (max) return max;
      if (amountUnits(s, s.dcaMinAmount) >= amountUnits(s, s.dcaMaxAmount))
        return 'Min Amount must be below Max Amount';
    } else {
      const amount = amountError(s, s.dcaAmount, 'Amount');
      if (amount) return amount;
    }
    if (
      !Number.isSafeInteger(s.dcaIntervalSeconds) ||
      s.dcaIntervalSeconds < 10 ||
      s.dcaIntervalSeconds > 86400
    )
      return 'Interval must be between 10 seconds and 24 hours';
    return null;
  }
  if (s.mode === 'limit') {
    if (!s.limitOrders.length) return 'Add at least one limit order';
    if (s.limitOrders.length > MAX_LIMIT_ORDERS)
      return `At most ${MAX_LIMIT_ORDERS} limit orders`;
    let previous = 0;
    for (const [i, row] of s.limitOrders.entries()) {
      const amount = amountError(s, row.amount, `Order ${i + 1} amount`);
      if (amount) return amount;
      if (!DECIMAL.test(row.marketCapUsd) || Number(row.marketCapUsd) <= 0)
        return `Order ${i + 1} needs a market cap above 0`;
      if (Number(row.marketCapUsd) <= previous)
        return `Order ${i + 1} market cap must be higher than the order above`;
      previous = Number(row.marketCapUsd);
    }
    return null;
  }
  if (!s.replicationPercent.trim()) return 'Replication factor is required';
  if (
    !PERCENT.test(s.replicationPercent) ||
    percentUnits(s.replicationPercent) === 0n ||
    percentUnits(s.replicationPercent) > 10n * HUNDRED
  )
    return 'Replication factor must be between 0 and 1000%';
  const t = s.trigger;
  if (t.kind === 'rate') {
    if (
      !PERCENT.test(t.percent) ||
      percentUnits(t.percent) === 0n ||
      percentUnits(t.percent) > HUNDRED
    )
      return 'Trigger rate must be between 0 and 100%';
  } else if (!DECIMAL.test(t.amount)) return 'Trigger amount is required';
  if (
    s.minSupplyPercentPerSell &&
    (!PERCENT.test(s.minSupplyPercentPerSell) ||
      percentUnits(s.minSupplyPercentPerSell) > HUNDRED)
  )
    return 'Min. % supply per sell must be between 0 and 100';
  if (s.whitelist.some((w) => !BASE58.test(w)))
    return 'Whitelist has an invalid address';
  return null;
}

/** Returns the first problem with a strategy, or null when it can run. */
export function autoSellStrategyError(s: AutoSellStrategy): string | null {
  const mode = modeError(s);
  if (mode) return mode;
  for (const v of [s.marketCapMinUsd, s.marketCapMaxUsd])
    if (v && !DECIMAL.test(v)) return 'Market cap must be a plain number';
  if (
    s.marketCapMinUsd &&
    s.marketCapMaxUsd &&
    Number(s.marketCapMinUsd) >= Number(s.marketCapMaxUsd)
  )
    return 'Market cap start must be below the end';
  if (
    s.endMaxSupplyPercent &&
    (!PERCENT.test(s.endMaxSupplyPercent) ||
      percentUnits(s.endMaxSupplyPercent) === 0n ||
      percentUnits(s.endMaxSupplyPercent) > HUNDRED)
  )
    return 'Max amount must be between 0 and 100% supply';
  if (
    !Number.isSafeInteger(s.endDurationSeconds) ||
    s.endDurationSeconds < 0 ||
    s.endDurationSeconds > 30 * 86400
  )
    return 'Duration must be under 30 days';
  return null;
}

export function marketCapLabel(s: AutoSellStrategy) {
  const fmt = (v: string) => {
    const n = Number(v);
    if (n >= 1e9) return `$${+(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `$${+(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `$${+(n / 1e3).toFixed(2)}K`;
    return `$${+n.toFixed(2)}`;
  };
  return `${s.marketCapMinUsd ? fmt(s.marketCapMinUsd) : '$0'} → ${s.marketCapMaxUsd ? fmt(s.marketCapMaxUsd) : '∞'}`;
}

/** Inclusive range check; null market cap is treated as unknown (out). */
export function marketCapInRange(
  s: AutoSellStrategy,
  marketCapUsd: number | null,
) {
  if (!s.marketCapMinUsd && !s.marketCapMaxUsd) return true;
  if (marketCapUsd === null || !Number.isFinite(marketCapUsd)) return false;
  if (s.marketCapMinUsd && marketCapUsd < Number(s.marketCapMinUsd))
    return false;
  if (s.marketCapMaxUsd && marketCapUsd > Number(s.marketCapMaxUsd))
    return false;
  return true;
}

export function marketCapFromPrice(
  priceUsd: string,
  totalSupplyRaw: string,
  decimals: number,
) {
  const price = Number(priceUsd);
  const supply = Number(totalSupplyRaw) / 10 ** decimals;
  const cap = price * supply;
  return Number.isFinite(cap) && cap >= 0 ? cap : null;
}

export function initialAutoSellState(now: number): AutoSellStrategyState {
  return {
    status: 'running',
    endedReason: null,
    startedAt: now,
    bufferedRaw: 0n,
    soldRaw: 0n,
    inFlightRaw: 0n,
    responses: 0,
    skipped: 0,
    nextDcaAt: now,
    filledLimitIds: [],
  };
}

/** Raw cap from the Max Amount end condition, or null when none. */
export function endCapRaw(s: AutoSellStrategy, totalSupplyRaw: bigint) {
  return s.endMaxSupplyPercent
    ? percentOfRaw(totalSupplyRaw, s.endMaxSupplyPercent)
    : null;
}

/**
 * Checks this strategy's own end conditions. Only this strategy ends; the
 * caller keeps the others running.
 */
export function checkAutoSellEnd(
  s: AutoSellStrategy,
  state: AutoSellStrategyState,
  now: number,
  totalSupplyRaw: bigint,
): AutoSellStrategyState {
  if (state.status !== 'running') return state;
  if (
    s.endDurationSeconds > 0 &&
    now - state.startedAt >= s.endDurationSeconds * 1000
  )
    return {
      ...state,
      status: 'ended',
      endedReason: 'Duration reached',
      bufferedRaw: 0n,
    };
  const cap = endCapRaw(s, totalSupplyRaw);
  if (cap !== null && state.soldRaw >= cap)
    return {
      ...state,
      status: 'ended',
      endedReason: 'Max amount sold',
      bufferedRaw: 0n,
    };
  if (
    s.mode === 'limit' &&
    s.limitOrders.every((row) => state.filledLimitIds.includes(row.id)) &&
    state.bufferedRaw === 0n &&
    state.inFlightRaw === 0n
  )
    return {
      ...state,
      status: 'ended',
      endedReason: 'All limit orders filled',
    };
  return state;
}

export type AutoSellContext = {
  decimals: number;
  totalSupplyRaw: bigint;
  /** Own wallets (every Solana workspace wallet) never trigger a response. */
  ownWallets: ReadonlySet<string>;
  marketCapUsd: number | null;
  /** Uniform draw in [0, 1). */
  random: () => number;
};

export type AutoSellOutcome =
  | 'not-running'
  | 'not-a-buy'
  | 'own-wallet'
  | 'whitelisted'
  | 'out-of-range'
  | 'below-trigger'
  | 'quote-unit-mismatch'
  | 'rate-skipped'
  | 'not-counter'
  | 'buffered';

/** Applies one observed trade to a strategy. Pure apart from `random`. */
export function applyAutoSellTrade(
  s: AutoSellStrategy,
  state: AutoSellStrategyState,
  trade: AutoSellObservedTrade,
  ctx: AutoSellContext,
): {
  state: AutoSellStrategyState;
  outcome: AutoSellOutcome;
  addedRaw: bigint;
} {
  const none = (outcome: AutoSellOutcome, skip = true) => ({
    state: skip ? { ...state, skipped: state.skipped + 1 } : state,
    outcome,
    addedRaw: 0n,
  });
  if (state.status !== 'running') return none('not-running', false);
  if (s.mode !== 'counter') return none('not-counter', false);
  if (trade.side !== 'Buy') return none('not-a-buy', false);
  if (ctx.ownWallets.has(trade.sender)) return none('own-wallet');
  if (s.whitelist.includes(trade.sender)) return none('whitelisted');
  if (!marketCapInRange(s, ctx.marketCapUsd)) return none('out-of-range');
  let tokenRaw: bigint;
  try {
    tokenRaw = decimalToRaw(trade.tokenAmount, ctx.decimals);
  } catch {
    return none('below-trigger');
  }
  const t = s.trigger;
  if (t.kind === 'min-sol') {
    if (trade.quoteMint !== AUTO_SELL_SOL_QUOTE)
      return none('quote-unit-mismatch');
    if (!autoSellQuoteAtLeast(trade.quoteAmount, t.amount))
      return none('below-trigger');
  }
  if (t.kind === 'min-token' && tokenRaw < decimalToRaw(t.amount, ctx.decimals))
    return none('below-trigger');
  if (t.kind === 'rate') {
    const threshold = Number(percentUnits(t.percent)) / Number(HUNDRED);
    if (threshold < 1 && ctx.random() >= threshold) return none('rate-skipped');
  }
  const added = clampToEndCap(
    s,
    state,
    percentOfRaw(tokenRaw, s.replicationPercent),
    ctx.totalSupplyRaw,
  );
  return {
    state: {
      ...state,
      bufferedRaw: state.bufferedRaw + added,
      responses: state.responses + 1,
    },
    outcome: 'buffered',
    addedRaw: added,
  };
}

/** Limits a new amount to what the Max Amount end condition still allows. */
function clampToEndCap(
  s: AutoSellStrategy,
  state: AutoSellStrategyState,
  amount: bigint,
  totalSupplyRaw: bigint,
) {
  const cap = endCapRaw(s, totalSupplyRaw);
  if (cap === null) return amount;
  const room = cap - state.soldRaw - state.inFlightRaw - state.bufferedRaw;
  return amount < room ? amount : room > 0n ? room : 0n;
}

/** Draws a DCA amount in raw units; randomized draws are uniform in [min, max]. */
export function dcaAmountRaw(
  s: AutoSellStrategy,
  totalSupplyRaw: bigint,
  decimals: number,
  random: () => number,
) {
  if (!s.dcaRandomized)
    return amountToRaw(s, s.dcaAmount, totalSupplyRaw, decimals);
  const min = amountToRaw(s, s.dcaMinAmount, totalSupplyRaw, decimals);
  const max = amountToRaw(s, s.dcaMaxAmount, totalSupplyRaw, decimals);
  if (max <= min) return min;
  const steps = 1_000_000n;
  const draw = BigInt(Math.min(999_999, Math.floor(random() * 1_000_000)));
  return min + ((max - min) * draw) / (steps - 1n);
}

export type AutoSellScheduleContext = {
  now: number;
  decimals: number;
  totalSupplyRaw: bigint;
  marketCapUsd: number | null;
  random: () => number;
};

/**
 * DCA and Limit Orders: queues whatever is due now. DCA queues one sell per
 * interval and never catches up on missed intervals; it waits (without
 * stacking) while out of range or while its previous sell is still queued.
 * Limit Orders queue each row once when the market cap reaches its target.
 */
export function scheduleAutoSell(
  s: AutoSellStrategy,
  state: AutoSellStrategyState,
  ctx: AutoSellScheduleContext,
): { state: AutoSellStrategyState; addedRaw: bigint; filled: string[] } {
  const none = { state, addedRaw: 0n, filled: [] as string[] };
  if (state.status !== 'running' || s.mode === 'counter') return none;
  if (!marketCapInRange(s, ctx.marketCapUsd)) return none;
  if (s.mode === 'dca') {
    if (
      ctx.now < state.nextDcaAt ||
      state.bufferedRaw > 0n ||
      state.inFlightRaw > 0n
    )
      return none;
    const added = clampToEndCap(
      s,
      state,
      dcaAmountRaw(s, ctx.totalSupplyRaw, ctx.decimals, ctx.random),
      ctx.totalSupplyRaw,
    );
    return {
      state: {
        ...state,
        bufferedRaw: state.bufferedRaw + added,
        responses: state.responses + 1,
        nextDcaAt: ctx.now + s.dcaIntervalSeconds * 1000,
      },
      addedRaw: added,
      filled: [],
    };
  }
  if (ctx.marketCapUsd === null || !Number.isFinite(ctx.marketCapUsd))
    return none;
  let next = state;
  let addedRaw = 0n;
  const filled: string[] = [];
  for (const row of s.limitOrders) {
    if (next.filledLimitIds.includes(row.id)) continue;
    if (ctx.marketCapUsd < Number(row.marketCapUsd)) break;
    const added = clampToEndCap(
      s,
      next,
      amountToRaw(s, row.amount, ctx.totalSupplyRaw, ctx.decimals),
      ctx.totalSupplyRaw,
    );
    next = {
      ...next,
      bufferedRaw: next.bufferedRaw + added,
      responses: next.responses + 1,
      filledLimitIds: [...next.filledLimitIds, row.id],
    };
    addedRaw += added;
    filled.push(row.id);
  }
  return filled.length ? { state: next, addedRaw, filled } : none;
}

/** How much of the buffer is ready to sell now (0 while below the minimum). */
export function readyToSellRaw(
  s: AutoSellStrategy,
  state: AutoSellStrategyState,
  totalSupplyRaw: bigint,
) {
  if (state.status !== 'running' || state.bufferedRaw <= 0n) return 0n;
  const minimum =
    s.mode === 'counter' && s.minSupplyPercentPerSell
      ? percentOfRaw(totalSupplyRaw, s.minSupplyPercentPerSell)
      : 0n;
  return state.bufferedRaw >= minimum ? state.bufferedRaw : 0n;
}

/** HH:MM:SS parts to seconds; blanks count as zero. */
export function durationSeconds(
  hours: string,
  minutes: string,
  seconds: string,
) {
  const n = (v: string) =>
    v.trim() === '' ? 0 : /^\d{1,4}$/.test(v.trim()) ? Number(v) : NaN;
  const total = n(hours) * 3600 + n(minutes) * 60 + n(seconds);
  return Number.isFinite(total) ? total : -1;
}

export function formatDuration(total: number) {
  if (!total) return '—';
  const h = Math.floor(total / 3600),
    m = Math.floor((total % 3600) / 60),
    s = total % 60;
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}
