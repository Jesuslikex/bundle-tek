import {
  AutoSellReviewRecoveryError,
  type AutoSellReviewReference,
} from './auto-sell-review-recovery';
import {
  applyAutoSellTrade,
  checkAutoSellEnd,
  endCapRaw,
  initialAutoSellState,
  marketCapInRange,
  minimumAutoSellRaw,
  rawToDecimal,
  readyToSellRaw,
  scheduleAutoSell,
  type AutoSellObservedTrade,
  type AutoSellStrategy,
  type AutoSellStrategyState,
} from './auto-sell';
import {
  autoSellSessionCap,
  type AutoSellSessionRules,
} from './auto-sell-session';
import {
  reviewedAutoSellConfiguration,
  type AutoSellConfiguration,
  type AutoSellEditReview,
} from './auto-sell-edit';
import {
  autoSellMarketObservation,
  AUTO_SELL_MARKET_MAX_AGE_MS,
} from './auto-sell-market-observation';
import {
  validatedAutoSellOutcomeReference,
  type AutoSellOutcomeReference,
} from './auto-sell-outcome-reference';

export type AutoSellLogEntry = {
  at: number;
  strategyId: string | null;
  kind: 'info' | 'sell' | 'error';
  text: string;
  signature?: string;
  outcome?: AutoSellOutcomeReference;
};
export const AUTO_SELL_OUTCOME_REMINDER_LIMIT = 100;
export type AutoSellOutcomeReminder = Readonly<{
  at: number;
  kind: 'sell' | 'error';
  outcome: AutoSellOutcomeReference;
}>;

export type AutoSellSnapshot = {
  running: boolean;
  paused: boolean;
  settling: boolean;
  configurationRevision: number;
  accountedRaw: bigint;
  marketCapUsd: number | null;
  states: Record<string, AutoSellStrategyState & { inRange: boolean }>;
  log: AutoSellLogEntry[];
  selling: boolean;
  /** Bounded lookup metadata, independent of the rolling activity log. */
  outcomes?: AutoSellOutcomeReminder[];
  outcomeOverflow?: boolean;
  reviewRecovery?: AutoSellReviewReference | null;
  reviewRecoveryConflict?: boolean;
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
  ) => Promise<{
    soldRaw: bigint;
    signature: string;
    wallet: string;
    outcome?: AutoSellOutcomeReference;
  }>;
  onUpdate: (snapshot: AutoSellSnapshot) => void;
  session?: AutoSellSessionRules;
  now?: () => number;
  random?: () => number;
  pollMs?: number;
  /** Wait after a failed sell before trying again. */
  retryMs?: number;
  /** Failed sells in a row before the whole run stops. */
  maxConsecutiveFailures?: number;
  /** A market cap older than this is unknown, so ranged strategies hold. */
  marketCapMaxAgeMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export function cryptoRandom() {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0] / 2 ** 32;
}

/**
 * Browser-side Auto Sell loop. It polls the trade feed (for outside buys and
 * the market cap), applies each new outside buy to every running Counter
 * strategy, queues due DCA and Limit Order sells, and sells buffered amounts
 * one at a time through the injected `sell`. Strategies end independently.
 */
export class AutoSellRunner {
  private readonly deps: Required<
    Pick<
      AutoSellRunnerDeps,
      | 'now'
      | 'random'
      | 'pollMs'
      | 'retryMs'
      | 'maxConsecutiveFailures'
      | 'marketCapMaxAgeMs'
      | 'setTimer'
      | 'clearTimer'
    >
  > &
    AutoSellRunnerDeps;
  private states = new Map<string, AutoSellStrategyState>();
  private seen = new Set<string>();
  private seeded = false;
  private running = false;
  private paused = false;
  private selling = false;
  private sellBlockedUntil = 0;
  private marketCapUsd: number | null = null;
  private marketCapAt = 0;
  private failures = 0;
  private log: AutoSellLogEntry[] = [];
  private outcomes = new Map<string, AutoSellOutcomeReminder>();
  private outcomeOverflow = false;
  private reviewRecovery: AutoSellReviewReference | null = null;
  private reviewRecoveryConflict = false;
  private timer: unknown = null;
  private controller = new AbortController();
  private polling = false;
  private activeAt = 0;
  private endTimer: unknown = null;
  private sessionCap: bigint | null = null;
  private configurationRevision = 1;
  private retiredAccountedRaw = 0n;
  private retiredIds = new Set<string>();
  private pendingEdit: { review: AutoSellEditReview; evidence: string } | null =
    null;

