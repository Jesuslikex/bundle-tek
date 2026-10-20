import {
  applyAutoSellTrade,
  checkAutoSellEnd,
  initialAutoSellState,
  marketCapInRange,
  readyToSellRaw,
  type AutoSellObservedTrade,
  type AutoSellStrategy,
  type AutoSellStrategyState,
} from './auto-sell';

export type AutoSellLogEntry = {
  at: number;
  strategyId: string | null;
  kind: 'info' | 'sell' | 'error';
  text: string;
  signature?: string;
};

export type AutoSellSnapshot = {
  running: boolean;
  marketCapUsd: number | null;
  states: Record<string, AutoSellStrategyState & { inRange: boolean }>;
  log: AutoSellLogEntry[];
  selling: boolean;
};

export type AutoSellRunnerDeps = {
  strategies: AutoSellStrategy[];
  decimals: number;
  totalSupplyRaw: bigint;
  ownWallets: ReadonlySet<string>;
  /** Latest trades for the token's pool, newest first. */
  readTrades: (signal: AbortSignal) => Promise<AutoSellObservedTrade[]>;
  /** Sells `amountRaw` from the user's wallets; resolves with what sold. */
  sell: (
    amountRaw: bigint,
    signal: AbortSignal,
  ) => Promise<{ soldRaw: bigint; signature: string; wallet: string }>;
  onUpdate: (snapshot: AutoSellSnapshot) => void;
  now?: () => number;
  random?: () => number;
  pollMs?: number;
  /** Wait after a failed sell before trying again. */
  retryMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export function cryptoRandom() {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0] / 2 ** 32;
}

/**
 * Browser-side Auto Sell loop. It polls the trade feed, applies each new
 * outside buy to every running strategy, and sells buffered amounts one at a
 * time through the injected `sell`. Strategies end independently.
 */
export class AutoSellRunner {
  private readonly deps: Required<
    Pick<
      AutoSellRunnerDeps,
      'now' | 'random' | 'pollMs' | 'retryMs' | 'setTimer' | 'clearTimer'
    >
  > &
    AutoSellRunnerDeps;
  private states = new Map<string, AutoSellStrategyState>();
  private seen = new Set<string>();
  private seeded = false;
  private running = false;
  private selling = false;
  private sellBlockedUntil = 0;
  private marketCapUsd: number | null = null;
  private log: AutoSellLogEntry[] = [];
  private timer: unknown = null;
  private controller = new AbortController();
  private polling = false;

