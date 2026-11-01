import { describe, expect, it } from 'vitest';
import {
  BUBBLE_CLEAN_DELAY_MS,
  MEV_SLIDER_MAX,
  MEV_SLIDER_MIN,
  bubbleCleanliness,
  bubbleMapEstimate,
  durationPosition,
  durationText,
  mevSliderPosition,
  supplyCostPosition,
  supplyCostText,
} from './bubble-map-estimate';

describe('mev slider position', () => {
  it('maps the captured bounds to the ends of the track', () => {
    expect(mevSliderPosition(MEV_SLIDER_MIN)).toBe(0);
    expect(mevSliderPosition(MEV_SLIDER_MAX)).toBe(1);
  });

  it('puts the default of 1 at the midpoint', () => {
    expect(mevSliderPosition(1)).toBeCloseTo(0.5, 10);
  });

  it('clamps beyond the bounds', () => {
    expect(mevSliderPosition(0)).toBe(0);
    expect(mevSliderPosition(9)).toBe(1);
  });

  it('treats a missing slider as the left end', () => {
    expect(mevSliderPosition(null)).toBe(0);
    expect(mevSliderPosition(undefined)).toBe(0);
  });
});

describe('duration text', () => {
  it('renders sub-minute, minute and hour scales', () => {
    expect(durationText(0)).toBe('0s');
    expect(durationText(null)).toBe('0s');
    expect(durationText(5000)).toBe('5s');
    expect(durationText(90_000)).toBe('1m 30s');
    expect(durationText(3_723_000)).toBe('1h 2m 3s');
  });

  it('omits zero components', () => {
    expect(durationText(3_600_000)).toBe('1h');
    expect(durationText(60_000)).toBe('1m');
  });
});

describe('duration position', () => {
  it('uses the narrow denominator up to the switch point', () => {
    expect(durationPosition(0)).toBe(0);
    expect(durationPosition(1_641_000)).toBeCloseTo(0.5, 10);
  });

  it('switches to the wide denominator past it', () => {
    expect(durationPosition(7_460_000)).toBeCloseTo(0.5, 10);
    expect(durationPosition(99_999_999)).toBe(1);
  });

  it('treats a missing duration as the left end', () => {
    expect(durationPosition(null)).toBe(0);
  });
});

describe('supply cost', () => {
  it('tracks basis points against 727', () => {
    expect(supplyCostPosition(0)).toBe(0);
    expect(supplyCostPosition(363.5)).toBeCloseTo(0.5, 10);
    expect(supplyCostPosition(727)).toBe(1);
    expect(supplyCostPosition(9999)).toBe(1);
    expect(supplyCostPosition(null)).toBe(0);
  });

  it('converts basis points of supply to a percentage', () => {
    // Locale-aware, so compare against the locale rendering.
    const pct = (value: number) =>
      `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
    expect(supplyCostText(50, 100)).toBe(pct(0.5));
    expect(supplyCostText(100, 250)).toBe(pct(2.5));
  });

  it('is an em dash without a usable supply or cost', () => {
    expect(supplyCostText(0, 100)).toBe('—');
    expect(supplyCostText(50, null)).toBe('—');
    expect(supplyCostText(50, undefined)).toBe('—');
  });
});

describe('cleanliness', () => {
  it('is clean only at or above the captured threshold', () => {
    expect(bubbleCleanliness(BUBBLE_CLEAN_DELAY_MS)).toEqual({
      firstHalf: true,
      secondHalf: true,
      label: 'Likely clean',
    });
    expect(bubbleCleanliness(BUBBLE_CLEAN_DELAY_MS - 1).label).toBe(
      'Uncertain',
    );
    expect(bubbleCleanliness(BUBBLE_CLEAN_DELAY_MS - 1).secondHalf).toBe(false);
  });

  it('always fills the first half', () => {
    expect(bubbleCleanliness(0).firstHalf).toBe(true);
    expect(bubbleCleanliness(null).firstHalf).toBe(true);
  });
});

describe('bubble map estimate', () => {
  it('renders supply cost, detection and cleanup in that order', () => {
    expect(bubbleMapEstimate({}).cards.map((c) => c.label)).toEqual([
      'Supply Cost',
      'Detection Mode',
      'Cleanup Time',
    ]);
  });

  it('omits detection mode when hidden', () => {
    expect(
      bubbleMapEstimate({ showDetectionMode: false }).cards.map((c) => c.label),
    ).toEqual(['Supply Cost', 'Cleanup Time']);
  });

  it('keeps detection mode as an indicator with no number', () => {
    const card = bubbleMapEstimate({ mevSlider: 1 }).cards[1];
    expect(card.value).toBe('');
    expect(card.position).toBeCloseTo(0.5, 10);
  });

  it('carries the captured axis labels', () => {
    const cards = bubbleMapEstimate({}).cards;
    expect(cards[0].leftLabel).toBe('Low');
    expect(cards[1].leftLabel).toBe('Less Sniper');
    expect(cards[2].rightLabel).toBe('Longest');
  });

  it('reports cleanliness from the buy delay', () => {
    expect(bubbleMapEstimate({ buyDelayMs: 20_000 }).cleanliness.label).toBe(
      'Likely clean',
    );
    expect(bubbleMapEstimate({}).cleanliness.label).toBe('Uncertain');
  });
});
