import { getSolanaIndexerRpcEndpoint, requireConsistentSolanaSlots, rpcCall } from '@/lib/solana-rpc';
import { formatRawAmount, percentOfSupply } from '@/lib/supply-analysis';

export const dynamic = 'force-dynamic';

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_BUNDLE_WALLETS = 12;

type TokenAmount = { amount: string; decimals: number; uiAmountString?: string | null };
type SupplyResponse = { context: { slot: number }; value: TokenAmount };
type LargestResponse = {
  context: { slot: number };
  value: Array<TokenAmount & { address: string }>;
};
type ParsedAccount = {
  data?: { parsed?: { info?: { owner?: string; tokenAmount?: TokenAmount } } };
};
type MultipleAccountsResponse = { context: { slot: number }; value: Array<ParsedAccount | null> };
type OwnerAccountsResponse = {
  context: { slot: number };
  value: Array<{ account?: ParsedAccount }>;
};

export async function POST(request: Request) {
  let body: { mint?: unknown; bundleWallets?: unknown };
  try {
    body = await request.json() as { mint?: unknown; bundleWallets?: unknown };
  } catch {
    return Response.json({ error: "Request body must be valid JSON.", code: "INVALID_JSON" }, { status: 400 });
  }

  try {
    const mint = typeof body.mint === 'string' ? body.mint.trim() : '';
    const suppliedWallets = Array.isArray(body.bundleWallets)
      ? body.bundleWallets.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean)
      : [];
    const bundleWallets = [...new Set(suppliedWallets)];

    if (!ADDRESS.test(mint)) return Response.json({ error: 'Enter a valid Solana token mint.' }, { status: 400 });
    if (bundleWallets.length > MAX_BUNDLE_WALLETS) return Response.json({ error: `Track up to ${MAX_BUNDLE_WALLETS} bundle wallets at once.` }, { status: 400 });
    if (bundleWallets.some((wallet) => !ADDRESS.test(wallet))) return Response.json({ error: 'One or more bundle wallet addresses are invalid.' }, { status: 400 });

    const endpoint = getSolanaIndexerRpcEndpoint();
    const supply = await rpcCall<SupplyResponse>(endpoint, 'getTokenSupply', [
      mint,
      { commitment: 'confirmed' },
    ]);
    const largest = await rpcCall<LargestResponse>(endpoint, 'getTokenLargestAccounts', [
      mint,
      { commitment: 'confirmed', minContextSlot: supply.context.slot },
    ]);
    const totalRaw = BigInt(supply.value.amount);
    const decimals = supply.value.decimals;
    if (totalRaw <= 0n) return Response.json({ error: 'This mint has no circulating token supply.' }, { status: 422 });

    const consistencyFloor = Math.max(supply.context.slot, largest.context.slot);
    const [accountDetails, ownerAccounts] = await Promise.all([
      largest.value.length
        ? rpcCall<MultipleAccountsResponse>(endpoint, 'getMultipleAccounts', [
            largest.value.map((account) => account.address),
            { encoding: 'jsonParsed', commitment: 'confirmed', minContextSlot: consistencyFloor },
          ])
        : Promise.resolve({ context: largest.context, value: [] }),
      Promise.all(bundleWallets.map((wallet) =>
        rpcCall<OwnerAccountsResponse>(endpoint, 'getTokenAccountsByOwner', [
          wallet,
          { mint },
          { encoding: 'jsonParsed', commitment: 'confirmed', minContextSlot: consistencyFloor },
        ]),
      )),
    ]);

    const ownerTotals = new Map<string, bigint>();
    largest.value.forEach((account, index) => {
      const owner = accountDetails.value[index]?.data?.parsed?.info?.owner ?? account.address;
      ownerTotals.set(owner, (ownerTotals.get(owner) ?? 0n) + BigInt(account.amount));
    });

    let bundleRaw = 0n;
    const observedSlot = requireConsistentSolanaSlots([
      supply.context.slot,
      largest.context.slot,
      accountDetails.context.slot,
      ...ownerAccounts.map((accounts) => accounts.context.slot),
    ]);
    for (const accounts of ownerAccounts) {
      for (const item of accounts.value) {
        const amount = item.account?.data?.parsed?.info?.tokenAmount?.amount;
        if (amount) bundleRaw += BigInt(amount);
      }
    }

    if (bundleRaw > totalRaw) bundleRaw = totalRaw;
    const bundleSet = new Set(bundleWallets);
    const topExternal = [...ownerTotals.entries()]
      .filter(([owner]) => !bundleSet.has(owner))
      .sort((a, b) => a[1] === b[1] ? 0 : a[1] > b[1] ? -1 : 1)
      .slice(0, 20)
      .map(([owner, amount], index) => ({
        rank: index + 1,
        owner,
        amount: formatRawAmount(amount, decimals),
        supplyPercent: percentOfSupply(amount, totalRaw),
      }));
    const topTenRaw = [...ownerTotals.entries()]
      .filter(([owner]) => !bundleSet.has(owner))
      .sort((a, b) => a[1] === b[1] ? 0 : a[1] > b[1] ? -1 : 1)
      .slice(0, 10)
      .reduce((sum, [, amount]) => sum + amount, 0n);
    const externalRaw = totalRaw - bundleRaw;

    return Response.json({
      mint,
      network: 'mainnet',
      slot: observedSlot,
      decimals,
      totalSupply: formatRawAmount(totalRaw, decimals),
      bundle: {
        walletCount: bundleWallets.length,
        amount: formatRawAmount(bundleRaw, decimals),
        supplyPercent: percentOfSupply(bundleRaw, totalRaw),
      },
      external: {
        amount: formatRawAmount(externalRaw, decimals),
        supplyPercent: percentOfSupply(externalRaw, totalRaw),
        topTenPercent: percentOfSupply(topTenRaw, totalRaw),
      },
      topExternal,
      note: 'External rankings are sampled from the largest token accounts returned by Solana RPC and may not represent every account owned by the same holder. Bundle totals include every token account owned by the supplied wallets.',
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Supply analysis failed.';
    const needsIndexer = /returned (403|429)|indexed requests|request blocked/i.test(message);
    return Response.json({
      error: needsIndexer
        ? 'Holder-capable Solana RPC required. Add a private indexed RPC endpoint to enable supply analysis.'
        : message,
      code: needsIndexer ? 'INDEXED_RPC_REQUIRED' : 'SUPPLY_ANALYSIS_FAILED',
    }, { status: 502 });
  }
}
