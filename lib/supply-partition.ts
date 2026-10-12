import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import {
  getSolanaIndexerRpcEndpoint,
  requireConsistentSolanaSlots,
} from './solana-rpc';
import { walletAddress } from './wallet-workspace';
import { TOKEN_PROGRAMS } from './wallet-holdings';
import { formatNativeBalance } from './wallet-balance-format';
import { percentOfSupply } from './supply-analysis';

export { supplyPartitionScope, type SupplyScope } from './supply-scope';
import { supplyPartitionScope } from './supply-scope';
function uint(value: unknown, max = (1n << 64n) - 1n): bigint {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > max
  )
    throw new Error('Invalid supply provider integer.');
  return BigInt(value);
}
type ParsedOwnerAccounts = {
  context?: { slot?: unknown };
  value?: Array<{
    pubkey?: unknown;
    account?: {
      owner?: unknown;
      executable?: unknown;
      data?: {
        parsed?: {
          type?: unknown;
          info?: {
            owner?: unknown;
            mint?: unknown;
            state?: unknown;
            tokenAmount?: { amount?: unknown; decimals?: unknown };
          };
        };
      };
    };
  }>;
};
export async function observeSupplyPartition(
  input: unknown,
  signal = AbortSignal.timeout(25000),
  fetcher: typeof fetch = fetch,
) {
  const scope = supplyPartitionScope(input);
  const endpoint = getSolanaIndexerRpcEndpoint();
  const rpc = (method: string, params: unknown[]) =>
    balanceRpc(endpoint, method, params, signal, fetcher);
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Supply provider network mismatch.');
  const supply = (await rpc('getTokenSupply', [
    scope.mint,
    { commitment: 'confirmed' },
  ])) as {
    context?: { slot?: unknown };
    value?: { amount?: unknown; decimals?: unknown };
  };
  const rawSupply = uint(supply?.value?.amount);
  const decimals = Number(uint(supply?.value?.decimals, 255n));
  const firstSlot = Number(
    uint(supply?.context?.slot, BigInt(Number.MAX_SAFE_INTEGER)),
  );
  if (!rawSupply) throw new Error('Mint has no token supply.');
  const snapshots = await Promise.all(
    scope.wallets.map(
      (w) =>
        rpc('getTokenAccountsByOwner', [
          w.address,
          { mint: scope.mint },
          {
            commitment: 'confirmed',
            encoding: 'jsonParsed',
            minContextSlot: firstSlot,
          },
        ]) as Promise<ParsedOwnerAccounts>,
    ),
  );
  const seen = new Set<string>();
  const slots = [firstSlot];
  const wallets = snapshots.map((snapshot, i) => {
    const selected = scope.wallets[i];
    const slot = Number(
      uint(snapshot?.context?.slot, BigInt(Number.MAX_SAFE_INTEGER)),
    );
    if (slot < firstSlot)
      throw new Error('Supply read predates requested slot.');
    slots.push(slot);
    if (!Array.isArray(snapshot?.value) || snapshot.value.length > 500)
      throw new Error(
        'Supply account enumeration is unavailable or exceeds limits.',
      );
    let raw = 0n;
    for (const row of snapshot.value) {
      const address = walletAddress(row?.pubkey, 'Solana');
      if (seen.has(address)) throw new Error('Duplicate supply token account.');
      seen.add(address);
      const account = row?.account,
        parsed = account?.data?.parsed,
        info = parsed?.info;
      if (
        !TOKEN_PROGRAMS.includes(
          account?.owner as (typeof TOKEN_PROGRAMS)[number],
        ) ||
        account?.executable !== false ||
        parsed?.type !== 'account' ||
        info?.owner !== selected.address ||
        info?.mint !== scope.mint ||
        !['initialized', 'frozen'].includes(String(info?.state)) ||
        Number(uint(info?.tokenAmount?.decimals, 255n)) !== decimals
      )
        throw new Error(
          'Supply account does not match the selected owner, mint, or precision.',
        );
      raw += uint(info?.tokenAmount?.amount);
    }
    return {
      ...selected,
      raw: raw.toString(),
      amount: formatNativeBalance(raw.toString(), decimals),
      supplyPercent: percentOfSupply(raw, rawSupply),
      slot,
    };
  });
  const maxSlot = requireConsistentSolanaSlots(slots);
  const totals = { team: 0n, external: 0n, pool: 0n };
  for (const w of wallets) totals[w.group] += BigInt(w.raw);
  const tracked = totals.team + totals.external + totals.pool;
  if (tracked > rawSupply)
    throw new Error(
      'Tracked balances exceed token supply; refresh after provider reconciliation.',
    );
  const parts = {
    ...totals,
    unclassified: rawSupply - tracked,
    outsideTeam: rawSupply - totals.team,
  };
  return {
    mint: scope.mint,
    decimals,
    totalSupplyRaw: rawSupply.toString(),
    totalSupply: formatNativeBalance(rawSupply.toString(), decimals),
    wallets,
    parts: Object.fromEntries(
      Object.entries(parts).map(([group, raw]) => [
        group,
        {
          raw: raw.toString(),
          amount: formatNativeBalance(raw.toString(), decimals),
          supplyPercent: percentOfSupply(raw, rawSupply),
        },
      ]),
    ) as Record<
      keyof typeof parts,
      { raw: string; amount: string; supplyPercent: number }
    >,
    minSlot: Math.min(...slots),
    maxSlot,
    observedAt: new Date().toISOString(),
    source: new URL(endpoint).hostname,
    commitment: 'confirmed' as const,
  };
}
export type SupplyPartition = Awaited<
  ReturnType<typeof observeSupplyPartition>
>;
