import { expect, it } from 'vitest';
import {
  defaultTradeAmountPresets,
  requireTradeAmountPresets,
  presetPercentToBps,
  presetPercentLabel,
  requireTradeAmountPreferenceView,
  defaultTradePresetKeyboard,
} from './trade-amount-preferences';
it('retains v1 records and validates canonical unique v2 key maps without activation or authority', () => {
  const legacy = defaultTradeAmountPresets();
  expect(requireTradeAmountPresets(legacy)).toEqual(legacy);
  const keyboard = defaultTradePresetKeyboard();
  const next = { ...legacy, format: 'trade-amount-presets-v2', keyboard };
  expect(requireTradeAmountPresets(next)).toEqual(next);
  expect(
    requireTradeAmountPresets({
      ...next,
      keyboard: { ...keyboard, buy: Array(8).fill('') },
    }).keyboard?.buy,
  ).toEqual(Array(8).fill(''));
  for (const invalid of [
    { ...next, keyboard: { ...keyboard, enabled: true } },
    { ...next, keyboard: { ...keyboard, buy: 'q2345678'.split('') } },
    { ...next, keyboard: { ...keyboard, buy: 'Q2345678'.split('') } },
    { ...next, keyboard: { ...keyboard, buy: ['Control+1'] } },
    { ...next, keyboard: { ...keyboard, buy: '!2345678'.split('') } },
    { ...next, keyboard: { ...keyboard, buy: '1234567'.split('') } },
    { ...legacy, keyboard },
    { ...next, format: 'trade-amount-presets-v3' },
  ])
    expect(() => requireTradeAmountPresets(invalid)).toThrow();
});
it('preserves existing Bundle defaults and canonicalizes exact native atoms without floating point', () => {
  const defaults = defaultTradeAmountPresets();
  expect(defaults).toEqual({
    format: 'trade-amount-presets-v1',
    buySol: ['0.01'],
    sellBalanceBps: [2500, 5000, 7500, 10000],
    sellSupplyBps: [10, 50, 100, 500],
  });
  expect(
    requireTradeAmountPresets({
      ...defaults,
      buySol: ['0.010', '0.000000001', '18446744073.709551615'],
    }).buySol,
  ).toEqual(['0.01', '0.000000001', '18446744073.709551615']);
});
it('rejects unknown authority/secret fields, duplicate normalized values, precision loss and unbounded lists', () => {
  const d = defaultTradeAmountPresets();
  for (const v of [
    { ...d, executionAllowed: true },
    { ...d, privateKey: 'unused' },
    { ...d, buySol: ['0.01', '0.010'] },
    { ...d, buySol: ['0'] },
    { ...d, buySol: ['1e-3'] },
    { ...d, buySol: ['0.0000000001'] },
    { ...d, buySol: ['18446744073.709551616'] },
    { ...d, buySol: Array(9).fill('1') },
    { ...d, sellBalanceBps: [0] },
    { ...d, sellSupplyBps: [10001] },
    { ...d, sellBalanceBps: [12.5] },
    { ...d, sellSupplyBps: [10, 10] },
  ])
    expect(() => requireTradeAmountPresets(v)).toThrow();
});
it('converts percentage text exactly and keeps supply/balance units explicit', () => {
  for (const [text, bps] of [
    ['0.01', 1],
    ['1.25', 125],
    ['100', 10000],
  ] as const) {
    expect(presetPercentToBps(text)).toBe(bps);
    expect(presetPercentLabel(bps)).toBe(text + '%');
  }
  for (const invalid of [
    '0',
    '100.01',
    '01',
    '1e2',
    '1.001',
    'NaN',
    '-1',
    ' 1',
  ])
    expect(() => presetPercentToBps(invalid)).toThrow();
});
it('binds responses to the active account and refuses hidden fields and invalid revisions', () => {
  const v = {
    ownerId: 'owner',
    revision: 0,
    preferences: defaultTradeAmountPresets(),
    updatedAt: null,
  };
  expect(requireTradeAmountPreferenceView(v, 'owner')).toEqual(v);
  for (const changed of [
    { ...v, ownerId: 'other' },
    { ...v, revision: 1 },
    { ...v, wallet: 'unused' },
    { ...v, revision: -1 },
  ])
    expect(() => requireTradeAmountPreferenceView(changed, 'owner')).toThrow();
});
