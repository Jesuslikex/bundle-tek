import {
  validateVolumeUsdTarget,
  type VolumeUsdTarget,
} from './volume-usd-target';
/**
 * Volume Bot planning, modelled on Proxima's Volume Bot settings: a target
 * volume, a duration, a min/max delay between trades, auto/fixed/random trade
 * sizes and a wave intensity. The plan is a pure, seeded schedule of buy/sell
 * round trips. It grants no signing or execution: every batch is still
 * prepared, reviewed, approved and signed in the browser.
 *
 * Bundle cannot pre-sign a sell before its buy lands (the swap provider builds
 * sells from the real token balance), so a round's sell is always placed in a
 * later batch than its buy and sells exactly the amount that buy received.
 */
export type VolumeWave = 'tight' | 'big-waves';
export type VolumeAmount =
  | { kind: 'auto' }
  | { kind: 'fixed'; lamports: string }
  | { kind: 'range'; minLamports: string; maxLamports: string };
export type VolumeTerms = {
  targetVolumeLamports: string;
  durationSeconds: number;
  delayMinMs: number;
  delayMaxMs: number;
  amount: VolumeAmount;
  wave: VolumeWave;
  wallets: string[];
};
export type VolumeWalletBalance = { address: string; lamports: string };
export type VolumeEvent = {
  index: number;
  round: number;
  side: 'Buy' | 'Sell';
  wallet: string;
  offsetMs: number;
  batch: number;
  batchOffsetMs: number;
};
export type VolumePlan = ReturnType<typeof planVolumeSession>;

export const VOLUME_LIMITS = {
  maxWallets: 25,
  maxRounds: 250,
  minDelayMs: 1_000,
  maxDelayMs: 600_000,
  minDurationSeconds: 60,
  maxDurationSeconds: 86_400,
  minTradeLamports: 1_000_000n,
  maxTradeLamports: 1_000_000_000_000n,
  /** Longest send span inside one approved batch, so it fits one blockhash window. */
  batchSpanMs: 30_000,
  /** Estimated network + priority fee per swap. Real fees come from each simulation. */
  feePerTradeLamports: 50_000n,
  /** One token account opened per wallet on its first buy. */
  tokenAccountRentLamports: 2_039_280n,
  /** Assumed pool/route cost per trade for the estimate only. */
  swapCostBps: 100n,
} as const;

export class VolumePlanError extends Error {}
/** Exact atomic units to a plain decimal string. */
export function rawToDecimal(raw: bigint, decimals: number) {
  const text = raw.toString().padStart(decimals + 1, '0');
  const whole = text.slice(0, text.length - decimals),
    fraction = text.slice(text.length - decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
/** Plain decimal text to exact atomic units, or undefined when it is not exact. */
export function decimalToRaw(text: string, decimals: number) {
  const match = /^(\d{1,12})(?:\.(\d+))?$/.exec(text.trim());
  if (!match || (match[2] ?? '').length > decimals) return undefined;
  return BigInt(match[1] + (match[2] ?? '').padEnd(decimals, '0'));
}
const fail = (message: string): never => {
  throw new VolumePlanError(message);
};
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const lamports = (value: unknown, label: string) => {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value))
    return fail(`Choose an exact positive ${label}.`);
  return BigInt(value);
};
const int = (value: unknown, min: number, max: number, label: string) => {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < min ||
    Number(value) > max
  )
    return fail(`Choose ${label} between ${min} and ${max}.`);
  return Number(value);
};

