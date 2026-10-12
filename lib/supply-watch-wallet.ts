import type { ImportedTokenProject } from './imported-token-project';
import { walletAddress, type WorkspaceWallet } from './wallet-workspace';

export const MAX_WATCHED_WALLETS = 12;

type Fetch = typeof fetch;

async function readRoster(request: Fetch): Promise<WorkspaceWallet[]> {
  const response = await request('/api/wallet-workspace', {
    cache: 'no-store',
  });
  const data = (await response.json().catch(() => null)) as {
    wallets?: WorkspaceWallet[];
    error?: string;
  } | null;
  if (!response.ok || !data || !Array.isArray(data.wallets))
    throw new Error(data?.error || 'Cannot load wallet roster.');
  return data.wallets;
}

function findSolanaWallet(wallets: WorkspaceWallet[], address: string) {
  return wallets.find((w) => w.chain === 'Solana' && w.address === address);
}

// Archived records are never unarchived here; the user restores them in Wallets.
function activeWallet(wallet: WorkspaceWallet) {
  if (wallet.archived)
    throw new Error(
      'This address is archived in your wallet roster. Restore it in Wallets before watching it.',
    );
  return wallet;
}

/**
 * Saves a sampled holder's public address to the signed-in user's Solana wallet
 * roster (watch-only, Recipient role) and returns the server's wallet record.
 * It never grants signing or ownership capability.
 */
export async function persistWatchedWallet(
  project: ImportedTokenProject,
  owner: string,
  request: Fetch = fetch,
): Promise<WorkspaceWallet> {
  if (project.document.token.chain !== 'Solana')
    throw new Error('Watching holders is available for Solana projects.');
  if (project.archived)
    throw new Error('Archived projects cannot add watched wallets.');
  const address = walletAddress(owner, 'Solana');
  const existing = findSolanaWallet(await readRoster(request), address);
  if (existing) return activeWallet(existing);
  const response = await request('/api/wallet-workspace', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'wallet.add',
      chain: 'Solana',
      wallets: [
        {
          address,
          label: `Holder ${address.slice(0, 6)}`,
          role: 'Recipient',
        },
      ],
    }),
  });
  if (!response.ok) {
    // A concurrent save of the same address returns 409; reuse that record.
    if (response.status === 409) {
      const again = findSolanaWallet(await readRoster(request), address);
      if (again) return activeWallet(again);
    }
    const data = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(data?.error || 'Cannot save this watched wallet.');
  }
  let roster: WorkspaceWallet[];
  try {
    roster = await readRoster(request);
  } catch {
    throw new Error(
      'The wallet was saved, but your roster could not be reloaded. Reload wallets before continuing.',
    );
  }
  const saved = findSolanaWallet(roster, address);
  if (!saved)
    throw new Error(
      'The wallet save could not be confirmed. Reload wallets and try again.',
    );
  return activeWallet(saved);
}
