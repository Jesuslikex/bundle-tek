// Recovered from the captured launch page (`page-Q373Hn5K.js`). These are the
// four read-only "Bubble Maps" metric cards the reference renders in MEV mode;
// none of them is an input.
//
// The slider is a preset multiplier, not a percentage: the entry bundle exports
// SLIDER_MIN = 0.4 and SLIDER_MAX = 1.6 with SLIDER_DEFAULT = 1, and the capture
// maps it with (v - SLIDER_MIN) / (SLIDER_MAX - SLIDER_MIN).
export const MEV_SLIDER_MIN = 0.4;
export const MEV_SLIDER_MAX = 1.6;
// The capture fills the cleanliness second half at or above this buy delay.
export const BUBBLE_CLEAN_DELAY_MS = 16_000;
// Position denominators the capture uses verbatim.
const SUPPLY_COST_POSITION_BPS = 727;
const DURATION_POSITION_MS = 3_282_000;
const DURATION_POSITION_WIDE_MS = 14_920_000;

const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);
const finite = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

export function mevSliderPosition(slider: number | null | undefined) {
  if (slider === null || slider === undefined) return 0;
  return clamp01(
    (finite(slider) - MEV_SLIDER_MIN) / (MEV_SLIDER_MAX - MEV_SLIDER_MIN),
  );
}

// "0s", "{n}s" under a minute, else a space-joined "{h}h {m}m {s}s".
export function durationText(ms: number | null | undefined) {
  if (ms === null || ms === undefined || ms === 0) return '0s';
  const seconds = finite(ms) / 1000;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = Math.round(seconds % 60);
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (rest > 0) parts.push(`${rest}s`);
  return parts.join(' ');
}

export function durationPosition(ms: number | null | undefined) {
  if (ms === null || ms === undefined) return 0;
  const value = finite(ms);
  // Past the first range the capture switches to the wider denominator.
  return value > DURATION_POSITION_MS
    ? clamp01(value / DURATION_POSITION_WIDE_MS)
    : clamp01(value / DURATION_POSITION_MS);
}

export function supplyCostPosition(bps: number | null | undefined) {
  if (bps === null || bps === undefined) return 0;
  return clamp01(finite(bps) / SUPPLY_COST_POSITION_BPS);
}

// Basis points of the holder supply, so the value is a percentage of supply.
// The capture returns an em dash when the supply is unset or non-positive.
// `localeStringVariableDigits` is approximated with a two-decimal locale number.
export function supplyCostText(
  supplyPercent: number | null | undefined,
  bps: number | null | undefined,
) {
  const supply = finite(supplyPercent);
  if (bps === null || bps === undefined || supply <= 0) return '—';
  const percent = (supply * finite(bps)) / 100 / 100;
  return `${percent.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

export function bubbleCleanliness(delayMs: number | null | undefined) {
  return finite(delayMs) >= BUBBLE_CLEAN_DELAY_MS
    ? { firstHalf: true, secondHalf: true, label: 'Likely clean' }
    : { firstHalf: true, secondHalf: false, label: 'Uncertain' };
}

export type BubbleCard = {
  label: string;
  value: string;
  position: number;
  leftLabel: string;
  rightLabel: string;
};

export type BubbleMapInput = {
  buyDelayMs?: number | null;
  mevSlider?: number | null;
  supplyPercent?: number | null;
  supplyCostBps?: number | null;
  estimatedDurationMs?: number | null;
  // The reference hides Detection Mode for some venues.
  showDetectionMode?: boolean;
};

// Cards render in this fixed order: Supply Cost, [Detection Mode], Cleanup Time.
export function bubbleMapEstimate(input: BubbleMapInput) {
  const cards: BubbleCard[] = [
    {
      label: 'Supply Cost',
      value: supplyCostText(input.supplyPercent, input.supplyCostBps),
      position: supplyCostPosition(input.supplyCostBps),
      leftLabel: 'Low',
      rightLabel: 'High',
    },
  ];
  if (input.showDetectionMode !== false)
    cards.push({
      label: 'Detection Mode',
      // Detection Mode is an indicator, never a number.
      value: '',
      position: mevSliderPosition(input.mevSlider),
      leftLabel: 'Less Sniper',
      rightLabel: 'Less Top Traders',
    });
  cards.push({
    label: 'Cleanup Time',
    value: durationText(input.estimatedDurationMs),
    position: durationPosition(input.estimatedDurationMs),
    leftLabel: 'Fastest',
    rightLabel: 'Longest',
  });
  return {
    cleanliness: bubbleCleanliness(input.buyDelayMs),
    cards,
  };
}
