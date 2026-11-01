import { autoSellMarketObservation } from './auto-sell-market-observation';
import type { AutoSellObservedTrade } from './auto-sell';
import { warmupAtoms } from './wallet-warmup';

// Browser-side Auto Buy run (Proxima "AutoBuy"). julian approved opt-in
// auto-signing on 1 Nov 2026 under the same model as Auto Sell: the user
// starts a run with a hard SOL budget, it signs buys from the unlocked vault
// only while this tab is open, and Stop ends it at once. Every SOL amount here
// is lamports. A signed buy whose landing is unknown is charged to the budget.

export const AUTO_BUY_DCA_MAX_INTERVAL_S = 86400;
export type AutoBuyCounter = {
  id: string;
  kind: 'Counter';
  /** Response probability, 0..100 (Proxima "Rate"). */
  ratePercent: number;
  /** Smallest observed outside sell that triggers, in lamports of SOL. */
  minSolLamports: bigint;
  /** Smallest observed outside sell that triggers, in decimal tokens. */
  minTokens: number;
  /** Your buy as a percent of the observed sell's SOL value. */
  replicationPercent: number;
  /** Accumulate until at least this much before buying (optional). */
  minPerTradeLamports: bigint;
};
export type AutoBuyDca = {
  id: string;
  kind: 'DCA';
  intervalSeconds: number;
  minLamports: bigint;
  /** Equal to min for a fixed amount. */
  maxLamports: bigint;
};
export type AutoBuyLimit = {
  id: string;
  kind: 'Limit';
  /** Each target lower than the previous one. */
  rows: { marketCapUsd: number; lamports: bigint }[];
};
export type AutoBuyStrategy = (AutoBuyCounter | AutoBuyDca | AutoBuyLimit) & {
  marketCapMinUsd?: number;
  marketCapMaxUsd?: number;
  endLamports?: bigint;
  endSeconds?: number;
};
export type AutoBuyRules = {
  /** Required hard cap for the whole run. */
  budgetLamports: bigint;
  endSeconds?: number;
  startDelaySeconds?: number;
  whitelist: string[];
};
export type AutoBuyStrategyState = {
  status: 'running' | 'ended';
  endedReason: string | null;
  spentLamports: bigint;
  bufferedLamports: bigint;
  nextDcaAt: number | null;
  limitDone: boolean[];
};
export type AutoBuyLogEntry = {
  at: number;
  strategyId: string | null;
  kind: 'info' | 'buy' | 'error';
  text: string;
  signature?: string;
};
export type AutoBuySnapshot = {
  running: boolean;
  paused: boolean;
  buying: boolean;
  spentLamports: bigint;
  marketCapUsd: number | null;
  startsAt: number;
  states: Record<string, AutoBuyStrategyState>;
  log: AutoBuyLogEntry[];
  endedReason: string | null;
};
export type AutoBuyRunnerDeps = {
  strategies: AutoBuyStrategy[];
  rules: AutoBuyRules;
  decimals: number;
  totalSupplyRaw: bigint;
  ownWallets: ReadonlySet<string>;
  readTrades: (signal: AbortSignal) => Promise<AutoSellObservedTrade[]>;
  buy: (
    lamports: bigint,
    signal: AbortSignal,
  ) => Promise<{ signature: string; wallet: string }>;
  isUncertain: (error: unknown) => boolean;
  onUpdate: (s: AutoBuySnapshot) => void;
  now?: () => number;
  random?: () => number;
  pollMs?: number;
  maxConsecutiveFailures?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
};

