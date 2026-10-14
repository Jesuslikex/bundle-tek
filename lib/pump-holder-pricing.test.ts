import { expect, it } from 'vitest';
import {
  pumpExactQuoteTarget,
  projectPumpHolderSequence,
} from './pump-holder-pricing';
import { decodePumpInitialBuyState } from './pump-initial-buy-state';
import { initialBuyFeeFixture } from '../test/pump-initial-buy-simulation-fixture';
const context = () => ({
  quoteMint: 'So11111111111111111111111111111111111111112',
  curve: {
    virtualTokensRaw: '1000',
    virtualQuoteRaw: '100',
    realTokensRaw: '900',
  },
  feeConfig: decodePumpInitialBuyState('FeeConfig', initialBuyFeeFixture()),
});
it('matches the independent exact-quote integer example and enforces the reviewed minimum', () => {
  const c = context();
  // floor(100*10000/10125)=98; ceil(98*.0095)=1, ceil(98*.003)=1.
  // floor((98-1)*1000/(100+98-1))=492.
  expect(
    pumpExactQuoteTarget({
      ...c,
      quoteAmountRaw: '100',
      minimumTokenOutputRaw: '490',
    }),
  ).toMatchObject({
    tokenAmountRaw: '492',
    sdkNetQuoteRaw: '98',
    protocolFeeRaw: '1',
    creatorFeeRaw: '1',
    projectedNetAndFeesRaw: '100',
    quoteRoundingRemainderRaw: '0',
    settlementValidated: false,
    observedSettlementRequired: true,
  });
  expect(() =>
    pumpExactQuoteTarget({
      ...c,
      quoteAmountRaw: '100',
      minimumTokenOutputRaw: '493',
    }),
  ).toThrow('minimum');
});
it('preserves a quote rounding remainder rather than claiming the whole budget was spent', () => {
  const c = context();
  c.feeConfig.fee_tiers = [
    {
      market_cap_lamports_threshold: 0n,
      fees: { lp_fee_bps: 0n, protocol_fee_bps: 5000n, creator_fee_bps: 5000n },
    },
  ];
  expect(
    pumpExactQuoteTarget({
      ...c,
      quoteAmountRaw: '5',
      minimumTokenOutputRaw: '1',
    }),
  ).toMatchObject({
    sdkNetQuoteRaw: '2',
    tokenAmountRaw: '9',
    projectedNetAndFeesRaw: '4',
    quoteBudgetRaw: '5',
    quoteRoundingRemainderRaw: '1',
  });
});
it('replays output buys against updated reserves and retains inactive slots', () => {
  const result = projectPumpHolderSequence({
    ...context(),
    trades: [
      {
        address: 'first',
        kind: 'exact-base-output',
        tokenAmountRaw: '100',
        maximumQuoteCostRaw: '100',
      },
      { address: 'inactive', kind: 'none' },
      {
        address: 'second',
        kind: 'exact-base-output',
        tokenAmountRaw: '100',
        maximumQuoteCostRaw: '100',
      },
    ],
  });
  expect(result.rows.map((r) => r.projectedQuoteCostRaw)).toEqual([
    '14',
    '0',
    '17',
  ]);
  expect(result).toMatchObject({
    totalTokenOutputRaw: '200',
    projectedQuoteCostRaw: '31',
    projectedProtocolFeeRaw: '2',
    projectedCreatorFeeRaw: '2',
    finalCurve: {
      virtualTokensRaw: '800',
      virtualQuoteRaw: '127',
      realTokensRaw: '700',
    },
    signingAllowed: false,
    executionAllowed: false,
    settlementValidated: false,
  });
});
it('re-evaluates native fee tiers as the projected market cap crosses a threshold', () => {
  const c = context();
  c.feeConfig.fee_tiers = [
    {
      market_cap_lamports_threshold: 0n,
      fees: { lp_fee_bps: 0n, protocol_fee_bps: 95n, creator_fee_bps: 30n },
    },
    {
      market_cap_lamports_threshold: 120000000000000n,
      fees: { lp_fee_bps: 0n, protocol_fee_bps: 5000n, creator_fee_bps: 0n },
    },
  ];
  const result = projectPumpHolderSequence({
    ...c,
    trades: [
      {
        address: 'first',
        kind: 'exact-base-output',
        tokenAmountRaw: '100',
        maximumQuoteCostRaw: '100',
      },
      {
        address: 'second',
        kind: 'exact-base-output',
        tokenAmountRaw: '100',
        maximumQuoteCostRaw: '100',
      },
    ],
  });
  expect(result.rows[0]).toMatchObject({
    projectedQuoteCostRaw: '14',
    protocolFeeRaw: '1',
    creatorFeeRaw: '1',
  });
  expect(result.rows[1]).toMatchObject({
    projectedQuoteCostRaw: '23',
    protocolFeeRaw: '8',
    creatorFeeRaw: '0',
  });
});
it('keeps quote-input projections distinct and does not reuse the initial curve price for following buys', () => {
  const result = projectPumpHolderSequence({
    ...context(),
    trades: [
      {
        address: 'quote-buyer',
        kind: 'exact-quote-input',
        quoteAmountRaw: '100',
        minimumTokenOutputRaw: '490',
      },
      {
        address: 'following',
        kind: 'exact-base-output',
        tokenAmountRaw: '100',
        maximumQuoteCostRaw: '100',
      },
    ],
  });
  expect(result.rows[0]).toMatchObject({
    tokenAmountRaw: '492',
    projectedPrincipalRaw: '98',
  });
  expect(result.rows[1]).toMatchObject({
    projectedPrincipalRaw: '49',
    projectedQuoteCostRaw: '51',
  });
  expect(result.observedSettlementRequired).toBe(true);
});
it('rejects budget shortfalls, too-small quote inputs, exhausted curves, overflow and malformed fees', () => {
  const c = context();
  expect(() =>
    projectPumpHolderSequence({
      ...c,
      trades: [
        {
          address: 'buyer',
          kind: 'exact-base-output',
          tokenAmountRaw: '100',
          maximumQuoteCostRaw: '13',
        },
      ],
    }),
  ).toThrow('quote cap');
  expect(() =>
    pumpExactQuoteTarget({
      ...c,
      quoteAmountRaw: '1',
      minimumTokenOutputRaw: '1',
    }),
  ).toThrow('too small');
  expect(() =>
    pumpExactQuoteTarget({
      ...c,
      curve: { ...c.curve, realTokensRaw: '492' },
      quoteAmountRaw: '100',
      minimumTokenOutputRaw: '1',
    }),
  ).toThrow('migration');
  expect(() =>
    projectPumpHolderSequence({
      ...c,
      curve: { ...c.curve, virtualQuoteRaw: '18446744073709551615' },
      trades: [
        {
          address: 'buyer',
          kind: 'exact-base-output',
          tokenAmountRaw: '1',
          maximumQuoteCostRaw: '18446744073709551615',
        },
      ],
    }),
  ).toThrow('overflows');
  c.feeConfig.fee_tiers = [
    {
      market_cap_lamports_threshold: 0n,
      fees: { lp_fee_bps: 0n, protocol_fee_bps: 10001n, creator_fee_bps: 0n },
    },
  ];
  expect(() =>
    pumpExactQuoteTarget({
      ...c,
      quoteAmountRaw: '100',
      minimumTokenOutputRaw: '1',
    }),
  ).toThrow('fee rates');
});
