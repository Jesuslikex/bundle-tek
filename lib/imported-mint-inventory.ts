import type { MintHoldingsSnapshot } from './wallet-mint-holdings';
import type { ImportedWalletInventory } from './imported-wallet-inventory';
import { formatNativeBalance } from './wallet-balance-format';
import { walletAddress } from './wallet-workspace';
import { TOKEN_PROGRAMS } from './wallet-holdings';

export function importedMintInventory(
  s: MintHoldingsSnapshot | null,
  wallet: string,
  walletRevision: number,
  mint: string,
  decimals: number,
): ImportedWalletInventory {
  walletAddress(wallet, 'Solana');
  walletAddress(mint, 'Solana');
  if (
    !Number.isSafeInteger(walletRevision) ||
    walletRevision < 1 ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255
  )
    throw new Error('Mint inventory context differs.');
  if (!s) return { wallet, walletRevision, observation: null };
  const atoms = (value: string) => {
    if (
      typeof value !== 'string' ||
      !/^(0|[1-9]\d{0,19})$/.test(value) ||
      BigInt(value) > (1n << 64n) - 1n
    )
      throw new Error('Invalid mint inventory units.');
    return BigInt(value);
  };
  if (
    !s ||
    s.format !== 'solana-mint-holdings-v1' ||
    s.scope !== 'mint' ||
    s.chain !== 'Solana' ||
    s.address !== wallet ||
    s.mint !== mint ||
    s.decimals !== decimals ||
    s.commitment !== 'confirmed' ||
    !TOKEN_PROGRAMS.includes(s.program as (typeof TOKEN_PROGRAMS)[number]) ||
    !Number.isSafeInteger(walletRevision) ||
    walletRevision < 1 ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255 ||
    !Number.isFinite(Date.parse(s.observedAt)) ||
    typeof s.source !== 'string' ||
    !/^[a-z0-9.-]{1,253}$/i.test(s.source) ||
    !Number.isSafeInteger(s.mintSlot) ||
    s.mintSlot < 0 ||
    !Array.isArray(s.slots) ||
    !s.slots.length ||
    s.slots.length > 100 ||
    s.slots.some(
      (slot, i) =>
        !Number.isSafeInteger(slot) ||
        slot < s.mintSlot ||
        slot > s.mintSlot + 150 ||
        (i > 0 && slot < s.slots[i - 1]),
    ) ||
    s.slot !== s.slots[s.slots.length - 1] ||
    !Array.isArray(s.accounts) ||
    s.accounts.length > 5000 ||
    s.accountCount !== s.accounts.length
  )
    throw new Error('Mint inventory context differs.');
  walletAddress(wallet, 'Solana');
  walletAddress(mint, 'Solana');
  let total = 0n,
    frozen = 0n;
  const seen = new Set<string>();
  for (const account of s.accounts) {
    if (
      !account ||
      seen.has(account.address) ||
      walletAddress(account.address, 'Solana') !== account.address ||
      typeof account.frozen !== 'boolean' ||
      account.extensions !== (s.program === TOKEN_PROGRAMS[1])
    )
      throw new Error('Mint inventory account coverage differs.');
    seen.add(account.address);
    const raw = atoms(account.raw);
    total += raw;
    if (account.frozen) frozen += raw;
  }
  if (
    total !== atoms(s.raw) ||
    frozen !== atoms(s.frozenRaw) ||
    total - frozen !== atoms(s.unfrozenRaw) ||
    s.amount !== formatNativeBalance(s.raw, decimals)
  )
    throw new Error('Mint inventory totals differ.');
  return {
    wallet,
    walletRevision,
    observation: {
      raw: s.raw,
      frozenRaw: s.frozenRaw,
      unfrozenRaw: s.unfrozenRaw,
      amount: s.amount,
      observedAt: s.observedAt,
      minSlot: Math.min(...s.slots),
      maxSlot: s.slot,
      source: s.source,
      scope: 'mint',
    },
  };
}
