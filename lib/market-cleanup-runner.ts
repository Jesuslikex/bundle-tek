import {
  nextBuyer,
  nextSeller,
  roundDelay,
  sellAmount,
  validMarketCleanupConfig,
  type MarketCleanupBalance,
  type MarketCleanupConfig,
} from './market-cleanup';
import type {
  CleanupFinalOutcome,
  CleanupSide,
  CleanupTradeResult,
} from './market-cleanup-execute';

export type MarketCleanupLogEntry = {
  at: number;
  round: number;
  kind: 'sell' | 'buy' | 'skip' | 'error' | 'end';
  message: string;
  wallet?: string;
  signature?: string;
};
export type MarketCleanupEnd =
  | 'sellers-empty'
  | 'no-buyer'
  | 'max-rounds'
  | 'buy-cap'
  | 'stopped'
  | 'uncertain'
  | 'failed';
export type MarketCleanupSnapshot = {
  running: boolean;
  round: number;
  soldRaw: bigint;
  boughtRaw: bigint;
  spentLamports: bigint;
  receivedLamports: bigint;
  balances: MarketCleanupBalance[];
  log: MarketCleanupLogEntry[];
  end: MarketCleanupEnd | null;
  /** A sent trade whose outcome is still unknown; never retried. */
  uncertainSignature: string | null;
};
export type MarketCleanupRunnerDeps = {
  config: MarketCleanupConfig;
  readBalances: (
    wallets: string[],
    signal: AbortSignal,
  ) => Promise<MarketCleanupBalance[]>;
  trade: (
    wallet: string,
    side: CleanupSide,
    amountRaw: bigint,
    signal: AbortSignal,
  ) => Promise<CleanupTradeResult>;
  awaitFinal: (
    sent: CleanupTradeResult,
    signal: AbortSignal,
  ) => Promise<CleanupFinalOutcome>;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  onUpdate: (snapshot: MarketCleanupSnapshot) => void;
  random?: () => number;
  now?: () => number;
  /** Failed rounds in a row before the run stops. */
  maxConsecutiveFailures?: number;
};
const LOG_LIMIT = 200;
const isUncertain = (e: unknown): e is { signature: string } =>
  !!e &&
  typeof e === 'object' &&
  (e as { uncertain?: unknown }).uncertain === true;

/**
 * Browser-side Cleanup loop. Each round sells part of one seller's balance,
 * waits for the finalized sale, then has one buyer buy with exactly the SOL
 * that sale returned. A sent trade with an unknown outcome stops the run and
 * is never resent.
 */
