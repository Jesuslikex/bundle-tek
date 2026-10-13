import { expect, it } from 'vitest';
import { dcaTradeSessionInput } from './dca-trade-session';
import {
  decodeTradeSession,
  tradeSessionTerms,
  sessionEntryNotBefore,
} from './imported-trade-session';
import {
  acquisitionId as id,
  acquisitionWallet as wallet,
  acquisitionMint as mint,
} from '../test/imported-sell-acquisition-fixture';
const token = { chain: 'Solana', address: mint, decimals: 6 };
const input = {
  projectId: id(1),
  projectRevision: 1,
  side: 'Buy' as const,
  wallet,
  walletRevision: 1,
  totalAmount: '0.000000011',
  cycles: 3,
  startAt: '2026-10-13T12:00:00.000Z',
  intervalSeconds: 60,
};
it('saves canonical DCA market-cap bounds without changing unbounded legacy terms', () => {
  const plain = dcaTradeSessionInput(input, token);
  expect(plain.terms).not.toHaveProperty('marketCapRange');
  const bounded = dcaTradeSessionInput(
    {
      ...input,
      marketCapRange: {
        pair: wallet,
        minimumUsd: '100.00',
        maximumUsd: '200.00',
      },
    },
    token,
  );
  expect(bounded.request.marketCapRange).toEqual({
    pair: wallet,
    minimumUsd: '100',
    maximumUsd: '200',
  });
  expect(bounded.terms.marketCapRange).toEqual(bounded.request.marketCapRange);
  const now = input.startAt;
  expect(
    decodeTradeSession({
      id: id(2),
      revision: 1,
      state: 'active',
      createdAt: now,
      updatedAt: now,
      terms: bounded.terms,
    }).terms,
  ).toEqual(bounded.terms);
  expect(() =>
    tradeSessionTerms(
      {
        ...plain.request,
        strategy: undefined,
        marketCapRange: bounded.terms.marketCapRange,
      },
      token,
    ),
  ).toThrow('Only DCA');
});
it('conserves SOL and token atoms and retains the exact repeated-wallet schedule', () => {
  const { terms } = dcaTradeSessionInput(input, token);
  expect(terms.format).toBe('imported-trade-session-v3');
  expect(terms.strategy).toBe('DCA');
  expect(terms.totalRaw).toBe('11');
  expect(terms.entries.map((e) => e.unitsRaw)).toEqual(['4', '4', '3']);
  expect(sessionEntryNotBefore(terms, 3)).toBe('2026-10-13T12:02:00.000Z');
  const sell = dcaTradeSessionInput(
    { ...input, side: 'Sell', totalAmount: '0.000011' },
    token,
  );
  expect(sell.terms.entries.map((e) => e.unitsRaw)).toEqual(['4', '4', '3']);
  const now = input.startAt;
  const saved = {
    id: id(2),
    revision: 1,
    state: 'active',
    terms,
    createdAt: now,
    updatedAt: now,
  };
  expect(decodeTradeSession(saved).terms).toEqual(terms);
  expect(() =>
    decodeTradeSession({
      ...saved,
      terms: { ...terms, format: 'imported-trade-session-v2' },
    }),
  ).toThrow();
});
it('rejects zero or overflowing budgets, invalid intervals, mixed wallets and unequal splits', () => {
  for (const patch of [
    { cycles: 1 },
    { cycles: 26 },
    { cycles: 2.5 },
    { totalAmount: '0.000000002' },
    { totalAmount: '18446744073.709551616' },
    { intervalSeconds: 0 },
    { intervalSeconds: 86401 },
    { intervalSeconds: 1.5 },
  ])
    expect(() => dcaTradeSessionInput({ ...input, ...patch }, token)).toThrow();
  const { request } = dcaTradeSessionInput(input, token);
  expect(() =>
    tradeSessionTerms({ ...request, strategy: 'Other' }, token),
  ).toThrow();
  expect(() =>
    tradeSessionTerms({ ...request, strategy: undefined }, token),
  ).toThrow();
  expect(() =>
    tradeSessionTerms(
      {
        ...request,
        entries: request.entries.map((e, i) =>
          i === 1 ? { ...e, wallet: '11111111111111111111111111111111' } : e,
        ),
      },
      token,
    ),
  ).toThrow();
  expect(() =>
    tradeSessionTerms(
      {
        ...request,
        entries: request.entries.map((e, i) =>
          i === 1 ? { ...e, walletRevision: 2 } : e,
        ),
      },
      token,
    ),
  ).toThrow();
  expect(() =>
    tradeSessionTerms(
      {
        ...request,
        entries: request.entries.map((e, i) => ({
          ...e,
          amount: i === 0 ? '0.000000001' : '0.000000005',
        })),
      },
      token,
    ),
  ).toThrow();
});
it('handles the maximum input atom budget without floating-point rounding', () => {
  const { terms } = dcaTradeSessionInput(
    { ...input, totalAmount: '18446744073.709551615', cycles: 25 },
    token,
  );
  expect(terms.totalRaw).toBe('18446744073709551615');
  expect(terms.entries.reduce((sum, e) => sum + BigInt(e.unitsRaw), 0n)).toBe(
    18446744073709551615n,
  );
});
it('retains an optional canonical deadline strictly after the final cycle and rejects deadlines on legacy sessions', () => {
  const endsAt = '2026-10-13T12:03:00.000Z';
  const { terms, request } = dcaTradeSessionInput({ ...input, endsAt }, token);
  expect(terms.endsAt).toBe(endsAt);
  for (const end of [
    '2026-10-13T12:02:00.000Z',
    '2026-10-13T12:01:00.000Z',
    'invalid',
  ])
    expect(() =>
      dcaTradeSessionInput({ ...input, endsAt: end }, token),
    ).toThrow();
  expect(() =>
    tradeSessionTerms(
      { ...request, strategy: undefined, entries: [request.entries[0]] },
      token,
    ),
  ).toThrow();
});
