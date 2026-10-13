import { readCounterProviderResponse } from './counter-provider-response';
import { decodeCounterPlan, type CounterPlan } from './counter-trade-store';
import { WRAPPED_SOL, WarmupQuoteError } from './warmup-swap-quote';
import { walletAddress } from './wallet-workspace';
const MAX = (1n << 64n) - 1n;
function amount(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(value) ||
    BigInt(value) > MAX
  )
    throw new WarmupQuoteError(
      'Invalid Counter quote amount.',
      'INVALID_RESPONSE',
    );
  return BigInt(value);
}
/** Server-side quote request. Provider payload stays private to preparation. */
export async function requestCounterBuyQuote(
  value: CounterPlan,
  decisionIdentity: string,
  maximumSolInputRaw: string,
  apiKey: string | undefined,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const plan = decodeCounterPlan(structuredClone(value));
  const proposal = plan.ledger.decisions.find(
    (d) => d.identity === decisionIdentity,
  );
  if (
    plan.state !== 'active' ||
    plan.rules.responseSide !== 'Buy' ||
    proposal?.outcome !== 'proposal' ||
    proposal.proposalTokenRaw === null
  )
    throw new WarmupQuoteError(
      'Choose a recorded proposal in an active Counter Buy plan.',
    );
  const target = amount(proposal.proposalTokenRaw),
    budget = amount(maximumSolInputRaw);
  const mint = walletAddress(plan.ledger.scope.mint, 'Solana');
  if (mint === WRAPPED_SOL)
    throw new WarmupQuoteError(
      'Counter Buy needs a token distinct from wrapped SOL.',
    );
  if (!apiKey?.trim() || apiKey.length > 1000 || /\s/.test(apiKey))
    throw new WarmupQuoteError(
      'Jupiter quote service is not configured or has invalid configuration.',
    );
  const url = new URL('https://api.jup.ag/swap/v1/quote');
  url.search = new URLSearchParams({
    inputMint: WRAPPED_SOL,
    outputMint: mint,
    amount: target.toString(),
    swapMode: 'ExactOut',
    slippageBps: '50',
    restrictIntermediateTokens: 'true',
    instructionVersion: 'V1',
    asLegacyTransaction: 'false',
  }).toString();
  if (signal.aborted)
    throw new WarmupQuoteError('Counter quote was cancelled.');
  const providerSignal = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { 'x-api-key': apiKey },
      signal: providerSignal,
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch {
    throw new WarmupQuoteError(
      'Exact-output quote request unavailable. Retry with a fresh review.',
    );
  }
  if (signal.aborted) {
    await response.body?.cancel().catch(() => undefined);
    throw new WarmupQuoteError('Counter quote was cancelled.');
  }
  if (!response.ok)
    throw new WarmupQuoteError(
      response.status === 401 || response.status === 403
        ? 'Jupiter quote service authentication failed.'
        : response.status === 429
          ? 'Jupiter quote service rate limit reached. Retry later.'
          : 'Exact-output quote unavailable. This route may not support the recorded target.',
    );
  const data = await readCounterProviderResponse(
    response,
    providerSignal,
    'Counter quote',
    262144,
  );
  if (data.error !== undefined || data.errorCode !== undefined)
    throw new WarmupQuoteError(
      'Counter quote provider rejected the target.',
      'PROVIDER_REJECTED',
    );
  if (
    data.inputMint !== WRAPPED_SOL ||
    data.outputMint !== mint ||
    data.swapMode !== 'ExactOut' ||
    data.slippageBps !== 50 ||
    amount(data.outAmount) !== target
  )
    throw new WarmupQuoteError(
      'Counter quote parameters differ from the recorded target.',
      'PARAMETER_MISMATCH',
    );
  const required = amount(data.inAmount),
    ceiling = amount(data.otherAmountThreshold);
  if (
    ceiling < required ||
    ceiling > (required * 10050n + 9999n) / 10000n ||
    ceiling > budget
  )
    throw new WarmupQuoteError(
      'Counter Buy exceeds the reviewed SOL input limit or quote protection.',
      'OUTPUT_PROTECTION',
    );
  if (data.platformFee !== undefined && data.platformFee !== null) {
    const fee = data.platformFee as { amount?: unknown; feeBps?: unknown };
    if (
      typeof fee !== 'object' ||
      !fee ||
      fee.amount !== '0' ||
      fee.feeBps !== 0
    )
      throw new WarmupQuoteError(
        'Counter quote contains an unrequested platform fee.',
        'PARAMETER_MISMATCH',
      );
  }
  if (
    !Number.isSafeInteger(data.contextSlot) ||
    Number(data.contextSlot) < 0 ||
    !Array.isArray(data.routePlan) ||
    !data.routePlan.length ||
    data.routePlan.length > 100
  )
    throw new WarmupQuoteError(
      'Counter quote route context is invalid.',
      'INVALID_RESPONSE',
    );
  const routes = data.routePlan.map((step: unknown) => {
    const route = step as {
      swapInfo?: {
        label?: unknown;
        ammKey?: unknown;
        inputMint?: unknown;
        outputMint?: unknown;
        inAmount?: unknown;
        outAmount?: unknown;
      };
    };
    const info = route?.swapInfo;
    if (
      !info ||
      typeof info.label !== 'string' ||
      !info.label.trim() ||
      info.label.length > 128 ||
      info.label
        .split('')
        .some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
      throw new WarmupQuoteError(
        'Counter quote route is invalid.',
        'INVALID_RESPONSE',
      );
    try {
      return {
        label: info.label,
        amm: walletAddress(info.ammKey, 'Solana'),
        inputMint: walletAddress(info.inputMint, 'Solana'),
        outputMint: walletAddress(info.outputMint, 'Solana'),
        inAmount: amount(info.inAmount).toString(),
        outAmount: amount(info.outAmount).toString(),
      };
    } catch {
      throw new WarmupQuoteError(
        'Counter quote route is invalid.',
        'INVALID_RESPONSE',
      );
    }
  });
  if (signal.aborted)
    throw new WarmupQuoteError('Counter quote was cancelled.');
  const observedAt = new Date().toISOString();
  const quote = {
    format: 'counter-buy-target-quote-v1' as const,
    executionAllowed: false as const,
    projectId: plan.projectId,
    projectRevision: plan.ledger.scope.revision,
    planId: plan.id,
    planRevision: plan.revision,
    decisionIdentity,
    inputMint: WRAPPED_SOL,
    outputMint: mint,
    outputTargetRaw: target.toString(),
    requiredSolInputRaw: required.toString(),
    maximumSolInputRaw: ceiling.toString(),
    reviewedSolBudgetRaw: budget.toString(),
    swapMode: 'ExactOut' as const,
    slippageBps: 50,
    contextSlot: Number(data.contextSlot),
    routes,
    source: 'api.jup.ag' as const,
    observedAt,
    expiresAt: new Date(Date.parse(observedAt) + 30000).toISOString(),
    limitations:
      'Quote-only pricing of a retained proposal. No wallet, transaction, signing or submission. Fresh source eligibility, mint extensions, balance, network/rent fees and durable proposal consumption must be verified independently before transaction review.',
  };
  return { quote, providerQuote: data };
}
/** Public pricing result excludes provider transaction and request material. */
export async function quoteCounterBuyProposal(
  ...args: Parameters<typeof requestCounterBuyQuote>
) {
  return (await requestCounterBuyQuote(...args)).quote;
}
export type CounterBuyTargetQuote = Awaited<
  ReturnType<typeof quoteCounterBuyProposal>
>;
