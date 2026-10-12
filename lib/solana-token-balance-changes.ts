import { walletAddress } from './wallet-workspace';
export type SolanaTokenBalanceChange = {
  mint: string;
  program: string;
  decimals: number;
  beforeRaw: string;
  afterRaw: string;
  changeRaw: string;
  accounts: string[];
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid token balance data.');
  return value as Record<string, unknown>;
}
function uint(value: unknown, max = (1n << 64n) - 1n) {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > max
  )
    throw new Error('Invalid token balance integer.');
  return BigInt(value);
}
// RPC integers have been decoded losslessly to decimal strings by balanceRpc.
export function solanaTokenBalanceChanges(
  keys: string[],
  wallet: string,
  pre: unknown,
  post: unknown,
): {
  complete: boolean;
  walletIncluded: boolean;
  changes: SolanaTokenBalanceChange[];
} {
  wallet = walletAddress(wallet, 'Solana');
  if (!keys.length || keys.length > 256 || new Set(keys).size !== keys.length)
    throw new Error('Invalid token balance account keys.');
  let complete = pre != null && post != null;
  const changes = new Map<string, SolanaTokenBalanceChange>();
  for (const [side, balances] of [
    ['beforeRaw', pre],
    ['afterRaw', post],
  ] as const) {
    if (balances == null) continue;
    if (!Array.isArray(balances) || balances.length > 256)
      throw new Error('Incomplete token balance data.');
    const seen = new Set<number>();
    for (const value of balances) {
      const balance = record(value),
        amount = record(balance.uiTokenAmount);
      const index = Number(uint(balance.accountIndex, 255n));
      if (index >= keys.length || seen.has(index))
        throw new Error('Token account index mismatch.');
      seen.add(index);
      const mint = walletAddress(balance.mint, 'Solana');
      const decimals = Number(uint(amount.decimals, 255n)),
        units = uint(amount.amount);
      if (balance.owner == null || balance.programId == null) {
        complete = false;
        continue;
      }
      const owner = walletAddress(balance.owner, 'Solana'),
        program = walletAddress(balance.programId, 'Solana');
      if (owner !== wallet) continue;
      const id = `${program}/${mint}`;
      const entry = changes.get(id) ?? {
        mint,
        program,
        decimals,
        beforeRaw: '0',
        afterRaw: '0',
        changeRaw: '0',
        accounts: [],
      };
      if (entry.decimals !== decimals)
        throw new Error('Token precision mismatch.');
      entry[side] = (BigInt(entry[side]) + units).toString();
      if (!entry.accounts.includes(keys[index]))
        entry.accounts.push(keys[index]);
      changes.set(id, entry);
    }
  }
  return {
    complete,
    walletIncluded: changes.size > 0,
    changes: complete
      ? [...changes.values()].map((e) => ({
          ...e,
          changeRaw: (BigInt(e.afterRaw) - BigInt(e.beforeRaw)).toString(),
        }))
      : [],
  };
}
