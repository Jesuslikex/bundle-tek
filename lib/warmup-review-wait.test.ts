import { expect, it } from 'vitest';
import { warmupReviewDeadline } from './warmup-review-wait';
it('uses the remaining server wait rather than a server wall clock or another full cooldown', () => {
  expect(warmupReviewDeadline(7200, 1000000)).toBe(1007200);
  expect(warmupReviewDeadline(0, 1000000)).toBe(1000000);
  expect(warmupReviewDeadline(15000, 1000000)).toBe(1015000);
  for (const invalid of [
    undefined,
    null,
    '7200',
    -1,
    15001,
    0.5,
    NaN,
    Infinity,
  ])
    expect(() => warmupReviewDeadline(invalid, 1000000)).toThrow(
      'timing unavailable',
    );
});
