import { walletAddress } from './wallet-workspace';

// Block-0 temporary holders: launch wallets the user plans to sell back after
// the launch finalizes. This only remembers the choice in this browser; every
// sell still goes through its own review and approval in the trade session.
const key = (mint: string) => 'bundle.temporary-holders.v1:' + mint;

export function readTemporaryHolders(
  mint: string,
  storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage,
): string[] {
  try {
    const value = JSON.parse(storage?.getItem(key(mint)) ?? '[]') as unknown;
    if (!Array.isArray(value) || value.length > 200) return [];
    const wallets = value.map((v) => walletAddress(v, 'Solana'));
    return new Set(wallets).size === wallets.length ? wallets : [];
  } catch {
    return [];
  }
}

export function saveTemporaryHolders(
  mint: string,
  wallets: string[],
  storage:
    | Pick<Storage, 'setItem' | 'removeItem'>
    | undefined = globalThis.localStorage,
) {
  const clean = [...new Set(wallets.map((w) => walletAddress(w, 'Solana')))];
  try {
    if (clean.length) storage?.setItem(key(mint), JSON.stringify(clean));
    else storage?.removeItem(key(mint));
  } catch {
    /* Private windows can refuse storage; the choice is a convenience only. */
  }
  return clean;
}
