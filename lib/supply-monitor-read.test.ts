import { afterEach, expect, it, vi } from 'vitest';
import {
  fetchSupplyMonitorJson,
  supplyMonitorFailure,
  supplyMonitorHttpError,
  supplyMonitorRetryAfter,
} from './supply-monitor-read';

afterEach(() => vi.unstubAllGlobals());
it('retries rate limits and temporary provider/storage failures, but not authorization or invalid scopes', () => {
  for (const status of [429, 500, 502, 503, 504]) {
    expect(
      supplyMonitorFailure(
        supplyMonitorHttpError(status, 'Try later.', '45', 'POST'),
      ),
    ).toEqual({ status: 'retry', reason: 'Try later.', retryAfterMs: 45000 });
  }
  for (const status of [400, 401, 403, 404, 409, 413, 415]) {
    expect(
      supplyMonitorFailure(
        supplyMonitorHttpError(
          status,
          'Select active saved Solana wallets.',
          null,
          'POST',
        ),
      ),
    ).toBe(false);
  }
  expect(supplyMonitorFailure(new Error('Saved supply scope differs.'))).toBe(
    false,
  );
});
it('retries only the specific overlapping-sample POST conflict', () => {
  const message =
    'Supply sample differs or overlaps the previous observation. Retry later.';
  expect(
    supplyMonitorFailure(supplyMonitorHttpError(409, message, null, 'POST')),
  ).toMatchObject({ status: 'retry' });
  expect(
    supplyMonitorFailure(supplyMonitorHttpError(409, message, null, 'GET')),
  ).toBe(false);
  expect(
    supplyMonitorFailure(
      supplyMonitorHttpError(
        409,
        'Project, wallet, or supply history changed during this read. Reload.',
        null,
        'POST',
      ),
    ),
  ).toBe(false);
});
it('parses seconds and HTTP-date Retry-After without accepting invalid or past values', () => {
  const now = Date.UTC(2026, 9, 12);
  expect(supplyMonitorRetryAfter('15', now)).toBe(15000);
  expect(
    supplyMonitorRetryAfter(new Date(now + 60000).toUTCString(), now),
  ).toBe(60000);
  for (const value of [
    null,
    '',
    '-1',
    'nonsense',
    '0',
    new Date(now - 1000).toUTCString(),
  ])
    expect(supplyMonitorRetryAfter(value, now)).toBeUndefined();
  expect(supplyMonitorRetryAfter('999999999999')).toBe(86400000);
});
it('classifies fetch failures, but does not retry an aborted request or malformed successful JSON', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
  );
  const error = await fetchSupplyMonitorJson(
    '/history',
    {},
    'Read failed.',
  ).catch((e) => e);
  expect(supplyMonitorFailure(error)).toMatchObject({ status: 'retry' });
  const c = new AbortController();
  c.abort();
  const aborted = await fetchSupplyMonitorJson(
    '/history',
    { signal: c.signal },
    'Read failed.',
  ).catch((e) => e);
  expect(supplyMonitorFailure(aborted)).toBe(false);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response('not json', { status: 200 })),
  );
  const malformed = await fetchSupplyMonitorJson(
    '/history',
    {},
    'Read failed.',
  ).catch((e) => e);
  expect(supplyMonitorFailure(malformed)).toBe(false);
});
it('honors an error Retry-After even when the upstream body is HTML', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response('<html>Unavailable</html>', {
          status: 503,
          headers: { 'retry-after': '120' },
        }),
      ),
  );
  const error = await fetchSupplyMonitorJson(
    '/history',
    {},
    'Cannot read history.',
  ).catch((e) => e);
  expect(supplyMonitorFailure(error)).toEqual({
    status: 'retry',
    reason: 'Cannot read history.',
    retryAfterMs: 120000,
  });
});
