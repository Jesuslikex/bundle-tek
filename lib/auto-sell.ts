// Proxima-style Auto Sell (Counter Trading) rules and pure evaluation.
// Everything here is deterministic apart from the injected random draw, so
// the browser runner and its tests share the same arithmetic.

export type AutoSellTrigger =
  | { kind: 'rate'; percent: string }
  | { kind: 'min-sol'; amount: string }
  | { kind: 'min-token'; amount: string };

export type AutoSellStrategy = {
  id: string;
  name: string;
  mode: 'counter';
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
};

export type AutoSellObservedTrade = {
  id: string;
  sender: string;
  side: 'Buy' | 'Sell';
  /** Decimal token amount as reported by the trade feed. */
  tokenAmount: string;
  /** Decimal quote amount (SOL for SOL pools). */
  quoteAmount: string;
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

export function newAutoSellStrategy(index: number): AutoSellStrategy {
  return {
    id:
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `strategy-${Date.now()}-${index}`,
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
  };
}

/** Returns the first problem with a strategy, or null when it can run. */
export function autoSellStrategyError(s: AutoSellStrategy): string | null {
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
  if (s.whitelist.some((w) => !BASE58.test(w)))
    return 'Whitelist has an invalid address';
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
  | 'rate-skipped'
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
  if (t.kind === 'min-sol' && Number(trade.quoteAmount) < Number(t.amount))
    return none('below-trigger');
  if (t.kind === 'min-token' && tokenRaw < decimalToRaw(t.amount, ctx.decimals))
    return none('below-trigger');
  if (t.kind === 'rate') {
    const threshold = Number(percentUnits(t.percent)) / Number(HUNDRED);
    if (threshold < 1 && ctx.random() >= threshold) return none('rate-skipped');
  }
  let added = percentOfRaw(tokenRaw, s.replicationPercent);
  const cap = endCapRaw(s, ctx.totalSupplyRaw);
  if (cap !== null) {
    const room = cap - state.soldRaw - state.inFlightRaw - state.bufferedRaw;
    added = added < room ? added : room > 0n ? room : 0n;
  }
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

/** How much of the buffer is ready to sell now (0 while below the minimum). */
export function readyToSellRaw(
  s: AutoSellStrategy,
  state: AutoSellStrategyState,
  totalSupplyRaw: bigint,
) {
  if (state.status !== 'running' || state.bufferedRaw <= 0n) return 0n;
  const minimum = s.minSupplyPercentPerSell
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
