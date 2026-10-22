import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { reviewWalletWarmupExecutionPacing as review } from './wallet-warmup-execution-pacing';
import { warmupSessionReviewFixture } from '@/test/warmup-session-review-fixture';

const now = Date.parse('2026-10-22T00:00:00.000Z');
const iso = (offset: number) => new Date(now + offset).toISOString();
const selection = (times: number[], end: number) => ({
  actions: times.map((time, index) => ({
    id: `action-${index}`,
    scheduledAt: iso(time),
  })),
  sessionExpiresAt: iso(end),
});
afterEach(() => vi.unstubAllGlobals());

it('keeps captured order and waits for both scheduled times and the existing 30-second gate', () => {
  const selected = selection([0, 1000, 90000, 2000], 120001);
  const before = structuredClone(selected);
  expect(review(selected, now)).toMatchObject({
    scope: 'schedule-lower-bound-only',
    status: 'qualification-required',
    fitsMinimumPacing: true,
    earliestLastStartAt: iso(120000),
    minimumGapMs: 30000,
    firstUnreachableActionId: null,
    executionAllowed: false,
    signingAllowed: false,
    automaticExecutionAllowed: false,
  });
  expect(selected).toEqual(before);
});

it('refuses exact-deadline starts and identifies the first unreachable action', () => {
  expect(review(selection([0, 0, 0], 30000), now)).toMatchObject({
    status: 'minimum-pacing-refused',
    fitsMinimumPacing: false,
    firstUnreachableActionId: 'action-1',
    earliestLastStartAt: iso(60000),
    sessionExpiresAt: iso(30000),
  });
  expect(review(selection([0, 0], 30001), now).fitsMinimumPacing).toBe(true);
});

it('does not backfill past actions or renew an expired deadline', () => {
  const selected = selection([-60000, -30000], -1);
  const result = review(selected, now);
  expect(result.firstUnreachableActionId).toBe('action-0');
  expect(result.earliestLastStartAt).toBe(iso(30000));
  expect(result.sessionExpiresAt).toBe(selected.sessionExpiresAt);
});

it('refuses a scheduled action exactly at the deadline even when owner pacing is clear', () => {
  const result = review(selection([60000], 60000), now);
  expect(result.firstUnreachableActionId).toBe('action-0');
  expect(result.status).toBe('minimum-pacing-refused');
});

it('uses a validation error for malformed dates rather than leaking a Date range error', () => {
  const selected = selection([0], 60000);
  expect(() =>
    review({ ...selected, actions: [{ id: 'a', scheduledAt: 'x' }] }, now),
  ).toThrow(z.ZodError);
  expect(() => review({ ...selected, sessionExpiresAt: 'x' }, now)).toThrow(
    z.ZodError,
  );
});

it('reports a dense real plan as impossible even before provider and finality time', () => {
  const fixture = warmupSessionReviewFixture(now, 20);
  const actions = fixture
    .response(now)
    .review.actions.map(({ id, scheduledAt }) => ({ id, scheduledAt }));
  expect(
    actions.every((action) => Date.parse(action.scheduledAt) < now + 300000),
  ).toBe(true);
  // Every scheduled time fits, but serial owner pacing cannot finish the stream.
  const result = review({ actions, sessionExpiresAt: iso(300000) }, now);
  expect(result.actionCount).toBe(40);
  expect(result.status).toBe('minimum-pacing-refused');
  expect(result.earliestLastStartEpochMs).toBeGreaterThanOrEqual(
    now + 39 * 30000,
  );
});

it('accounts for every action at the full retained-format bound without legacy truncation', () => {
  const times = Array.from({ length: 4800 }, () => 0);
  const result = review(selection(times, 4799 * 30000 + 1), now);
  expect(result.actionCount).toBe(4800);
  expect(result.earliestLastStartAt).toBe(iso(4799 * 30000));
  expect(result.fitsMinimumPacing).toBe(true);
  expect(
    review(selection(times, 4799 * 30000), now).firstUnreachableActionId,
  ).toBe('action-4799');
  expect(() => review(selection([...times, 0], 200000000), now)).toThrow();
});

it('stays fail-closed at the date limit without arithmetic overflow or an invalid ISO date', () => {
  const max = 8640000000000000;
  const result = review(selection([0, 0], 60000), max);
  expect(result.earliestLastStartEpochMs).toBe(max + 30000);
  expect(result.earliestLastStartAt).toBeNull();
  expect(result.firstUnreachableActionId).toBe('action-0');
  expect(result.fitsMinimumPacing).toBe(false);
  expect(() => review(selection([0], 60000), max + 1)).toThrow();
});

it.each([NaN, Infinity, -1, 1.5])('rejects invalid server time %s', (clock) => {
  expect(() => review(selection([0], 60000), clock)).toThrow(
    'Choose a valid server observation time.',
  );
});

it('rejects duplicate IDs, empty actions, noncanonical dates and caller policy overrides', () => {
  expect(() =>
    review(
      {
        ...selection([0, 0], 60000),
        actions: [
          { id: 'a', scheduledAt: iso(0) },
          { id: 'a', scheduledAt: iso(1) },
        ],
      },
      now,
    ),
  ).toThrow('Each captured action must have a distinct identity.');
  expect(() => review(selection([], 60000), now)).toThrow();
  expect(() =>
    review({ ...selection([0], 60000), minimumGapMs: 0 }, now),
  ).toThrow();
  expect(() =>
    review(
      {
        actions: [{ id: 'a', scheduledAt: '2026-10-22T00:00:00Z' }],
        sessionExpiresAt: iso(60000),
      },
      now,
    ),
  ).toThrow();
});

it('makes no network request and never promotes a fitting bound into signing authority', () => {
  const fetcher = vi.fn(() => {
    throw Error('No network');
  });
  vi.stubGlobal('fetch', fetcher);
  const result = review(selection([0], 60000), now);
  expect(result.status).toBe('qualification-required');
  expect(
    result.executionAllowed ||
      result.signingAllowed ||
      result.automaticExecutionAllowed,
  ).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});
