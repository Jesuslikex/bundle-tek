import {
  buildWarmupPlan,
  nativeUnits,
  warmupAtoms,
  warmupDecimal,
} from './wallet-warmup';
import { inspectToken } from './token-import';
import { observeWalletBalances } from './wallet-balances';
import type { SavedWarmup } from './wallet-warmup-storage';

export async function inspectWarmupPreflight(
  document: SavedWarmup['document'],
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const now = Date.now(),
    start = Date.parse(document.startAt);
  const plan = buildWarmupPlan(document, Math.min(now, start)),
    unit = nativeUnits(plan.chain);
  const boundedFetch: typeof fetch = (input, init) =>
    fetcher(input, {
      ...init,
      signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
    });
  const tokens: Array<{
    address: string;
    name?: string;
    symbol?: string;
    decimals?: number;
    observedAt?: string;
    source?: string;
    error?: string;
  }> = [];
  let index = 0;
  const tokenWork = Promise.all(
    Array.from({ length: Math.min(3, plan.tokens.length) }, async () => {
      while (index < plan.tokens.length && !signal.aborted) {
        const address = plan.tokens[index++];
        try {
          const token = await inspectToken(
            { chain: plan.chain, address },
            boundedFetch,
          );
          tokens.push({
            address,
            name: token.name,
            symbol: token.symbol,
            decimals: token.decimals,
            observedAt: token.observedAt,
            source: new URL(
              token.source.startsWith('http')
                ? token.source
                : `https://${token.source}`,
            ).hostname,
          });
        } catch {
          tokens.push({
            address,
            error:
              'Token identity unavailable. This token is held from execution.',
          });
        }
      }
    }),
  );
  let snapshot: Awaited<ReturnType<typeof observeWalletBalances>> | undefined;
  let balanceError: string | undefined;
  try {
    snapshot = await observeWalletBalances(
      plan.chain,
      plan.addresses,
      signal,
      boundedFetch,
    );
  } catch {
    balanceError = 'Wallet balances unavailable. Funding coverage is unknown.';
  }
  await tokenWork;
  for (const address of plan.tokens)
    if (!tokens.some((t) => t.address === address))
      tokens.push({ address, error: 'Token lookup timed out.' });
  const required =
    warmupAtoms(plan.buyAmount, unit.decimals) * BigInt(plan.cycles) +
    warmupAtoms(plan.feeReserve, unit.decimals);
  const wallets = plan.addresses.map((address) => {
    const balance = snapshot?.items.find((b) => b.address === address);
    if (!balance)
      return { address, amount: null, shortfall: null, covered: null };
    const raw = BigInt(balance.raw),
      gap = required > raw ? required - raw : 0n;
    return {
      address,
      amount: balance.amount,
      shortfall: warmupDecimal(gap, unit.decimals),
      covered: gap === 0n,
    };
  });
  const issues = [
    ...(start <= Date.now()
      ? ['Start time has passed. Update the saved schedule.']
      : []),
    ...(balanceError ? [balanceError] : []),
    ...(wallets.some((w) => w.covered === false)
      ? ['At least one wallet does not cover its configured budget.']
      : []),
    ...(tokens.some((t) => t.error)
      ? ['One or more token identities are unavailable.']
      : []),
  ];
  return {
    executionAllowed: false as const,
    status: issues.length ? ('Hold' as const) : ('Observed' as const),
    chain: plan.chain,
    currency: unit.symbol,
    requiredPerWallet: warmupDecimal(required, unit.decimals),
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    issues,
    wallets,
    tokens: plan.tokens.map((a) => tokens.find((t) => t.address === a)!),
    snapshot: snapshot
      ? {
          source: snapshot.source,
          blockNumber: snapshot.blockNumber,
          blockHash: snapshot.blockHash,
          commitment: snapshot.commitment,
          observedAt: snapshot.observedAt,
        }
      : null,
    limitations:
      'Budget and identity observations only. Fee reserve is user-selected, not a fee estimate. Tokens and balances may come from separate blocks. No swap quote, liquidity check, transfer-tax assessment, allowance, signature, scheduler or execution clearance.',
  };
}
export type WarmupPreflight = Awaited<
  ReturnType<typeof inspectWarmupPreflight>
>;
