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
/**
 * Proxima's Mode switch: `Bundle` buys and sells in the same block and removes
 * the wave control, `Organic` spreads trades over time.
 */
export type VolumeMode = 'Bundle' | 'Organic';
/**
 * Proxima's end condition. `time` runs a fixed duration with the trades spread
 * evenly across it; `delay` waits a random delay between min and max before
 * each trade. Only `delay` carries trade amounts.
 */
export type VolumeEndCondition = 'time' | 'delay';
export type VolumeAmount =
  | { kind: 'auto' }
  | { kind: 'fixed'; lamports: string }
  | { kind: 'range'; minLamports: string; maxLamports: string };
/**
 * Proxima's volume bot payload. Target volume is always required; the end
 * condition picks either a duration or a min/max delay pair, and the amount per
 * trade is required in delay mode and absent in time mode (the server sizes
 * trades from the target and duration instead).
 */
export type VolumeTerms = {
  targetVolumeLamports: string;
  /** Defaults to `delay` so plans saved before the switch still rebuild. */
  endCondition?: VolumeEndCondition;
  /** Required in time mode, absent in delay mode. */
  durationSeconds?: number;
  /** Required in delay mode, absent in time mode. */
  delayMinMs?: number;
  delayMaxMs?: number;
  /** Required in delay mode, absent in time mode. */
  amount?: VolumeAmount;
  wave: VolumeWave;
  waveIntensityTenths?: number;
  /** Defaults to `Organic` so plans saved before the switch still rebuild. */
  mode?: VolumeMode;
  /** Native SOL tip budget for the whole run, split across its trades. */
  feeTargetLamports?: string;
  /** Legacy organic sizing, kept so plans saved before it was dropped rebuild. */
  organic?: unknown;
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
  maxDelayMs: 300_000,
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
  const hasEnd = Object.hasOwn(input, 'endCondition');
  const endCondition = (hasEnd ? input.endCondition : 'delay') as VolumeEndCondition;
  if (endCondition !== 'time' && endCondition !== 'delay')
    return fail('Choose a duration or a delay.');
  const delayMode = endCondition === 'delay';
  const hasDuration = Object.hasOwn(input, 'durationSeconds');
  const hasDelays =
    Object.hasOwn(input, 'delayMinMs') || Object.hasOwn(input, 'delayMaxMs');
  // Plans saved before the switch carry both a duration and delays, so the
  // exclusive rules only apply once an end condition is actually stored.
  if (hasEnd && delayMode && hasDuration)
    fail('Delay mode has no duration. Clear it or switch to Duration.');
  if (hasEnd && !delayMode && hasDelays)
    fail('Duration mode has no delays. Clear them or switch to Delay.');
  const durationSeconds =
    hasEnd && delayMode
      ? undefined
      : int(
          input.durationSeconds,
          VOLUME_LIMITS.minDurationSeconds,
          VOLUME_LIMITS.maxDurationSeconds,
          'a duration in seconds',
        );
  const delayMinMs =
    hasEnd && !delayMode
      ? undefined
      : int(
          input.delayMinMs,
          VOLUME_LIMITS.minDelayMs,
          VOLUME_LIMITS.maxDelayMs,
          'a min delay and max delay that are positive with min <= max',
        );
  const delayMaxMs =
    delayMinMs === undefined
      ? undefined
      : int(
          input.delayMaxMs,
          delayMinMs,
          VOLUME_LIMITS.maxDelayMs,
          'a min delay and max delay that are positive with min <= max',
        );
  if (input.wave !== 'tight' && input.wave !== 'big-waves')
    return fail('Choose Tight or Big waves.');
  const amountInput = input.amount as Record<string, unknown> | null;
  let amount: VolumeAmount | undefined;
  const bounded = (value: unknown, label: string) => {
    const raw = lamports(value, label);
    if (
      raw < VOLUME_LIMITS.minTradeLamports ||
      raw > VOLUME_LIMITS.maxTradeLamports
    )
      fail(`Each trade must be between 0.001 and 1000 SOL.`);
    return raw.toString();
  };
  if (hasEnd && !delayMode && Object.hasOwn(input, 'amount'))
    return fail(
      'Duration mode has no amount per trade. Clear it or switch to Delay.',
    );
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
      fail('Min amount must be positive and less than max amount.');
    amount = { kind: 'range', minLamports, maxLamports };
  } else if (hasEnd && delayMode)
    return fail('Choose fixed or random trade amounts.');
  else if (Object.hasOwn(input, 'amount'))
    return fail(
      'Duration mode has no amount per trade. Clear it or switch to Delay.',
    );
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
  const hasIntensity = Object.hasOwn(input, 'waveIntensityTenths');
  const intensity = hasIntensity
    ? int(input.waveIntensityTenths, 0, 10, 'wave intensity in tenths')
    : undefined;
  if (
    intensity !== undefined &&
    input.wave !== (intensity === 0 ? 'tight' : 'big-waves')
  )
    fail('Wave mode differs from the selected intensity.');
  const hasMode = Object.hasOwn(input, 'mode');
  const mode = (hasMode ? input.mode : 'Organic') as VolumeMode;
  if (mode !== 'Bundle' && mode !== 'Organic')
    fail('Choose Bundle or Organic mode.');
  // Proxima removes the wave control in Bundle mode, so a stray intensity is
  // a stale form rather than a setting to honour.
  if (mode === 'Bundle' && intensity !== undefined)
    fail('Bundle mode has no wave intensity. Clear it or switch to Organic.');
  const hasFeeTarget = Object.hasOwn(input, 'feeTargetLamports');
  const feeTarget = hasFeeTarget
    ? lamports(input.feeTargetLamports, 'fee target in lamports')
    : undefined;
  const expected = [
    'targetVolumeLamports',
    'wallets',
    'wave',
    ...(hasEnd ? ['endCondition'] : []),
    ...(hasDuration ? ['durationSeconds'] : []),
    ...(Object.hasOwn(input, 'delayMinMs') ? ['delayMinMs'] : []),
    ...(Object.hasOwn(input, 'delayMaxMs') ? ['delayMaxMs'] : []),
    ...(Object.hasOwn(input, 'amount') ? ['amount'] : []),
    ...(hasIntensity ? ['waveIntensityTenths'] : []),
    ...(hasMode ? ['mode'] : []),
    ...(hasFeeTarget ? ['feeTargetLamports'] : []),
    // Legacy: plans saved while organic carried its own jitter and shuffle
    // still rebuild, the field is simply dropped.
    ...(Object.hasOwn(input, 'organic') ? ['organic'] : []),
  ].sort();
  if (Object.keys(input).sort().join(',') !== expected.join(','))
    fail('Volume Bot settings contain unknown fields.');
  return {
    targetVolumeLamports: target.toString(),
    ...(hasEnd ? { endCondition } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(delayMinMs !== undefined ? { delayMinMs } : {}),
    ...(delayMaxMs !== undefined ? { delayMaxMs } : {}),
    ...(amount !== undefined ? { amount } : {}),
    wave: input.wave,
    ...(intensity !== undefined ? { waveIntensityTenths: intensity } : {}),
    // Keep this order identical to the panel's draft builder: the estimate is
    // compared to the draft by JSON, so key order is part of the contract.
    ...(Object.hasOwn(input, 'organic') ? { organic: input.organic } : {}),
    ...(hasMode ? { mode } : {}),
    ...(feeTarget !== undefined ? { feeTargetLamports: feeTarget.toString() } : {}),
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
  return baseRoundAmounts(terms, rand, gaps);
}

function baseRoundAmounts(
  terms: VolumeTerms,
  rand: ReturnType<typeof volumeRandom>,
  gaps: number[],
) {
  const target = BigInt(terms.targetVolumeLamports);
  const { minTradeLamports, maxRounds } = VOLUME_LIMITS;
  const amounts: bigint[] = [];
  if (terms.endCondition === 'time') {
    // Duration mode: no amount inputs, so the target is split into as many
    // equal round trips as it covers, then spread across the duration.
    const rounds = Math.max(
      1,
      Math.min(Number(target / (2n * minTradeLamports)), maxRounds),
    );
    const each = target / 2n / BigInt(rounds);
    for (let n = 0; n < rounds; n++) amounts.push(each);
    amounts[rounds - 1] += (target - 2n * each * BigInt(rounds) + 1n) / 2n;
    return amounts;
  }
  if (terms.amount!.kind === 'auto') {
    // As many trades as the sampled delays fit into the duration, so the
    // schedule always ends inside it. Legacy plans still carry a duration.
    const limitMs = terms.durationSeconds
      ? terms.durationSeconds * 1000
      : Number.POSITIVE_INFINITY;
    let events = 1,
      elapsed = 0;
    for (const gap of gaps) {
      if (elapsed + gap > limitMs) break;
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
      terms.amount!.kind === 'fixed'
        ? BigInt(terms.amount!.lamports)
        : rand.big(
            BigInt(terms.amount!.minLamports),
            BigInt(terms.amount!.maxLamports),
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
  const delayMode = terms.endCondition !== 'time';
  // Delays come from their own stream so trade sizing never shifts timing.
  const timing = volumeRandom(seed.split('').reverse().join(''));
  const sampled = delayMode
    ? Array.from({ length: 2 * VOLUME_LIMITS.maxRounds }, () =>
        timing.int(terms.delayMinMs!, terms.delayMaxMs!),
      )
    : [];
  const amounts = roundAmounts(terms, rand, sampled);
  // Duration mode has no delay inputs: the trades are spread evenly across the
  // duration instead, so the run still ends inside it.
  const gaps = delayMode
    ? sampled
    : Array.from({ length: 2 * amounts.length }, () =>
        Math.max(1, Math.floor((terms.durationSeconds! * 1000) / (2 * amounts.length))),
      );
  const largest = amounts.reduce((a, b) => (a > b ? a : b));
  const fee = VOLUME_LIMITS.feePerTradeLamports;
  // The fee target is a whole-run tip budget, so it is split evenly per trade.
  const tradeCount = BigInt(2 * amounts.length);
  const tipTarget = terms.feeTargetLamports ? BigInt(terms.feeTargetLamports) : 0n;
  if (tipTarget && tipTarget < tradeCount)
    fail(
      `A ${tipTarget} lamport fee target cannot cover ${tradeCount} trades. Raise it or lower the round count.`,
    );
  const tipPerTrade = tipTarget ? tipTarget / tradeCount : 0n;
  const requiredPerWallet =
    largest + VOLUME_LIMITS.tokenAccountRentLamports + 2n * (fee + tipPerTrade);
  const observed = new Map(balances.map((b) => [b.address, b.lamports]));
  if (terms.wallets.some((w) => !/^\d{1,20}$/.test(observed.get(w) ?? '')))
    fail('Observe every selected wallet balance before planning.');
  const excluded = terms.wallets.filter(
    (w) => BigInt(observed.get(w)!) < requiredPerWallet,
  );
  // A wallet short of the requirement still gets a schedule so the review can
  // show the shortfall, exactly like Proxima. Only when every wallet is short
  // does the plan fall back to using them all.
  const eligible = excluded.length === terms.wallets.length
    ? terms.wallets
    : terms.wallets.filter((w) => !excluded.includes(w));

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
  const mode: VolumeMode = terms.mode ?? 'Organic';
  while (next < amounts.length) {
    let streak: number;
    if (mode === 'Bundle') {
      // One wallet per bundle: its buy and sell share a block.
      streak = 1;
    } else if (terms.waveIntensityTenths === undefined) {
      // Preserve legacy random draws and exact serialized plans.
      streak =
        terms.wave === 'tight'
          ? 1
          : rand.int(2, Math.max(2, Math.min(6, eligible.length)));
    } else {
      const cap = Math.max(1, Math.min(6, eligible.length));
      streak = 1;
      while (streak < cap && streak < amounts.length - next) {
        if (terms.waveIntensityTenths === 0) break;
        if (
          terms.waveIntensityTenths !== 10 &&
          rand.int(1, 10) > terms.waveIntensityTenths
        )
          break;
        streak++;
      }
    }
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
    // A bundle sell rides its own buy's block, so it takes the same offset and
    // must stay in the same batch as that buy.
    const bundleSell = mode === 'Bundle' && step.side === 'Sell';
    if (index && !bundleSell) offset += gaps[index - 1];
    const conflict =
      batch < 0 ||
      // Every bundle round gets its own block, so a buy always opens a batch.
      (mode === 'Bundle' && step.side === 'Buy' && batch >= 0) ||
      (!bundleSell &&
        (offset - batchStart > VOLUME_LIMITS.batchSpanMs ||
          inBatch.has(step.wallet) ||
          (step.side === 'Sell' && buyBatch.get(step.round) === batch)));
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
  // A delay schedule knows its own floor; a duration schedule is only bound by
  // the shortest spacing the runner allows between two trades.
  const minimumDurationSeconds = Math.ceil(
    ((order.length - 1) * (terms.delayMinMs ?? VOLUME_LIMITS.minDelayMs)) / 1000,
  );
  // Only a duration end condition can be overrun; a delay schedule has no
  // duration to fit inside.
  if (terms.durationSeconds !== undefined && scheduledMs > terms.durationSeconds * 1000)
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
      ...(tipTarget
        ? {
            feeTargetLamports: tipTarget.toString(),
            tipPerTradeLamports: tipPerTrade.toString(),
            tipTotalLamports: (tipPerTrade * trades).toString(),
          }
        : {}),
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
