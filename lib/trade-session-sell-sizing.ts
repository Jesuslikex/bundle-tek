import {
  validatedInventoryItems,
  type ImportedWalletInventory,
} from './imported-wallet-inventory';
import { formatNativeBalance } from './wallet-balance-format';
import { solanaTokenAtoms } from './solana-token-amount';
import {
  IMPORTED_SUPPLY_SELL_PRESETS,
  type ImportedSellSupply,
} from './imported-balance-review';
export function sizeSessionSupplyPercentage(
  items: ImportedWalletInventory[],
  wallets: Array<{ address: string; revision: number }>,
  supply: ImportedSellSupply,
  basisPoints: number,
  now: number,
  minimumTimes: ReadonlyMap<string, number> = new Map(),
) {
  if (
    !IMPORTED_SUPPLY_SELL_PRESETS.some((p) => p.basisPoints === basisPoints) ||
    !/^[1-9]\d{0,19}$/.test(supply.totalSupplyRaw) ||
    BigInt(supply.totalSupplyRaw) > (1n << 64n) - 1n ||
    !Number.isFinite(Date.parse(supply.observedAt)) ||
    Date.parse(supply.observedAt) > now + 1000
  )
    throw new Error(
      'Valid saved token supply and supported percentage required.',
    );
  const holdings = sizeSessionSellPercentage(
    items,
    wallets,
    supply.decimals,
    100,
    now,
    minimumTimes,
  ).map((amount) => solanaTokenAtoms(amount, supply.decimals));
  const target = (BigInt(supply.totalSupplyRaw) * BigInt(basisPoints)) / 10000n;
  const available = holdings.reduce((sum, units) => sum + units, 0n);
  if (target > available)
    throw new Error(
      'Selected wallets do not hold enough unfrozen units for this supply percentage.',
    );
  if (target < BigInt(wallets.length))
    throw new Error(
      'Supply percentage is too small to allocate a positive amount to every selected wallet.',
    );
  const allocation = holdings.map((units) => (target * units) / available);
  let remainder = target - allocation.reduce((sum, units) => sum + units, 0n);
  const ranked = holdings
    .map((units, index) => ({
      index,
      remainder: (target * units) % available,
      wallet: wallets[index].address,
    }))
    .sort((a, b) =>
      a.remainder === b.remainder
        ? a.wallet < b.wallet
          ? -1
          : a.wallet > b.wallet
            ? 1
            : 0
        : a.remainder > b.remainder
          ? -1
          : 1,
    );
  for (const row of ranked) {
    if (remainder === 0n) break;
    allocation[row.index] += 1n;
    remainder -= 1n;
  }
  if (allocation.some((units, index) => units < 1n || units > holdings[index]))
    throw new Error(
      'Proportional sizing leaves a wallet with no sellable units. Remove that wallet or choose a larger percentage.',
    );
  return {
    totalRaw: target.toString(),
    totalAmount: formatNativeBalance(target.toString(), supply.decimals),
    amounts: allocation.map((units) =>
      formatNativeBalance(units.toString(), supply.decimals),
    ),
  };
}
export function sizeSessionSellPercentage(
  items: ImportedWalletInventory[],
  wallets: Array<{ address: string; revision: number }>,
  decimals: number,
  percentage: number,
  now: number,
  minimumTimes: ReadonlyMap<string, number> = new Map(),
) {
  if (
    !wallets.length ||
    wallets.length > 25 ||
    ![25, 50, 75, 100].includes(percentage) ||
    !Number.isFinite(now)
  )
    throw new Error('Choose selected wallets and a supported sell percentage.');
  const selected = validatedInventoryItems(
    wallets.map((w) => items.find((i) => i.wallet === w.address)),
    wallets,
    decimals,
  );
  const amounts = selected.map((item) => {
    const o = item.observation;
    if (!o)
      throw new Error(
        `Refresh token holdings for ${item.wallet}. No saved observation is available.`,
      );
    const time = Date.parse(o.observedAt);
    if (
      time > now + 5000 ||
      now - time > 60000 ||
      time <= (minimumTimes.get(item.wallet) ?? -Infinity)
    )
      throw new Error(
        `Refresh token holdings for ${item.wallet}. The observation is stale or predates a finalized trade.`,
      );
    const units = (BigInt(o.unfrozenRaw) * BigInt(percentage)) / 100n;
    if (units < 1n)
      throw new Error(
        `The selected percentage rounds to zero for ${item.wallet}. Choose another percentage or remove this wallet.`,
      );
    return formatNativeBalance(units.toString(), decimals);
  });
  return amounts;
}
