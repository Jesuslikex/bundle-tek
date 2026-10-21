import {
  observeWalletHoldings,
  TOKEN_PROGRAMS,
  type HoldingsSnapshot,
} from './wallet-holdings';
import { walletAddress } from './wallet-workspace';
import { formatNativeBalance } from './wallet-balance-format';
import { solanaTokenAtoms } from './solana-token-amount';
import { balanceRpc } from './wallet-balances';
import { getSolanaIndexerRpcEndpoint } from './solana-rpc';
import { tokenExtensionNames } from './token-extension-names';
export type WarmupMintObservation = {
  mint: string;
  program: string;
  decimals: number;
  slot: number;
  extensions: string[];
};
export class WarmupSellAmountError extends Error {}
// Trade assessment needs the chosen mint's account inventory, not a portfolio.
export type SellInventoryEvidence = Pick<
  HoldingsSnapshot,
  | 'chain'
  | 'address'
  | 'holdings'
  | 'minSlot'
  | 'maxSlot'
  | 'observedAt'
  | 'source'
>;
export function assessWarmupSellInventory(
  snapshot: SellInventoryEvidence,
  wallet: string,
  mint: string,
  amount?: string,
  mintObservation?: WarmupMintObservation,
) {
  if (snapshot.chain !== 'Solana' || snapshot.address !== wallet)
    throw new Error('Inventory wallet mismatch.');
  const matches = snapshot.holdings.filter((h) => h.mint === mint);
  if (matches.length > 1) throw new Error('Ambiguous mint inventory.');
  const holding = matches[0];
  const uint = (value: string) => {
    if (!/^(0|[1-9]\d{0,19})$/.test(value) || BigInt(value) > (1n << 64n) - 1n)
      throw new Error('Invalid inventory units.');
    return BigInt(value);
  };
  if (
    holding &&
    (!TOKEN_PROGRAMS.some((p) => p === holding.program) ||
      !Number.isInteger(holding.decimals) ||
      holding.decimals < 0 ||
      holding.decimals > 255)
  )
    throw new Error('Invalid mint inventory.');
  const total = holding ? uint(holding.raw) : 0n;
  const accountTotal =
    holding?.accounts.reduce((sum, a) => sum + uint(a.raw), 0n) ?? 0n;
  if (total !== accountTotal) throw new Error('Inventory units disagree.');
  const frozen =
    holding?.accounts
      .filter((a) => a.frozen)
      .reduce((sum, a) => sum + uint(a.raw), 0n) ?? 0n;
  const available = total - frozen;
  let requested: bigint | null = null;
  if (amount !== undefined && holding) {
    try {
      requested = solanaTokenAtoms(amount, holding.decimals);
    } catch {
      throw new WarmupSellAmountError(
        'Use a positive sell amount within the observed token decimals and Solana limits.',
      );
    }
  }
  if (
    mintObservation &&
    (mintObservation.mint !== mint ||
      mintObservation.program !== holding?.program ||
      mintObservation.decimals !== holding?.decimals ||
      !Number.isSafeInteger(mintObservation.slot) ||
      mintObservation.slot < snapshot.maxSlot ||
      mintObservation.slot > snapshot.maxSlot + 64)
  )
    throw new Error('Mint observation does not match inventory.');
  const blockedExtensions: string[] = [];
  const token2022 = holding?.program === TOKEN_PROGRAMS[1];
  if (token2022) {
    if (!mintObservation) blockedExtensions.push('mint details unavailable');
    else
      for (const name of mintObservation.extensions)
        if (!['metadataPointer', 'tokenMetadata'].includes(name))
          blockedExtensions.push('mint: ' + name);
    for (const account of holding!.accounts) {
      if (!account.extensionTypes)
        blockedExtensions.push('account details unavailable');
      else
        for (const name of account.extensionTypes)
          if (name !== 'immutableOwner')
            blockedExtensions.push('account: ' + name);
    }
  } else if (holding?.accounts.some((a) => a.extensions))
    blockedExtensions.push('unsupported account extensions');
  const unsupported = blockedExtensions.length > 0;
  return {
    executionAllowed: false as const,
    wallet,
    mint,
    decimals: holding?.decimals ?? null,
    tokenProgram: holding?.program ?? null,
    mintExtensions: mintObservation?.extensions ?? null,
    accountExtensions:
      holding?.accounts.map((a) => ({
        address: a.address,
        extensions: a.extensionTypes ?? null,
      })) ?? [],
    blockedExtensions: [...new Set(blockedExtensions)],
    mintSlot: mintObservation?.slot ?? null,
    totalRaw: total.toString(),
    frozenRaw: frozen.toString(),
    unfrozenRaw: available.toString(),
    unfrozenAmount: holding
      ? formatNativeBalance(available.toString(), holding.decimals)
      : null,
    requestedRaw: requested?.toString() ?? null,
    amountCovered: requested !== null && requested <= available,
    preparationSupported: Boolean(holding) && !unsupported,
    source: snapshot.source,
    minSlot: snapshot.minSlot,
    maxSlot: snapshot.maxSlot,
    observedAt: snapshot.observedAt,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    limitations:
      'Current holdings only. These units are not linked to a warmup buy receipt. Frozen units are excluded. Token-2022 preparation accepts only metadata mint extensions and immutable-owner account extensions after a fresh mint read. Other or unknown extensions remain unsupported. Delegation, route liquidity and swap semantics remain unverified. No signing or execution clearance.',
  };
}
export async function inspectWarmupSellInventory(
  wallet: string,
  mint: string,
  signal: AbortSignal,
  amount?: string,
  fetcher: typeof fetch = fetch,
  minimumSlot = 0,
) {
  wallet = walletAddress(wallet, 'Solana');
  mint = walletAddress(mint, 'Solana');
  const snapshot = await observeWalletHoldings(
    wallet,
    signal,
    fetcher,
    minimumSlot,
  );
  const observation = await observeSellMint(
    snapshot,
    wallet,
    mint,
    signal,
    fetcher,
  );
  return assessWarmupSellInventory(snapshot, wallet, mint, amount, observation);
}
export async function observeSellMint(
  snapshot: SellInventoryEvidence,
  wallet: string,
  mint: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<WarmupMintObservation | undefined> {
  if (snapshot.chain !== 'Solana' || snapshot.address !== wallet)
    throw new Error('Inventory wallet mismatch.');
  const holding = snapshot.holdings.find((h) => h.mint === mint);
  if (!holding) return undefined;
  const result = (await balanceRpc(
    getSolanaIndexerRpcEndpoint(),
    'getAccountInfo',
    [
      mint,
      {
        commitment: 'confirmed',
        encoding: 'jsonParsed',
        minContextSlot: snapshot.maxSlot,
      },
    ],
    signal,
    fetcher,
  )) as {
    context?: { slot?: unknown };
    value?: {
      owner?: string;
      executable?: boolean;
      data?: {
        space?: unknown;
        parsed?: {
          type?: string;
          info?: {
            decimals?: unknown;
            isInitialized?: boolean;
            extensions?: unknown;
          };
        };
      };
    };
  };
  const account = result?.value,
    info = account?.data?.parsed?.info;
  const slot = Number(result?.context?.slot);
  if (
    !account ||
    account.owner !== holding.program ||
    account.executable !== false ||
    account.data?.parsed?.type !== 'mint' ||
    info?.isInitialized !== true ||
    String(info.decimals) !== String(holding.decimals) ||
    !Number.isSafeInteger(slot) ||
    slot < snapshot.maxSlot ||
    slot > snapshot.maxSlot + 64
  )
    throw new Error('Mint observation mismatch.');
  const extensions =
    holding.program === TOKEN_PROGRAMS[0]
      ? []
      : info.extensions !== undefined
        ? tokenExtensionNames(info.extensions)
        : account.data?.space === '82'
          ? []
          : null;
  if (extensions === null) return undefined;
  return {
    mint,
    program: holding.program,
    decimals: holding.decimals,
    slot,
    extensions,
  };
}
export type WarmupSellInventory = ReturnType<typeof assessWarmupSellInventory>;
