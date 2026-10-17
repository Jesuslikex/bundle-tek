import { projectPumpHolderSequence } from './pump-holder-pricing';
import type { PumpHolderBuy } from './pump-holder-message';

/**
 * Organic/Stagger holder-buy schedule after a separately finalized create.
 * Planning only: every buy still needs its own unsigned build, fresh
 * simulation, explicit batch approval, browser-local signing and one-attempt
 * submission. Nothing here signs, sends or asserts settlement.
 */
export type PumpOrganicMode = 'Organic' | 'Stagger';
export type PumpOrganicSequenceInput = {
  mode: PumpOrganicMode;
  /** Ordered holder wallets and exact token targets. */
  buys: { address: string; tokenAmountRaw: string }[];
  /** Organic: inclusive random range. Stagger: minimum must equal maximum. */
  delayMinMs: number;
  delayMaxMs: number;
  /** Per-buy quote cap headroom over the sequential projection, in bps. */
  slippageBps: number;
  /** Signed-transaction window per approval batch; below the ~60s blockhash life. */
  batchWindowMs?: number;
  quoteMint: string;
  curve: {
    virtualTokensRaw: string;
    virtualQuoteRaw: string;
    realTokensRaw: string;
  };
  feeConfig: Record<string, unknown>;
};
export const PUMP_ORGANIC_MAX_BUYS = 200;
export const PUMP_ORGANIC_MAX_DELAY_MS = 300_000;
export const PUMP_ORGANIC_MIN_DELAY_MS = 500;
export const PUMP_ORGANIC_DEFAULT_WINDOW_MS = 45_000;
export const PUMP_ORGANIC_MAX_WINDOW_MS = 50_000;
export const PUMP_ORGANIC_MAX_SLIPPAGE_BPS = 5_000;
const U64 = (1n << 64n) - 1n;

/** Uniform integer in [min, max] by rejection sampling; no modulo bias. */
export function uniformDelay(
  min: number,
  max: number,
  random: () => number = () => crypto.getRandomValues(new Uint32Array(1))[0],
) {
  const span = max - min + 1;
  if (span === 1) return min;
  const limit = Math.floor(0x1_0000_0000 / span) * span;
  for (let attempt = 0; attempt < 64; attempt++) {
    const value = random();
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff)
      throw new Error('Random source must return unsigned 32-bit integers.');
    if (value < limit) return min + (value % span);
  }
  throw new Error('Random source did not produce an unbiased delay.');
}

const millis = (value: unknown, label: string) => {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < PUMP_ORGANIC_MIN_DELAY_MS ||
    (value as number) > PUMP_ORGANIC_MAX_DELAY_MS
  )
    throw new Error(
      `${label} must be whole milliseconds from ${PUMP_ORGANIC_MIN_DELAY_MS} to ${PUMP_ORGANIC_MAX_DELAY_MS}.`,
    );
  return value as number;
};

