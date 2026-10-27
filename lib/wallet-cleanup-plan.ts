/**
 * Proxima's cleanup contract, copied verbatim.
 *
 * Proxima's form (launch page → Cleanup → Configure) posts:
 *   { input_wallet_pubkeys, output_wallet_pubkeys, min_delay_ms, max_delay_ms,
 *     double_buy_pct, fake_tip_pct }
 * with the same validation order and copy as the bundle. The form label for
 * `fake_tip_pct` is "Alternative Routing"; the wire key stays `fake_tip_pct`.
 */

export const CLEANUP_MIN_DELAY_MS = 500;
export const CLEANUP_MAX_DELAY_MS = 300_000;
export const CLEANUP_DEFAULT_DELAY_MS = 16_000;
export const CLEANUP_DEFAULT_MAX_DELAY_MS = 25_000;

export type CleanupDelayMode = 'Fixed' | 'Random';

export type CleanupPlan = {
  inputWalletPubkeys: string[];
  outputWalletPubkeys: string[];
  minDelayMs: number;
  maxDelayMs: number;
  doubleBuyPct: number;
  fakeTipPct: number;
};

export type CleanupPayload = {
  input_wallet_pubkeys: string[];
  output_wallet_pubkeys: string[];
  min_delay_ms: number;
  max_delay_ms: number;
  double_buy_pct: number;
  fake_tip_pct: number;
};

/** Proxima floors both percentages and treats an empty field as zero. */
export const cleanupPercent = (value: unknown) => {
  const number = Math.floor(Number(value) || 0);
  return Number.isFinite(number) ? number : 0;
};

/** MIN:SEC pair to milliseconds. Empty fields count as zero, like Proxima. */
export function cleanupDelayMs(minutes: unknown, seconds: unknown) {
  const m = Math.max(0, Math.floor(Number(minutes) || 0));
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return (m * 60 + s) * 1000;
}

/** Milliseconds back to the MIN:SEC pair the two inputs render. */
export function cleanupDelayParts(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return { minutes: Math.floor(total / 60), seconds: total % 60 };
}

/**
 * Proxima's `W()` builder: same checks, same order, same sentences, same key
 * order. Throws the first failure so the panel can show it verbatim.
 */
export function cleanupPayload(plan: CleanupPlan): CleanupPayload {
  const minDelayMs = Number(plan.minDelayMs);
  const maxDelayMs = Number(plan.maxDelayMs);
  if (!Number.isFinite(minDelayMs) || minDelayMs < CLEANUP_MIN_DELAY_MS)
    throw new Error('Min delay must be at least 0.5 seconds');
  if (!Number.isFinite(maxDelayMs) || maxDelayMs > CLEANUP_MAX_DELAY_MS)
    throw new Error('Max delay cannot exceed 300 seconds');
  if (minDelayMs > maxDelayMs)
    throw new Error('Min delay cannot be greater than max delay');
  if (!plan.inputWalletPubkeys.length)
    throw new Error('Please select at least one input wallet (seller)');
  if (!plan.outputWalletPubkeys.length)
    throw new Error('Please select at least one output wallet (buyer)');
  const doubleBuyPct = cleanupPercent(plan.doubleBuyPct);
  if (doubleBuyPct < 0 || doubleBuyPct > 100)
    throw new Error('Double buy percentage must be between 0 and 100');
  const fakeTipPct = cleanupPercent(plan.fakeTipPct);
  if (fakeTipPct < 0 || fakeTipPct > 100)
    throw new Error('Fake tip percentage must be between 0 and 100');
  return {
    input_wallet_pubkeys: [...plan.inputWalletPubkeys],
    output_wallet_pubkeys: [...plan.outputWalletPubkeys],
    min_delay_ms: minDelayMs,
    max_delay_ms: maxDelayMs,
    double_buy_pct: doubleBuyPct,
    fake_tip_pct: fakeTipPct,
  };
}

/** Read the wire payload back into the panel's plan shape. */
export function cleanupPlan(value: CleanupPayload): CleanupPlan {
  return {
    inputWalletPubkeys: [...value.input_wallet_pubkeys],
    outputWalletPubkeys: [...value.output_wallet_pubkeys],
    minDelayMs: value.min_delay_ms,
    maxDelayMs: value.max_delay_ms,
    doubleBuyPct: value.double_buy_pct,
    fakeTipPct: value.fake_tip_pct,
  };
}

/**
 * One cleanup round per input wallet, paired round-robin onto the buyers, so a
 * short buyer list is reused instead of leaving sellers behind.
 */
export function cleanupRounds(
  inputWalletPubkeys: string[],
  outputWalletPubkeys: string[],
) {
  if (!outputWalletPubkeys.length) return [];
  return inputWalletPubkeys.map((seller, index) => ({
    round: index + 1,
    seller,
    buyer: outputWalletPubkeys[index % outputWalletPubkeys.length],
  }));
}

/** Deterministic delay for a round: fixed uses min, random walks min..max. */
export function cleanupRoundDelay(
  mode: CleanupDelayMode,
  minDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
) {
  if (mode === 'Fixed' || maxDelayMs <= minDelayMs) return minDelayMs;
  const span = maxDelayMs - minDelayMs;
  return minDelayMs + Math.round(random() * span);
}
