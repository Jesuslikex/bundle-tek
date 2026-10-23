import { expect, it } from 'vitest';
import {
  trackedHistoryView,
  trackedHistoryTimeLabel,
  TRACKED_HISTORY_FILTERS as defaults,
} from './tracked-history-view';
const rows = [
  {
    signature: 'Abc',
    slot: 3,
    failed: false,
    time: Date.parse('2026-10-23T00:00:00Z'),
  },
  {
    signature: 'Bcd',
    slot: 2,
    failed: true,
    time: Date.parse('2026-10-23T23:59:59.999Z'),
  },
  { signature: 'Cde', slot: 1, failed: false, time: null },
  {
    signature: 'Dde',
    slot: 4,
    failed: false,
    time: Date.parse('2026-10-24T00:00:00Z'),
  },
];
const time = (row: (typeof rows)[number]) => row.time;
it('labels UTC evidence consistently and refuses missing or malformed timestamps', () => {
  expect(trackedHistoryTimeLabel(Date.parse('2026-10-23T23:59:59.999Z'))).toBe(
    '2026-10-23 23:59:59.999 UTC',
  );
  expect(trackedHistoryTimeLabel(0)).toBe('1970-01-01 00:00:00.000 UTC');
  expect(trackedHistoryTimeLabel(null)).toBe('Time unavailable');
  expect(trackedHistoryTimeLabel(Number.NaN)).toBe('Time unavailable');
  expect(trackedHistoryTimeLabel(1e20)).toBe('Time unavailable');
});
it('keeps unknown times by default and last in either time direction, without mutating source', () => {
  expect(
    trackedHistoryView(rows, defaults, 0, time).rows.map((e) => e.signature),
  ).toEqual(['Dde', 'Bcd', 'Abc', 'Cde']);
  expect(
    trackedHistoryView(
      rows,
      { ...defaults, order: 'oldest' },
      0,
      time,
    ).rows.map((e) => e.signature),
  ).toEqual(['Abc', 'Bcd', 'Dde', 'Cde']);
  expect(rows[0].signature).toBe('Abc');
});
it('uses inclusive full UTC days, never the browser timezone or a fabricated unknown time', () => {
  expect(
    trackedHistoryView(
      rows,
      { ...defaults, from: '2026-10-23', to: '2026-10-23' },
      0,
      time,
    ).rows.map((e) => e.signature),
  ).toEqual(['Bcd', 'Abc']);
  expect(
    trackedHistoryView(rows, { ...defaults, to: '2026-10-23' }, 0, time)
      .matching,
  ).toBe(2);
  expect(
    trackedHistoryView(
      rows,
      { ...defaults, from: '2026-10-24' },
      0,
      time,
    ).rows.map((e) => e.signature),
  ).toEqual(['Dde']);
});
it('searches partial signatures case-sensitively and filters recorded error status', () => {
  expect(
    trackedHistoryView(rows, { ...defaults, search: 'c' }, 0, time).rows.map(
      (e) => e.signature,
    ),
  ).toEqual(['Bcd', 'Abc']);
  expect(
    trackedHistoryView(rows, { ...defaults, search: 'abc' }, 0, time).matching,
  ).toBe(0);
  expect(
    trackedHistoryView(
      rows,
      { ...defaults, status: 'failed' },
      0,
      time,
    ).rows.map((e) => e.signature),
  ).toEqual(['Bcd']);
  expect(
    trackedHistoryView(rows, { ...defaults, status: 'no-error' }, 0, time)
      .matching,
  ).toBe(3);
});
it.each([
  ['2026-10-24', '2026-10-23'],
  ['2026-02-30', ''],
  ['2026-2-01', ''],
  ['0000-01-01', ''],
  ['2026-10-23T01:00:00Z', ''],
  ['', 'not-a-date'],
])(
  'refuses invalid or reversed dates %s/%s without discarding loaded records',
  (from, to) => {
    expect(
      trackedHistoryView(rows, { ...defaults, from, to }, 0, time),
    ).toMatchObject({ valid: false, rows: [], loaded: 4 });
  },
);
it('pages by 25, clamps changed result counts and uses exact identity ties', () => {
  const many = Array.from({ length: 51 }, (_, i) => ({
    signature: String(i).padStart(3, '0'),
    slot: 1,
    failed: false,
    time: 10,
  }));
  expect(trackedHistoryView(many, defaults, 1, time)).toMatchObject({
    page: 1,
    pageCount: 3,
    matching: 51,
  });
  expect(trackedHistoryView(many, defaults, 1, time).rows[0].signature).toBe(
    '025',
  );
  expect(
    trackedHistoryView(many, { ...defaults, search: '050' }, 2, time),
  ).toMatchObject({ page: 0, pageCount: 1, matching: 1 });
  expect(trackedHistoryView(many, defaults, 999, time).rows).toHaveLength(1);
});