/** Strict structural validation of saved or requested terms. */
export function volumeTerms(value: unknown): VolumeTerms {
  const input = value as Record<string, unknown> | null;
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return fail('Choose Volume Bot settings.');
  const target = lamports(input.targetVolumeLamports, 'target volume');
  const durationSeconds = int(
    input.durationSeconds,
    VOLUME_LIMITS.minDurationSeconds,
    VOLUME_LIMITS.maxDurationSeconds,
    'a duration in seconds',
  );
  const delayMinMs = int(
    input.delayMinMs,
    VOLUME_LIMITS.minDelayMs,
    VOLUME_LIMITS.maxDelayMs,
    'a minimum delay in milliseconds',
  );
  const delayMaxMs = int(
    input.delayMaxMs,
    delayMinMs,
    VOLUME_LIMITS.maxDelayMs,
    'a maximum delay at or above the minimum',
  );
  if (input.wave !== 'tight' && input.wave !== 'big-waves')
    return fail('Choose Tight or Big waves.');
  const amountInput = input.amount as Record<string, unknown> | null;
  let amount: VolumeAmount;
  const bounded = (value: unknown, label: string) => {
    const raw = lamports(value, label);
    if (
      raw < VOLUME_LIMITS.minTradeLamports ||
      raw > VOLUME_LIMITS.maxTradeLamports
    )
      fail(`Each trade must be between 0.001 and 1000 SOL.`);
    return raw.toString();
  };
  if (amountInput?.kind === 'auto') amount = { kind: 'auto' };
  else if (amountInput?.kind === 'fixed')
    amount = {
      kind: 'fixed',
      lamports: bounded(amountInput.lamports, 'trade amount'),
    };
  else if (amountInput?.kind === 'range') {
    const minLamports = bounded(
      amountInput.minLamports,
      'minimum trade amount',
    );
    const maxLamports = bounded(
      amountInput.maxLamports,
      'maximum trade amount',
    );
    if (BigInt(maxLamports) < BigInt(minLamports))
      fail('Maximum trade amount must be at or above the minimum.');
    amount = { kind: 'range', minLamports, maxLamports };
  } else return fail('Choose auto, fixed or random trade amounts.');
  if (
    !Array.isArray(input.wallets) ||
    !input.wallets.length ||
    input.wallets.length > VOLUME_LIMITS.maxWallets ||
    input.wallets.some((w) => typeof w !== 'string' || !BASE58.test(w)) ||
    new Set(input.wallets).size !== input.wallets.length
  )
    return fail(
      `Choose 1 to ${VOLUME_LIMITS.maxWallets} distinct Solana wallets.`,
    );
  if (target < VOLUME_LIMITS.minTradeLamports * 2n)
    fail('Target volume must cover at least one 0.001 SOL round trip.');
  const keys = Object.keys(input).sort().join(',');
  if (
    keys !==
    'amount,delayMaxMs,delayMinMs,durationSeconds,targetVolumeLamports,wallets,wave'
  )
    fail('Volume Bot settings contain unknown fields.');
  return {
    targetVolumeLamports: target.toString(),
    durationSeconds,
    delayMinMs,
    delayMaxMs,
    amount,
    wave: input.wave,
    wallets: [...(input.wallets as string[])],
  };
}

/** sfc32 seeded from 16 bytes of hex, so the server can reproduce the client plan exactly. */
export function volumeRandom(seed: string) {
  if (!/^[0-9a-f]{32}$/.test(seed)) fail('Invalid plan seed.');
  const words = [0, 8, 16, 24].map((n) => parseInt(seed.slice(n, n + 8), 16));
  let [a, b, c, d] = words;
  const next = () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const t = (a + b + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let n = 0; n < 12; n++) next();
  return {
    next,
    int: (min: number, max: number) =>
      min + Math.floor(next() * (max - min + 1)),
    big: (min: bigint, max: bigint) =>
      min +
      (BigInt(Math.floor(next() * 2 ** 32)) * (max - min + 1n)) / 2n ** 32n,
  };
}
export function newVolumeSeed() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

