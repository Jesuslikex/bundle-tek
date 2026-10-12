import type { ImportedSwapBalance } from './imported-swap-balance';
import { formatNativeBalance } from './wallet-balance-format';
export type ImportedBalanceContext = {
  wallet: string;
  mint: string;
  tokenDecimals: number;
  side: 'Buy' | 'Sell';
  requestedRaw: string;
};
const u64 = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^(0|[1-9]\d{0,19})$/.test(v) &&
  BigInt(v) <= (1n << 64n) - 1n;
const slot = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0;
const extensions = (v: unknown): v is string[] =>
  Array.isArray(v) &&
  v.length <= 64 &&
  v.every((x) => typeof x === 'string' && x.length <= 256);
export function validatedImportedBalance(
  value: unknown,
  context: ImportedBalanceContext,
  now = Date.now(),
): ImportedSwapBalance {
  const r = value as ImportedSwapBalance;
  if (
    !r ||
    r.executionAllowed !== false ||
    (r.inventoryScope !== undefined && r.inventoryScope !== 'mint') ||
    r.wallet !== context.wallet ||
    r.mint !== context.mint ||
    r.side !== context.side ||
    !Number.isInteger(context.tokenDecimals) ||
    context.tokenDecimals < 0 ||
    context.tokenDecimals > 255 ||
    r.decimals !== (context.side === 'Buy' ? 9 : context.tokenDecimals) ||
    !u64(context.requestedRaw) ||
    context.requestedRaw === '0' ||
    r.requestedRaw !== context.requestedRaw ||
    ![
      r.nativeRaw,
      r.tokenRaw,
      r.frozenRaw,
      r.unfrozenRaw,
      r.shortfallRaw,
    ].every(u64) ||
    typeof r.amountCovered !== 'boolean' ||
    typeof r.preparationSupported !== 'boolean' ||
    typeof r.token2022 !== 'boolean' ||
    !extensions(r.blockedExtensions) ||
    (r.mintExtensions !== null && !extensions(r.mintExtensions)) ||
    (r.preparationSupported && r.blockedExtensions.length > 0) ||
    !slot(r.minSlot) ||
    !slot(r.maxSlot) ||
    r.maxSlot < r.minSlot ||
    r.maxSlot - r.minSlot > 64 ||
    (r.mintSlot !== null &&
      (!slot(r.mintSlot) ||
        r.mintSlot < r.maxSlot ||
        r.mintSlot - r.minSlot > 64)) ||
    (r.nativeSlot !== undefined &&
      (!slot(r.nativeSlot) ||
        r.nativeSlot < (r.mintSlot ?? r.maxSlot) ||
        r.nativeSlot - r.minSlot > 64)) ||
    typeof r.source !== 'string' ||
    !/^[a-zA-Z0-9.-]{1,253}$/.test(r.source) ||
    typeof r.limitations !== 'string' ||
    r.limitations.length > 2048 ||
    typeof r.observedAt !== 'string' ||
    typeof r.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(r.observedAt)) ||
    Date.parse(r.observedAt) > now + 1000 ||
    Date.parse(r.expiresAt) !== Date.parse(r.observedAt) + 60000
  )
    throw new Error('Balance report does not match this trade review.');
  const required = BigInt(r.requestedRaw),
    available = BigInt(context.side === 'Buy' ? r.nativeRaw : r.unfrozenRaw);
  if (
    BigInt(r.frozenRaw) + BigInt(r.unfrozenRaw) !== BigInt(r.tokenRaw) ||
    r.amountCovered !== required <= available ||
    r.shortfallRaw !==
      (required > available ? required - available : 0n).toString()
  )
    throw new Error('Balance inventory or coverage differs.');
  return r;
}
export const IMPORTED_SELL_PERCENTAGES = [25, 50, 75, 100] as const;
export const IMPORTED_SUPPLY_SELL_PRESETS = [
  { basisPoints: 10, label: '0.1%' },
  { basisPoints: 50, label: '0.5%' },
  { basisPoints: 100, label: '1%' },
  { basisPoints: 500, label: '5%' },
] as const;
export type ImportedSellSupply = {
  mint: string;
  decimals: number;
  totalSupplyRaw: string;
  observedAt: string;
};
export function importedSupplySellAmount(
  report: ImportedSwapBalance,
  context: ImportedBalanceContext,
  supply: ImportedSellSupply,
  basisPoints: number,
  now = Date.now(),
) {
  const r = validatedImportedBalance(report, context, now);
  if (
    r.side !== 'Sell' ||
    !r.preparationSupported ||
    Date.parse(r.expiresAt) <= now ||
    !IMPORTED_SUPPLY_SELL_PRESETS.some((p) => p.basisPoints === basisPoints) ||
    supply.mint !== context.mint ||
    supply.decimals !== context.tokenDecimals ||
    !u64(supply.totalSupplyRaw) ||
    supply.totalSupplyRaw === '0' ||
    typeof supply.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(supply.observedAt)) ||
    Date.parse(supply.observedAt) > now + 1000
  )
    throw new Error(
      'Valid saved supply and fresh supported sell inventory required.',
    );
  const units = (BigInt(supply.totalSupplyRaw) * BigInt(basisPoints)) / 10000n;
  if (units === 0n)
    throw new Error('Supply percentage is smaller than one atomic unit.');
  if (units > BigInt(r.unfrozenRaw))
    throw new Error('Supply percentage exceeds observed unfrozen holdings.');
  return formatNativeBalance(units.toString(), context.tokenDecimals);
}
export function importedSellPercentage(
  report: ImportedSwapBalance,
  context: ImportedBalanceContext,
  percent: number,
  now = Date.now(),
) {
  const r = validatedImportedBalance(report, context, now);
  if (
    r.side !== 'Sell' ||
    !IMPORTED_SELL_PERCENTAGES.some((p) => p === percent) ||
    !r.preparationSupported ||
    Date.parse(r.expiresAt) <= now
  )
    throw new Error('Fresh supported sell inventory required.');
  const units = (BigInt(r.unfrozenRaw) * BigInt(percent)) / 100n;
  if (units === 0n)
    throw new Error('Percentage is smaller than one atomic unit.');
  return formatNativeBalance(units.toString(), context.tokenDecimals);
}
