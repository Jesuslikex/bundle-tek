import {
  getSolanaHolderRpcEndpoint,
  requireConsistentSolanaSlots,
  rpcCall,
} from '@/lib/solana-rpc';
import { formatRawAmount, percentOfSupply } from '@/lib/supply-analysis';
import {
  supplyTokenAmount,
  supplyAccountBalance,
  largestSupplyOwners,
} from '@/lib/supply-account-validation';
import { walletAddress } from '@/lib/wallet-workspace';
import { SOLANA_MAINNET_GENESIS } from '@/lib/wallet-balances';

export const dynamic = 'force-dynamic';

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_BUNDLE_WALLETS = 12;

type TokenAmount = {
  amount: string;
  decimals: number;
  uiAmountString?: string | null;
};
type SupplyResponse = { context: { slot: number }; value: TokenAmount };
type LargestResponse = {
  context: { slot: number };
  value: Array<TokenAmount & { address: string }>;
};
type ParsedAccount = {
  data?: { parsed?: { info?: { owner?: string; tokenAmount?: TokenAmount } } };
};
type MultipleAccountsResponse = {
  context: { slot: number };
  value: Array<ParsedAccount | null>;
};
type OwnerAccountsResponse = {
  context: { slot: number };
  value: Array<{ account?: ParsedAccount }>;
};