/** Validates strategies; throws a user-facing message on the first problem. */
export function validateAutoBuy(
  strategies: AutoBuyStrategy[],
  rules: AutoBuyRules,
) {
  if (rules.budgetLamports <= 0n)
    throw new Error('Set a total SOL budget for the run.');
  if (!strategies.length) throw new Error('Add at least one strategy.');
  if (strategies.length > 8) throw new Error('Use at most 8 strategies.');
  for (const s of strategies) {
    if (
      s.marketCapMinUsd !== undefined &&
      s.marketCapMaxUsd !== undefined &&
      s.marketCapMinUsd > s.marketCapMaxUsd
    )
      throw new Error('Market cap minimum is above the maximum.');
    if (s.kind === 'Counter') {
      if (!(s.ratePercent > 0 && s.ratePercent <= 100))
        throw new Error('Counter rate must be above 0 and at most 100%.');
      if (!(s.replicationPercent > 0 && s.replicationPercent <= 1000))
        throw new Error(
          'Replication factor must be above 0 and at most 1000%.',
        );
    } else if (s.kind === 'DCA') {
      if (
        !Number.isInteger(s.intervalSeconds) ||
        s.intervalSeconds < 1 ||
        s.intervalSeconds > AUTO_BUY_DCA_MAX_INTERVAL_S
      )
        throw new Error('DCA interval must be 1 second to 24 hours.');
      if (s.minLamports <= 0n || s.maxLamports < s.minLamports)
        throw new Error('DCA amounts must be positive with max ≥ min.');
    } else {
      if (!s.rows.length) throw new Error('Add at least one limit order row.');
      for (let i = 0; i < s.rows.length; i++) {
        const r = s.rows[i];
        if (!(r.marketCapUsd > 0) || r.lamports <= 0n)
          throw new Error('Each limit row needs a market cap and amount.');
        if (i > 0 && !(r.marketCapUsd < s.rows[i - 1].marketCapUsd))
          throw new Error(
            'Each Auto Buy limit target must be lower than the previous one.',
          );
      }
    }
  }
}

/** Parses a SOL decimal string to lamports (9 decimals). */
export const solToLamports = (sol: string) => warmupAtoms(sol, 9);

export class AutoBuyRunner {
  private d: Required<
    Pick<
      AutoBuyRunnerDeps,
      | 'now'
      | 'random'
      | 'pollMs'
      | 'maxConsecutiveFailures'
      | 'setTimer'
      | 'clearTimer'
    >
  > &
    AutoBuyRunnerDeps;
  private states = new Map<string, AutoBuyStrategyState>();
  private seen = new Set<string>();
  private primed = false;
  private timer: unknown = null;
  private controller = new AbortController();
  private running = false;
  private paused = false;
  private buying = false;
  private spent = 0n;
  private failures = 0;
  private marketCapUsd: number | null = null;
  private marketCapAt = 0;
  private startedAt = 0;
  private startsAt = 0;
  private endedReason: string | null = null;
  private log: AutoBuyLogEntry[] = [];

