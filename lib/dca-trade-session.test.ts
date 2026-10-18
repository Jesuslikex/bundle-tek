import { expect, it } from 'vitest';
import {
  dcaTradeSessionInput,
  dcaPerCycleBudget,
  dcaStartAfter,
} from './dca-trade-session';
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
it('captures an exact delay into the existing immutable UTC schedule and duration', () => {
  const now = Date.parse('2026-10-18T03:00:00.123Z');
  expect(dcaStartAfter(now, 1)).toBe('2026-10-18T03:00:01.123Z');
  expect(dcaStartAfter(now, 86400)).toBe('2026-10-19T03:00:00.123Z');
  const startAt = dcaStartAfter(now, 3661);
  const { request, terms } = dcaTradeSessionInput(
    { ...input, startAt, durationSeconds: 180 },
    token,
  );
  expect(request.schedule.startAt).toBe('2026-10-18T04:01:01.123Z');
  expect(sessionEntryNotBefore(terms, 3)).toBe('2026-10-18T04:03:01.123Z');
  expect(terms.endsAt).toBe('2026-10-18T04:04:01.123Z');
  expect(tradeSessionTerms(request, token)).toEqual(terms);
  expect(request).not.toHaveProperty('delaySeconds');
});
it('refuses invalid or out-of-range delay and clock inputs before producing a start', () => {
  const now = Date.parse(input.startAt);
  for (const delay of [
    0,
    -1,
    86401,
    1.1,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER,
  ])
    expect(() => dcaStartAfter(now, delay)).toThrow();
  for (const clock of [
    NaN,
    Infinity,
    1.1,
    Number.MAX_SAFE_INTEGER,
    Date.parse('2099-12-31T23:59:59Z'),
    Date.parse('1999-01-01T00:00:00Z'),
  ])
    expect(() => dcaStartAfter(clock, 60)).toThrow();
});
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

it('converts fixed per-cycle atoms to an exact existing DCA budget without Number rounding', () => {
  expect(dcaPerCycleBudget('0.000000003', 9, 3)).toBe('0.000000009');
  expect(dcaPerCycleBudget('9007199254.740993', 6, 3)).toBe(
    '27021597764.222979',
  );
  const result = dcaTradeSessionInput(
    { ...input, totalAmount: dcaPerCycleBudget('0.000000003', 9, 3) },
    token,
  );
  expect(result.terms.entries.map((e) => e.unitsRaw)).toEqual(['3', '3', '3']);
  expect(tradeSessionTerms(result.request, token)).toEqual(result.terms);
});
it('maps per-cycle supply targets to the existing conservative total-supply calculation', () => {
  const captured = {
    ...token,
    totalSupplyRaw: '17',
    observedAt: '2026-10-13T12:00:00.000Z',
  };
  const percent = dcaPerCycleBudget('10', 6, 3);
  expect(percent).toBe('30');
  const sized = dcaSupplyInput(captured, { totalPercent: percent });
  expect(sized.totalRaw).toBe('5');
  const result = dcaTradeSessionInput(
    {
      ...input,
      side: 'Sell',
      totalAmount: '0.000005',
      supplySizing: sized.sizing,
    },
    captured,
  );
  expect(result.terms.entries.map((e) => e.unitsRaw)).toEqual(['2', '2', '1']);
  expect(() =>
    dcaSupplyInput(captured, { totalPercent: dcaPerCycleBudget('40', 6, 3) }),
  ).toThrow('at most 100');
});
it('refuses unsafe per-cycle inputs and overflow before constructing a total', () => {
  for (const cycles of [0, 1, 26, 1.5, NaN, Infinity])
    expect(() => dcaPerCycleBudget('1', 9, cycles)).toThrow('2 to 25');
  for (const amount of [
    '0',
    '-1',
    '1e-3',
    '0.0000000001',
    '18446744073.709551615',
  ])
    expect(() => dcaPerCycleBudget(amount, 9, 2)).toThrow();
  expect(dcaPerCycleBudget('9223372036.854775807', 9, 2)).toBe(
    '18446744073.709551614',
  );
});
