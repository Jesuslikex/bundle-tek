import { walletAddress } from './wallet-workspace';
import { SUPPLY_GROUPS, type SupplyGroup } from './supply-tracker-handoff';
export type SupplyScope = {
  mint: string;
  wallets: { address: string; group: SupplyGroup }[];
};
export function supplyPartitionScope(input: unknown): SupplyScope {
  const body = input as Partial<SupplyScope> | null;
  if (
    !body ||
    !Array.isArray(body.wallets) ||
    body.wallets.length < 1 ||
    body.wallets.length > 12
  )
    throw new Error('Choose 1 to 12 wallets for a supply read.');
  const mint = walletAddress(body.mint, 'Solana');
  const seen = new Set<string>();
  const wallets = body.wallets.map((w) => {
    const address = walletAddress(w?.address, 'Solana');
    if (seen.has(address)) throw new Error('Duplicate supply wallet.');
    seen.add(address);
    if (!SUPPLY_GROUPS.includes(w?.group))
      throw new Error('Choose team, external, or pool.');
    return { address, group: w.group };
  });
  return { mint, wallets };
}