  constructor(deps: AutoBuyRunnerDeps) {
    validateAutoBuy(deps.strategies, deps.rules);
    this.d = {
      now: Date.now,
      random: Math.random,
      pollMs: 4000,
      maxConsecutiveFailures: 5,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      ...deps,
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.startedAt = this.d.now();
    this.startsAt =
      this.startedAt + (this.d.rules.startDelaySeconds ?? 0) * 1000;
    for (const s of this.d.strategies)
      this.states.set(s.id, {
        status: 'running',
        endedReason: null,
        spentLamports: 0n,
        bufferedLamports: 0n,
        nextDcaAt: s.kind === 'DCA' ? this.startsAt : null,
        limitDone: s.kind === 'Limit' ? s.rows.map(() => false) : [],
      });
    this.note(null, 'info', 'Auto Buy started.');
    this.schedule(0);
  }
  pause() {
    this.paused = true;
    this.emit();
  }
  resume() {
    this.paused = false;
    this.emit();
  }
  /** Stops at once: no new buy starts; an in-flight send settles on its own. */
  stop(reason = 'Stopped by you.') {
    if (!this.running) return;
    this.running = false;
    this.endedReason = reason;
    this.controller.abort();
    if (this.timer !== null) this.d.clearTimer(this.timer);
    this.timer = null;
    this.note(null, 'info', reason);
  }
  snapshot(): AutoBuySnapshot {
    return {
      running: this.running,
      paused: this.paused,
      buying: this.buying,
      spentLamports: this.spent,
      marketCapUsd: this.marketCapUsd,
      startsAt: this.startsAt,
      states: Object.fromEntries(
        [...this.states].map(([k, v]) => [
          k,
          { ...v, limitDone: [...v.limitDone] },
        ]),
      ),
      log: [...this.log],
      endedReason: this.endedReason,
    };
  }

  private emit() {
    this.d.onUpdate(this.snapshot());
  }
  private note(
    strategyId: string | null,
    kind: AutoBuyLogEntry['kind'],
    text: string,
    signature?: string,
  ) {
    this.log = [
      { at: this.d.now(), strategyId, kind, text, signature },
      ...this.log,
    ].slice(0, 100);
    this.emit();
  }
  private schedule(ms: number) {
    if (!this.running) return;
    this.timer = this.d.setTimer(() => {
      this.timer = null;
      void this.tick();
    }, ms);
  }
  private remaining() {
    return this.d.rules.budgetLamports - this.spent;
  }
  private endStrategy(id: string, reason: string) {
    const st = this.states.get(id);
    if (!st || st.status !== 'running') return;
    st.status = 'ended';
    st.endedReason = reason;
    st.bufferedLamports = 0n;
    this.note(id, 'info', reason);
  }
  private inRange(s: AutoBuyStrategy) {
    if (s.marketCapMinUsd === undefined && s.marketCapMaxUsd === undefined)
      return true;
    if (this.marketCapUsd === null) return false;
    return (
      (s.marketCapMinUsd === undefined ||
        this.marketCapUsd >= s.marketCapMinUsd) &&
      (s.marketCapMaxUsd === undefined ||
        this.marketCapUsd <= s.marketCapMaxUsd)
    );
  }

  /** One loop step. Public for tests. */
  async tick() {
    if (!this.running) return;
    const now = this.d.now();
    const rules = this.d.rules;
    if (
      rules.endSeconds !== undefined &&
      now - this.startedAt >= rules.endSeconds * 1000
    )
      return this.stop('Run duration reached.');
    if (this.remaining() <= 0n) return this.stop('SOL budget used.');
    for (const s of this.d.strategies) {
      const st = this.states.get(s.id)!;
      if (st.status !== 'running') continue;
      if (
        s.endSeconds !== undefined &&
        now - this.startsAt >= s.endSeconds * 1000
      )
        this.endStrategy(s.id, 'Strategy duration reached.');
      else if (s.endLamports !== undefined && st.spentLamports >= s.endLamports)
        this.endStrategy(s.id, 'Strategy amount reached.');
    }
    if (![...this.states.values()].some((st) => st.status === 'running'))
      return this.stop('All strategies ended.');

    let trades: AutoSellObservedTrade[] = [];
    try {
      trades = await this.d.readTrades(this.controller.signal);
    } catch (e) {
      if (!this.running) return;
      this.note(
        null,
        'error',
        `Trade feed unavailable: ${e instanceof Error ? e.message : 'error'}`,
      );
    }
    if (!this.running) return;
    const obs = autoSellMarketObservation(trades, now);
    if (obs && obs.at >= this.marketCapAt) {
      const cap =
        Number(obs.priceUsd) *
        (Number(this.d.totalSupplyRaw) / 10 ** this.d.decimals);
      this.marketCapUsd = Number.isFinite(cap) ? cap : null;
      this.marketCapAt = obs.at;
    } else if (this.marketCapAt && now - this.marketCapAt > 60000)
      this.marketCapUsd = null;

    const fresh = trades.filter((t) => !this.seen.has(t.id)).reverse();
    for (const t of trades) this.seen.add(t.id);
    const live = this.primed && now >= this.startsAt && !this.paused;
    this.primed = true;
    if (live) this.accumulate(fresh);
    if (live && !this.buying) {
      const due = this.nextDue(now);
      if (due) await this.buy(due.id, due.lamports, due.after);
    }
    this.emit();
    this.schedule(this.d.pollMs);
  }

  private accumulate(fresh: AutoSellObservedTrade[]) {
    const ignore = new Set([...this.d.ownWallets, ...this.d.rules.whitelist]);
    for (const t of fresh) {
      if (t.side !== 'Sell' || ignore.has(t.sender)) continue;
      // Min. SOL only means SOL when the pool quote is wrapped SOL.
      if (t.quoteMint !== 'So11111111111111111111111111111111111111112')
        continue;
      const solLamports = decimalToLamports(t.quoteAmount);
      if (solLamports === null) continue;
      const tokens = Number(t.tokenAmount);
      for (const s of this.d.strategies) {
        const st = this.states.get(s.id)!;
        if (s.kind !== 'Counter' || st.status !== 'running' || !this.inRange(s))
          continue;
        if (solLamports < s.minSolLamports || !(tokens >= s.minTokens))
          continue;
        if (this.d.random() * 100 >= s.ratePercent) continue;
        const add =
          (solLamports * BigInt(Math.round(s.replicationPercent * 100))) /
          10000n;
        if (add > 0n) st.bufferedLamports += add;
      }
    }
  }

  private nextDue(
    now: number,
  ): { id: string; lamports: bigint; after: () => void } | null {
    for (const s of this.d.strategies) {
      const st = this.states.get(s.id)!;
      if (st.status !== 'running' || !this.inRange(s)) continue;
      if (s.kind === 'Counter') {
        const floor = s.minPerTradeLamports > 0n ? s.minPerTradeLamports : 1n;
        if (st.bufferedLamports >= floor) {
          const amount = st.bufferedLamports;
          return {
            id: s.id,
            lamports: amount,
            after: () => (st.bufferedLamports = 0n),
          };
        }
      } else if (s.kind === 'DCA') {
        if (st.nextDcaAt !== null && now >= st.nextDcaAt) {
          const span = s.maxLamports - s.minLamports;
          const pick =
            span > 0n
              ? s.minLamports +
                BigInt(Math.floor(this.d.random() * Number(span + 1n)))
              : s.minLamports;
          return {
            id: s.id,
            lamports: pick > s.maxLamports ? s.maxLamports : pick,
            after: () => (st.nextDcaAt = now + s.intervalSeconds * 1000),
          };
        }
      } else if (this.marketCapUsd !== null) {
        const i = s.rows.findIndex(
          (r, idx) =>
            !st.limitDone[idx] && this.marketCapUsd! <= r.marketCapUsd,
        );
        if (i >= 0)
          return {
            id: s.id,
            lamports: s.rows[i].lamports,
            after: () => (st.limitDone[i] = true),
          };
        if (st.limitDone.every(Boolean))
          this.endStrategy(s.id, 'All limit orders filled.');
      }
    }
    return null;
  }

  private async buy(id: string, wanted: bigint, after: () => void) {
    const s = this.d.strategies.find((x) => x.id === id)!;
    const st = this.states.get(id)!;
    let lamports = wanted;
    const left = this.remaining();
    if (lamports > left) lamports = left;
    if (
      s.endLamports !== undefined &&
      lamports > s.endLamports - st.spentLamports
    )
      lamports = s.endLamports - st.spentLamports;
    if (lamports <= 0n) return;
    this.buying = true;
    this.emit();
    try {
      const r = await this.d.buy(lamports, this.controller.signal);
      this.charge(st, lamports);
      after();
      this.failures = 0;
      this.note(
        id,
        'buy',
        `Bought with ${fmt(lamports)} SOL from ${r.wallet.slice(0, 4)}…`,
        r.signature,
      );
    } catch (e) {
      if (this.d.isUncertain(e)) {
        // Signed: it may have landed. Charge it and never retry this amount.
        this.charge(st, lamports);
        after();
        this.note(
          id,
          'error',
          e instanceof Error ? e.message : 'Signed buy outcome unknown.',
        );
        this.stop(
          'Stopped after a signed buy with an unknown outcome. Check it before starting again.',
        );
      } else if (this.running) {
        this.failures++;
        this.note(id, 'error', e instanceof Error ? e.message : 'Buy failed.');
        if (this.failures >= this.d.maxConsecutiveFailures)
          this.stop(`Stopped after ${this.failures} failed buys in a row.`);
      }
    } finally {
      this.buying = false;
    }
  }
  private charge(st: AutoBuyStrategyState, lamports: bigint) {
    st.spentLamports += lamports;
    this.spent += lamports;
  }
}

/** Feed decimal (any precision) to lamports, truncating past 9 places. */
export function decimalToLamports(value: string): bigint | null {
  const m = /^(\d{1,12})(?:\.(\d+))?$/.exec(value.trim());
  if (!m) return null;
  return (
    BigInt(m[1]) * 1_000_000_000n +
    BigInt((m[2] ?? '').slice(0, 9).padEnd(9, '0'))
  );
}

export function fmt(lamports: bigint) {
  const s = lamports.toString().padStart(10, '0');
  const frac = s.slice(-9).replace(/0+$/, '');
  return `${s.slice(0, -9)}${frac ? `.${frac}` : ''}`;
}
