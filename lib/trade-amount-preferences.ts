import { solanaTokenAtoms } from './solana-token-amount';
import { formatNativeBalance } from './wallet-balance-format';
import {
  IMPORTED_SELL_PERCENTAGES,
  IMPORTED_SUPPLY_SELL_PRESETS,
} from './imported-balance-review';
export type TradeAmountPresets = {
  format: 'trade-amount-presets-v1' | 'trade-amount-presets-v2';
  buySol: string[];
  sellBalanceBps: number[];
  sellSupplyBps: number[];
  keyboard?: TradePresetKeyboard;
};
export type TradePresetKeyboard = {
  buy: string[];
  sellBalance: string[];
  sellSupply: string[];
};
export function defaultTradePresetKeyboard(): TradePresetKeyboard {
  return {
    buy: '12345678'.split(''),
    sellBalance: 'qwertyui'.split(''),
    sellSupply: 'asdfghjk'.split(''),
  };
}
export function requireTradePresetKeyboard(
  value: unknown,
): TradePresetKeyboard {
  presetKeys(value, 'buy,sellBalance,sellSupply');
  const v = value as TradePresetKeyboard;
  const all: string[] = [];
  for (const list of [v.buy, v.sellBalance, v.sellSupply]) {
    if (
      !Array.isArray(list) ||
      list.length !== 8 ||
      list.some((key) => typeof key !== 'string' || !/^[a-z0-9]?$/.test(key))
    )
      throw Error(
        'Use eight key positions per list, with one lowercase letter or digit, or blank.',
      );
    all.push(...list.filter(Boolean));
  }
  if (new Set(all).size !== all.length)
    throw Error('Each preset key must be unique across buy and sell lists.');
  return {
    buy: [...v.buy],
    sellBalance: [...v.sellBalance],
    sellSupply: [...v.sellSupply],
  };
}
export const tradePresetKeyboard = (p: TradeAmountPresets) =>
  p.keyboard ?? defaultTradePresetKeyboard();
const fail = (): never => {
  throw Error('Choose 1 to 8 distinct positive presets for each amount type.');
};
export function presetKeys(value: unknown, keys: string) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== keys
  )
    fail();
}
export function defaultTradeAmountPresets(): TradeAmountPresets {
  return {
    format: 'trade-amount-presets-v1',
    buySol: ['0.01'],
    sellBalanceBps: IMPORTED_SELL_PERCENTAGES.map((p) => p * 100),
    sellSupplyBps: IMPORTED_SUPPLY_SELL_PRESETS.map((p) => p.basisPoints),
  };
}
export function requireTradeAmountPresets(value: unknown): TradeAmountPresets {
  const extended =
    (value as TradeAmountPresets | null)?.format === 'trade-amount-presets-v2';
  presetKeys(
    value,
    extended
      ? 'buySol,format,keyboard,sellBalanceBps,sellSupplyBps'
      : 'buySol,format,sellBalanceBps,sellSupplyBps',
  );
  const v = value as TradeAmountPresets;
  if (!extended && v.format !== 'trade-amount-presets-v1') fail();
  const keyboard = extended
    ? requireTradePresetKeyboard(v.keyboard)
    : undefined;
  for (const list of [v.buySol, v.sellBalanceBps, v.sellSupplyBps])
    if (!Array.isArray(list) || list.length < 1 || list.length > 8) fail();
  const buySol = v.buySol.map((amount) => {
    if (typeof amount !== 'string' || amount.length > 40) fail();
    const raw = solanaTokenAtoms(amount, 9);
    if (raw <= 0n || raw > (1n << 64n) - 1n) fail();
    return formatNativeBalance(raw.toString(), 9);
  });
  for (const list of [v.sellBalanceBps, v.sellSupplyBps])
    if (
      list.some((n) => !Number.isSafeInteger(n) || n < 1 || n > 10000) ||
      new Set(list).size !== list.length
    )
      fail();
  if (new Set(buySol).size !== buySol.length) fail();
  return {
    format: v.format,
    buySol,
    sellBalanceBps: [...v.sellBalanceBps],
    sellSupplyBps: [...v.sellSupplyBps],
    ...(keyboard ? { keyboard } : {}),
  };
}
export function presetPercentToBps(value: string) {
  if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,2})?$/.test(value))
    throw Error(
      'Use percentages from 0.01 to 100, with up to two decimal places.',
    );
  const [whole, fraction = ''] = value.split('.');
  const bps = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (bps < 1n || bps > 10000n)
    throw Error('Use percentages from 0.01 to 100.');
  return Number(bps);
}
export function presetPercentLabel(bps: number) {
  if (!Number.isInteger(bps) || bps < 1 || bps > 10000) fail();
  return formatNativeBalance(String(bps), 2) + '%';
}
export type TradeAmountPreferenceView = {
  ownerId: string;
  revision: number;
  preferences: TradeAmountPresets;
  updatedAt: string | null;
};
export function requireTradeAmountPreferenceView(
  value: unknown,
  ownerId: string,
): TradeAmountPreferenceView {
  presetKeys(value, 'ownerId,preferences,revision,updatedAt');
  const v = value as TradeAmountPreferenceView;
  if (
    !ownerId ||
    v.ownerId !== ownerId ||
    !Number.isSafeInteger(v.revision) ||
    v.revision < 0 ||
    v.revision > 1e9 ||
    (v.revision === 0
      ? v.updatedAt !== null
      : typeof v.updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(v.updatedAt)) ||
        new Date(v.updatedAt).toISOString() !== v.updatedAt)
  )
    throw Error(
      'Saved presets belong to a different or unavailable account. Reload presets.',
    );
  const preferences = requireTradeAmountPresets(v.preferences);
  if (JSON.stringify(preferences) !== JSON.stringify(v.preferences))
    throw Error('Saved preset response differs. Reload presets.');
  return { ownerId, revision: v.revision, preferences, updatedAt: v.updatedAt };
}
