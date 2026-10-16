import { afterEach, expect, it } from 'vitest';
import { pairOrderFixture } from '../test/pair-order-fixture';
import { prepareOwnedImportedPairOrder } from './imported-pair-order-candidate';
import {
  assertPairOrderQuoteBounds,
  PairOrderQuoteBoundsError,
} from './pair-order-quote-bounds';
let fixture: Awaited<ReturnType<typeof pairOrderFixture>> | undefined;
afterEach(() => {
  fixture?.close();
  fixture = undefined;
});
it('preserves the captured one-unit refusal without changing raw units or the original bound', async () => {
  const f = (fixture = await pairOrderFixture());
  const candidate = await prepareOwnedImportedPairOrder(
    f.db,
    'alice',
    f.orderRequest,
    new AbortController().signal,
    f.orderDependencies,
  );
  // Values from the public 2026-10-15T23:50:40Z capture; no captured wallet or packet is needed.
  const quote = structuredClone(candidate.preflight.quote),
    order = structuredClone(candidate.order);
  quote.quote.minimumOutAmount = '28886';
  order.minimumOutAmount = '28885';
  expect(() => assertPairOrderQuoteBounds(quote, order, f.wallet)).toThrow(
    PairOrderQuoteBoundsError,
  );
  expect(quote.quote.minimumOutAmount).toBe('28886');
  order.minimumOutAmount = '28886';
  expect(() =>
    assertPairOrderQuoteBounds(quote, order, f.wallet),
  ).not.toThrow();
  order.minimumOutAmount = '28887';
  expect(() =>
    assertPairOrderQuoteBounds(quote, order, f.wallet),
  ).not.toThrow();
});
it.each([
  'input-mint',
  'output-mint',
  'side',
  'input',
  'slippage',
  'wallet',
  'execution',
  'fee',
  'raw-overflow',
] as const)('refuses changed %s context', async (mode) => {
  const f = (fixture = await pairOrderFixture()),
    c = await prepareOwnedImportedPairOrder(
      f.db,
      'alice',
      f.orderRequest,
      new AbortController().signal,
      f.orderDependencies,
    );
  const order = structuredClone(c.order);
  if (mode === 'input-mint') order.inputMint = order.outputMint;
  if (mode === 'output-mint') order.outputMint = order.inputMint;
  if (mode === 'side') order.side = order.side === 'Buy' ? 'Sell' : 'Buy';
  if (mode === 'input')
    order.inAmount = (BigInt(order.inAmount) + 1n).toString();
  if (mode === 'slippage') order.slippageBps = 51;
  if (mode === 'wallet') order.preparation.wallet = order.inputMint;
  if (mode === 'execution') Object.assign(order, { executionAllowed: true });
  if (mode === 'fee') order.platformFee = { bps: 1, mint: order.inputMint };
  if (mode === 'raw-overflow') order.minimumOutAmount = '18446744073709551616';
  expect(() =>
    assertPairOrderQuoteBounds(c.preflight.quote, order, f.wallet),
  ).toThrow();
  expect(() =>
    assertPairOrderQuoteBounds(
      c.preflight.quote,
      order,
      f.wallet,
      'fresh-reference',
    ),
  ).toThrow();
});
it.each([
  ['999000', true],
  ['998999', false],
  ['1000001', true],
] as const)(
  'fresh reference boundary accepts %s only when within 0.1%%: %s',
  async (minimum, accepted) => {
    const f = (fixture = await pairOrderFixture());
    const c = await prepareOwnedImportedPairOrder(
      f.db,
      'alice',
      f.orderRequest,
      new AbortController().signal,
      f.orderDependencies,
    );
    c.preflight.quote.quote.minimumOutAmount = '1000000';
    c.order.minimumOutAmount = minimum;
    const check = () =>
      assertPairOrderQuoteBounds(
        c.preflight.quote,
        c.order,
        f.wallet,
        'fresh-reference',
      );
    if (accepted) expect(check).not.toThrow();
    else expect(check).toThrow(PairOrderQuoteBoundsError);
    if (minimum === '999000')
      expect(() =>
        assertPairOrderQuoteBounds(c.preflight.quote, c.order, f.wallet),
      ).toThrow(PairOrderQuoteBoundsError);
  },
);
it('uses the exact cross-product beyond safe Number precision', async () => {
  const f = (fixture = await pairOrderFixture());
  const c = await prepareOwnedImportedPairOrder(
    f.db,
    'alice',
    f.orderRequest,
    new AbortController().signal,
    f.orderDependencies,
  );
  const reference = 18446744073709551615n;
  c.preflight.quote.quote.minimumOutAmount = reference.toString();
  c.order.minimumOutAmount = ((reference * 9990n + 9999n) / 10000n).toString();
  expect(() =>
    assertPairOrderQuoteBounds(
      c.preflight.quote,
      c.order,
      f.wallet,
      'fresh-reference',
    ),
  ).not.toThrow();
  c.order.minimumOutAmount = (BigInt(c.order.minimumOutAmount) - 1n).toString();
  expect(() =>
    assertPairOrderQuoteBounds(
      c.preflight.quote,
      c.order,
      f.wallet,
      'fresh-reference',
    ),
  ).toThrow();
});
