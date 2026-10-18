import { expect, it } from 'vitest';
import bs58 from 'bs58';
import { exchangeOrderHistoryFixture } from '../test/exchange-order-history-fixture';
import {
  decodeExchangeOrderHistory,
  decodeExchangeOrderHistoryDetail,
} from './exchange-order-history';
it('validates an exact read-only history projection', () => {
  const f = exchangeOrderHistoryFixture();
  expect(decodeExchangeOrderHistory(f.page)).toEqual(f.page);
  expect(decodeExchangeOrderHistoryDetail(f.detail)).toEqual(f.detail);
});
it.each([
  'wrong plan',
  'duplicate order',
  'bad cursor',
  'extra private field',
  'authority enabled',
  'too many rows',
])('refuses %s', (kind) => {
  const f = exchangeOrderHistoryFixture(),
    v: Record<string, unknown> = structuredClone(f.page);
  if (kind === 'wrong plan') v.planId = 'other';
  if (kind === 'duplicate order') v.items = [f.page.items[0], f.page.items[0]];
  if (kind === 'bad cursor') v.nextCursor = crypto.randomUUID();
  if (kind === 'extra private field') v.providerId = 'private';
  if (kind === 'authority enabled') v.fundingAllowed = true;
  if (kind === 'too many rows') v.items = Array(11).fill(f.page.items[0]);
  expect(() => decodeExchangeOrderHistory(v)).toThrow();
});
it('requires verified detail to bind the exact saved receiving wallet and amount', () => {
  const f = exchangeOrderHistoryFixture();
  const payout = {
    signature: bs58.encode(new Uint8Array(64).fill(4)),
    recipient: f.funder.address,
    amountRaw: f.review.expectedPayoutLamports,
    slot: 120,
    observedAt: f.review.quotedAt,
  };
  const v = {
    ...f.detail,
    state: 'payout-verified',
    approved: true,
    approvalExpiresAt: f.review.expiresAt,
    providerStatus: 'finished',
    providerReferenceRetained: true,
    payoutVerified: true,
    payout,
  };
  expect(decodeExchangeOrderHistoryDetail(v).payout?.recipient).toBe(
    f.funder.address,
  );
  for (const change of [
    { amountRaw: '1' },
    { recipient: f.detail.refundAddress },
    { signature: 'invalid' },
    { slot: -1 },
  ])
    expect(() =>
      decodeExchangeOrderHistoryDetail({
        ...v,
        payout: { ...payout, ...change },
      }),
    ).toThrow();
  expect(() =>
    decodeExchangeOrderHistoryDetail({ ...v, payoutVerified: false }),
  ).toThrow();
  expect(() =>
    decodeExchangeOrderHistoryDetail({ ...f.detail, approved: true }),
  ).toThrow();
});
