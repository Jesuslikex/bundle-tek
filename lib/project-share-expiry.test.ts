import { expect, it } from 'vitest';
import {
  SHARE_EXPIRY_OPTIONS,
  readShareExpiry,
  shareExpiresAt,
} from './project-share-expiry';

const now = '2026-10-25T12:34:56.789Z';

it('offers exactly the named read-access durations', () => {
  expect(SHARE_EXPIRY_OPTIONS).toEqual([
    { seconds: 3600, label: '1 hour' },
    { seconds: 86400, label: '24 hours' },
    { seconds: 604800, label: '7 days' },
  ]);
});

it.each([
  [3600, '2026-10-25T13:34:56.789Z'],
  [86400, '2026-10-26T12:34:56.789Z'],
  [604800, '2026-11-01T12:34:56.789Z'],
  [undefined, '2026-10-26T12:34:56.789Z'],
])('derives expiry from server time with duration %s', (duration, expected) => {
  expect(shareExpiresAt(duration, now)).toBe(expected);
});

it.each([null, '3600', 0, -1, 3600.5, 3601, NaN, Infinity, true, {}, []])(
  'refuses non-enumerated duration %j without coercion',
  (duration) => {
    expect(() => shareExpiresAt(duration, now)).toThrow(
      'Choose a supported sharing duration.',
    );
  },
);

it('retains canonical timestamp precision and admits null only as legacy expiry', () => {
  expect(readShareExpiry(now)).toBe(now);
  expect(readShareExpiry(null)).toBeNull();
  expect(readShareExpiry('1970-01-01T00:00:00.000Z')).toBe(
    '1970-01-01T00:00:00.000Z',
  );
});

it.each([
  undefined,
  '',
  0,
  {},
  [],
  'not a date',
  '2026-10-25T12:34:56Z',
  '2026-10-25T12:34:56.789+00:00',
  '2026-02-29T00:00:00.000Z',
  '2026-10-25T12:34:56.7890Z',
  '2026-10-25t12:34:56.789z',
  '+010000-01-01T00:00:00.000Z',
])('refuses non-canonical expiry %j', (value) => {
  expect(() => readShareExpiry(value)).toThrow('Invalid share timestamp.');
});

it.each([
  '2026-02-29T00:00:00.000Z',
  '2026-10-25T12:34:56Z',
  '2026-10-25T12:34:56.789+00:00',
  'not a date',
])('refuses invalid server time %s', (value) => {
  expect(() => shareExpiresAt(3600, value)).toThrow('Invalid share timestamp.');
});

it('refuses an expiry outside the canonical four-digit year range', () => {
  expect(() => shareExpiresAt(3600, '9999-12-31T23:59:59.999Z')).toThrow(
    'Invalid share timestamp.',
  );
});

it('adds actual elapsed hours across leap days without locale or DST adjustment', () => {
  expect(shareExpiresAt(86400, '2028-02-28T23:30:00.000Z')).toBe(
    '2028-02-29T23:30:00.000Z',
  );
});
