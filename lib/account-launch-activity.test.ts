import { expect, it } from 'vitest';
import {
  validatedAccountLaunchActivity,
  type AccountLaunchActivity,
} from './account-launch-activity';

const id = (n: number) =>
  `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const date = '2026-10-18T10:00:00.000Z';
const record = (n: number) => ({
  id: id(n),
  mint: '11111111111111111111111111111111',
  state: 'finalized',
  createdAt: date,
  settlementState: 'finalized',
  settledAt: date,
});
const activity = (): AccountLaunchActivity => ({
  observedAt: date,
  savedGroups: 1,
  finalizedGroups: 1,
  awaitingReview: 0,
  finalizationEvidenceMissing: 0,
  recent: [record(1)],
});

it('accepts a complete owner-scoped launch activity snapshot', () => {
  expect(validatedAccountLaunchActivity(activity())).toEqual(activity());
});

it('rejects duplicate records and counts that contradict the saved total', () => {
  const duplicated = activity();
  duplicated.savedGroups = 2;
  duplicated.recent.push({ ...record(1) });
  expect(() => validatedAccountLaunchActivity(duplicated)).toThrow(
    'Launch activity record is invalid.',
  );
  expect(() =>
    validatedAccountLaunchActivity({
      ...activity(),
      finalizedGroups: 2,
    }),
  ).toThrow('Launch activity is unavailable.');
});

it('rejects malformed mint, dates and unknown settlement payload shapes', () => {
  for (const update of [
    { mint: 'not-a-public-key' },
    { createdAt: 'yesterday' },
    { settlementState: { status: 'finalized' } },
  ]) {
    const candidate = activity();
    candidate.recent[0] = { ...record(1), ...update } as never;
    expect(() => validatedAccountLaunchActivity(candidate)).toThrow();
  }
});

it('requires the complete bounded recent sample and coherent category totals', () => {
  expect(() =>
    validatedAccountLaunchActivity({ ...activity(), recent: [] }),
  ).toThrow();
  expect(() =>
    validatedAccountLaunchActivity({ ...activity(), finalizedGroups: 0 }),
  ).toThrow('counts do not match');
  expect(() =>
    validatedAccountLaunchActivity({ ...activity(), awaitingReview: 1 }),
  ).toThrow();
  const nine = {
    ...activity(),
    savedGroups: 9,
    finalizedGroups: 9,
    recent: Array.from({ length: 8 }, (_, i) => record(9 - i)),
  };
  expect(validatedAccountLaunchActivity(nine).recent).toHaveLength(8);
});

it('rejects reversed chronology and unmatched or earlier finalization dates', () => {
  const candidate = {
    ...activity(),
    savedGroups: 2,
    finalizedGroups: 2,
    recent: [record(1), record(2)],
  };
  expect(() => validatedAccountLaunchActivity(candidate)).toThrow('ordering');
  for (const update of [
    { settledAt: null },
    { settlementState: null },
    { settledAt: '2026-10-18T09:59:59.000Z' },
  ]) {
    expect(() =>
      validatedAccountLaunchActivity({
        ...activity(),
        recent: [{ ...record(1), ...update }],
      }),
    ).toThrow();
  }
});
