import type { LaunchPlanInput } from './launch-plan';
import { venueLaunchMethods } from './launch-methods';
import { LAUNCH_TIMING_LIMITS } from './launch-timing-limits';
export type LaunchTiming = { buyDelayMs: number; initialBuyDelayMs: number };
export const ZERO_LAUNCH_TIMING: LaunchTiming = {
  buyDelayMs: 0,
  initialBuyDelayMs: 0,
};

export function parseLaunchTiming(value: unknown): LaunchTiming | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid launch timing.');
  const raw = value as LaunchTiming;
  if (
    !Number.isSafeInteger(raw.buyDelayMs) ||
    raw.buyDelayMs < 0 ||
    raw.buyDelayMs > 60000
  )
    throw new Error('Buy delay must be whole milliseconds from 0 to 60000.');
  // Local storage bound, not a captured venue maximum.
  if (
    !Number.isSafeInteger(raw.initialBuyDelayMs) ||
    raw.initialBuyDelayMs < 0 ||
    raw.initialBuyDelayMs > 86400000
  )
    throw new Error(
      'Initial buy delay must be whole milliseconds from 0 to 86400000.',
    );
  return {
    buyDelayMs: raw.buyDelayMs,
    initialBuyDelayMs: raw.initialBuyDelayMs,
  };
}
export function launchTimingBounds(
  plan: Pick<LaunchPlanInput, 'chain' | 'launchpad' | 'mode'>,
) {
  const limits = LAUNCH_TIMING_LIMITS[`${plan.chain}/${plan.launchpad}`];
  const profile = venueLaunchMethods(plan.chain, plan.launchpad);
  return {
    minMs:
      plan.mode === 'Stagger'
        ? (limits?.staggerMinMs ?? 0)
        : plan.mode === 'Block-0'
          ? (limits?.sequencedMinMs ?? 0)
          : 0,
    maxMs:
      plan.mode === 'Stagger'
        ? (limits?.staggerMaxMs ?? 0)
        : plan.mode === 'Block-0'
          ? (limits?.sequencedMaxMs ?? 0)
          : 0,
    initialEnabled:
      profile.captured &&
      profile.initialBuyDelayMs !== null &&
      plan.mode !== 'Manual',
    initialSuggestedMs: profile.initialBuyDelayMs,
    captured: !!limits,
  };
}
export function validateLaunchTiming(
  plan: Pick<LaunchPlanInput, 'chain' | 'launchpad' | 'mode' | 'timing'>,
) {
  const timing = parseLaunchTiming(plan.timing);
  if (!timing) return;
  const bounds = launchTimingBounds(plan);
  if (timing.buyDelayMs < bounds.minMs || timing.buyDelayMs > bounds.maxMs)
    throw new Error(
      `${plan.launchpad} ${plan.mode} buy delay must be ${bounds.minMs} to ${bounds.maxMs} ms.`,
    );
  if (!bounds.initialEnabled && timing.initialBuyDelayMs !== 0)
    throw new Error(
      'Initial buy delay is unavailable for this venue and method.',
    );
}
export function timingAfterPlanChange(
  current: LaunchPlanInput,
  change: Partial<LaunchPlanInput>,
  mode: LaunchPlanInput['mode'],
) {
  if ('timing' in change) return change.timing;
  if (
    change.chain === undefined &&
    change.launchpad === undefined &&
    change.mode === undefined
  )
    return current.timing;
  const timing = { ...(current.timing ?? ZERO_LAUNCH_TIMING) };
  const bounds = launchTimingBounds({ ...current, ...change, mode });
  if (bounds.maxMs === 0) timing.buyDelayMs = 0;
  if (!bounds.initialEnabled) timing.initialBuyDelayMs = 0;
  return current.timing || timing.buyDelayMs || timing.initialBuyDelayMs
    ? timing
    : undefined;
}
