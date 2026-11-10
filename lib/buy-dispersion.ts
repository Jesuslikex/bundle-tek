/**
 * Multi-wallet Buy options (Proxima "Buy & Sell" panel settings):
 * Dispersion (how many of the selected wallets take part), Wallet Selection
 * (Random, Low Tokens or High Tokens) and Amount Distribution (Equal, Random
 * with a deviation, or Weighted by native balance).
 *
 * Pure planning only. It decides which wallets buy and how much each spends;
 * every buy is still its own transaction, signed in the browser.
 */
export const WALLET_SELECTIONS = [
  'Random',
  'Low Tokens',
  'High Tokens',
] as const;
export type WalletSelection = (typeof WALLET_SELECTIONS)[number];
export const AMOUNT_DISTRIBUTIONS = ['Equal', 'Random', 'Weighted'] as const;
export type AmountDistribution = (typeof AMOUNT_DISTRIBUTIONS)[number];
export const MAX_DEVIATION_PERCENT = 90;

/** Blank means every selected wallet; otherwise a whole number from 1 to the selection size. */
export function parseDispersion(value: string, selected: number) {
  const text = value.trim();
  if (!text) return selected;
  if (!/^\d{1,4}$/.test(text))
    throw new Error('Dispersion must be a whole number of wallets.');
  const count = Number(text);
  if (count < 1 || count > selected)
    throw new Error(
      `Dispersion must be 1 to ${selected} (the wallets you selected).`,
    );
  return count;
}

export function parseDeviationPercent(value: string) {
  const text = value.trim();
  if (!/^\d{1,2}$/.test(text))
    throw new Error(
      `Deviation must be a whole percent from 1 to ${MAX_DEVIATION_PERCENT}.`,
    );
  const percent = Number(text);
  if (percent < 1 || percent > MAX_DEVIATION_PERCENT)
    throw new Error(
      `Deviation must be a whole percent from 1 to ${MAX_DEVIATION_PERCENT}.`,
    );
  return percent;
}

/**
 * Choose which wallets take part. Random shuffles; Low/High Tokens rank by the
 * token balance just read (ties keep the selection order) and need a balance
 * for every wallet.
 */
export function pickDispersedWallets<T extends { address: string }>(
  wallets: T[],
  count: number,
  selection: WalletSelection,
  tokenBalances: Record<string, bigint | undefined> = {},
  random: () => number = Math.random,
): T[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > wallets.length)
    throw new Error('Dispersion exceeds the selected wallets.');
  if (selection === 'Random') {
    if (count === wallets.length) return wallets.slice();
    const pool = wallets.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.min(i, Math.floor(random() * (i + 1)));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, count);
  }
  const missing = wallets.find((w) => tokenBalances[w.address] === undefined);
  if (missing)
    throw new Error(
      'Token balances are unavailable for some wallets. Refresh balances first.',
    );
  const ranked = wallets
    .map((wallet, index) => ({
      wallet,
      index,
      balance: tokenBalances[wallet.address]!,
    }))
    .sort((a, b) => {
      if (a.balance === b.balance) return a.index - b.index;
      const lower = a.balance < b.balance ? -1 : 1;
      return selection === 'Low Tokens' ? lower : -lower;
    });
  return ranked.slice(0, count).map((r) => r.wallet);
}

function splitByWeights(total: bigint, weights: bigint[]) {
  const sum = weights.reduce((s, w) => s + w, 0n);
  if (sum <= 0n) throw new Error('No wallet has a weight to split by.');
  const shares = weights.map((w) => (total * w) / sum);
  let rest = total - shares.reduce((s, v) => s + v, 0n);
  // Rounding remainders go to the earliest wallets that already have a share.
  for (let i = 0; rest > 0n && i < shares.length; i++)
    if (weights[i] > 0n) {
      shares[i] += 1n;
      rest -= 1n;
    }
  return shares;
}

/**
 * Split the buy budget. `perWalletRaw` is the entered amount per wallet, so the
 * total spent is always `perWalletRaw * wallets.length` in every mode.
 */
export function distributeBuyAmounts(
  addresses: string[],
  perWalletRaw: bigint,
  distribution: AmountDistribution,
  options: {
    deviationPercent?: number;
    nativeBalances?: Record<string, bigint | undefined>;
    random?: () => number;
  } = {},
): Record<string, bigint> {
  if (!addresses.length) return {};
  if (perWalletRaw <= 0n) throw new Error('Enter a positive buy amount.');
  const total = perWalletRaw * BigInt(addresses.length);
  let shares: bigint[];
  if (distribution === 'Equal') shares = addresses.map(() => perWalletRaw);
  else if (distribution === 'Random') {
    const deviation = options.deviationPercent ?? 0;
    if (
      !Number.isSafeInteger(deviation) ||
      deviation < 1 ||
      deviation > MAX_DEVIATION_PERCENT
    )
      throw new Error(
        `Deviation must be a whole percent from 1 to ${MAX_DEVIATION_PERCENT}.`,
      );
    const random = options.random ?? Math.random;
    const scale = 1_000_000;
    shares = splitByWeights(
      total,
      addresses.map(() =>
        BigInt(
          Math.round(
            scale *
              (1 +
                (deviation / 100) *
                  (2 * Math.min(1, Math.max(0, random())) - 1)),
          ),
        ),
      ),
    );
  } else {
    const balances = options.nativeBalances ?? {};
    if (addresses.some((a) => balances[a] === undefined))
      throw new Error(
        'SOL balances are unavailable for some wallets. Refresh wallet balances first.',
      );
    shares = splitByWeights(
      total,
      addresses.map((a) => balances[a]!),
    );
  }
  return Object.fromEntries(addresses.map((a, i) => [a, shares[i]]));
}
