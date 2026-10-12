import type { ImportedTokenProject } from './imported-token-project';
import { walletAddress, type WorkspaceWallet } from './wallet-workspace';

export const SUPPLY_TRACKER_ORIGIN =
  'https://robinhood-team-supply.chris-toney0702.chatgpt.site';
export const SUPPLY_GROUPS = ['team', 'external', 'pool'] as const;
export type SupplyGroup = (typeof SUPPLY_GROUPS)[number];
export type SupplyWallet = {
  address: string;
  label: string;
  group: SupplyGroup;
};

export function supplyTrackerWallets(
  project: ImportedTokenProject,
  wallets: WorkspaceWallet[],
) {
  return wallets.filter(
    (w) => w.chain === project.document.token.chain && !w.archived,
  );
}

export function supplyTrackerHandoff(
  project: ImportedTokenProject,
  wallets: SupplyWallet[],
) {
  const token = project.document.token;
  if (!['Solana', 'Robinhood'].includes(token.chain))
    throw new Error(
      'The hosted SupplyTracker supports Solana and Robinhood Chain.',
    );
  if (!wallets.length || wallets.length > 100)
    throw new Error('Choose 1 to 100 wallets.');
  const seen = new Set<string>();
  const selected = wallets.map((w) => {
    const address = walletAddress(w.address, token.chain);
    const canonical =
      token.chain === 'Solana' ? address : address.toLowerCase();
    if (seen.has(canonical)) throw new Error('Choose each wallet once.');
    seen.add(canonical);
    if (!SUPPLY_GROUPS.includes(w.group))
      throw new Error('Choose a supply classification.');
    // The Solana tracker uses comma-separated lines, so labels must not inject fields.
    const label =
      w.label
        .split('')
        .map((c) =>
          c === ',' || c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127
            ? ' '
            : c,
        )
        .join('')
        .trim()
        .slice(0, 48) || address.slice(0, 8);
    return { address, label, group: w.group };
  });
  const url = new URL(
    token.chain === 'Solana' ? '/solana.html' : '/robinhood.html',
    SUPPLY_TRACKER_ORIGIN,
  );
  url.searchParams.set(
    token.chain === 'Solana' ? 'mint' : 'token',
    walletAddress(token.address, token.chain),
  );
  url.searchParams.set('name', token.name.slice(0, 48));
  url.searchParams.set(
    'wallets',
    token.chain === 'Solana'
      ? selected.map((w) => `${w.label}, ${w.address}, ${w.group}`).join('\n')
      : JSON.stringify(selected),
  );
  return url.href;
}
