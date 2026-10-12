import { it, expect } from 'vitest';
import {
  conditionalSellTerms,
  decodeConditionalSellOrder,
} from './conditional-sell-order';
import {
  acquisitionId as id,
  acquisitionWallet as wallet,
  acquisitionMint as mint,
} from '../test/imported-sell-acquisition-fixture';
const terms = () =>
  conditionalSellTerms(
    {
      projectId: id(1),
      projectRevision: 1,
      wallet,
      walletRevision: 1,
      pair: mint,
      kind: 'grid',
      direction: 'at-or-above',
      amount: '0.000013',
      minimumUsd: '4064',
      maximumUsd: '4877',
      lines: 5,
    },
    { chain: 'Solana', address: mint, decimals: 6 },
  );
const order = () => ({
  id: id(2),
  revision: 1,
  state: 'draft' as const,
  terms: terms(),
  createdAt: '2026-10-11T00:00:00Z',
  updatedAt: '2026-10-11T00:00:00Z',
});
it('decodes exact order terms without allowing altered allocations or target spacing', () => {
  const record = order();
  expect(decodeConditionalSellOrder(record)).toEqual(record);
  record.terms.levels[0].unitsRaw = '3';
  expect(() => decodeConditionalSellOrder(record)).toThrow();
  const changed = order();
  changed.terms.levels[1].targetUsd = '4267.26';
  expect(() => decodeConditionalSellOrder(changed)).toThrow();
});
it('rejects invalid lifecycle, amounts, precision and dates before displaying stored orders', () => {
  for (const change of [
    { revision: 2 },
    { state: 'executing' },
    { updatedAt: 'invalid' },
    { updatedAt: '2026-10-10T00:00:00Z' },
  ])
    expect(() =>
      decodeConditionalSellOrder({ ...order(), ...change }),
    ).toThrow();
  for (const change of [
    { decimals: 1000000 },
    { totalRaw: '18446744073709551616' },
    { direction: 'at-or-below' },
  ])
    expect(() =>
      decodeConditionalSellOrder({
        ...order(),
        terms: { ...terms(), ...change },
      }),
    ).toThrow();
});
