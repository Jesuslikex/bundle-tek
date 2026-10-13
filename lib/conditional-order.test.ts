import { expect, it } from 'vitest';
import {
  CONDITIONAL_BUY_INPUT_MINT,
  conditionalOrderTerms,
  conditionalOrderSide,
  conditionalOrderInputDecimals,
  decodeConditionalOrder,
} from './conditional-order';
import { conditionalSellTerms } from './conditional-sell-order';
import { requireConditionalSwapContext } from './conditional-signing';
const mint = '11111111111111111111111111111111';
const input = {
  projectId: '11111111-1111-4111-8111-111111111111',
  projectRevision: 1,
  wallet: mint,
  walletRevision: 1,
  pair: mint,
  kind: 'limit',
  direction: 'at-or-below',
  amount: '0.001',
  targetUsd: '100',
};
const token = { chain: 'Solana', address: mint, decimals: 6 };
const saved = (terms: ReturnType<typeof conditionalOrderTerms>) => ({
  id: '22222222-2222-4222-8222-222222222222',
  revision: 1,
  state: 'draft',
  terms,
  createdAt: '2026-10-13T00:00:00.000Z',
  updatedAt: '2026-10-13T00:00:00.000Z',
});
it('preserves legacy Sell terms and fingerprints with an omitted or explicit Sell side', () => {
  const original = conditionalSellTerms(input, token);
  expect(conditionalOrderTerms(input, token)).toEqual(original);
  expect(
    JSON.stringify(conditionalOrderTerms({ ...input, side: 'Sell' }, token)),
  ).toBe(JSON.stringify(original));
  const order = decodeConditionalOrder(saved(original));
  expect(conditionalOrderSide(order)).toBe('Sell');
  expect(conditionalOrderInputDecimals(order)).toBe(6);
  expect(order.terms.totalRaw).toBe('1000');
});
it('records Buy SOL input separately from target precision and accepts reordered JSON properties', () => {
  const terms = conditionalOrderTerms({ ...input, side: 'Buy' }, token);
  expect(terms).toMatchObject({
    format: 'conditional-buy-v1',
    side: 'Buy',
    inputMint: CONDITIONAL_BUY_INPUT_MINT,
    inputDecimals: 9,
    mint,
    decimals: 6,
    totalRaw: '1000000',
  });
  const reordered = Object.fromEntries(Object.entries(terms).reverse());
  const order = decodeConditionalOrder({ ...saved(terms), terms: reordered });
  expect(order.terms).toEqual(terms);
  expect(conditionalOrderSide(order)).toBe('Buy');
  expect(conditionalOrderInputDecimals(order)).toBe(9);
});
it('allocates exact Buy grid lamports with stable ascending levels and no loss to target precision', () => {
  const terms = conditionalOrderTerms(
    {
      ...input,
      side: 'Buy',
      kind: 'grid',
      amount: '0.000000007',
      minimumUsd: '10',
      maximumUsd: '30',
      lines: 3,
    },
    { ...token, decimals: 0 },
  );
  expect(terms.levels.map((l) => l.targetUsd)).toEqual(['10', '20', '30']);
  expect(terms.levels.map((l) => l.unitsRaw)).toEqual(['2', '2', '3']);
  expect(terms.levels.map((l) => l.amount)).toEqual([
    '0.000000002',
    '0.000000002',
    '0.000000003',
  ]);
  expect(decodeConditionalOrder(saved(terms)).terms).toEqual(terms);
  expect(() =>
    conditionalOrderTerms(
      {
        ...input,
        side: 'Buy',
        kind: 'grid',
        direction: 'at-or-above',
        minimumUsd: '10',
        maximumUsd: '30',
        lines: 3,
      },
      token,
    ),
  ).toThrow();
});
it.each([
  { inputDecimals: 6 },
  { inputMint: mint },
  { side: 'Sell' },
  { decimals: 256 },
  { totalRaw: '18446744073709551616' },
  {
    levels: [{ level: 1, targetUsd: '100', unitsRaw: '1000', amount: '0.001' }],
  },
])('rejects corrupt Buy denomination or exact levels: %j', (patch) => {
  const terms = conditionalOrderTerms({ ...input, side: 'Buy' }, token);
  expect(() =>
    decodeConditionalOrder(saved({ ...terms, ...patch } as typeof terms)),
  ).toThrow();
});
it('never reinterprets a legacy conditional capture as Buy or a Buy capture as Sell', () => {
  const capture = {
    format: 'conditional-preparation-v2',
    side: 'Buy',
    inputMint: CONDITIONAL_BUY_INPUT_MINT,
    inputDecimals: 9,
    outputMint: mint,
    outputDecimals: 6,
    orderId: input.projectId,
    orderRevision: 1,
    level: 1,
    termsSha256: 'a'.repeat(64),
    pair: mint,
    direction: 'at-or-below',
    targetUsd: '100',
    unitsRaw: '1000000',
    observedMarketCapUsd: '90',
    observedAt: '2026-10-13T00:00:00.000Z',
    expiresAt: '2026-10-13T00:00:30.000Z',
    source: 'api.dexscreener.com',
  };
  const context = {
    side: 'Buy',
    inputMint: CONDITIONAL_BUY_INPUT_MINT,
    outputMint: mint,
    inputRaw: '1000000',
    outputDecimals: 6,
  };
  expect(requireConditionalSwapContext(capture, context)).toEqual(capture);
  expect(() =>
    requireConditionalSwapContext(capture, { ...context, side: 'Sell' }),
  ).toThrow();
  expect(() =>
    requireConditionalSwapContext(capture, { ...context, outputDecimals: 9 }),
  ).toThrow();
  const {
    side: _side,
    inputMint: _mint,
    inputDecimals: _decimals,
    outputMint: _output,
    outputDecimals: _outputDecimals,
    ...legacy
  } = capture;
  expect(() =>
    requireConditionalSwapContext(
      { ...legacy, format: 'conditional-preparation-v1' },
      context,
    ),
  ).toThrow();
});
