import { describe, expect, it } from 'vitest';
import { generateKeyPairSigner } from '@solana/kit';
import { DEFAULT_LAUNCH_PLAN } from './launch-plan';
import {
  DEFAULT_VENUE_OPTIONS,
  type ProjectDocument,
} from './workspace-project';
import {
  planSnipeBuys,
  plannedSnipeQuote,
  snipeDeferred,
} from './launch-snipe';
import { decodePumpInitialBuyState } from './pump-initial-buy-state';
import { initialBuyFeeFixture } from '../test/pump-initial-buy-simulation-fixture';
import { PUMP_NATIVE_QUOTE } from './pump-launch-config';
import { planPumpOrganicSequence } from './pump-organic-sequence';

const curve = {
  virtualTokensRaw: '1073000000000000',
  virtualQuoteRaw: '30000000000',
  realTokensRaw: '793100000000000',
};
const feeConfig = () =>
  decodePumpInitialBuyState('FeeConfig', initialBuyFeeFixture()) as Record<
    string,
    unknown
  >;

async function doc(over: Partial<ProjectDocument['plan']> = {}) {
  const holders = await Promise.all(
    [0, 1, 2].map(async () => (await generateKeyPairSigner()).address),
  );
  const document = {
    plan: {
      ...DEFAULT_LAUNCH_PLAN,
      mode: 'Manual',
      developerBuy: 0,
      holdersBuy: 0,
      holdersBuyQuote: '0.3',
      holderCount: 3,
      holdersDistribution: {
        kind: 'random',
        deviationPercent: 0,
        seed: 'a'.repeat(32),
      },
      ...over,
    },
    identity: {},
    options: {
      ...DEFAULT_VENUE_OPTIONS,
      wallets: {
        chain: 'Solana',
        recipients: holders.map((address) => ({
          address,
          revision: 1,
          folderRevision: 0,
        })),
      },
    },
  } as unknown as ProjectDocument;
  return { document, holders };
}

describe('snipeDeferred / plannedSnipeQuote', () => {
  it('defers only Manual mode', () => {
    expect(snipeDeferred({ mode: 'Manual' })).toBe(true);
    for (const mode of ['Block-0', 'Quick', 'Stagger', 'Organic'] as const)
      expect(snipeDeferred({ mode })).toBe(false);
  });
  it('reads a positive saved holder quote only', () => {
    expect(
      plannedSnipeQuote({ ...DEFAULT_LAUNCH_PLAN, holdersBuyQuote: '0.5' }),
    ).toBe('0.5');
    expect(
      plannedSnipeQuote({ ...DEFAULT_LAUNCH_PLAN, holdersBuyQuote: '0' }),
    ).toBeNull();
    expect(plannedSnipeQuote(DEFAULT_LAUNCH_PLAN)).toBeNull();
  });
});

describe('planSnipeBuys', () => {
  it('splits the saved quote across saved holders in order and projects tokens sequentially', async () => {
    const { document, holders } = await doc();
    const deployer = (await generateKeyPairSigner()).address;
    const result = planSnipeBuys({
      document,
      deployer,
      quoteMint: PUMP_NATIVE_QUOTE,
      curve,
      feeConfig: feeConfig(),
    });
    expect(result.quoteSymbol).toBe('SOL');
    expect(result.totalQuoteRaw).toBe('300000000');
    expect(result.buys.map((b) => b.address)).toEqual(holders);
    const sum = result.buys.reduce((s, b) => s + BigInt(b.quoteBudgetRaw), 0n);
    expect(sum).toBe(300_000_000n);
    // Later buys see a moved curve, so equal budgets buy fewer tokens.
    const tokens = result.buys.map((b) => BigInt(b.tokenAmountRaw));
    expect(tokens.every((t) => t > 0n)).toBe(true);
    if (result.buys[0].quoteBudgetRaw === result.buys[1].quoteBudgetRaw)
      expect(tokens[1]).toBeLessThan(tokens[0]);
    // The targets feed the existing organic planner unchanged, and its
    // projected cost stays within the saved budget.
    const plan = planPumpOrganicSequence({
      mode: 'Stagger',
      buys: result.buys.map(({ address, tokenAmountRaw }) => ({
        address,
        tokenAmountRaw,
      })),
      delayMinMs: 800,
      delayMaxMs: 800,
      slippageBps: 500,
      quoteMint: PUMP_NATIVE_QUOTE,
      curve,
      feeConfig: feeConfig(),
    });
    expect(BigInt(plan.projectedQuoteCostRaw)).toBeLessThanOrEqual(
      300_000_000n,
    );
  });

  it('skips holder slots the saved distribution leaves empty', async () => {
    const { document, holders } = await doc({
      holdersDistribution: {
        kind: 'single',
        deviationPercent: 0,
        seed: 'b'.repeat(32),
      },
    });
    const result = planSnipeBuys({
      document,
      deployer: (await generateKeyPairSigner()).address,
      quoteMint: PUMP_NATIVE_QUOTE,
      curve,
      feeConfig: feeConfig(),
    });
    expect(result.buys).toHaveLength(1);
    expect(holders).toContain(result.buys[0].address);
    expect(result.buys[0].quoteBudgetRaw).toBe('300000000');
  });

  it('refuses non-Manual plans, missing amounts, wallet gaps and deployer reuse', async () => {
    const deployer = (await generateKeyPairSigner()).address;
    const args = (document: ProjectDocument, payer = deployer) => ({
      document,
      deployer: payer,
      quoteMint: PUMP_NATIVE_QUOTE,
      curve,
      feeConfig: feeConfig(),
    });
    const quick = (await doc({ mode: 'Quick' })).document;
    expect(() => planSnipeBuys(args(quick))).toThrow(/Manual mode/);
    const empty = (await doc({ holdersBuyQuote: undefined })).document;
    expect(() => planSnipeBuys(args(empty))).toThrow(/no holder buy amount/);
    const gap = (await doc({ holderCount: 4 })).document;
    expect(() => planSnipeBuys(args(gap))).toThrow(/every holder slot/);
    const { document, holders } = await doc();
    expect(() => planSnipeBuys(args(document, holders[1]))).toThrow(/deployer/);
    expect(() =>
      planSnipeBuys({ ...args(document), quoteMint: 'Unknown111' }),
    ).toThrow(/quote asset/);
    const bonk = (await doc({ launchpad: 'LetsBonk' })).document;
    expect(() => planSnipeBuys(args(bonk))).toThrow(/Pump\.fun/);
  });
});
