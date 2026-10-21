import type { SolanaSwapRuntimeReference } from './solana-swap-runtime-context';
import type { SolanaPairPreparation } from './warmup-swap-quote';
import { pairWalletUint } from './pair-wallet-evidence';
import {
  pairReviewDiagnostic,
  pairDiagnosticComparisons,
} from './pair-review-diagnostic';
export class PairOrderQuoteBoundsError extends Error {}
export const PAIR_FRESH_REFERENCE_MINIMUM_TOLERANCE_BPS = 10;
export type PairQuoteBoundsMode = 'strict' | 'fresh-reference';
/** Cheap request/response checks precede expensive RPC work and repeat in instruction review. */
export function assertPairOrderQuoteBounds(
  quote: SolanaSwapRuntimeReference,
  order: SolanaPairPreparation,
  wallet: string,
  mode: PairQuoteBoundsMode = 'strict',
) {
  if (mode !== 'strict' && mode !== 'fresh-reference')
    throw new PairOrderQuoteBoundsError('Unknown minimum-output comparison.');
  const input = quote.side === 'Buy' ? quote.pair.quote : quote.pair.base,
    output = quote.side === 'Buy' ? quote.pair.base : quote.pair.quote;
  if (
    order.inputMint !== input.address ||
    order.outputMint !== output.address ||
    order.side !== quote.side ||
    order.inAmount !== quote.inputRaw ||
    order.slippageBps !== 50 ||
    order.preparation.wallet !== wallet ||
    order.executionAllowed !== false ||
    JSON.stringify(order.platformFee ?? null) !==
      JSON.stringify(quote.quote.platformFee ?? null)
  )
    throw new PairOrderQuoteBoundsError(
      'Unsigned order differs from the selected pair, wallet, raw input or fee context. Request a fresh quote.',
    );
  const minimum = pairWalletUint(order.minimumOutAmount),
    original = pairWalletUint(quote.quote.minimumOutAmount);
  if (
    mode === 'strict'
      ? minimum < original
      : minimum * 10000n <
        original * (10000n - BigInt(PAIR_FRESH_REFERENCE_MINIMUM_TOLERANCE_BPS))
  )
    throw pairReviewDiagnostic(
      new PairOrderQuoteBoundsError(
        mode === 'strict'
          ? 'The unsigned order offers less than the original minimum output. Request a fresh quote; the original minimum was preserved.'
          : 'The unsigned order minimum is below the fresh-reference tolerance. Request a fresh quote.',
      ),
      'minimum-output',
      {
        comparisons: pairDiagnosticComparisons(
          { minimumOutputRaw: original.toString() },
          { minimumOutputRaw: minimum.toString() },
        ),
      },
    );
}
