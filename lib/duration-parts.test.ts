import { expect, it } from 'vitest';
import { parseDurationParts, splitDurationSeconds } from './duration-parts';
it('converts hours, minutes and seconds exactly without changing the entered object', () => {
  const parts = { hours: '1', minutes: '2', seconds: '3' };
  expect(parseDurationParts(parts)).toEqual({ seconds: 3723, error: '' });
  expect(parts).toEqual({ hours: '1', minutes: '2', seconds: '3' });
  expect(parseDurationParts({ hours: '', minutes: '1', seconds: '' })).toEqual({
    seconds: 60,
    error: '',
  });
});
it('accepts the existing inclusive one-second and 24-hour interval boundaries', () => {
  expect(
    parseDurationParts({ hours: '', minutes: '', seconds: '1' }, 86400).seconds,
  ).toBe(1);
  expect(
    parseDurationParts({ hours: '24', minutes: '0', seconds: '0' }, 86400)
      .seconds,
  ).toBe(86400);
  expect(
    parseDurationParts({ hours: '24', minutes: '0', seconds: '1' }, 86400)
      .seconds,
  ).toBeNull();
});
it('roundtrips all safe boundary totals using exact integer arithmetic', () => {
  for (const value of [
    0,
    1,
    59,
    60,
    3599,
    3600,
    86399,
    86400,
    Number.MAX_SAFE_INTEGER,
  ]) {
    const parts = splitDurationSeconds(value);
    if (value === 0) expect(parseDurationParts(parts).seconds).toBeNull();
    else expect(parseDurationParts(parts).seconds).toBe(value);
  }
});
for (const [label, parts] of [
  ['empty', { hours: '', minutes: '', seconds: '' }],
  ['zero', { hours: '0', minutes: '0', seconds: '0' }],
  ['minutes over59', { hours: '0', minutes: '60', seconds: '0' }],
  ['seconds over59', { hours: '0', minutes: '0', seconds: '60' }],
  ['negative', { hours: '-1', minutes: '0', seconds: '0' }],
  ['fraction', { hours: '0', minutes: '0', seconds: '1.5' }],
  ['exponent', { hours: '1e3', minutes: '0', seconds: '0' }],
  ['whitespace', { hours: ' 1', minutes: '0', seconds: '0' }],
  ['too large', { hours: '9999999999999999', minutes: '0', seconds: '0' }],
  ['oversized text', { hours: '1'.repeat(17), minutes: '0', seconds: '0' }],
] as const)
  it(`refuses ${label} without normalization`, () => {
    expect(parseDurationParts(parts).seconds).toBeNull();
    expect(parseDurationParts(parts).error).not.toBe('');
  });
it('rejects invalid programmatic bounds and invalid totals rather than truncating', () => {
  for (const n of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
    expect(() =>
      parseDurationParts({ hours: '0', minutes: '1', seconds: '0' }, n),
    ).toThrow();
  for (const n of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
    expect(() => splitDurationSeconds(n)).toThrow();
});