function roundAmounts(
  terms: VolumeTerms,
  rand: ReturnType<typeof volumeRandom>,
  gaps: number[],
) {
  const target = BigInt(terms.targetVolumeLamports);
  const { minTradeLamports, maxRounds } = VOLUME_LIMITS;
  const amounts: bigint[] = [];
  if (terms.amount.kind === 'auto') {
    // As many trades as the sampled delays fit into the duration, so the
    // schedule always ends inside it.
    let events = 1,
      elapsed = 0;
    for (const gap of gaps) {
      if (elapsed + gap > terms.durationSeconds * 1000) break;
      elapsed += gap;
      events++;
    }
    let rounds = Math.max(1, Math.floor(events / 2));
    rounds = Math.min(
      rounds,
      Number(target / (2n * minTradeLamports)),
      maxRounds,
    );
    const each = target / 2n / BigInt(rounds);
    for (let n = 0; n < rounds; n++) amounts.push(each);
    // Floor division can leave the target a few lamports short; the last round absorbs it.
    amounts[rounds - 1] += (target - 2n * each * BigInt(rounds) + 1n) / 2n;
    return amounts;
  }
  let volume = 0n;
  while (volume < target) {
    const amount =
      terms.amount.kind === 'fixed'
        ? BigInt(terms.amount.lamports)
        : rand.big(
            BigInt(terms.amount.minLamports),
            BigInt(terms.amount.maxLamports),
          );
    amounts.push(amount);
    volume += 2n * amount;
    if (amounts.length > maxRounds)
      fail(
        `This target needs more than ${maxRounds} round trips. Raise the trade amount or lower the target.`,
      );
  }
  return amounts;
}

/**
 * Deterministic plan from terms, observed wallet balances and a seed. Wallets
 * that cannot cover their largest round plus rent and fees are excluded when
 * other eligible wallets remain, as Proxima does.
 */
