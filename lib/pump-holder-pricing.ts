import { pumpBuyFeeRates, pumpInitialBuyPrice } from './pump-initial-buy-state';
import type { PumpHolderBuy } from './pump-holder-message';
type Curve = {
  virtualTokensRaw: string;
  virtualQuoteRaw: string;
  realTokensRaw: string;
};
type Context = {
  quoteMint: string;
  curve: Curve;
  feeConfig: Record<string, unknown>;
};
const U64 = (1n << 64n) - 1n;
const uint = (value: string) => {
  if (
    typeof value !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(value) ||
    BigInt(value) > U64
  )
    throw new Error('Read positive exact quote inputs and curve reserves.');
  return BigInt(value);
};
/** SDK 4.1.0 exact-quote projection, not evidence of actual spending or settlement. */
export function pumpExactQuoteTarget(
  supplied: Context & { quoteAmountRaw: string; minimumTokenOutputRaw: string },
) {
  const input = structuredClone(supplied),
    budget = uint(input.quoteAmountRaw),
    minimum = uint(input.minimumTokenOutputRaw);
  const vt = uint(input.curve.virtualTokensRaw),
    vq = uint(input.curve.virtualQuoteRaw),
    real = uint(input.curve.realTokensRaw);
  if (real > vt)
    throw new Error('Real token reserve exceeds virtual reserves.');
  const rates = pumpBuyFeeRates({
    quoteMint: input.quoteMint,
    ...input.curve,
    feeConfig: input.feeConfig,
  });
  const fee = (net: bigint, bps: bigint) => (net * bps + 9999n) / 10000n;
  const sum = rates.protocolFeeBps + rates.creatorFeeBps;
  let net = sum === 0n ? budget : (budget * 10000n) / (10000n + sum);
  const provisional =
    net + fee(net, rates.protocolFeeBps) + fee(net, rates.creatorFeeBps);
  if (provisional > budget) net -= provisional - budget;
  if (net <= 1n)
    throw new Error('Quote budget is too small after rounded fees.');
  const amount = ((net - 1n) * vt) / (vq + net - 1n);
  if (amount < minimum || amount === 0n)
    throw new Error('Projected holder output misses its reviewed minimum.');
  if (amount >= real || amount >= vt)
    throw new Error(
      'Quote buy exhausts the curve; synthetic migration is not covered.',
    );
  if (vq + net > U64) throw new Error('Projected quote reserve exceeds u64.');
  const protocol = fee(net, rates.protocolFeeBps),
    creator = fee(net, rates.creatorFeeBps),
    cost = net + protocol + creator;
  if (cost > budget)
    throw new Error('Rounded quote fees exceed the reviewed budget.');
  return {
    tokenAmountRaw: amount.toString(),
    sdkNetQuoteRaw: net.toString(),
    protocolFeeRaw: protocol.toString(),
    creatorFeeRaw: creator.toString(),
    projectedNetAndFeesRaw: cost.toString(),
    quoteBudgetRaw: budget.toString(),
    quoteRoundingRemainderRaw: (budget - cost).toString(),
    protocolFeeBps: rates.protocolFeeBps.toString(),
    creatorFeeBps: rates.creatorFeeBps.toString(),
    observedSettlementRequired: true as const,
    settlementValidated: false as const,
  };
}

/** Projection for preparing independent simulation checks. Never a substitute for observed prefix/whole-packet settlement. */
export function projectPumpHolderSequence(
  supplied: Context & { trades: PumpHolderBuy[] },
) {
  const input = structuredClone(supplied);
  if (
    !Array.isArray(input.trades) ||
    !input.trades.length ||
    input.trades.length > 201
  )
    throw new Error('Review the bounded ordered holder trade list.');
  let vt = uint(input.curve.virtualTokensRaw),
    vq = uint(input.curve.virtualQuoteRaw),
    real = uint(input.curve.realTokensRaw);
  if (real > vt)
    throw new Error('Real token reserve exceeds virtual reserves.');
  let totalTokens = 0n,
    totalQuote = 0n,
    totalProtocol = 0n,
    totalCreator = 0n;
  const rows = input.trades.map((trade, index) => {
    const before = {
      virtualTokensRaw: vt.toString(),
      virtualQuoteRaw: vq.toString(),
      realTokensRaw: real.toString(),
    };
    if (trade.kind === 'none')
      return {
        index,
        address: trade.address,
        kind: trade.kind,
        before,
        after: before,
        tokenAmountRaw: '0',
        projectedQuoteCostRaw: '0',
        projectedPrincipalRaw: '0',
        protocolFeeRaw: '0',
        creatorFeeRaw: '0',
      };
    let amount: bigint,
      principal: bigint,
      cost: bigint,
      protocol: bigint,
      creator: bigint;
    let remainder = '0';
    if (trade.kind === 'exact-base-output') {
      amount = uint(trade.tokenAmountRaw);
      const price = pumpInitialBuyPrice({
        quoteMint: input.quoteMint,
        ...before,
        tokenAmountRaw: trade.tokenAmountRaw,
        feeConfig: input.feeConfig,
      });
      principal = BigInt(price.principalRaw);
      cost = BigInt(price.totalQuoteCostRaw);
      protocol = BigInt(price.protocolFeeRaw);
      creator = BigInt(price.creatorFeeRaw);
      if (cost > uint(trade.maximumQuoteCostRaw))
        throw new Error(
          'Sequential holder price exceeds its reviewed quote cap.',
        );
    } else if (trade.kind === 'exact-quote-input') {
      const projected = pumpExactQuoteTarget({
        quoteMint: input.quoteMint,
        feeConfig: input.feeConfig,
        curve: before,
        quoteAmountRaw: trade.quoteAmountRaw,
        minimumTokenOutputRaw: trade.minimumTokenOutputRaw,
      });
      amount = BigInt(projected.tokenAmountRaw);
      principal = BigInt(projected.sdkNetQuoteRaw);
      cost = BigInt(projected.projectedNetAndFeesRaw);
      protocol = BigInt(projected.protocolFeeRaw);
      creator = BigInt(projected.creatorFeeRaw);
      remainder = projected.quoteRoundingRemainderRaw;
    } else throw new Error('Unsupported holder amount denomination.');
    if (amount >= real || amount >= vt || vq + principal > U64)
      throw new Error('Sequential holder buy exhausts or overflows the curve.');
    vt -= amount;
    real -= amount;
    vq += principal;
    totalTokens += amount;
    totalQuote += cost;
    totalProtocol += protocol;
    totalCreator += creator;
    return {
      index,
      address: trade.address,
      kind: trade.kind,
      before,
      after: {
        virtualTokensRaw: vt.toString(),
        virtualQuoteRaw: vq.toString(),
        realTokensRaw: real.toString(),
      },
      tokenAmountRaw: amount.toString(),
      projectedQuoteCostRaw: cost.toString(),
      projectedPrincipalRaw: principal.toString(),
      protocolFeeRaw: protocol.toString(),
      creatorFeeRaw: creator.toString(),
      quoteRoundingRemainderRaw: remainder,
    };
  });
  return {
    format: 'pump-holder-pricing-projection-v1' as const,
    rows,
    totalTokenOutputRaw: totalTokens.toString(),
    projectedQuoteCostRaw: totalQuote.toString(),
    projectedProtocolFeeRaw: totalProtocol.toString(),
    projectedCreatorFeeRaw: totalCreator.toString(),
    finalCurve: {
      virtualTokensRaw: vt.toString(),
      virtualQuoteRaw: vq.toString(),
      realTokensRaw: real.toString(),
    },
    observedSettlementRequired: true as const,
    settlementValidated: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
