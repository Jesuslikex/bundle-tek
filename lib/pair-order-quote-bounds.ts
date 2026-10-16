import type { ImportedPairQuote } from './imported-trade-pair';
import type { SolanaPairPreparation } from './warmup-swap-quote';
import { pairWalletUint } from './pair-wallet-evidence';
import {
  pairReviewDiagnostic,
  pairDiagnosticComparisons,
} from './pair-review-diagnostic';
export class PairOrderQuoteBoundsError extends Error {}
/** Cheap request/response checks precede expensive RPC work and repeat in instruction review. */
export function assertPairOrderQuoteBounds(
  quote: ImportedPairQuote,
  order: SolanaPairPreparation,
  wallet: string,
) {
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
  if (minimum < original)
    throw pairReviewDiagnostic(
      new PairOrderQuoteBoundsError(
        'The unsigned order offers less than the original minimum output. Request a fresh quote; the original minimum was preserved.',
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
