import { expect, it } from 'vitest';
import { counterBuyFixture } from '../test/counter-buy-fixture';
import { routeReview, routeWallet } from '../test/jupiter-route-fixture';
import { quoteCounterBuyProposal } from './counter-buy-quote';
import { reviewCounterBuyRoute } from './counter-buy-instruction-review';

async function fixture() {
  const p = counterBuyFixture();
  const quote = await quoteCounterBuyProposal(
    p.plan,
    p.identity,
    '1005',
    'test-key',
    new AbortController().signal,
    async () => Response.json(p.response),
  );
  const instructions = routeReview({
    accountIndices: [5, 6, 0, 1, 1, 2, 2, 3, 4, 6, 6, 6, 6],
  });
  const call = instructions.instructions[0];
  call.accounts[8].address = quote.outputMint;
  const bytes = Uint8Array.from(call.dataHex.match(/../g)!, (v) =>
    parseInt(v, 16),
  );
  bytes.set([176, 209, 105, 168, 154, 125, 69, 62]);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(bytes.length - 19, BigInt(quote.outputTargetRaw), true);
  view.setBigUint64(bytes.length - 11, 1000n, true);
  call.dataHex = Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join(
    '',
  );
  return { ...p, quote, instructions };
}
it('binds ExactOut inspection to the saved proposal without consuming or mutating its plan', async () => {
  const f = await fixture(),
    before = structuredClone(f.plan);
  const result = reviewCounterBuyRoute(
    f.plan,
    f.identity,
    f.quote,
    '1005',
    routeWallet,
    f.instructions,
  );
  expect(result).toMatchObject({
    executionAllowed: false,
    planId: f.plan.id,
    decisionIdentity: f.identity,
    assessment: {
      status: 'Matched fields',
      executionAllowed: false,
      instructionsVerified: false,
    },
  });
  expect(f.plan).toEqual(before);
});
it('rejects changed identity, revisions, mint, target, mode, budget, source and timing', async () => {
  const f = await fixture();
  for (const changed of [
    { projectId: '00000000-0000-4000-8000-000000000099' },
    { projectRevision: 99 },
    { planId: '00000000-0000-4000-8000-000000000099' },
    { planRevision: 99 },
    { decisionIdentity: 'other' },
    { outputMint: f.quote.inputMint },
    { inputMint: f.quote.outputMint },
    { outputTargetRaw: '2' },
    { swapMode: 'ExactIn' },
    { slippageBps: 51 },
    { reviewedSolBudgetRaw: '1006' },
    { source: 'other' },
    { executionAllowed: true },
    { contextSlot: NaN },
    { observedAt: new Date(Date.now() + 60000).toISOString() },
    { expiresAt: new Date(0).toISOString() },
    {
      expiresAt: new Date(Date.parse(f.quote.observedAt) + 30001).toISOString(),
    },
  ])
    expect(() =>
      reviewCounterBuyRoute(
        f.plan,
        f.identity,
        { ...f.quote, ...changed } as typeof f.quote,
        '1005',
        routeWallet,
        f.instructions,
      ),
    ).toThrow('context changed');
  expect(() =>
    reviewCounterBuyRoute(
      f.plan,
      'other',
      f.quote,
      '1005',
      routeWallet,
      f.instructions,
    ),
  ).toThrow();
  expect(() =>
    reviewCounterBuyRoute(
      { ...f.plan, state: 'paused' },
      f.identity,
      f.quote,
      '1005',
      routeWallet,
      f.instructions,
    ),
  ).toThrow();
  expect(() =>
    reviewCounterBuyRoute(
      f.plan,
      f.identity,
      f.quote,
      '1004',
      routeWallet,
      f.instructions,
    ),
  ).toThrow();
  expect(() =>
    reviewCounterBuyRoute(
      f.plan,
      f.identity,
      f.quote,
      '1005',
      routeWallet,
      f.instructions,
      Date.parse(f.quote.expiresAt),
    ),
  ).toThrow();
});
it('retains a failed assessment for substituted transaction fields instead of authorizing signing', async () => {
  const f = await fixture();
  f.instructions.instructions[0].accounts[2].signer = false;
  expect(
    reviewCounterBuyRoute(
      f.plan,
      f.identity,
      f.quote,
      '1005',
      routeWallet,
      f.instructions,
    ),
  ).toMatchObject({
    executionAllowed: false,
    assessment: { status: 'Mismatch', checks: { walletAuthority: false } },
  });
});
