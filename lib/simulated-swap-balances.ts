import { solanaTokenBalanceChanges } from './solana-token-balance-changes';
import { TOKEN_PROGRAMS } from './wallet-holdings';
import { WRAPPED_SOL, type SolanaSwapPreparation } from './warmup-swap-quote';
import { walletAddress } from './wallet-workspace';
export function assessSimulatedSwapTokens(
  order: Pick<
    SolanaSwapPreparation,
    'inputMint' | 'outputMint' | 'inAmount' | 'minimumOutAmount'
  > & {
    preparation: Pick<
      SolanaSwapPreparation['preparation'],
      'wallet' | 'accountCount'
    >;
  },
  staticKeys: readonly string[],
  lookups: readonly {
    writableIndexes: readonly number[];
    readonlyIndexes: readonly number[];
  }[],
  value: {
    loadedAddresses?: unknown;
    preTokenBalances?: unknown;
    postTokenBalances?: unknown;
  },
) {
  const writableCount = lookups.reduce(
    (n, l) => n + l.writableIndexes.length,
    0,
  );
  const readonlyCount = lookups.reduce(
    (n, l) => n + l.readonlyIndexes.length,
    0,
  );
  const loaded = value.loadedAddresses as
    | { writable?: unknown; readonly?: unknown }
    | undefined;
  const loadedKeys = (raw: unknown, count: number) => {
    if (raw == null && count === 0) return [];
    if (!Array.isArray(raw) || raw.length !== count)
      throw new Error('Incomplete simulation lookup accounts.');
    return raw.map((key) => walletAddress(key, 'Solana'));
  };
  // Older providers without token metadata cannot establish token comparisons.
  if (value.preTokenBalances == null || value.postTokenBalances == null)
    return {
      tokensComplete: false,
      tokenChanges: [],
      inputAmountMatches: null,
      minimumOutputCovered: null,
    };
  const keys = [
    ...staticKeys,
    ...loadedKeys(loaded?.writable, writableCount),
    ...loadedKeys(loaded?.readonly, readonlyCount),
  ];
  if (
    keys.length !== order.preparation.accountCount ||
    keys[0] !== order.preparation.wallet
  )
    throw new Error('Simulation account envelope mismatch.');
  const tokens = solanaTokenBalanceChanges(
    keys,
    order.preparation.wallet,
    value.preTokenBalances,
    value.postTokenBalances,
  );
  const delta = (mint: string) => {
    if (!tokens.complete || mint === WRAPPED_SOL) return null;
    const entries = tokens.changes.filter((e) => e.mint === mint);
    if (
      entries.length > 1 ||
      entries.some((e) => !TOKEN_PROGRAMS.some((p) => p === e.program))
    )
      throw new Error('Ambiguous simulated mint identity.');
    return entries.length ? BigInt(entries[0].changeRaw) : 0n;
  };
  const input = delta(order.inputMint),
    output = delta(order.outputMint);
  return {
    tokensComplete: tokens.complete,
    tokenChanges: tokens.changes,
    inputAmountMatches:
      input === null ? null : input === -BigInt(order.inAmount),
    minimumOutputCovered:
      output === null ? null : output >= BigInt(order.minimumOutAmount),
  };
}
