import { expect, it } from 'vitest';
import { dcaTradeSessionInput } from './dca-trade-session';
import { dcaSupplyInput } from './dca-supply-sizing';
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
it('anchors a duration to the scheduled start and persists only the enforced UTC deadline', () => {
  const result = dcaTradeSessionInput(
    { ...input, durationSeconds: 180 },
    token,
  );
  expect(result.request.endsAt).toBe('2026-10-13T12:03:00.000Z');
  expect(result.terms.endsAt).toBe(result.request.endsAt);
  expect(result.request).not.toHaveProperty('durationSeconds');
  expect(tradeSessionTerms(result.request, token)).toEqual(result.terms);
  const moved = dcaTradeSessionInput(
    {
      ...input,
      startAt: '2026-10-14T12:00:00.000Z',
      durationSeconds: 180,
    },
    token,
  );
  expect(moved.terms.endsAt).toBe('2026-10-14T12:03:00.000Z');
});
it('rejects ambiguous, unsafe or too-short duration limits before producing a request', () => {
  for (const durationSeconds of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER,
  ]) {
    expect(() =>
      dcaTradeSessionInput({ ...input, durationSeconds }, token),
    ).toThrow();
  }
  expect(() =>
    dcaTradeSessionInput(
      {
        ...input,
        durationSeconds: 180,
        endsAt: '2026-10-13T12:05:00.000Z',
      },
      token,
    ),
  ).toThrow('not both');
  for (const durationSeconds of [119, 120]) {
    expect(() =>
      dcaTradeSessionInput({ ...input, durationSeconds }, token),
    ).toThrow('final scheduled cycle');
  }
  expect(
    dcaTradeSessionInput({ ...input, durationSeconds: 121 }, token).terms
      .endsAt,
  ).toBe('2026-10-13T12:02:01.000Z');
});
it('saves exact Sell supply intent and rejects altered atoms, random bounds or forged captures', () => {
  const supplyToken = {
    ...token,
    totalSupplyRaw: '17',
    observedAt: input.startAt,
  };
  const sized = dcaSupplyInput(supplyToken, {
    totalPercent: '50',
    minimumPercent: '10',
    maximumPercent: '30',
  });
  const requestInput = {
    ...input,
    side: 'Sell' as const,
    totalAmount: '0.000008',
    supplySizing: sized.sizing,
    randomization: {
      format: 'bounded-dca-allocation-v1' as const,
      minimumRaw: '2',
      maximumRaw: '5',
      totalRaw: '8',
    },
    cycleAmountsRaw: ['2', '3', '3'],
  };
  const { request, terms } = dcaTradeSessionInput(requestInput, supplyToken);
  expect(terms.totalRaw).toBe('8');
  expect(terms.supplySizing).toEqual(sized.sizing);
  expect(
    decodeTradeSession({
      id: id(2),
      revision: 1,
      state: 'active',
      terms,
      createdAt: input.startAt,
      updatedAt: input.startAt,
    }).terms,
  ).toEqual(terms);
  expect(() =>
    tradeSessionTerms({ ...request, side: 'Buy' }, supplyToken),
  ).toThrow('Only Sell');
  expect(() =>
    tradeSessionTerms(
      { ...request, supplySizing: { ...sized.sizing, totalSupplyRaw: '18' } },
      supplyToken,
    ),
  ).toThrow('capture differs');
  expect(() =>
    tradeSessionTerms(
      {
        ...request,
        randomization: { ...request.randomization!, minimumRaw: '1' },
      },
      supplyToken,
    ),
  ).toThrow('input bounds');
  const even = dcaSupplyInput(supplyToken, { totalPercent: '50' });
  const fixed = dcaTradeSessionInput(
    {
      ...input,
      side: 'Sell',
      totalAmount: '0.000008',
      supplySizing: even.sizing,
    },
    supplyToken,
  );
  expect(fixed.terms.entries.map((e) => e.unitsRaw)).toEqual(['3', '3', '2']);
  expect(() =>
    tradeSessionTerms(
      {
        ...fixed.request,
        entries: fixed.request.entries.map((e) => ({
          ...e,
          amount: '0.000004',
        })),
      },
      supplyToken,
    ),
  ).toThrow('conserve the captured');
});
it('retains reviewed randomized amounts and bounds and rejects altered or legacy misuse', () => {
  const randomization = {
    format: 'bounded-dca-allocation-v1' as const,
    minimumRaw: '2',
    maximumRaw: '5',
    totalRaw: '11',
  };
  const { request, terms } = dcaTradeSessionInput(
    { ...input, randomization, cycleAmountsRaw: ['2', '4', '5'] },
    token,
  );
  expect(terms.entries.map((e) => e.unitsRaw)).toEqual(['2', '4', '5']);
  expect(terms.totalRaw).toBe('11');
  expect(() =>
    tradeSessionTerms(
      {
        ...request,
        entries: request.entries.map((e) => ({ ...e, amount: '0.000000005' })),
      },
      token,
    ),
  ).toThrow('exact total budget');
  expect(terms.randomization).toEqual(randomization);
  const now = input.startAt;
  expect(
    decodeTradeSession({
      id: id(2),
      revision: 1,
      state: 'active',
      terms,
      createdAt: now,
      updatedAt: now,
    }).terms,
  ).toEqual(terms);
  expect(() =>
    dcaTradeSessionInput({ ...input, randomization }, token),
  ).toThrow('review every');
  expect(() =>
    dcaTradeSessionInput({ ...input, cycleAmountsRaw: ['2', '4', '5'] }, token),
  ).toThrow('Choose randomized');
  expect(() =>
    tradeSessionTerms({ ...request, randomization: undefined }, token),
  ).toThrow();
  expect(() =>
    tradeSessionTerms({ ...request, strategy: undefined }, token),
  ).toThrow('Only DCA');
  expect(() =>
    tradeSessionTerms(
      { ...request, randomization: { ...randomization, minimumRaw: '3' } },
      token,
    ),
  ).toThrow('outside');
  expect(() =>
    tradeSessionTerms(
      {
        ...request,
        entries: request.entries.map((e, i) => ({
          ...e,
          walletRevision: i + 1,
        })),
      },
      token,
    ),
  ).toThrow();
});
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
