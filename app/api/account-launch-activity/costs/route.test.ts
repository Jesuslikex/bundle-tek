import { beforeEach, expect, it, vi } from 'vitest';
import {
  recordedCostResponse,
  recordedCostReviewId,
} from '@/test/pump-group-recorded-costs-fixture';
import { PumpPreflightError } from '@/lib/owned-pump-preflight';
const mocks = vi.hoisted(() => ({
  user: null as { userId: string } | null,
  db: {} as D1Database,
  read: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/pump-group-recorded-costs-service', () => ({
  readOwnedPumpGroupRecordedCosts: mocks.read,
}));
import { GET } from './route';
const url =
  'https://bundle.test/api/account-launch-activity/costs?reviewId=' +
  recordedCostReviewId;
beforeEach(() => {
  mocks.user = { userId: 'alice' };
  mocks.read.mockReset();
  mocks.read.mockResolvedValue(recordedCostResponse);
});
it('requires the session owner and one exact review selector before reading costs', async () => {
  mocks.user = null;
  expect((await GET(new Request(url))).status).toBe(401);
  mocks.user = { userId: 'alice' };
  for (const suffix of [
    '',
    '?reviewId=bad',
    '?owner=bob',
    '?reviewId=' + recordedCostReviewId + '&owner=bob',
    '?reviewId=' + recordedCostReviewId + '&reviewId=' + recordedCostReviewId,
  ])
    expect(
      (
        await GET(
          new Request(
            'https://bundle.test/api/account-launch-activity/costs' + suffix,
          ),
        )
      ).status,
    ).toBe(400);
  expect(mocks.read).not.toHaveBeenCalled();
});
it('returns a no-store cost projection using only the authenticated owner and request cancellation', async () => {
  const response = await GET(new Request(url));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual(recordedCostResponse);
  expect(mocks.read.mock.calls[0].slice(0, 3)).toEqual([
    mocks.db,
    'alice',
    recordedCostReviewId,
  ]);
  expect(mocks.read.mock.calls[0][3]).toBeInstanceOf(AbortSignal);
});
it('does not expose foreign or inconsistent stored evidence or internal errors', async () => {
  mocks.read.mockRejectedValueOnce(
    new PumpPreflightError('private foreign owner', 404),
  );
  let response = await GET(new Request(url));
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    error: 'Saved launch group not found.',
  });
  mocks.read.mockRejectedValueOnce(
    new Error('private database/provider detail'),
  );
  response = await GET(new Request(url));
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('private');
  mocks.read.mockRejectedValueOnce(
    new PumpPreflightError(
      'This group has no closed broadcast cost record yet.',
      409,
    ),
  );
  response = await GET(new Request(url));
  expect(response.status).toBe(409);
  expect(response.headers.get('cache-control')).toBe('no-store');
});
