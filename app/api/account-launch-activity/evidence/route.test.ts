import { afterEach, expect, it, vi } from 'vitest';
import { PumpPreflightError } from '@/lib/owned-pump-preflight';
const mocks = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: {} as D1Database,
  read: vi.fn(),
  retain: vi.fn(),
  endpoint: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/pump-group-receipt-evidence-service', () => ({
  readOwnedPumpGroupReceiptEvidence: mocks.read,
  retainOwnedPumpGroupReceiptEvidence: mocks.retain,
}));
vi.mock('@/lib/solana-rpc', () => ({
  getSolanaIndexerRpcEndpoint: mocks.endpoint,
}));
import { GET, POST } from './route';
const reviewId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  requestId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  url = 'https://bundle.example/api/account-launch-activity/evidence';
const post = (
  body: unknown,
  headers: Record<string, string> = {
    origin: 'https://bundle.example',
    'content-type': 'application/json',
  },
) =>
  POST(
    new Request(url, { method: 'POST', headers, body: JSON.stringify(body) }),
  );
afterEach(() => {
  mocks.user = { userId: 'alice' };
  vi.resetAllMocks();
});
it('keeps saved-only GET owner scoped, no-store and independent of provider configuration', async () => {
  mocks.read.mockResolvedValueOnce({ reviewId, entry: null });
  const r = await GET(new Request(url + '?reviewId=' + reviewId));
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(mocks.read).toHaveBeenCalledWith(
    mocks.db,
    'alice',
    reviewId,
    expect.any(AbortSignal),
  );
  expect(mocks.endpoint).not.toHaveBeenCalled();
  expect(
    (await GET(new Request(url + '?reviewId=' + reviewId + '&extra=1'))).status,
  ).toBe(400);
});
it('accepts only explicit same-origin identity-only saves and resolves provider lazily', async () => {
  mocks.retain.mockResolvedValueOnce({ reviewId, entry: null });
  expect((await post({ reviewId, requestId })).status).toBe(200);
  expect(mocks.retain).toHaveBeenCalledWith(
    mocks.db,
    'alice',
    reviewId,
    requestId,
    expect.any(AbortSignal),
    expect.any(Function),
  );
  expect(mocks.endpoint).not.toHaveBeenCalled();
  mocks.retain.mockClear();
  for (const body of [
    { reviewId, requestId, receipts: [] },
    { reviewId, requestId, executionAllowed: true },
    { reviewId, requestId: 'bad' },
    [],
  ])
    expect((await post(body)).status).toBe(400);
  expect(
    (
      await post(
        { reviewId, requestId },
        {
          origin: 'https://foreign.example',
          'content-type': 'application/json',
        },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await post(
        { reviewId, requestId },
        { origin: 'https://bundle.example', 'content-type': 'text/plain' },
      )
    ).status,
  ).toBe(415);
  expect(mocks.retain).not.toHaveBeenCalled();
});
it('bounds bodies and refuses cancelled or signed-out requests before storage/provider access', async () => {
  expect(
    (await post({ reviewId, requestId, extra: 'x'.repeat(512) })).status,
  ).toBe(413);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await POST(
    new Request(url, {
      method: 'POST',
      headers: {
        origin: 'https://bundle.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ reviewId, requestId }),
      signal: controller.signal,
    }),
  );
  expect(cancelled.status).toBe(408);
  mocks.user = null;
  expect((await post({ reviewId, requestId })).status).toBe(401);
  expect((await GET(new Request(url + '?reviewId=' + reviewId))).status).toBe(
    401,
  );
  expect(mocks.retain).not.toHaveBeenCalled();
  expect(mocks.endpoint).not.toHaveBeenCalled();
});
it('keeps pacing and installation failures actionable without exposing internal errors', async () => {
  mocks.retain.mockRejectedValueOnce(
    new PumpPreflightError('Wait 5 seconds.', 429),
  );
  const limited = await post({ reviewId, requestId });
  expect(limited.status).toBe(429);
  expect(limited.headers.get('retry-after')).toBe('5');
  mocks.retain.mockRejectedValueOnce(new Error('private provider details'));
  const failed = await post({ reviewId, requestId });
  expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain('private provider');
});