export async function POST(request: Request) {
  let body: { mint?: unknown; bundleWallets?: unknown };
  try {
    body = (await request.json()) as {
      mint?: unknown;
      bundleWallets?: unknown;
    };
  } catch {
    return Response.json(
      { error: 'Request body must be valid JSON.', code: 'INVALID_JSON' },
      { status: 400 },
    );
  }

  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    (body.bundleWallets !== undefined &&
      (!Array.isArray(body.bundleWallets) ||
        body.bundleWallets.some((wallet) => typeof wallet !== 'string')))
  )
    return Response.json(
      {
        error:
          'Supply input must contain a mint and an array of wallet addresses.',
      },
      { status: 400 },
    );

  try {
    const mint = typeof body.mint === 'string' ? body.mint.trim() : '';
    const suppliedWallets = Array.isArray(body.bundleWallets)
      ? body.bundleWallets
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim())
          .filter(Boolean)
      : [];
    const bundleWallets = [...new Set(suppliedWallets)];

    if (!ADDRESS.test(mint))
      return Response.json(
        { error: 'Enter a valid Solana token mint.' },
        { status: 400 },
      );
    if (bundleWallets.length > MAX_BUNDLE_WALLETS)
      return Response.json(
        { error: `Track up to ${MAX_BUNDLE_WALLETS} bundle wallets at once.` },
        { status: 400 },
      );
    if (bundleWallets.some((wallet) => !ADDRESS.test(wallet)))
      return Response.json(
        { error: 'One or more bundle wallet addresses are invalid.' },
        { status: 400 },
      );

    const endpoint = getSolanaHolderRpcEndpoint();
    try {
      walletAddress(mint, 'Solana');
      bundleWallets.forEach((wallet) => walletAddress(wallet, 'Solana'));
    } catch {
      return Response.json(
        { error: 'Invalid Solana mint or wallet address.' },
        { status: 400 },
      );
    }
    if (
      (await rpcCall(endpoint, 'getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS
    )
      throw new Error('Supply provider network differs.');
    const supply = await rpcCall<SupplyResponse>(endpoint, 'getTokenSupply', [
      mint,
      { commitment: 'confirmed' },
    ]);
    let largest: LargestResponse;
    try {
      largest = await rpcCall<LargestResponse>(
        endpoint,
        'getTokenLargestAccounts',
        [mint, { commitment: 'confirmed' }],
      );
    } catch {
      return Response.json(
        {
          error:
            'The configured Solana RPC could not read largest token accounts. No sampled holder ranking is available. Use an RPC that supports getTokenLargestAccounts.',
          code: 'HOLDER_RPC_UNAVAILABLE',
        },
        { status: 502 },
      );
    }
    const { raw: totalRaw, decimals } = supplyTokenAmount(supply.value);
    if (totalRaw <= 0n)
      return Response.json(
        { error: 'This mint has no token supply.' },
        { status: 422 },
      );
    requireConsistentSolanaSlots([supply.context.slot, largest.context.slot]);
    if (largest.context.slot < supply.context.slot)
      throw new Error('Largest account context regressed.');
    if (
      !Array.isArray(largest.value) ||
      largest.value.length > 20 ||
      new Set(largest.value.map((a) => walletAddress(a.address, 'Solana')))
        .size !== largest.value.length
    )
      throw new Error('Largest account coverage differs.');

    const consistencyFloor = Math.max(
      supply.context.slot,
      largest.context.slot,
    );
    const [accountDetails, ownerAccounts] = await Promise.all([
      largest.value.length
        ? rpcCall<MultipleAccountsResponse>(endpoint, 'getMultipleAccounts', [
            largest.value.map((account) => account.address),
            {
              encoding: 'jsonParsed',
              commitment: 'confirmed',
              minContextSlot: consistencyFloor,
            },
          ])
        : Promise.resolve({ context: largest.context, value: [] }),
      Promise.all(
        bundleWallets.map((wallet) =>
          rpcCall<OwnerAccountsResponse>(endpoint, 'getTokenAccountsByOwner', [
            wallet,
            { mint },
            {
              encoding: 'jsonParsed',
              commitment: 'confirmed',
              minContextSlot: consistencyFloor,
            },
          ]),
        ),
      ),
    ]);

    const ownerTotals = largestSupplyOwners(
      largest.value,
      accountDetails.value,
      mint,
      decimals,
      totalRaw,
    );

    let bundleRaw = 0n;
    const observedSlot = requireConsistentSolanaSlots([
      supply.context.slot,
      largest.context.slot,
      accountDetails.context.slot,
      ...ownerAccounts.map((accounts) => accounts.context.slot),
    ]);
    if (
      accountDetails.context.slot < consistencyFloor ||
      ownerAccounts.some((accounts) => accounts.context.slot < consistencyFloor)
    )
      throw new Error('Holder account context regressed.');
    const walletAccountsSeen = new Set<string>();
    ownerAccounts.forEach((accounts, index) => {
      if (!Array.isArray(accounts.value) || accounts.value.length > 500)
        throw new Error('Wallet account coverage exceeds limits.');
      for (const entry of accounts.value) {
        const address = walletAddress(
          (entry as { pubkey?: unknown }).pubkey,
          'Solana',
        );
        if (walletAccountsSeen.has(address))
          throw new Error('Duplicate wallet token account.');
        walletAccountsSeen.add(address);
        bundleRaw += supplyAccountBalance(
          entry.account,
          mint,
          decimals,
          bundleWallets[index],
        ).raw;
      }
    });

    if (bundleRaw > totalRaw)
      throw new Error('Tracked holdings exceed total supply.');
    const bundleSet = new Set(bundleWallets);
    const topExternal = [...ownerTotals.entries()]
      .filter(([owner]) => !bundleSet.has(owner))
      .sort((a, b) => (a[1] === b[1] ? 0 : a[1] > b[1] ? -1 : 1))
      .slice(0, 20)
      .map(([owner, amount], index) => ({
        rank: index + 1,
        owner,
        raw: amount.toString(),
        amount: formatRawAmount(amount, decimals),
        supplyPercent: percentOfSupply(amount, totalRaw),
      }));
    const topTenRaw = [...ownerTotals.entries()]
      .filter(([owner]) => !bundleSet.has(owner))
      .sort((a, b) => (a[1] === b[1] ? 0 : a[1] > b[1] ? -1 : 1))
      .slice(0, 10)
      .reduce((sum, [, amount]) => sum + amount, 0n);
    const externalRaw = totalRaw - bundleRaw;
    if (
      [...ownerTotals.entries()]
        .filter(([owner]) => !bundleSet.has(owner))
        .reduce((sum, [, units]) => sum + units, 0n) > externalRaw
    )
      throw new Error('Sampled external holdings exceed remaining supply.');

    return Response.json(
      {
        mint,
        network: 'mainnet',
        slot: observedSlot,
        decimals,
        totalSupplyRaw: totalRaw.toString(),
        observedAt: new Date().toISOString(),
        totalSupply: formatRawAmount(totalRaw, decimals),
        bundle: {
          raw: bundleRaw.toString(),
          walletCount: bundleWallets.length,
          amount: formatRawAmount(bundleRaw, decimals),
          supplyPercent: percentOfSupply(bundleRaw, totalRaw),
        },
        external: {
          raw: externalRaw.toString(),
          amount: formatRawAmount(externalRaw, decimals),
          supplyPercent: percentOfSupply(externalRaw, totalRaw),
          topTenPercent: percentOfSupply(topTenRaw, totalRaw),
        },
        topExternal,
        note: 'External rankings are sampled from the largest token accounts returned by Solana RPC and may not represent every account owned by the same holder. Bundle totals include every token account owned by the supplied wallets.',
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Supply analysis failed.';
    const needsIndexer =
      /returned (403|429)|indexed requests|request blocked/i.test(message);
    return Response.json(
      {
        error: needsIndexer
          ? 'Holder-capable Solana RPC required. Add a private indexed RPC endpoint to enable supply analysis.'
          : 'Supply analysis unavailable. The RPC may not support holder reads or returned inconsistent token data.',
        code: needsIndexer ? 'INDEXED_RPC_REQUIRED' : 'SUPPLY_ANALYSIS_FAILED',
      },
      { status: 502 },
    );
  }
}
