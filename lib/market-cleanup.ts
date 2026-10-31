/**
 * Proxima-style project Cleanup: tokens move from input wallets (sellers) to
 * output wallets (buyers) through market sell→buy rounds. Each round one
 * seller sells part of its balance to SOL and one buyer then buys the coin
 * back with the SOL that sale actually returned, so supply rotates between
 * the user's wallets on the open market.
 *
 * This module is pure planning. Every trade still goes through the existing
 * imported-token prepare → server review → local signature → one-attempt send.
 */
export const MARKET_CLEANUP_MAX_WALLETS = 20;
export const MARKET_CLEANUP_MIN_DELAY_MS = 500;
export const MARKET_CLEANUP_MAX_DELAY_MS = 300_000;
export const MARKET_CLEANUP_MAX_ROUNDS = 500;
/** SOL each buyer keeps for fees and token-account rent. */
export const MARKET_CLEANUP_BUYER_RESERVE_LAMPORTS = 5_000_000n;

export type MarketCleanupDelay =
  | { kind: 'fixed'; ms: number }
  | { kind: 'random'; minMs: number; maxMs: number };
export type MarketCleanupConfig = {
  sellers: string[];
  buyers: string[];
  /** Share of the seller's current balance sold per round, in basis points. */
  sellMinBps: number;
  sellMaxBps: number;
  delay: MarketCleanupDelay;
  maxRounds: number;
  /** Optional cap on SOL spent by all buys together. */
  maxBuyLamports: bigint | null;
};
export type MarketCleanupBalance = {
  wallet: string;
  tokenRaw: bigint;
  lamports: bigint;
};

const fail = (message: string): never => {
  throw new Error(message);
};

export function validMarketCleanupConfig(
  config: MarketCleanupConfig,
): MarketCleanupConfig {
  const { sellers, buyers } = config;
  if (!sellers.length) fail('Select at least one input wallet (seller).');
  if (!buyers.length) fail('Select at least one output wallet (buyer).');
  if (
    sellers.length > MARKET_CLEANUP_MAX_WALLETS ||
    buyers.length > MARKET_CLEANUP_MAX_WALLETS
  )
    fail(`Select up to ${MARKET_CLEANUP_MAX_WALLETS} wallets on each side.`);
  if (
    new Set(sellers).size !== sellers.length ||
    new Set(buyers).size !== buyers.length
  )
    fail('Remove duplicate wallets.');
  if (sellers.some((w) => buyers.includes(w)))
    fail('A wallet cannot be both a seller and a buyer.');
  if (
    !Number.isInteger(config.sellMinBps) ||
    !Number.isInteger(config.sellMaxBps) ||
    config.sellMinBps < 1 ||
    config.sellMaxBps > 10_000 ||
    config.sellMinBps > config.sellMaxBps
  )
    fail('Sell between 0.01% and 100% of the seller balance each round.');
  const d = config.delay;
  const inRange = (ms: number) =>
    Number.isInteger(ms) &&
    ms >= MARKET_CLEANUP_MIN_DELAY_MS &&
    ms <= MARKET_CLEANUP_MAX_DELAY_MS;
  if (
    d.kind === 'fixed'
      ? !inRange(d.ms)
      : d.kind !== 'random' ||
        !inRange(d.minMs) ||
        !inRange(d.maxMs) ||
        d.minMs > d.maxMs
  )
    fail('Delay between rounds must be 0.5s to 300s.');
  if (
    !Number.isSafeInteger(config.maxRounds) ||
    config.maxRounds < 1 ||
    config.maxRounds > MARKET_CLEANUP_MAX_ROUNDS
  )
    fail(`Run 1 to ${MARKET_CLEANUP_MAX_ROUNDS} rounds.`);
  if (config.maxBuyLamports !== null && config.maxBuyLamports <= 0n)
    fail('The SOL cap for buys must be above zero.');
  return config;
}

/** Next seller holding tokens, rotating from `after`. */
export function nextSeller(
  sellers: string[],
  balances: ReadonlyMap<string, MarketCleanupBalance>,
  after: number,
) {
  for (let i = 1; i <= sellers.length; i++) {
    const index = (after + i) % sellers.length;
    if ((balances.get(sellers[index])?.tokenRaw ?? 0n) > 0n) return index;
  }
  return -1;
}

/** Next buyer that can pay `lamports` and keep its reserve, rotating from `after`. */
export function nextBuyer(
  buyers: string[],
  balances: ReadonlyMap<string, MarketCleanupBalance>,
  after: number,
  lamports: bigint,
) {
  for (let i = 1; i <= buyers.length; i++) {
    const index = (after + i) % buyers.length;
    const have = balances.get(buyers[index])?.lamports ?? 0n;
    if (have >= lamports + MARKET_CLEANUP_BUYER_RESERVE_LAMPORTS) return index;
  }
  return -1;
}

/** Raw tokens sold this round: a share of the balance, never zero. */
export function sellAmount(
  balanceRaw: bigint,
  config: Pick<MarketCleanupConfig, 'sellMinBps' | 'sellMaxBps'>,
  random: () => number,
) {
  if (balanceRaw <= 0n) return 0n;
  const span = config.sellMaxBps - config.sellMinBps;
  const bps = config.sellMinBps + Math.floor(random() * (span + 1));
  const amount = (balanceRaw * BigInt(Math.min(bps, 10_000))) / 10_000n;
  return amount > 0n ? amount : balanceRaw;
}

export function roundDelay(delay: MarketCleanupDelay, random: () => number) {
  return delay.kind === 'fixed'
    ? delay.ms
    : delay.minMs + Math.floor(random() * (delay.maxMs - delay.minMs + 1));
}

/** Share of supply held by a group, in basis points (for the "Total %" line). */
export function groupSupplyBps(
  wallets: string[],
  balances: ReadonlyMap<string, MarketCleanupBalance>,
  supplyRaw: bigint,
) {
  if (supplyRaw <= 0n) return 0;
  const held = wallets.reduce(
    (sum, w) => sum + (balances.get(w)?.tokenRaw ?? 0n),
    0n,
  );
  return Number((held * 10_000n) / supplyRaw);
}
