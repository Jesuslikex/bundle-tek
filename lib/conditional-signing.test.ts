import { it, expect } from 'vitest';
import {
  validatedConditionalSigning,
  sameConditionalTerms,
} from './conditional-signing';
import { conditionalLevelStatuses } from './conditional-level-status';
import { conditionalSellTerms } from './conditional-sell-order';
import {
  acquisitionId as id,
  acquisitionWallet as wallet,
  acquisitionMint as mint,
} from '../test/imported-sell-acquisition-fixture';
const now = Date.now();
const capture = {
  format: 'conditional-preparation-v1' as const,
  orderId: id(1),
  orderRevision: 1,
  level: 1,
  termsSha256: 'a'.repeat(64),
  pair: mint,
  direction: 'at-or-above' as const,
  targetUsd: '100',
  unitsRaw: '1',
  observedMarketCapUsd: '110',
  observedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 30000).toISOString(),
  source: 'api.dexscreener.com' as const,
};
it('validates fresh exact conditional captures and keeps expired history readable', () => {
  expect(validatedConditionalSigning(capture, '1', now)).toEqual(capture);
  expect(() =>
    validatedConditionalSigning(capture, '1', now + 30000),
  ).toThrow();
  expect(validatedConditionalSigning(capture, '1')).toEqual(capture);
  for (const patch of [
    { unitsRaw: '2' },
    { level: 51 },
    { observedMarketCapUsd: '99' },
    { expiresAt: new Date(now + 60000).toISOString() },
    { source: 'unknown' },
    { termsSha256: 'xyz' },
    { orderRevision: 0 },
    { extra: true },
  ])
    expect(() =>
      validatedConditionalSigning({ ...capture, ...patch }, '1', now),
    ).toThrow();
  expect(
    sameConditionalTerms(capture, {
      ...capture,
      observedAt: new Date(now + 1).toISOString(),
    }),
  ).toBe(true);
  expect(sameConditionalTerms(capture, { ...capture, targetUsd: '101' })).toBe(
    false,
  );
});
it('validates reserved and filled status against saved exact units, rejecting duplicates or foreign levels', () => {
  const terms = conditionalSellTerms(
    {
      projectId: id(2),
      projectRevision: 1,
      wallet,
      walletRevision: 1,
      pair: mint,
      kind: 'limit',
      direction: 'at-or-above',
      amount: '0.000001',
      targetUsd: '100',
    },
    { chain: 'Solana', address: mint, decimals: 6 },
  );
  const order = {
    id: id(1),
    revision: 1,
    state: 'draft' as const,
    terms,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
  const status = {
    orderId: order.id,
    level: 1,
    intentId: id(3),
    unitsRaw: '1',
    state: 'awaiting_signature' as const,
    signature: null,
    receiptId: null,
  };
  expect(conditionalLevelStatuses([status], [order])).toEqual([status]);
  const fill = {
    ...status,
    state: 'filled' as const,
    signature: '1'.repeat(88),
    receiptId: id(4),
  };
  expect(conditionalLevelStatuses([fill], [order])).toEqual([fill]);
  for (const rows of [
    [status, status],
    [{ ...status, unitsRaw: '2' }],
    [{ ...status, orderId: id(5) }],
    [{ ...fill, receiptId: null }],
    [{ ...status, state: 'failed' }],
  ])
    expect(() => conditionalLevelStatuses(rows, [order])).toThrow();
});