  constructor(deps: AutoSellRunnerDeps) {
    this.deps = {
      now: Date.now,
      random: cryptoRandom,
      pollMs: 4000,
      retryMs: 15000,
      maxConsecutiveFailures: 5,
      marketCapMaxAgeMs: AUTO_SELL_MARKET_MAX_AGE_MS,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      ...deps,
      strategies: structuredClone(deps.strategies),
      ownWallets: new Set(deps.ownWallets),
      session: deps.session ? { ...deps.session } : undefined,
    };
    if (this.deps.session)
      this.sessionCap = autoSellSessionCap(
        this.deps.session,
        deps.totalSupplyRaw,
        deps.decimals,
      );
    for (const strategy of this.deps.strategies)
      endCapRaw(strategy, deps.totalSupplyRaw, deps.decimals);
  }

  start() {
    if (this.running) return;
    this.running = true;
    const now = this.deps.now();
    this.activeAt = now + (this.deps.session?.startDelaySeconds ?? 0) * 1000;
    for (const s of this.deps.strategies)
      this.states.set(s.id, initialAutoSellState(this.activeAt));
    if (this.deps.session?.endDurationSeconds)
      this.endTimer = this.deps.setTimer(
        () => this.stop('Session duration reached.'),
        this.activeAt - now + this.deps.session.endDurationSeconds * 1000,
      );
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
    this.pendingEdit = null;
    this.paused = false;
    this.controller.abort();
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    if (this.endTimer !== null) this.deps.clearTimer(this.endTimer);
    this.endTimer = null;
    for (const [id, state] of this.states)
      if (state.status === 'running')
        this.states.set(id, {
          ...state,
          status: 'stopped',
          endedReason: reason,
        });
    this.note(null, 'info', reason);
  }

  pause() {
    if (!this.running || this.paused) return false;
    this.paused = true;
    this.controller.abort();
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    this.note(
      null,
      'info',
      'Paused. Existing transaction outcomes are retained; session time limits continue.',
    );
    this.schedulePausedCheck();
    return true;
  }

  resume() {
    if (!this.running || !this.paused || this.polling || this.selling)
      return false;
    this.checkEnds();
    if (!this.running) return false;
    this.pendingEdit = null;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    this.controller = new AbortController();
    this.paused = false;
    this.seeded = false;
    this.seen.clear();
    this.marketCapUsd = null;
    this.marketCapAt = 0;
    const now = this.deps.now();
    for (const strategy of this.deps.strategies) {
      const state = this.states.get(strategy.id)!;
      if (strategy.mode === 'dca' && state.status === 'running')
        this.states.set(strategy.id, {
          ...state,
          nextDcaAt: Math.max(
            state.nextDcaAt,
            now + strategy.dcaIntervalSeconds * 1000,
          ),
        });
    }
    this.note(
      null,
      'info',
      'Resumed. Paused market activity is not replayed; queued amounts and existing limits are retained.',
    );
    void this.tick();
    return true;
  }

