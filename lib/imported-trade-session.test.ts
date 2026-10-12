import { it, expect } from 'vitest';
import {
  tradeSessionTerms,
  validatedTradeSessionControls,
  sessionEntryNotBefore,
  requireSessionEntryDue,
  tradeSessionSchedule,
  decodeTradeSession,
  tradeSessionRequest,
  validatedTradeSessionCapture,
  validatedTradeSessionActivity,
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
  side: 'Buy',
  entries: [
    { wallet, walletRevision: 1, amount: '0.000000001' },
    {
      wallet: '11111111111111111111111111111111',
      walletRevision: 2,
      amount: '0.001',
    },
  ],
};
it('conserves exact per-wallet native or token amounts and keeps canonical immutable history', () => {
  const terms = tradeSessionTerms(input, token);
  expect(terms.totalRaw).toBe('1000001');
  expect(terms.entries[0].unitsRaw).toBe('1');
  const sell = tradeSessionTerms(
    {
      ...input,
      side: 'Sell',
      entries: input.entries.map((e) => ({ ...e, amount: '0.000001' })),
    },
    token,
  );
  expect(sell.totalRaw).toBe('2');
  const now = new Date().toISOString(),
    s = {
      id: id(2),
      revision: 1,
      state: 'active' as const,
      terms,
      createdAt: now,
      updatedAt: now,
    };
  expect(decodeTradeSession(s)).toEqual(s);
  expect(() =>
    decodeTradeSession({ ...s, terms: { ...terms, totalRaw: '2' } }),
  ).toThrow();
  for (const patch of [
    { entries: [] },
    { entries: [input.entries[0], input.entries[0]] },
    { projectRevision: 0 },
    { side: 'Other' },
    { entries: [{ ...input.entries[0], amount: '1e-9' }] },
    { entries: [{ ...input.entries[0], amount: '0.0000000001' }] },
  ])
    expect(() => tradeSessionTerms({ ...input, ...patch }, token)).toThrow();
});
it('validates entry and approval capture identities and refuses malformed or cross-session activity', () => {
  const request = { sessionId: id(2), revision: 1, entry: 2 };
  expect(tradeSessionRequest(request)).toEqual(request);
  expect(() => tradeSessionRequest({ ...request, entry: 26 })).toThrow();
  const c = {
    format: 'trade-session-entry-v1' as const,
    sessionId: id(2),
    sessionRevision: 1,
    entry: 1,
    unitsRaw: '1',
    termsSha256: 'a'.repeat(64),
  };
  expect(validatedTradeSessionCapture(c, '1')).toEqual(c);
  expect(() => validatedTradeSessionCapture(c, '2')).toThrow();
  const now = new Date().toISOString(),
    s = {
      id: id(2),
      revision: 1,
      state: 'active' as const,
      terms: tradeSessionTerms(input, token),
      createdAt: now,
      updatedAt: now,
    };
  const a = {
    sessionId: s.id,
    entry: 1,
    intentId: id(3),
    state: 'awaiting_signature',
    signature: null,
    receiptId: null,
  };
  expect(validatedTradeSessionActivity([a], [s])).toEqual([a]);
  for (const rows of [
    [a, a],
    [{ ...a, sessionId: id(4) }],
    [{ ...a, state: 'finalized' }],
    [{ ...a, entry: 25 }],
  ])
    expect(() => validatedTradeSessionActivity(rows, [s])).toThrow();
});

it('preserves version-one terms and computes exact immutable version-two UTC entry schedules', () => {
  const schedule = { startAt: '2026-10-11T10:20:30.123Z', spacingSeconds: 30 },
    terms = tradeSessionTerms({ ...input, schedule }, token);
  expect(terms.format).toBe('imported-trade-session-v2');
  expect(sessionEntryNotBefore(terms, 1)).toBe(schedule.startAt);
  expect(sessionEntryNotBefore(terms, 2)).toBe('2026-10-11T10:21:00.123Z');
  expect(
    sessionEntryNotBefore(tradeSessionTerms(input, token), 1),
  ).toBeUndefined();
  const s = {
    id: id(2),
    revision: 1,
    state: 'active' as const,
    terms,
    createdAt: schedule.startAt,
    updatedAt: schedule.startAt,
  };
  expect(decodeTradeSession(s).terms).toEqual(terms);
  expect(() =>
    decodeTradeSession({
      ...s,
      terms: { ...terms, format: 'imported-trade-session-v1' },
    }),
  ).toThrow();
  for (const invalid of [
    { ...schedule, startAt: '2026-02-30T00:00:00.000Z' },
    { ...schedule, startAt: '2026-10-11T10:20:30Z' },
    { ...schedule, spacingSeconds: 0.5 },
    { ...schedule, spacingSeconds: 86401 },
    { ...schedule, spacingSeconds: -1 },
    { ...schedule, extra: 1 },
    null,
  ])
    expect(() => tradeSessionSchedule(invalid)).toThrow();
  expect(
    tradeSessionSchedule({ ...schedule, spacingSeconds: 0 }).spacingSeconds,
  ).toBe(0);
  expect(() =>
    tradeSessionTerms(
      {
        ...input,
        schedule: {
          startAt: '2099-12-31T23:59:59.000Z',
          spacingSeconds: 86400,
        },
      },
      token,
    ),
  ).toThrow();
});
it('binds scheduled capture format and units, and refuses local signing even one millisecond early', () => {
  const c = {
    format: 'trade-session-entry-v2' as const,
    sessionId: id(2),
    sessionRevision: 1,
    entry: 1,
    unitsRaw: '1',
    termsSha256: 'a'.repeat(64),
    notBefore: '2026-10-11T10:20:30.123Z',
  };
  expect(validatedTradeSessionCapture(c, '1')).toEqual(c);
  expect(() => requireSessionEntryDue(c, Date.parse(c.notBefore) - 1)).toThrow(
    /not due/,
  );
  expect(() =>
    requireSessionEntryDue(c, Date.parse(c.notBefore)),
  ).not.toThrow();
  expect(() =>
    validatedTradeSessionCapture(
      { ...c, format: 'trade-session-entry-v1' },
      '1',
    ),
  ).toThrow();
  expect(() =>
    validatedTradeSessionCapture({ ...c, notBefore: undefined }, '1'),
  ).toThrow();
  expect(() => validatedTradeSessionCapture(c, '2')).toThrow();
});

it('validates complete owned control snapshots without enabling missing, duplicate or cross-session controls', () => {
  const now = new Date().toISOString(),
    session = {
      id: id(2),
      revision: 1,
      state: 'active' as const,
      terms: tradeSessionTerms(input, token),
      createdAt: now,
      updatedAt: now,
    },
    control = {
      sessionId: id(2),
      projectId: id(1),
      revision: 1,
      state: 'ready',
      createdAt: now,
      updatedAt: now,
    };
  expect(validatedTradeSessionControls([control], [session])).toEqual([
    control,
  ]);
  for (const v of [
    [],
    [control, control],
    [{ ...control, sessionId: id(3) }],
    [{ ...control, projectId: id(3) }],
    [{ ...control, state: 'paused' }],
    [{ ...control, revision: 0 }],
    [{ ...control, updatedAt: 'invalid' }],
  ])
    expect(() => validatedTradeSessionControls(v, [session])).toThrow();
  expect(
    validatedTradeSessionControls(
      [{ ...control, state: 'paused', revision: 2 }],
      [session],
    )[0].state,
  ).toBe('paused');
});
