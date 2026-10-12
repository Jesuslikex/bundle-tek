import type { ImportedTokenProject } from './imported-token-project';
import type { HoldingsSnapshot } from './wallet-holdings';
import { TOKEN_PROGRAMS } from './wallet-holdings';
import {
  observeWalletMintHoldings,
  type MintHoldingsSnapshot,
} from './wallet-mint-holdings';
import { importedMintInventory } from './imported-mint-inventory';
import { balanceRpc } from './wallet-balances';
import { getSolanaIndexerRpcEndpoint } from './solana-rpc';
import { solanaTokenAtoms } from './solana-token-amount';
import { warmupAtoms } from './wallet-warmup';
import {
  assessWarmupSellInventory,
  observeSellMint,
  type WarmupMintObservation,
  type SellInventoryEvidence,
} from './warmup-sell-inventory';
export type ImportedSwapTokenIdentity = Pick<
  ImportedTokenProject['document']['token'],
  'chain' | 'address' | 'decimals' | 'tokenProgram'
>;
function tradeInventory(
  snapshot: HoldingsSnapshot | MintHoldingsSnapshot,
  wallet: string,
  token: ImportedSwapTokenIdentity,
): SellInventoryEvidence {
  if (!('scope' in snapshot)) return snapshot;
  const observation = importedMintInventory(
    snapshot,
    wallet,
    1,
    token.address,
    token.decimals,
  ).observation!;
  if (snapshot.program !== token.tokenProgram)
    throw new Error(
      'Holding identity does not match the saved mint. Refresh the imported identity.',
    );
  return {
    chain: snapshot.chain,
    address: snapshot.address,
    holdings: snapshot.accounts.length
      ? [
          {
            mint: snapshot.mint,
            program: snapshot.program,
            raw: snapshot.raw,
            amount: snapshot.amount,
            decimals: snapshot.decimals,
            accounts: snapshot.accounts,
          },
        ]
      : [],
    minSlot: observation.minSlot,
    maxSlot: observation.maxSlot,
    source: snapshot.source,
    observedAt: snapshot.observedAt,
  };
}
export function assessImportedSwapBalance(
  token: ImportedSwapTokenIdentity,
  wallet: string,
  side: 'Buy' | 'Sell',
  amount: string,
  evidence: HoldingsSnapshot | MintHoldingsSnapshot,
  nativeRaw: string,
  mintObservation?: WarmupMintObservation,
) {
  const snapshot = tradeInventory(evidence, wallet, token);
  if (
    token.chain !== 'Solana' ||
    snapshot.chain !== 'Solana' ||
    snapshot.address !== wallet ||
    !token.tokenProgram ||
    !TOKEN_PROGRAMS.some((program) => program === token.tokenProgram) ||
    !/^(0|[1-9]\d{0,19})$/.test(nativeRaw) ||
    BigInt(nativeRaw) > (1n << 64n) - 1n
  )
    throw new Error(
      'Balance observation does not match the saved token and wallet.',
    );
  const matches = snapshot.holdings.filter(
    (holding) => holding.mint === token.address,
  );
  if (
    matches.length > 1 ||
    matches.some(
      (holding) =>
        holding.program !== token.tokenProgram ||
        holding.decimals !== token.decimals,
    )
  )
    throw new Error(
      'Holding identity does not match the saved mint. Refresh the imported identity.',
    );
  const holding = matches[0];
  const uint = (raw: string) => {
    if (
      typeof raw !== 'string' ||
      !/^(0|[1-9]\d{0,19})$/.test(raw) ||
      BigInt(raw) > (1n << 64n) - 1n
    )
      throw new Error('Invalid token inventory units.');
    return BigInt(raw);
  };
  const total = uint(holding?.raw ?? '0');
  const accounts = holding?.accounts ?? [];
  if (
    new Set(accounts.map((a) => a.address)).size !== accounts.length ||
    accounts.some(
      (a) => typeof a.frozen !== 'boolean' || typeof a.extensions !== 'boolean',
    ) ||
    accounts.reduce((sum, a) => sum + uint(a.raw), 0n) !== total
  )
    throw new Error('Inconsistent token inventory accounts.');
  const frozen =
    holding?.accounts
      .filter((account) => account.frozen)
      .reduce((sum, account) => sum + BigInt(account.raw), 0n) ?? 0n;
  const available = total - frozen;
  if (available < 0n) throw new Error('Inconsistent frozen token units.');
  const required =
    side === 'Buy'
      ? warmupAtoms(amount, 9)
      : solanaTokenAtoms(amount, token.decimals);
  const observed = side === 'Buy' ? BigInt(nativeRaw) : available;
  const sellInventory =
    side === 'Sell'
      ? assessWarmupSellInventory(
          snapshot,
          wallet,
          token.address,
          amount,
          mintObservation,
        )
      : null;
  return {
    ...('scope' in evidence ? { inventoryScope: 'mint' as const } : {}),
    executionAllowed: false as const,
    side,
    wallet,
    mint: token.address,
    requestedRaw: required.toString(),
    nativeRaw,
    tokenRaw: total.toString(),
    frozenRaw: frozen.toString(),
    unfrozenRaw: available.toString(),
    shortfallRaw: (required > observed ? required - observed : 0n).toString(),
    amountCovered: required <= observed,
    preparationSupported:
      side === 'Buy' || sellInventory?.preparationSupported === true,
    mintExtensions: sellInventory?.mintExtensions ?? null,
    blockedExtensions: sellInventory?.blockedExtensions ?? [],
    mintSlot: sellInventory?.mintSlot ?? null,
    decimals: side === 'Buy' ? 9 : token.decimals,
    token2022: token.tokenProgram === TOKEN_PROGRAMS[1],
    source: snapshot.source,
    observedAt: snapshot.observedAt,
    expiresAt: new Date(Date.parse(snapshot.observedAt) + 60000).toISOString(),
    minSlot: snapshot.minSlot,
    maxSlot: snapshot.maxSlot,
    limitations:
      'Observed units only. Token-2022 sell preparation accepts metadata mint extensions and immutable-owner account extensions after a fresh mint read. Other or unknown extensions are unsupported. Fees, delegation, wallet signing access, route liquidity and transferability remain unverified. No execution clearance.',
  };
}
export type ImportedSwapBalance = ReturnType<
  typeof assessImportedSwapBalance
