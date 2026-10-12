import { walletChain, type WalletWorkspace } from './wallet-workspace';
import type { SavedWarmup } from './wallet-warmup-storage';
export function resolveWarmupWorkspace(
  plan: SavedWarmup,
  workspace: WalletWorkspace,
) {
  const chain = walletChain(plan.document.chain);
  const addresses = plan.document.addresses;
  if (
    !addresses.length ||
    addresses.length > 20 ||
    new Set(addresses).size !== addresses.length
  )
    throw new Error('Invalid saved warmup wallet selection.');
  const unavailable: string[] = [],
    changed: string[] = [];
  for (const address of addresses) {
    const wallet = workspace.wallets.find(
      (w) => w.chain === chain && w.address === address && !w.archived,
    );
    const captured = plan.document.walletRevisions.find(
      (w) => w.address === address,
    );
    if (!wallet) unavailable.push(address);
    else if (!captured || captured.revision !== wallet.revision)
      changed.push(address);
  }
  return {
    chain,
    addresses,
    unavailable,
    changed,
    canOpen: unavailable.length === 0,
  };
}
