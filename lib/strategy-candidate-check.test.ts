import { expect, it } from 'vitest';
import {
  strategyCheckFixture,
  checkHoldId,
} from '../test/strategy-check-fixture';
import {
  strategyWallet,
  strategySecond,
} from '../test/strategy-session-fixture';
import {
  buildStrategyCandidateCheck,
  requireStrategyCandidateCheck,
  type StrategyCheckMarket,
} from './strategy-candidate-check';
const at = '2026-10-18T12:00:00.000Z';
const market = (mint: string): StrategyCheckMarket => ({
  source: 'api.dexscreener.com',
  chain: 'Solana',
  address: mint,
  observedAt: at,
  returnedPairCount: 2,
  quoteOnlyPairCount: 0,
  pairs: [
    {
      address: strategyWallet,
      dex: 'pump',
      quoteSymbol: 'SOL',
      marketCapUsd: '100000',
    },
    {
      address: strategySecond,
      dex: 'raydium',
      quoteSymbol: 'USDC',
      marketCapUsd: null,
    },
  ],
});
it('returns independent pool checks without silently choosing a pool or substituting missing caps', async () => {
  const { draft, capacity } = await strategyCheckFixture(),
    data = market(draft.plan.token.address);
  const result = buildStrategyCandidateCheck(
    draft,
    capacity,
    checkHoldId,
    at,
    data,
  );
  expect(result).toMatchObject({
    status: 'market-observed',
    expiresAt: '2026-10-18T12:00:30.000Z',
    executionAllowed: false,
    signingAllowed: false,
    fundingAllowed: false,
    pools: [{ condition: 'met' }, { condition: 'unavailable' }],
  });
  expect(
    requireStrategyCandidateCheck(result, draft, capacity, checkHoldId),
  ).toEqual(result);
  data.pairs[0].marketCapUsd = '1';
  expect(result.pools[0].marketCapUsd).toBe('100000');
});
it.each(['at-or-above', 'at-or-below'] as const)(
  'compares inclusive %s thresholds with sub-micro provider precision exactly',
  async (direction) => {
    const { draft, capacity } = await strategyCheckFixture();
    const row = draft.plan.input.strategies.find((s) => s.kind === 'Limit')!;
    row.direction = direction;
    // Rebuild the plan because retained derived terms cannot be edited independently.
    const { planStrategySession } = await import('./strategy-session-plan');
    const { strategyContext } =
      await import('../test/strategy-session-fixture');
    draft.plan = planStrategySession(draft.plan.input, strategyContext());
    const { capacityDigest } = await import('./strategy-review-capacity');
    capacity.planSha256 = await capacityDigest(draft.plan);
    const data = market(draft.plan.token.address);
    data.pairs[0].marketCapUsd = '99999.999999999';
    expect(
      buildStrategyCandidateCheck(draft, capacity, checkHoldId, at, data)
        .pools[0].condition,
    ).toBe(direction === 'at-or-above' ? 'not-met' : 'met');
    data.pairs[0].marketCapUsd = '100000.000000001';
    expect(
      buildStrategyCandidateCheck(draft, capacity, checkHoldId, at, data)
        .pools[0].condition,
    ).toBe(direction === 'at-or-above' ? 'met' : 'not-met');
  },
);
it('reports scheduled, due and ended boundaries without market data and clips expiry at a boundary', async () => {
  const { draft, capacity } = await strategyCheckFixture('DCA');
  expect(
    buildStrategyCandidateCheck(
      draft,
      capacity,
      checkHoldId,
      '2026-10-18T11:59:59.000Z',
      null,
    ),
  ).toMatchObject({ status: 'scheduled', expiresAt: at });
  expect(
    buildStrategyCandidateCheck(draft, capacity, checkHoldId, at, null).status,
  ).toBe('dca-due');
  expect(
    buildStrategyCandidateCheck(
      draft,
      capacity,
      checkHoldId,
      '2026-10-18T12:04:59.000Z',
      null,
    ).expiresAt,
  ).toBe('2026-10-18T12:05:00.000Z');
  expect(
    buildStrategyCandidateCheck(
      draft,
      capacity,
      checkHoldId,
      '2026-10-18T12:05:00.000Z',
      null,
    ).status,
  ).toBe('ended');
});
it.each(['expired', 'future', 'mint', 'source', 'duplicate', 'cap'] as const)(
  'refuses %s market observations',
  async (kind) => {
    const { draft, capacity } = await strategyCheckFixture(),
      data = market(draft.plan.token.address);
    if (kind === 'expired') data.observedAt = '2026-10-18T11:59:30.000Z';
    if (kind === 'future') data.observedAt = '2026-10-18T12:00:00.001Z';
    if (kind === 'mint') data.address = strategyWallet;
    if (kind === 'source') Object.assign(data, { source: 'untrusted.test' });
    if (kind === 'duplicate') data.pairs[1].address = data.pairs[0].address;
    if (kind === 'cap') data.pairs[0].marketCapUsd = 'Infinity';
    expect(() =>
      buildStrategyCandidateCheck(draft, capacity, checkHoldId, at, data),
    ).toThrow();
  },
);
it.each(['authority', 'hold', 'status', 'expiry', 'pool'])(
  'refuses altered %s nominally successful responses',
  async (kind) => {
    const { draft, capacity } = await strategyCheckFixture();
    const result = buildStrategyCandidateCheck(
      draft,
      capacity,
      checkHoldId,
      at,
      market(draft.plan.token.address),
    );
    if (kind === 'authority') Object.assign(result, { signingAllowed: true });
    if (kind === 'hold') result.holdId = strategyWallet;
    if (kind === 'status') Object.assign(result, { status: 'ready-to-sign' });
    if (kind === 'expiry') result.expiresAt = '2026-10-18T12:00:31.000Z';
    if (kind === 'pool') result.pools[1].condition = 'met';
    expect(() =>
      requireStrategyCandidateCheck(result, draft, capacity, checkHoldId),
    ).toThrow();
  },
);