  constructor(deps: AutoSellRunnerDeps) {
    this.deps = {
      now: Date.now,
      random: cryptoRandom,
      pollMs: 4000,
      retryMs: 15000,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      ...deps,
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    const now = this.deps.now();
    for (const s of this.deps.strategies)
      this.states.set(s.id, initialAutoSellState(now));
    this.note(
      null,
      'info',
      `Started ${this.deps.strategies.length} strateg${this.deps.strategies.length === 1 ? 'y' : 'ies'}. Watching for buys.`,
    );
    void this.tick();
  }

  stop(reason = 'Stopped') {
    if (!this.running) return;
    this.running = false;
    this.controller.abort();
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    for (const [id, state] of this.states)
      if (state.status === 'running')
        this.states.set(id, {
          ...state,
          status: 'stopped',
          endedReason: reason,
        });
    this.note(null, 'info', reason);
  }

  isRunning() {
    return this.running;
  }

  snapshot(): AutoSellSnapshot {
    const states: AutoSellSnapshot['states'] = {};
    for (const s of this.deps.strategies) {
      const state = this.states.get(s.id);
      if (state)
        states[s.id] = {
          ...state,
          inRange: marketCapInRange(s, this.marketCapUsd),
        };
    }
    return {
      running: this.running,
      marketCapUsd: this.marketCapUsd,
      states,
      log: this.log.slice(-50),
      selling: this.selling,
    };
  }

  private emit() {
    this.deps.onUpdate(this.snapshot());
  }

  private note(
    strategyId: string | null,
    kind: AutoSellLogEntry['kind'],
    text: string,
    signature?: string,
  ) {
    this.log.push({
      at: this.deps.now(),
      strategyId,
      kind,
      text,
      ...(signature ? { signature } : {}),
    });
    if (this.log.length > 200) this.log = this.log.slice(-100);
    this.emit();
  }

  /** One poll: exposed for tests. */
  async tick() {
    if (!this.running || this.polling) return;
    this.polling = true;
    try {
      const trades = await this.deps.readTrades(this.controller.signal);
      if (!this.running) return;
      this.observe(trades);
    } catch (error) {
      if (this.running && !this.controller.signal.aborted)
        this.note(
          null,
          'error',
          `Trade feed: ${error instanceof Error ? error.message : 'unavailable'}`,
        );
    } finally {
      this.polling = false;
    }
    if (!this.running) return;
    this.checkEnds();
    this.maybeSell();
    this.timer = this.deps.setTimer(() => void this.tick(), this.deps.pollMs);
  }

  private observe(trades: AutoSellObservedTrade[]) {
    if (trades[0]) {
      const ctxPrice = trades.find((t) => Number(t.priceUsd) > 0)?.priceUsd;
      if (ctxPrice) {
        const supply =
          Number(this.deps.totalSupplyRaw) / 10 ** this.deps.decimals;
        const cap = Number(ctxPrice) * supply;
        this.marketCapUsd = Number.isFinite(cap) ? cap : null;
      }
    }
    // The first read only marks history; Auto Sell reacts to buys after Run.
    const fresh = trades.filter((t) => !this.seen.has(t.id)).reverse();
    for (const t of trades) this.seen.add(t.id);
    if (this.seen.size > 5000) this.seen = new Set(trades.map((t) => t.id));
    if (!this.seeded) {
      this.seeded = true;
      this.emit();
      return;
    }
    for (const trade of fresh) {
      for (const s of this.deps.strategies) {
        const state = this.states.get(s.id)!;
        const result = applyAutoSellTrade(s, state, trade, {
          decimals: this.deps.decimals,
          totalSupplyRaw: this.deps.totalSupplyRaw,
          ownWallets: this.deps.ownWallets,
          marketCapUsd: this.marketCapUsd,
          random: this.deps.random,
        });
        this.states.set(s.id, result.state);
        if (result.outcome === 'buffered' && result.addedRaw > 0n)
          this.note(
            s.id,
            'info',
            `${s.name}: buy by ${short(trade.sender)} of ${trade.tokenAmount}, queued ${result.addedRaw} raw to sell.`,
          );
        else if (result.outcome === 'out-of-range')
          this.note(
            s.id,
            'info',
            `${s.name}: buy skipped, market cap out of range.`,
          );
      }
    }
    this.emit();
  }

  private checkEnds() {
    const now = this.deps.now();
    for (const s of this.deps.strategies) {
      const before = this.states.get(s.id)!;
      const after = checkAutoSellEnd(s, before, now, this.deps.totalSupplyRaw);
      if (after !== before) {
        this.states.set(s.id, after);
        this.note(
          s.id,
          'info',
          `${s.name} ended: ${after.endedReason}. Other strategies keep running.`,
        );
      }
    }
    if ([...this.states.values()].every((st) => st.status !== 'running')) {
      this.running = false;
      if (this.timer !== null) this.deps.clearTimer(this.timer);
      this.timer = null;
      this.note(null, 'info', 'All strategies ended.');
    }
  }

  private maybeSell() {
    if (
      !this.running ||
      this.selling ||
      this.deps.now() < this.sellBlockedUntil
    )
      return;
    for (const s of this.deps.strategies) {
      const state = this.states.get(s.id)!;
      if (!marketCapInRange(s, this.marketCapUsd)) continue;
      const amount = readyToSellRaw(s, state, this.deps.totalSupplyRaw);
      if (amount <= 0n) continue;
      this.states.set(s.id, {
        ...state,
        bufferedRaw: state.bufferedRaw - amount,
        inFlightRaw: state.inFlightRaw + amount,
      });
      this.selling = true;
      this.emit();
      void this.deps
        .sell(amount, this.controller.signal)
        .then(({ soldRaw, signature, wallet }) => {
          const current = this.states.get(s.id)!;
          const sold = soldRaw < amount ? soldRaw : amount;
          this.states.set(s.id, {
            ...current,
            inFlightRaw: current.inFlightRaw - amount,
            soldRaw: current.soldRaw + sold,
            // Anything the wallets could not cover goes back to the queue.
            bufferedRaw:
              current.status === 'running'
                ? current.bufferedRaw + (amount - sold)
                : current.bufferedRaw,
          });
          this.note(
            s.id,
            'sell',
            `${s.name}: sold ${sold} raw from ${short(wallet)}.`,
            signature,
          );
        })
        .catch((error) => {
          const current = this.states.get(s.id)!;
          if (error && (error as { uncertain?: boolean }).uncertain) {
            // Signed and possibly landed: count it as sold so it is never resold.
            this.states.set(s.id, {
              ...current,
              inFlightRaw: current.inFlightRaw - amount,
              soldRaw: current.soldRaw + amount,
            });
            this.sellBlockedUntil = this.deps.now() + this.deps.retryMs;
            this.note(
              s.id,
              'error',
              `${s.name}: ${error instanceof Error ? error.message : 'submission unknown'}`,
            );
            return;
          }
          this.states.set(s.id, {
            ...current,
            inFlightRaw: current.inFlightRaw - amount,
            bufferedRaw:
              current.status === 'running'
                ? current.bufferedRaw + amount
                : current.bufferedRaw,
          });
          this.sellBlockedUntil = this.deps.now() + this.deps.retryMs;
          if (!this.controller.signal.aborted)
            this.note(
              s.id,
              'error',
              `${s.name}: sell failed, retrying shortly. ${error instanceof Error ? error.message : ''}`.trim(),
            );
        })
        .finally(() => {
          this.selling = false;
          if (this.running) {
            this.checkEnds();
            this.maybeSell();
          }
          this.emit();
        });
      return;
    }
  }
}

function short(address: string) {
  return address.length > 12
    ? `${address.slice(0, 4)}…${address.slice(-4)}`
    : address;
}