export function startMarketCleanup(deps: MarketCleanupRunnerDeps) {
  const config = validMarketCleanupConfig(deps.config);
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;
  const maxFailures = deps.maxConsecutiveFailures ?? 3;
  const controller = new AbortController();
  const signal = controller.signal;
  const snapshot: MarketCleanupSnapshot = {
    running: true,
    round: 0,
    soldRaw: 0n,
    boughtRaw: 0n,
    spentLamports: 0n,
    receivedLamports: 0n,
    balances: [],
    log: [],
    end: null,
    uncertainSignature: null,
  };
  const emit = () =>
    deps.onUpdate({
      ...snapshot,
      balances: [...snapshot.balances],
      log: [...snapshot.log],
    });
  const log = (entry: Omit<MarketCleanupLogEntry, 'at' | 'round'>) => {
    snapshot.log = [
      ...snapshot.log,
      { at: now(), round: snapshot.round, ...entry },
    ].slice(-LOG_LIMIT);
  };
  const finish = (end: MarketCleanupEnd, message: string) => {
    snapshot.running = false;
    snapshot.end = end;
    log({ kind: 'end', message });
    emit();
  };

  const done = (async () => {
    let sellerAt = -1,
      buyerAt = -1,
      failures = 0;
    let pending: CleanupTradeResult | null = null;
    const wallets = [...config.sellers, ...config.buyers];
    try {
      while (snapshot.round < config.maxRounds) {
        signal.throwIfAborted();
        const read = await deps.readBalances(wallets, signal);
        snapshot.balances = read;
        const balances = new Map(read.map((b) => [b.wallet, b]));
        const s = nextSeller(config.sellers, balances, sellerAt);
        if (s < 0)
          return finish('sellers-empty', 'Input wallets hold no more tokens.');
        snapshot.round++;
        emit();
        const seller = config.sellers[s];
        sellerAt = s;
        const amount = sellAmount(
          balances.get(seller)!.tokenRaw,
          config,
          random,
        );
        let proceeds: bigint;
        try {
          const sale = await deps.trade(seller, 'Sell', amount, signal);
          log({
            kind: 'sell',
            wallet: seller,
            signature: sale.signature,
            message: 'Sell sent.',
          });
          emit();
          pending = sale;
          const outcome = await deps.awaitFinal(sale, signal);
          pending = null;
          if (outcome.state === 'failed') {
            log({
              kind: 'error',
              wallet: seller,
              signature: sale.signature,
              message: 'Sell failed on chain; nothing was bought.',
            });
            if (++failures >= maxFailures)
              return finish('failed', 'Too many failed rounds in a row.');
            emit();
            await deps.sleep(roundDelay(config.delay, random), signal);
            continue;
          }
          snapshot.soldRaw += outcome.tokenUnitsRaw ?? amount;
          proceeds =
            outcome.nativeChangeRaw !== null && outcome.nativeChangeRaw > 0n
              ? outcome.nativeChangeRaw
              : 0n;
          snapshot.receivedLamports += proceeds;
        } catch (error) {
          if (isUncertain(error)) {
            snapshot.uncertainSignature = error.signature;
            return finish(
              'uncertain',
              error instanceof Error ? error.message : 'Sell outcome unknown.',
            );
          }
          if (signal.aborted) throw error;
          log({
            kind: 'error',
            wallet: seller,
            message: error instanceof Error ? error.message : 'Sell failed.',
          });
          if (++failures >= maxFailures)
            return finish('failed', 'Too many failed rounds in a row.');
          emit();
          await deps.sleep(roundDelay(config.delay, random), signal);
          continue;
        }
        let spend = proceeds;
        if (config.maxBuyLamports !== null) {
          const left = config.maxBuyLamports - snapshot.spentLamports;
          if (left < spend) spend = left > 0n ? left : 0n;
        }
        if (spend <= 0n) {
          log({
            kind: 'skip',
            message:
              proceeds > 0n
                ? 'SOL cap for buys reached; the sale proceeds stay with the seller.'
                : 'The sale returned no SOL to spend.',
          });
          if (proceeds > 0n)
            return finish('buy-cap', 'Reached the SOL cap for buys.');
          emit();
          await deps.sleep(roundDelay(config.delay, random), signal);
          continue;
        }
        const fresh = new Map(
          (await deps.readBalances(config.buyers, signal)).map((b) => [
            b.wallet,
            b,
          ]),
        );
        const b = nextBuyer(config.buyers, fresh, buyerAt, spend);
        if (b < 0)
          return finish(
            'no-buyer',
            'No output wallet has enough SOL to buy back this sale.',
          );
        buyerAt = b;
        const buyer = config.buyers[b];
        try {
          const purchase = await deps.trade(buyer, 'Buy', spend, signal);
          log({
            kind: 'buy',
            wallet: buyer,
            signature: purchase.signature,
            message: 'Buy sent.',
          });
          emit();
          pending = purchase;
          const outcome = await deps.awaitFinal(purchase, signal);
          pending = null;
          if (outcome.state === 'failed') {
            log({
              kind: 'error',
              wallet: buyer,
              signature: purchase.signature,
              message: 'Buy failed on chain.',
            });
            if (++failures >= maxFailures)
              return finish('failed', 'Too many failed rounds in a row.');
          } else {
            failures = 0;
            snapshot.spentLamports += spend;
            snapshot.boughtRaw +=
              outcome.tokenUnitsRaw !== null && outcome.tokenUnitsRaw > 0n
                ? outcome.tokenUnitsRaw
                : 0n;
          }
        } catch (error) {
          if (isUncertain(error)) {
            snapshot.uncertainSignature = error.signature;
            return finish(
              'uncertain',
              error instanceof Error ? error.message : 'Buy outcome unknown.',
            );
          }
          if (signal.aborted) throw error;
          log({
            kind: 'error',
            wallet: buyer,
            message: error instanceof Error ? error.message : 'Buy failed.',
          });
          if (++failures >= maxFailures)
            return finish('failed', 'Too many failed rounds in a row.');
        }
        if (
          config.maxBuyLamports !== null &&
          snapshot.spentLamports >= config.maxBuyLamports
        )
          return finish('buy-cap', 'Reached the SOL cap for buys.');
        emit();
        if (snapshot.round < config.maxRounds)
          await deps.sleep(roundDelay(config.delay, random), signal);
      }
      finish('max-rounds', `Finished ${config.maxRounds} rounds.`);
    } catch (error) {
      if (pending) snapshot.uncertainSignature = pending.signature;
      if (signal.aborted)
        finish(
          'stopped',
          pending
            ? `Stopped. Trade ${pending.signature} was already sent; check its outcome before trading that wallet again.`
            : 'Stopped. No new trade starts.',
        );
      else
        finish(
          'failed',
          error instanceof Error ? error.message : 'Cleanup stopped.',
        );
    }
  })();
  emit();
  return {
    stop: () => controller.abort(),
    done,
  };
}
