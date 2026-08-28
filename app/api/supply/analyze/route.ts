import { getSolanaIndexerRpcEndpoint, rpcCall } from '@/lib/solana-rpc';

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

function formatRaw(raw: bigint, decimals: number) {
  const negative = raw < 0n;
  const digits = (negative ? -raw : raw).toString().padStart(decimals + 1, '0');
  if (decimals === 0) return `${negative ? '-' : ''}${digits}`;
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, '').slice(0, 6);
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function percentOf(part: bigint, total: bigint) {
  if (total <= 0n) return 0;
  return Number((part * 1_000_000n) / total) / 10_000;
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { mint?: unknown; bundleWallets?: unknown };
    const mint = typeof body.mint === 'string' ? body.mint.trim() : '';
    const suppliedWallets = Array.isArray(body.bundleWallets)
      ? body.bundleWallets.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean)
      : [];
    const bundleWallets = [...new Set(suppliedWallets)];

    if (!ADDRESS.test(mint)) return Response.json({ error: 'Enter a valid Solana token mint.' }, { status: 400 });
    if (bundleWallets.length > MAX_BUNDLE_WALLETS) return Response.json({ error: `Track up to ${MAX_BUNDLE_WALLETS} bundle wallets at once.` }, { status: 400 });
    if (bundleWallets.some((wallet) => !ADDRESS.test(wallet))) return Response.json({ error: 'One or more bundle wallet addresses are invalid.' }, { status: 400 });

    const endpoint = getSolanaIndexerRpcEndpoint();
    const [supply, largest] = await Promise.all([
      rpcCall<SupplyResponse>(endpoint, 'getTokenSupply', [mint, { commitment: 'confirmed' }]),
      rpcCall<LargestResponse>(endpoint, 'getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]),
    ]);
    const totalRaw = BigInt(supply.value.amount);
    const decimals = supply.value.decimals;
    if (totalRaw <= 0n) return Response.json({ error: 'This mint has no circulating token supply.' }, { status: 422 });

    const accountDetails = largest.value.length
      ? await rpcCall<MultipleAccountsResponse>(endpoint, 'getMultipleAccounts', [
          largest.value.map((account) => account.address),
          { encoding: 'jsonParsed', commitment: 'confirmed' },
        ])
      : { context: largest.context, value: [] };

    const ownerTotals = new Map<string, bigint>();
    largest.value.forEach((account, index) => {
      const owner = accountDetails.value[index]?.data?.parsed?.info?.owner ?? account.address;
      ownerTotals.set(owner, (ownerTotals.get(owner) ?? 0n) + BigInt(account.amount));
    });

    let bundleRaw = 0n;
    let observedSlot = Math.max(supply.context.slot, largest.context.slot, accountDetails.context.slot);
    for (const wallet of bundleWallets) {
      const accounts = await rpcCall<OwnerAccountsResponse>(endpoint, 'getTokenAccountsByOwner', [
        wallet,
        { mint },
        { encoding: 'jsonParsed', commitment: 'confirmed' },
      ]);
      observedSlot = Math.max(observedSlot, accounts.context.slot);
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
        amount: formatRaw(amount, decimals),
        supplyPercent: percentOf(amount, totalRaw),
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
      totalSupply: formatRaw(totalRaw, decimals),
      bundle: {
        walletCount: bundleWallets.length,
        amount: formatRaw(bundleRaw, decimals),
        supplyPercent: percentOf(bundleRaw, totalRaw),
      },
      external: {
        amount: formatRaw(externalRaw, decimals),
        supplyPercent: percentOf(externalRaw, totalRaw),
        topTenPercent: percentOf(topTenRaw, totalRaw),
      },
      topExternal,
      note: 'Top holder rankings cover the largest token accounts returned by Solana RPC. Bundle totals include every token account owned by the supplied wallets.',
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