  private schedulePausedCheck() {
    if (!this.running || !this.paused) return;
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      if (!this.running || !this.paused) return;
      this.checkEnds();
      this.schedulePausedCheck();
    }, this.deps.pollMs);
  }

  isRunning() {
    return this.running;
  }

  configuration(): AutoSellConfiguration {
    return structuredClone({
      strategies: this.deps.strategies,
      session: this.deps.session ?? {
        startDelaySeconds: 0,
        endDurationSeconds: 0,
        endMaxSupplyPercent: '',
      },
    });
  }

  private projectEdit(configuration: AutoSellConfiguration, now: number) {
    const cap = autoSellSessionCap(
      configuration.session,
      this.deps.totalSupplyRaw,
      this.deps.decimals,
    );
    const remaining = cap === null ? null : cap - this.sessionUsed(false);
    const sessionCapChanged =
      configuration.session.endMaxSupplyPercent !==
        this.configuration().session.endMaxSupplyPercent ||
      configuration.session.endMaxTokenAmount !==
        this.configuration().session.endMaxTokenAmount;
    const states = new Map<string, AutoSellStrategyState>();
    const reactivatedStrategies: string[] = [];
    const endingStrategies: AutoSellEditReview['endingStrategies'] = [];
    for (const strategy of configuration.strategies) {
      const old = this.deps.strategies.find((item) => item.id === strategy.id);
      const existing = this.states.get(strategy.id);
      let state = existing
        ? structuredClone(existing)
        : initialAutoSellState(Math.max(now, this.activeAt));
      if (
        state.status === 'ended' &&
        old &&
        (JSON.stringify(old) !== JSON.stringify(strategy) || sessionCapChanged)
      )
        state = { ...state, status: 'running', endedReason: null };
      state = checkAutoSellEnd(
        strategy,
        state,
        now,
        this.deps.totalSupplyRaw,
        remaining,
        this.deps.decimals,
      );
      if (existing && strategy.mode === 'dca' && state.status === 'running')
        state = {
          ...state,
          nextDcaAt: Math.max(
            state.nextDcaAt,
            now + strategy.dcaIntervalSeconds * 1000,
          ),
        };
      states.set(strategy.id, state);
      if (existing?.status === 'ended' && state.status === 'running')
        reactivatedStrategies.push(strategy.name);
      if (existing?.status !== 'ended' && state.status === 'ended')
        endingStrategies.push({
          id: strategy.id,
          name: strategy.name,
          reason: state.endedReason!,
        });
    }
    return {
      cap,
      states,
      summary: {
        reactivatedStrategies,
        endingStrategies,
        endsSession:
          (cap !== null && this.sessionUsed(false) >= cap) ||
          (configuration.session.endDurationSeconds > 0 &&
            now >=
              this.activeAt +
                configuration.session.endDurationSeconds * 1000) ||
          [...states.values()].every((state) => state.status !== 'running'),
      },
    };
  }

  reviewEdit(configuration: AutoSellConfiguration): AutoSellEditReview {
    this.requireEditable();
    this.pendingEdit = null;
    this.checkEnds();
    this.requireEditable();
    const after = reviewedAutoSellConfiguration(configuration);
    const before = this.configuration();
    if (JSON.stringify(before) === JSON.stringify(after))
      throw new Error('No settings have changed.');
    if (after.session.startDelaySeconds !== before.session.startDelaySeconds)
      throw new Error(
        'The original start delay cannot be restarted by editing.',
      );
    for (const strategy of after.strategies) {
      if (this.retiredIds.has(strategy.id))
        throw new Error(
          'A removed strategy cannot be rearmed. Add a new strategy instead.',
        );
      const old = before.strategies.find((item) => item.id === strategy.id);
      const state = this.states.get(strategy.id);
      if (
        old &&
        state &&
        state.bufferedRaw > 0n &&
        (old.mode !== strategy.mode ||
          (old.mode === 'limit' &&
            JSON.stringify(old.limitOrders) !==
              JSON.stringify(strategy.limitOrders)))
      )
        throw new Error(
          `${old.name} has queued trades. Resume to settle them, or remove the strategy to cancel its unsent queue before changing its mode or limit rows.`,
        );
    }
    const evidence = this.editEvidence();
    const projected = this.projectEdit(after, this.deps.now());
    const review: AutoSellEditReview = {
      revision: this.configurationRevision,
      reviewKey: JSON.stringify([evidence, after]),
      before,
      after,
      accountedRaw: this.sessionUsed(false).toString(),
      queuedRaw: [...this.states.values()]
        .reduce((sum, state) => sum + state.bufferedRaw, 0n)
        .toString(),
      cancelledQueuedRaw: [...this.states]
        .reduce(
          (sum, [id, state]) =>
            sum +
            state.bufferedRaw -
            (projected.states.get(id)?.bufferedRaw ?? 0n),
          0n,
        )
        .toString(),
      ...projected.summary,
    };
    this.pendingEdit = { review: structuredClone(review), evidence };
    return structuredClone(review);
  }

  cancelEdit() {
    this.pendingEdit = null;
  }

  applyEdit(reviewKey: string, approved: boolean) {
    this.requireEditable();
    this.checkEnds();
    this.requireEditable();
    const pending = this.pendingEdit;
    if (
      approved !== true ||
      !pending ||
      reviewKey !== pending.review.reviewKey ||
      pending.evidence !== this.editEvidence()
    )
      throw new Error(
        'The reviewed settings or session state changed. Review and approve the exact changes again.',
      );
    const configuration = structuredClone(pending.review.after);
    const now = this.deps.now();
    const projected = this.projectEdit(configuration, now);
    if (
      JSON.stringify(projected.summary) !==
      JSON.stringify({
        reactivatedStrategies: pending.review.reactivatedStrategies,
        endingStrategies: pending.review.endingStrategies,
        endsSession: pending.review.endsSession,
      })
    )
      throw new Error(
        'Ending conditions changed. Review and approve the exact changes again.',
      );
    const kept = new Set(
      configuration.strategies.map((strategy) => strategy.id),
    );
    for (const [id, state] of this.states) {
      if (!kept.has(id)) {
        this.retiredAccountedRaw += state.soldRaw + state.inFlightRaw;
        this.retiredIds.add(id);
        this.states.delete(id);
      }
    }
    this.states = projected.states;
    this.deps.strategies = configuration.strategies;
    this.deps.session = configuration.session;
    this.sessionCap = projected.cap;
    this.configurationRevision += 1;
    this.pendingEdit = null;
    if (this.endTimer !== null) this.deps.clearTimer(this.endTimer);
    this.endTimer = null;
    this.note(
      null,
      'info',
      'Applied explicitly approved settings. Session progress and original clocks are retained; the session remains paused.',
    );
    this.checkEnds(now);
    if (this.running && configuration.session.endDurationSeconds)
      this.endTimer = this.deps.setTimer(
        () => this.stop('Session duration reached.'),
        Math.max(
          0,
          this.activeAt + configuration.session.endDurationSeconds * 1000 - now,
        ),
      );
  }

  private requireEditable() {
    if (!this.running || !this.paused || this.polling || this.selling)
      throw new Error(
        'Pause and wait for every pending operation to settle before editing this session.',
      );
  }

  private editEvidence() {
    return JSON.stringify(
      [
        this.configurationRevision,
        this.activeAt,
        this.configuration(),
        this.retiredAccountedRaw.toString(),
        [...this.retiredIds],
        [...this.states],
      ],
      (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
    );
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
      paused: this.paused,
      settling: this.polling || this.selling,
      configurationRevision: this.configurationRevision,
      accountedRaw: this.sessionUsed(false),
      marketCapUsd: this.marketCapUsd,
      states,
      log: this.log.slice(-50),
      selling: this.selling,
      outcomes: [...this.outcomes.values()],
      outcomeOverflow: this.outcomeOverflow,
      reviewRecovery: this.reviewRecovery,
      reviewRecoveryConflict: this.reviewRecoveryConflict,
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
    outcome?: AutoSellOutcomeReference,
  ) {
    let retained: AutoSellOutcomeReference | undefined;
    if (outcome) {
      try {
        retained = validatedAutoSellOutcomeReference(outcome);
      } catch {
        /* Invalid lookup coordinates grant no read capability. */
      }
    }
    if (retained && kind !== 'info' && !this.outcomes.has(retained.intentId)) {
      this.outcomes.set(
        retained.intentId,
        Object.freeze({
          at: this.deps.now(),
          kind,
          outcome: retained,
        }),
      );
      if (this.outcomes.size > AUTO_SELL_OUTCOME_REMINDER_LIMIT) {
        this.outcomes.delete(this.outcomes.keys().next().value!);
        this.outcomeOverflow = true;
      }
    }
    this.log.push({
      at: this.deps.now(),
      strategyId,
      kind,
      text,
      ...(signature ? { signature } : {}),
      ...(retained ? { outcome: retained } : {}),
    });
    if (this.log.length > 200) this.log = this.log.slice(-100);
    this.emit();
  }

  /** One poll: exposed for tests. */
  async tick() {
    if (!this.running || this.paused || this.polling) return;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    this.polling = true;
    const controller = this.controller;
    try {
      const trades = await this.deps.readTrades(controller.signal);
      if (!this.running || this.paused || this.controller !== controller)
        return;
      this.observe(trades);
    } catch (error) {
      if (this.running && !controller.signal.aborted)
        this.note(
          null,
          'error',
          `Trade feed: ${error instanceof Error ? error.message : 'unavailable'}`,
        );
    } finally {
      this.polling = false;
      if (this.paused) this.emit();
    }
    if (!this.running || this.paused || this.controller !== controller) return;
    this.expireMarketCap();
    this.checkEnds();
    this.schedule();
    this.maybeSell();
    if (this.running && !this.paused)
      this.timer = this.deps.setTimer(() => void this.tick(), this.deps.pollMs);
  }

  private observe(trades: AutoSellObservedTrade[]) {
    this.expireMarketCap();
    const observation = autoSellMarketObservation(
      trades,
      this.deps.now(),
      this.deps.marketCapMaxAgeMs,
    );
    if (observation && observation.at >= this.marketCapAt) {
      const supply =
        Number(this.deps.totalSupplyRaw) / 10 ** this.deps.decimals;
      const cap = Number(observation.priceUsd) * supply;
      this.marketCapUsd = Number.isFinite(cap) ? cap : null;
      this.marketCapAt = observation.at;
    }
    // The first read only marks history; Auto Sell reacts to buys after Run.
    const fresh = trades.filter((t) => !this.seen.has(t.id)).reverse();
    for (const t of trades) this.seen.add(t.id);
    if (this.deps.now() < this.activeAt) {
      // Do not accumulate pre-start buys for a later counter sell.
      this.seen.clear();
      this.seeded = false;
      this.emit();
      return;
    }
    if (this.seen.size > 5000) this.seen = new Set(trades.map((t) => t.id));
    if (!this.seeded) {
      this.seeded = true;
      this.emit();
      return;
    }
    for (const trade of fresh) {
      for (const s of this.deps.strategies) {
        if (!this.running || this.paused) return;
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
        else if (result.outcome === 'quote-unit-mismatch')
          this.note(
            s.id,
            'info',
            `${s.name}: Min. SOL trigger skipped because this pool is not quoted in verified SOL. Use Rate or Min. Token for other quote assets.`,
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

  /** Queues due DCA and Limit Order sells. */
  private schedule() {
    if (!this.running || this.paused || this.deps.now() < this.activeAt) return;
    const now = this.deps.now();
    for (const s of this.deps.strategies) {
      if (!this.running || this.paused) return;
      if (s.mode === 'counter') continue;
      const result = scheduleAutoSell(s, this.states.get(s.id)!, {
        now,
        decimals: this.deps.decimals,
        totalSupplyRaw: this.deps.totalSupplyRaw,
        marketCapUsd: this.marketCapUsd,
        random: this.deps.random,
      });
      if (result.state === this.states.get(s.id)) continue;
      this.states.set(s.id, result.state);
      const amount = rawToDecimal(result.addedRaw, this.deps.decimals);
      this.note(
        s.id,
        'info',
        s.mode === 'dca'
          ? `${s.name}: DCA sell ${result.state.responses} queued, ${amount} tokens.`
          : `${s.name}: market cap reached ${result.filled.length === 1 ? 'a limit order' : `${result.filled.length} limit orders`}, queued ${amount} tokens.`,
      );
    }
  }

  /** A failing feed must not leave an old market cap gating sells. */
  private expireMarketCap() {
    if (
      this.marketCapUsd !== null &&
      (this.deps.now() < this.marketCapAt ||
        this.deps.now() - this.marketCapAt > this.deps.marketCapMaxAgeMs)
    ) {
      this.marketCapUsd = null;
      this.emit();
    }
  }

  private checkEnds(now = this.deps.now()) {
    if (
      this.deps.session?.endDurationSeconds &&
      now >= this.activeAt + this.deps.session.endDurationSeconds * 1000
    ) {
      this.stop('Session duration reached.');
      return;
    }
    if (
      this.sessionCap !== null &&
      this.sessionUsed(false) >= this.sessionCap
    ) {
      this.stop('Session maximum amount reached.');
      return;
    }
    for (const s of this.deps.strategies) {
      const before = this.states.get(s.id)!;
      const after = checkAutoSellEnd(
        s,
        before,
        now,
        this.deps.totalSupplyRaw,
        this.selling || this.sessionCap === null
          ? null
          : this.sessionCap - this.sessionUsed(),
        this.deps.decimals,
      );
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
      this.pendingEdit = null;
      this.paused = false;
      if (this.timer !== null) this.deps.clearTimer(this.timer);
      this.timer = null;
      if (this.endTimer !== null) this.deps.clearTimer(this.endTimer);
      this.endTimer = null;
      this.note(null, 'info', 'All strategies ended.');
    }
  }

  private maybeSell() {
    if (
      !this.running ||
      this.paused ||
      this.deps.now() < this.activeAt ||
      this.selling ||
      this.deps.now() < this.sellBlockedUntil
    )
      return;
    this.expireMarketCap();
    for (const s of this.deps.strategies) {
      const state = this.states.get(s.id)!;
      if (state.status !== 'running') continue;
      if (!marketCapInRange(s, this.marketCapUsd)) continue;
      let amount = readyToSellRaw(s, state, this.deps.totalSupplyRaw);
      let capRemaining: bigint | null = null;
      const strategyCap = endCapRaw(
        s,
        this.deps.totalSupplyRaw,
        this.deps.decimals,
      );
      if (strategyCap !== null) {
        const remaining = strategyCap - state.soldRaw - state.inFlightRaw;
        if (remaining <= 0n) {
          this.checkEnds();
          continue;
        }
        capRemaining = remaining;
        if (amount > remaining) amount = remaining;
      }
      if (this.sessionCap !== null) {
        const remaining = this.sessionCap - this.sessionUsed();
        if (remaining <= 0n) {
          this.stop('Session maximum amount reached.');
          return;
        }
        if (capRemaining === null || remaining < capRemaining)
          capRemaining = remaining;
        if (amount > remaining) amount = remaining;
      }
      if (
        capRemaining !== null &&
        capRemaining < minimumAutoSellRaw(s, this.deps.totalSupplyRaw)
      ) {
        // Fail closed before dispatch even if a future caller omits checkEnds.
        this.checkEnds();
        continue;
      }
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
        .then(({ soldRaw, signature, wallet, outcome }) => {
          this.failures = 0;
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
            outcome,
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
              undefined,
              (error as { outcome?: AutoSellOutcomeReference }).outcome,
            );
            if (
              !this.controller.signal.aborted &&
              ++this.failures >= this.deps.maxConsecutiveFailures
            )
              this.stop(
                `Stopped after ${this.failures} failed sells in a row. Check the wallets and try again.`,
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
          if (error instanceof AutoSellReviewRecoveryError) {
            if (!this.reviewRecovery) {
              this.reviewRecovery = error.reference;
              this.reviewRecoveryConflict = error.conflict;
            }
            this.note(s.id, 'error', error.message);
            this.stop(
              'Review response unavailable. Recover the original saved approval before starting again.',
            );
            return;
          }
          if (this.controller.signal.aborted) return;
          this.failures++;
          const detail = error instanceof Error ? error.message : '';
          if (this.failures >= this.deps.maxConsecutiveFailures) {
            this.note(
              s.id,
              'error',
              `${s.name}: sell failed. ${detail}`.trim(),
            );
            this.stop(
              `Stopped after ${this.failures} failed sells in a row. Check the wallets and try again.`,
            );
            return;
          }
          this.note(
            s.id,
            'error',
            `${s.name}: sell failed, retrying shortly. ${detail}`.trim(),
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

  private sessionUsed(includeFlight = true) {
    return [...this.states.values()].reduce(
      (sum, state) =>
        sum + state.soldRaw + (includeFlight ? state.inFlightRaw : 0n),
      this.retiredAccountedRaw,
    );
  }
}

function short(address: string) {
  return address.length > 12
    ? `${address.slice(0, 4)}…${address.slice(-4)}`
    : address;
}
