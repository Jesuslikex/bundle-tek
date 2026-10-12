import type { HoldingsSnapshot } from './wallet-holdings';
import { formatNativeBalance } from './wallet-balance-format';
const programs = [
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
];
function atoms(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > 18446744073709551615n
  )
    throw new Error('Invalid saved token units.');
  return BigInt(value);
}
export type ImportedWalletInventory = {
  wallet: string;
  walletRevision: number;
  observation: null | {
    raw: string;
    frozenRaw: string;
    unfrozenRaw: string;
    amount: string;
    observedAt: string;
    minSlot: number;
    maxSlot: number;
    source: string;
    scope?: 'mint';
  };
};
export function importedWalletInventory(
  snapshot: HoldingsSnapshot | null,
  wallet: string,
  walletRevision: number,
  mint: string,
  decimals: number,
): ImportedWalletInventory {
  if (
    !Number.isSafeInteger(walletRevision) ||
    walletRevision < 1 ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255
  )
    throw new Error('Inventory context differs.');
  if (!snapshot) return { wallet, walletRevision, observation: null };
  if (
    snapshot.chain !== 'Solana' ||
    snapshot.address !== wallet ||
    snapshot.commitment !== 'confirmed' ||
    !Number.isSafeInteger(snapshot.minSlot) ||
    snapshot.minSlot < 0 ||
    !Number.isSafeInteger(snapshot.maxSlot) ||
    snapshot.maxSlot < snapshot.minSlot ||
    snapshot.maxSlot - snapshot.minSlot > 150 ||
    !Number.isFinite(Date.parse(snapshot.observedAt)) ||
    typeof snapshot.source !== 'string' ||
    !/^[a-z0-9.-]{1,253}$/i.test(snapshot.source) ||
    !Array.isArray(snapshot.slots) ||
    snapshot.slots.length !== 2 ||
    programs.some(
      (p) =>
        snapshot.slots.filter(
          (s) =>
            s.program === p &&
            Number.isSafeInteger(s.slot) &&
            s.slot >= snapshot.minSlot &&
            s.slot <= snapshot.maxSlot,
        ).length !== 1,
    ) ||
    Math.min(...snapshot.slots.map((s) => s.slot)) !== snapshot.minSlot ||
    Math.max(...snapshot.slots.map((s) => s.slot)) !== snapshot.maxSlot ||
    !Array.isArray(snapshot.holdings) ||
    snapshot.holdings.length > 1000 ||
    !Number.isSafeInteger(snapshot.accountCount) ||
    snapshot.accountCount < 0 ||
    snapshot.accountCount > 1000
  )
    throw new Error('Saved holdings observation is incomplete.');
  const mints = new Set<string>(),
    accounts = new Set<string>();
  let raw = 0n,
    frozen = 0n;
  for (const holding of snapshot.holdings) {
    if (
      !holding ||
      typeof holding.mint !== 'string' ||
      !holding.mint ||
      mints.has(holding.mint) ||
      !programs.includes(holding.program) ||
      !Number.isInteger(holding.decimals) ||
      holding.decimals < 0 ||
      holding.decimals > 255 ||
      !Array.isArray(holding.accounts) ||
      !holding.accounts.length
    )
      throw new Error('Saved token inventory differs.');
    mints.add(holding.mint);
    const total = atoms(holding.raw);
    let sum = 0n,
      locked = 0n;
    for (const account of holding.accounts) {
      if (
        !account ||
        typeof account.address !== 'string' ||
        !account.address ||
        accounts.has(account.address) ||
        typeof account.frozen !== 'boolean'
      )
        throw new Error('Saved token accounts differ.');
      accounts.add(account.address);
      const units = atoms(account.raw);
      sum += units;
      if (account.frozen) locked += units;
    }
    if (
      sum !== total ||
      formatNativeBalance(holding.raw, holding.decimals) !== holding.amount
    )
      throw new Error('Saved token totals differ.');
    if (holding.mint === mint) {
      if (holding.decimals !== decimals)
        throw new Error('Saved token precision differs.');
      raw = total;
      frozen = locked;
    }
  }
  if (accounts.size !== snapshot.accountCount)
    throw new Error('Saved account coverage differs.');
  return {
    wallet,
    walletRevision,
    observation: {
      raw: raw.toString(),
      frozenRaw: frozen.toString(),
      unfrozenRaw: (raw - frozen).toString(),
      amount: formatNativeBalance(raw.toString(), decimals),
      observedAt: snapshot.observedAt,
      minSlot: snapshot.minSlot,
      maxSlot: snapshot.maxSlot,
      source: snapshot.source,
    },
  };
}
export function inventorySupplyShare(raw: string, supply: string) {
  const units = atoms(raw),
    total = atoms(supply);
  if (!total || units > total) return null;
  if (units > 0n && units * 1000000n < total) return '<0.0001%';
  return formatNativeBalance(((units * 1000000n) / total).toString(), 4) + '%';
}
export function validatedInventoryItems(
  value: unknown,
  wallets: Array<{ address: string; revision: number }>,
  decimals: number,
): ImportedWalletInventory[] {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255 ||
    !Array.isArray(value) ||
    value.length !== wallets.length ||
    value.length > 500
  )
    throw new Error('Inventory wallet coverage changed. Reload trade wallets.');
  const seen = new Set<string>();
  return value.map((item: ImportedWalletInventory) => {
    if (
      !item ||
      seen.has(item.wallet) ||
      !wallets.some(
        (w) => w.address === item.wallet && w.revision === item.walletRevision,
      )
    )
      throw new Error(
        'Inventory wallet revision changed. Reload trade wallets.',
      );
    seen.add(item.wallet);
    if (item.observation !== null) {
      const o = item.observation;
      if (
        !o ||
        (o.scope !== undefined && o.scope !== 'mint') ||
        atoms(o.frozenRaw) + atoms(o.unfrozenRaw) !== atoms(o.raw) ||
        formatNativeBalance(o.raw, decimals) !== o.amount ||
        !Number.isFinite(Date.parse(o.observedAt)) ||
        !Number.isSafeInteger(o.minSlot) ||
        o.minSlot < 0 ||
        !Number.isSafeInteger(o.maxSlot) ||
        o.maxSlot < o.minSlot ||
        o.maxSlot - o.minSlot > 150 ||
        typeof o.source !== 'string' ||
        !/^[a-z0-9.-]{1,253}$/i.test(o.source)
      )
        throw new Error('Inventory observation differs.');
    }
    return item;
  });
}

/** Confirm the inventory reload retained the exact completed provider read. */
export function inventoryRetainedRefresh(
  items: ImportedWalletInventory[],
  refreshed: ImportedWalletInventory,
) {
  const saved = items.find((item) => item.wallet === refreshed.wallet);
  const a = saved?.observation,
    b = refreshed.observation;
  return (
    !!a &&
    !!b &&
    saved?.walletRevision === refreshed.walletRevision &&
    a.raw === b.raw &&
    a.frozenRaw === b.frozenRaw &&
    a.unfrozenRaw === b.unfrozenRaw &&
    a.amount === b.amount &&
    a.observedAt === b.observedAt &&
    a.minSlot === b.minSlot &&
    a.maxSlot === b.maxSlot &&
    a.source === b.source &&
    a.scope === b.scope
  );
}