export function planVolumeSession(
  supplied: VolumeTerms,
  balances: VolumeWalletBalance[],
  seed: string,
  usdTarget?: VolumeUsdTarget,
) {
  const terms = volumeTerms(structuredClone(supplied));
  const usd =
    usdTarget === undefined ? undefined : validateVolumeUsdTarget(usdTarget);
  if (usd && usd.targetVolumeLamports !== terms.targetVolumeLamports)
    fail('USD conversion differs from the fixed SOL target.');
  const rand = volumeRandom(seed);
  // Delays come from their own stream so trade sizing never shifts timing.
  const timing = volumeRandom(seed.split('').reverse().join(''));
  const gaps = Array.from({ length: 2 * VOLUME_LIMITS.maxRounds }, () =>
    timing.int(terms.delayMinMs, terms.delayMaxMs),
  );
  const amounts = roundAmounts(terms, rand, gaps);
  const largest = amounts.reduce((a, b) => (a > b ? a : b));
  const fee = VOLUME_LIMITS.feePerTradeLamports;
  const requiredPerWallet =
    largest + VOLUME_LIMITS.tokenAccountRentLamports + 2n * fee;
  const observed = new Map(balances.map((b) => [b.address, b.lamports]));
  if (terms.wallets.some((w) => !/^\d{1,20}$/.test(observed.get(w) ?? '')))
    fail('Observe every selected wallet balance before planning.');
  const eligible = terms.wallets.filter(
    (w) => BigInt(observed.get(w)!) >= requiredPerWallet,
  );
  if (!eligible.length)
    fail(
      `No selected wallet holds the ${requiredPerWallet} lamports each needs (largest trade, token account rent and fees).`,
    );
  const excluded = terms.wallets.filter((w) => !eligible.includes(w));

  // Order buys and sells. A wallet holds at most one open round at a time so
  // each sell can only ever sell what its own buy received.
  type Pending = { round: number; side: 'Buy' | 'Sell'; wallet: string };
  const order: Pending[] = [];
  const holding = new Set<string>();
  let cursor = 0,
    next = 0;
  const freeWallet = () => {
    for (let n = 0; n < eligible.length; n++) {
      const wallet = eligible[(cursor + n) % eligible.length];
      if (!holding.has(wallet)) {
        cursor = (cursor + n + 1) % eligible.length;
        return wallet;
      }
    }
    return undefined;
  };
  while (next < amounts.length) {
    const streak =
      terms.wave === 'tight'
        ? 1
        : rand.int(2, Math.max(2, Math.min(6, eligible.length)));
    const open: Pending[] = [];
    for (let n = 0; n < streak && next < amounts.length; n++) {
      const wallet = freeWallet();
      if (!wallet) break;
      holding.add(wallet);
      const buy = { round: next++, side: 'Buy' as const, wallet };
      order.push(buy);
      open.push(buy);
    }
    // Big waves sell back in a shuffled order; tight sells right after.
    for (let n = open.length - 1; n > 0; n--) {
      const k = rand.int(0, n);
      [open[n], open[k]] = [open[k], open[n]];
    }
    for (const buy of open) {
      order.push({ round: buy.round, side: 'Sell', wallet: buy.wallet });
      holding.delete(buy.wallet);
    }
  }

  // Times and batches. A sell never shares a batch with its own buy, and a
  // wallet appears at most once per batch.
  const events: VolumeEvent[] = [];
  let offset = 0,
    batch = -1,
    batchStart = 0;
  let inBatch = new Set<string>();
  const buyBatch = new Map<number, number>();
  for (const [index, step] of order.entries()) {
    if (index) offset += gaps[index - 1];
    const conflict =
      batch < 0 ||
      offset - batchStart > VOLUME_LIMITS.batchSpanMs ||
      inBatch.has(step.wallet) ||
      (step.side === 'Sell' && buyBatch.get(step.round) === batch);
    if (conflict) {
      batch++;
      batchStart = offset;
      inBatch = new Set();
    }
    inBatch.add(step.wallet);
    if (step.side === 'Buy') buyBatch.set(step.round, batch);
    events.push({
      index,
      round: step.round,
      side: step.side,
      wallet: step.wallet,
      offsetMs: offset,
      batch,
      batchOffsetMs: offset - batchStart,
    });
  }
  const scheduledMs = offset;
  const minimumDurationSeconds = Math.ceil(
    ((order.length - 1) * terms.delayMinMs) / 1000,
  );
  if (scheduledMs > terms.durationSeconds * 1000)
    fail(
      `This schedule needs at least ${Math.ceil(scheduledMs / 1000)} seconds. Lengthen the duration, shorten delays or raise trade sizes.`,
    );
  const volume = amounts.reduce((a, b) => a + 2n * b, 0n);
  const trades = BigInt(events.length);
  return {
    format: 'volume-bot-plan-v1' as const,
    ...(usd ? { usdTarget: usd } : {}),
    terms,
    seed,
    rounds: amounts.map((amount, round) => ({
      round,
      wallet: order.find((o) => o.round === round)!.wallet,
      lamports: amount.toString(),
    })),
    events,
    batches: batch + 1,
    wallets: eligible,
    excludedWallets: excluded,
    estimate: {
      rounds: amounts.length,
      trades: events.length,
      approvals: batch + 1,
      volumeLamports: volume.toString(),
      scheduledSeconds: Math.ceil(scheduledMs / 1000),
      minimumDurationSeconds,
      requiredPerWalletLamports: requiredPerWallet.toString(),
      networkFeesLamports: (trades * fee).toString(),
      swapCostLamports: (
        (volume * VOLUME_LIMITS.swapCostBps) /
        10_000n
      ).toString(),
      assumptions:
        'Fees assume about 0.00005 SOL per swap and swap cost assumes about 1% per trade. Price movement, liquidity and failed transactions change the real cost. Each batch waits for the previous batch to finalize, so real time runs longer than the schedule.',
    },
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}

/** Rebuilds the plan from its own terms and seed and requires it to match exactly. */
export function requireVolumePlan(
  supplied: VolumePlan,
  balances: VolumeWalletBalance[],
) {
  if (supplied?.format !== 'volume-bot-plan-v1')
    fail('Save a reviewed Volume Bot plan.');
  const rebuilt = planVolumeSession(
    supplied.terms,
    balances,
    supplied.seed,
    supplied.usdTarget,
  );
  if (JSON.stringify(rebuilt) !== JSON.stringify(supplied))
    fail('Volume Bot plan changed. Estimate again with current balances.');
  return rebuilt;
}
