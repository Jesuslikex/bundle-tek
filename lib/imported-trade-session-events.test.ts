import { it, expect } from 'vitest';
import {
  decodeTradeSessionEvent,
  decodeTradeSessionEventPage,
  sessionEventDetail,
  type TradeSessionEvent,
} from './imported-trade-session-events';
import { tradeSessionTerms } from './imported-trade-session';
import bs58 from 'bs58';
const projectId = '00000000-0000-4000-8000-000000000001',
  sessionId = '00000000-0000-4000-8000-000000000002',
  wallet = '11111111111111111111111111111111',
  mint = 'So11111111111111111111111111111111111111112',
  now = '2026-10-11T00:00:00.000Z';
const terms = tradeSessionTerms(
  {
    projectId,
    projectRevision: 7,
    side: 'Buy',
    entries: [{ wallet, walletRevision: 3, amount: '0.000000001' }],
  },
  { chain: 'Solana', address: mint, decimals: 6 },
);
const event: TradeSessionEvent = {
  id: 'a'.repeat(32),
  sequence: 2,
  projectId,
  sessionId,
  type: 'session.saved',
  document: {
    id: sessionId,
    revision: 1,
    state: 'active',
    terms,
    createdAt: now,
    updatedAt: now,
  },
  approval: null,
  createdAt: now,
};
it('validates captured exact session terms and distinguishes retained baseline from reconstructed transitions', () => {
  expect(decodeTradeSessionEvent(event)).toEqual(event);
  expect(sessionEventDetail(event)).toContain('project revision 7');
  expect(sessionEventDetail({ ...event, type: 'session.baseline' })).toContain(
    'prior transitions were not reconstructed',
  );
  for (const bad of [
    { ...event, sessionId: projectId },
    { ...event, sequence: 0 },
    { ...event, type: 'approval.finalized' },
    { ...event, type: 'session.cancelled' },
    {
      ...event,
      document: { ...event.document, terms: { ...terms, totalRaw: '2' } },
    },
  ])
    expect(() => decodeTradeSessionEvent(bad)).toThrow();
});
it('requires an exact approval entry, state, signature and finalized receipt identity', () => {
  const approved = {
    ...event,
    type: 'approval.finalized',
    approval: {
      id: projectId,
      preparationId: sessionId,
      entry: 1,
      state: 'finalized',
      signature: bs58.encode(new Uint8Array(64).fill(1)),
      sha256: 'a'.repeat(64),
      receiptId: projectId,
    },
  };
  expect(decodeTradeSessionEvent(approved).approval?.receiptId).toBe(projectId);
  expect(sessionEventDetail(approved as TradeSessionEvent)).toContain(
    'exact 1 atomic input units',
  );
  for (const patch of [
    { entry: 2 },
    { signature: null },
    { signature: '1' },
    { receiptId: null },
    { state: 'submitted' },
    { sha256: 'g'.repeat(64) },
  ])
    expect(() =>
      decodeTradeSessionEvent({
        ...approved,
        approval: { ...approved.approval, ...patch },
      }),
    ).toThrow();
});
it('rejects cross-context, duplicate, reordered and overlapping pages before display', () => {
  const older = { ...event, id: 'b'.repeat(32), sequence: 1 };
  const page = { events: [event, older], nextCursor: older.id };
  expect(
    decodeTradeSessionEventPage(page, projectId, sessionId, 3).events,
  ).toHaveLength(2);
  for (const bad of [
    { events: [older, event], nextCursor: event.id },
    { events: [event, event], nextCursor: event.id },
    { ...page, nextCursor: event.id },
  ])
    expect(() =>
      decodeTradeSessionEventPage(bad, projectId, sessionId),
    ).toThrow();
  expect(() => decodeTradeSessionEventPage(page, sessionId)).toThrow();
  expect(() =>
    decodeTradeSessionEventPage(page, projectId, projectId),
  ).toThrow();
  expect(() =>
    decodeTradeSessionEventPage(page, projectId, sessionId, 2),
  ).toThrow();
});

it('requires a captured matching pause or resume control revision and preserves the unchanged session terms', () => {
  const paused = {
    ...event,
    type: 'session.paused',
    control: {
      sessionId,
      projectId,
      state: 'paused',
      revision: 2,
      createdAt: now,
      updatedAt: now,
    },
  };
  expect(decodeTradeSessionEvent(paused).document.terms).toEqual(
    event.document.terms,
  );
  expect(sessionEventDetail(paused as TradeSessionEvent)).toContain(
    'control paused revision 2',
  );
  for (const control of [
    null,
    { ...paused.control, sessionId: projectId },
    { ...paused.control, revision: 1 },
    { ...paused.control, state: 'ready' },
    { ...paused.control, updatedAt: '2026-10-12T00:00:00.000Z' },
  ])
    expect(() => decodeTradeSessionEvent({ ...paused, control })).toThrow();
  expect(() =>
    decodeTradeSessionEvent({ ...paused, type: 'session.saved' }),
  ).toThrow();
  expect(
    decodeTradeSessionEvent({
      ...paused,
      type: 'session.resumed',
      control: { ...paused.control, state: 'ready', revision: 3 },
    }).control?.revision,
  ).toBe(3);
});