export function planPumpOrganicSequence(
  supplied: PumpOrganicSequenceInput,
  random?: () => number,
) {
  const input = structuredClone(supplied);
  const allowed = [
    'mode',
    'buys',
    'delayMinMs',
    'delayMaxMs',
    'slippageBps',
    'batchWindowMs',
    'quoteMint',
    'curve',
    'feeConfig',
  ];
  if (Object.keys(input).some((k) => !allowed.includes(k)))
    throw new Error('Unsupported organic sequence option.');
  if (input.mode !== 'Organic' && input.mode !== 'Stagger')
    throw new Error('Choose Organic or Stagger holder buys.');
  if (
    !Array.isArray(input.buys) ||
    !input.buys.length ||
    input.buys.length > PUMP_ORGANIC_MAX_BUYS
  )
    throw new Error(
      `Review 1 to ${PUMP_ORGANIC_MAX_BUYS} holder buys; none are dropped.`,
    );
  const seen = new Set<string>();
  for (const buy of input.buys) {
    if (
      Object.keys(buy).sort().join(',') !== 'address,tokenAmountRaw' ||
      typeof buy.address !== 'string'
    )
      throw new Error('Each holder buy needs only a wallet and token target.');
    if (seen.has(buy.address))
      throw new Error('Each holder wallet may appear once per sequence.');
    seen.add(buy.address);
  }
  const min = millis(input.delayMinMs, 'Minimum delay'),
    max = millis(input.delayMaxMs, 'Maximum delay');
  if (min > max)
    throw new Error('Minimum delay cannot exceed the maximum delay.');
  if (input.mode === 'Stagger' && min !== max)
    throw new Error('Stagger uses one fixed delay between buys.');
  if (input.mode === 'Organic' && min === max)
    throw new Error('Organic needs a delay range; use Stagger for fixed.');
  const window = input.batchWindowMs ?? PUMP_ORGANIC_DEFAULT_WINDOW_MS;
  if (
    !Number.isSafeInteger(window) ||
    window < 1_000 ||
    window > PUMP_ORGANIC_MAX_WINDOW_MS
  )
    throw new Error(
      `Batch window must be 1000 to ${PUMP_ORGANIC_MAX_WINDOW_MS} ms, inside one blockhash lifetime.`,
    );
  if (
    !Number.isSafeInteger(input.slippageBps) ||
    input.slippageBps < 0 ||
    input.slippageBps > PUMP_ORGANIC_MAX_SLIPPAGE_BPS
  )
    throw new Error(
      `Slippage must be 0 to ${PUMP_ORGANIC_MAX_SLIPPAGE_BPS} basis points.`,
    );

  // Uncapped projection first; caps are derived from it, never the reverse.
  const trades: PumpHolderBuy[] = input.buys.map((b) => ({
    address: b.address,
    kind: 'exact-base-output',
    tokenAmountRaw: b.tokenAmountRaw,
    maximumQuoteCostRaw: U64.toString(),
  }));
  const projection = projectPumpHolderSequence({
    quoteMint: input.quoteMint,
    curve: input.curve,
    feeConfig: input.feeConfig,
    trades,
  });
  const bps = BigInt(input.slippageBps);
  let offset = 0,
    batch = 0,
    batchStart = 0,
    totalCap = 0n;
  const rows = projection.rows.map((row, index) => {
    const delayMs = index === 0 ? 0 : uniformDelay(min, max, random);
    offset += delayMs;
    if (index > 0 && offset - batchStart > window) {
      batch += 1;
      batchStart = offset;
    }
    const projected = BigInt(row.projectedQuoteCostRaw);
    const cap = (projected * (10_000n + bps) + 9_999n) / 10_000n;
    if (cap > U64) throw new Error('Holder quote cap exceeds u64.');
    totalCap += cap;
    return {
      index,
      address: row.address,
      batch,
      delayMs,
      offsetMs: offset,
      batchOffsetMs: offset - batchStart,
      tokenAmountRaw: row.tokenAmountRaw,
      projectedQuoteCostRaw: row.projectedQuoteCostRaw,
      maximumQuoteCostRaw: cap.toString(),
    };
  });
  const batches = Array.from({ length: batch + 1 }, (_, n) => {
    const members = rows.filter((r) => r.batch === n);
    return {
      batch: n,
      indexes: members.map((r) => r.index),
      spanMs: members.at(-1)!.batchOffsetMs,
      maximumQuoteCostRaw: members
        .reduce((s, r) => s + BigInt(r.maximumQuoteCostRaw), 0n)
        .toString(),
    };
  });
  return {
    format: 'pump-organic-sequence-plan-v1' as const,
    mode: input.mode,
    delayMinMs: min,
    delayMaxMs: max,
    batchWindowMs: window,
    slippageBps: input.slippageBps,
    rows,
    batches,
    totalDurationMs: offset,
    totalTokenOutputRaw: projection.totalTokenOutputRaw,
    projectedQuoteCostRaw: projection.projectedQuoteCostRaw,
    maximumQuoteCostRaw: totalCap.toString(),
    finalProjectedCurve: projection.finalCurve,
    /** External trades between buys move price; only the per-buy caps bind. */
    priceMovesBetweenBuys: true as const,
    approvalRequiredPerBatch: true as const,
    simulationRequiredPerBuy: true as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
