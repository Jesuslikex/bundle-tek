import { expect, it } from 'vitest';
import {
  compactUsd,
  readAge,
  shortUsdPrice,
  signedPercent,
} from './token-stats-format';

it('shortens prices, collapsing long runs of leading zeros', () => {
  expect(shortUsdPrice('1.0023')).toBe('$1.00');
  expect(shortUsdPrice('1234.5')).toBe('$1,234.50');
  expect(shortUsdPrice('0.5')).toBe('$0.5');
  expect(shortUsdPrice('0.01234')).toBe('$0.01234');
  expect(shortUsdPrice('0.00004567891')).toBe('$0.0₄4567');
  expect(shortUsdPrice('0.000000000012')).toBe('$0.0₁₀12');
  expect(shortUsdPrice('0.0000')).toBe('$0');
  expect(shortUsdPrice(null)).toBe('Unavailable');
  expect(shortUsdPrice('-1')).toBe('Unavailable');
  expect(shortUsdPrice('1e-9')).toBe('Unavailable');
});

it('formats compact dollar amounts and signed changes', () => {
  expect(compactUsd(4060)).toBe('$4.06K');
  expect(compactUsd(1_250_000)).toBe('$1.25M');
  expect(compactUsd(512)).toBe('$512');
  expect(compactUsd(null)).toBe('Unavailable');
  expect(signedPercent(12.44)).toBe('+12.4%');
  expect(signedPercent(-3)).toBe('−3.0%');
  expect(signedPercent(0)).toBe('0.0%');
  expect(signedPercent(250.4)).toBe('+250%');
  expect(signedPercent(null)).toBe('Unavailable');
});

it('describes how old a reading is', () => {
  const now = Date.parse('2026-10-15T12:00:00.000Z');
  const at = (seconds: number) => new Date(now - seconds * 1000).toISOString();
  expect(readAge(at(3), now)).toBe('just now');
  expect(readAge(at(45), now)).toBe('45s ago');
  expect(readAge(at(180), now)).toBe('3m ago');
  expect(readAge(at(7200), now)).toBe('2h ago');
  expect(readAge(at(4 * 86400), now)).toBe('4d ago');
  expect(readAge(at(-30), now)).toBe('just now');
});