> & { nativeSlot?: number };

export async function observeImportedSwapBalance(
  token: ImportedSwapTokenIdentity,
  wallet: string,
  side: 'Buy' | 'Sell',
  amount: string,
  signal: AbortSignal,
): Promise<ImportedSwapBalance> {
  const endpoint = getSolanaIndexerRpcEndpoint();
  const evidence = await observeWalletMintHoldings(
    wallet,
    token.address,
    token.decimals,
    signal,
    fetch,
    new URL(endpoint).hostname === 'mainnet.helius-rpc.com'
      ? { pagination: 'helius-v2' }
      : {},
  );
  const snapshot = tradeInventory(evidence, wallet, token);
  const mintObservation =
    side === 'Sell' && token.tokenProgram === TOKEN_PROGRAMS[1]
      ? await observeSellMint(snapshot, wallet, token.address, signal)
      : undefined;
  const native = (await balanceRpc(
    getSolanaIndexerRpcEndpoint(),
    'getBalance',
    [
      wallet,
      {
        commitment: 'confirmed',
        minContextSlot: mintObservation?.slot ?? snapshot.maxSlot,
      },
    ],
    signal,
    fetch,
  )) as { context: { slot: string }; value: string };
  const slot = Number(native?.context?.slot);
  const observed = Date.parse(snapshot.observedAt);
  if (
    typeof native?.context?.slot !== 'string' ||
    !/^(0|[1-9]\d{0,15})$/.test(native.context.slot) ||
    !Number.isSafeInteger(slot) ||
    slot < (mintObservation?.slot ?? snapshot.maxSlot) ||
    slot - snapshot.minSlot > 64 ||
    !Number.isFinite(observed) ||
    observed > Date.now() ||
    observed + 60000 <= Date.now()
  )
    throw new Error('Balance snapshot changed or expired.');
  return {
    ...assessImportedSwapBalance(
      token,
      wallet,
      side,
      amount,
      evidence,
      native.value,
      mintObservation,
    ),
    nativeSlot: slot,
  };
}
