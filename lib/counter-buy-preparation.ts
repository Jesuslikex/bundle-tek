import {
  getBase64Encoder,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit';
import { requestCounterBuyQuote } from './counter-buy-quote';
import { decodeCounterPlan, type CounterPlan } from './counter-trade-store';
import { reviewCounterBuyRoute } from './counter-buy-instruction-review';
import { reviewUnsignedSwapEnvelope } from './unsigned-swap-order';
import { readCounterProviderResponse } from './counter-provider-response';
import { readSwapLookupAccounts } from './swap-lookup-accounts';
import { reviewSwapInstructions } from './swap-instruction-review';
import { walletAddress } from './wallet-workspace';
import { WarmupQuoteError } from './warmup-swap-quote';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';

type LookupRpc = (
  method: string,
  params: unknown[],
  signal: AbortSignal,
) => Promise<unknown>;
const fail = (message: string) => {
  throw new WarmupQuoteError(message, 'INVALID_RESPONSE');
};
const uint = (value: unknown, positive = false): string => {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n ||
    (positive && BigInt(value) === 0n)
  )
    return fail('Invalid Counter preparation amount.');
  return value;
};

/** Build one fresh ExactOut unsigned packet. Does not persist, approve, sign or submit. */
export async function prepareCounterBuyProposal(
  value: CounterPlan,
  decisionIdentity: string,
  maximumSolInputRaw: string,
  selectedWallet: string,
  apiKey: string | undefined,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  lookupRpc?: LookupRpc,
) {
  const plan = decodeCounterPlan(structuredClone(value));
  const wallet = walletAddress(selectedWallet, 'Solana');
  const preparationSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(30000),
  ]);
  const { quote, providerQuote } = await requestCounterBuyQuote(
    plan,
    decisionIdentity,
    maximumSolInputRaw,
    apiKey,
    preparationSignal,
    fetcher,
  );
  // Only the quote fields required by Jupiter cross back to the provider. Never
  // forward provider request IDs, transactions, destination/payer overrides.
  if (
    typeof providerQuote.priceImpactPct !== 'string' ||
    !/^\d{1,4}(?:\.\d{1,30})?$/.test(providerQuote.priceImpactPct)
  )
    fail('Counter preparation quote metadata is invalid.');
  const routePlan = (providerQuote.routePlan as unknown[]).map(
    (value, index) => {
      const original = value as {
        percent?: unknown;
        bps?: unknown;
        swapInfo?: { feeAmount?: unknown; feeMint?: unknown };
      };
      const percent = original.percent,
        bps = original.bps;
      if (
        (percent === undefined && bps === undefined) ||
        (percent !== undefined &&
          (typeof percent !== 'number' ||
            !Number.isFinite(percent) ||
            percent < 0 ||
            percent > 100)) ||
        (bps !== undefined &&
          (!Number.isInteger(bps) || Number(bps) < 1 || Number(bps) > 10000))
      )
        return fail('Counter preparation route weights are invalid.');
      const route = quote.routes[index];
      return {
        ...(percent !== undefined ? { percent } : {}),
        ...(bps !== undefined ? { bps } : {}),
        swapInfo: {
          ammKey: route.amm,
          label: route.label,
          inputMint: route.inputMint,
          outputMint: route.outputMint,
          inAmount: route.inAmount,
          outAmount: route.outAmount,
          feeAmount: uint(original.swapInfo?.feeAmount),
          feeMint: walletAddress(original.swapInfo?.feeMint, 'Solana'),
        },
      };
    },
  );
  const quoteResponse = {
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    inAmount: quote.requiredSolInputRaw,
    outAmount: quote.outputTargetRaw,
    otherAmountThreshold: quote.maximumSolInputRaw,
    swapMode: 'ExactOut',
    slippageBps: 50,
    priceImpactPct: providerQuote.priceImpactPct,
    routePlan,
    platformFee: null,
  };
  if (preparationSignal.aborted)
    throw new WarmupQuoteError('Counter preparation was cancelled.');
  let response: Response;
  try {
    response = await fetcher('https://api.jup.ag/swap/v1/swap', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey! },
      body: JSON.stringify({
        userPublicKey: wallet,
        quoteResponse,
        wrapAndUnwrapSol: true,
        useSharedAccounts: true,
        asLegacyTransaction: false,
        dynamicSlippage: false,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 0,
      }),
      signal: preparationSignal,
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch {
    throw new WarmupQuoteError(
      'Counter unsigned transaction request unavailable. Retry with a fresh review.',
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new WarmupQuoteError(
      response.status === 429
        ? 'Counter preparation rate limit reached. Retry later.'
        : 'Counter unsigned transaction service unavailable.',
    );
  }
  const data = await readCounterProviderResponse(
    response,
    preparationSignal,
    'Counter preparation',
    8192,
  );
  if (
    (data.simulationError !== undefined && data.simulationError !== null) ||
    data.error !== undefined ||
    data.errorCode !== undefined
  )
    throw new WarmupQuoteError(
      'Counter transaction provider rejected preparation.',
      'PROVIDER_REJECTED',
    );
  if (
    !Number.isSafeInteger(data.lastValidBlockHeight) ||
    Number(data.lastValidBlockHeight) < 1 ||
    data.prioritizationFeeLamports !== 0 ||
    data.dynamicSlippageReport != null
  )
    fail('Counter preparation protection or blockheight differs.');
  let envelope;
  try {
    envelope = await reviewUnsignedSwapEnvelope(data.swapTransaction, wallet);
  } catch {
    return fail('Counter provider returned an unsupported unsigned packet.');
  }
  const message = getCompiledTransactionMessageDecoder().decode(
    getTransactionDecoder().decode(
      getBase64Encoder().encode(envelope.transaction),
    ).messageBytes,
  );
  let lookupAccounts: Awaited<ReturnType<typeof readSwapLookupAccounts>> = null;
  if (envelope.lookupTableCount) {
    if (!lookupRpc)
      fail('Counter preparation needs mainnet lookup-account reads.');
    try {
      if (
        (await lookupRpc!('getGenesisHash', [], preparationSignal)) !==
        SOLANA_MAINNET_GENESIS
      )
        throw new Error();
      lookupAccounts = await readSwapLookupAccounts(
        message,
        quote.contextSlot,
        (method, params) => lookupRpc!(method, params, preparationSignal),
      );
    } catch {
      return fail('Counter lookup-account review unavailable or inconsistent.');
    }
  }
  const instructionReview = reviewSwapInstructions(
    message,
    lookupAccounts ?? undefined,
  );
  const review = reviewCounterBuyRoute(
    plan,
    decisionIdentity,
    quote,
    maximumSolInputRaw,
    wallet,
    instructionReview,
  );
  if (review.assessment.status !== 'Matched fields')
    throw new WarmupQuoteError(
      'Counter ExactOut instruction fields could not be matched to the retained proposal.',
      'PARAMETER_MISMATCH',
    );
  if (preparationSignal.aborted)
    throw new WarmupQuoteError('Counter preparation was cancelled.');
  return {
    format: 'counter-buy-preparation-v1' as const,
    executionAllowed: false as const,
    instructionsVerified: false as const,
    tokenDecimals: plan.ledger.scope.decimals,
    quote,
    review,
    preparation: {
      ...envelope,
      instructionReview,
      lastValidBlockHeight: uint(String(data.lastValidBlockHeight), true),
      estimatedFeesLamports: null,
      lookupAccounts,
    },
    observedAt: new Date().toISOString(),
    expiresAt: quote.expiresAt,
    limitations:
      'Unsigned provider packet with proposal-bound declared ExactOut fields. Wrapping is requested but not verified. Current database/project/wallet state, source freshness, token ownership/extensions, actual fees and aggregate debits, blockhash, independent simulation and durable proposal-use reservation are still required before explicit user approval/signing. No execution clearance.',
  };
}
export type CounterBuyPreparation = Awaited<
  ReturnType<typeof prepareCounterBuyProposal>
>;
