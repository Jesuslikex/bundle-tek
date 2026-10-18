import { afterEach, expect, it, vi } from 'vitest';
import { PumpPreflightError } from '@/lib/owned-pump-preflight';
const m = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: {} as D1Database,
  preview: vi.fn(),
  history: vi.fn(),
  record: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({ getChatGPTUser: async () => m.user }));
vi.mock('@/db', () => ({ getD1: () => m.db }));
vi.mock('@/lib/pump-purchase-cost-service', () => ({
  readOwnedPumpPurchaseCostPlan: m.preview,
  readOwnedPumpPurchaseCostHistory: m.history,
  recordOwnedPumpPurchaseCosts: m.record,
}));
import { GET, POST } from './route';
const url = 'https://bundle.example/api/account-launch-activity/purchases',
  reviewId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  receiptId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  valid = {
    reviewId,
    receiptId,
    approved: true,
    policy: 'reviewed-buy-shares-v1',
    planSha256: 'c'.repeat(64),
  };
const post = (
  value: unknown,
  headers: Record<string, string> = {
    origin: 'https://bundle.example',
    'content-type': 'application/json',
  },
) =>
  POST(
    new Request(url, { method: 'POST', headers, body: JSON.stringify(value) }),
  );
afterEach(() => {
  m.user = { userId: 'alice' };
  vi.resetAllMocks();
});
it('authenticates every read/write and binds owner from the session only', async () => {
  m.user = null;
  expect((await GET(new Request(url + '?reviewId=' + reviewId))).status).toBe(
    401,
  );
  expect((await post(valid)).status).toBe(401);
  expect(m.record).not.toHaveBeenCalled();
  m.user = { userId: 'alice' };
  m.preview.mockResolvedValue({ reviewId, receiptId });
  m.history.mockResolvedValue({ reviewId, sources: [] });
  m.record.mockResolvedValue({ saved: true });
  const response = await GET(
    new Request(`${url}?reviewId=${reviewId}&receiptId=${receiptId}`),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(m.preview).toHaveBeenCalledWith(
    m.db,
    'alice',
    reviewId,
    receiptId,
    expect.any(AbortSignal),
  );
  expect((await GET(new Request(url + '?reviewId=' + reviewId))).status).toBe(
    200,
  );
  expect(m.history).toHaveBeenCalledWith(
    m.db,
    'alice',
    reviewId,
    expect.any(AbortSignal),
  );
  expect((await post(valid)).status).toBe(200);
  const { reviewId: _review, ...consent } = valid;
  expect(m.record).toHaveBeenCalledWith(
    m.db,
    'alice',
    reviewId,
    consent,
    expect.any(AbortSignal),
  );
});
it('rejects extra, duplicate, missing or malformed selection and caller amounts', async () => {
  for (const suffix of [
    '',
    `?reviewId=${reviewId}&reviewId=${reviewId}`,
    `?reviewId=${reviewId}&receiptId=${receiptId}&receiptId=${receiptId}`,
    `?reviewId=${reviewId}&owner=bob`,
    `?reviewId=${reviewId}&receiptId=bad`,
  ])
    expect((await GET(new Request(url + suffix))).status).toBe(400);
  for (const value of [
    null,
    [],
    { ...valid, amount: '1' },
    { ...valid, userId: 'bob' },
    { ...valid, approved: false },
    { ...valid, policy: 'new' },
    { ...valid, planSha256: 'invalid' },
  ])
    expect((await post(value)).status).toBe(400);
  expect(m.record).not.toHaveBeenCalled();
});
it('requires same origin, JSON and a bounded cancellable UTF8 body', async () => {
  expect(
    (await post(valid, { 'content-type': 'application/json' })).status,
  ).toBe(403);
  expect(
    (
      await post(valid, {
        origin: 'https://other.example',
        'content-type': 'application/json',
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await post(valid, {
        origin: 'https://bundle.example',
        'content-type': 'text/plain',
      })
    ).status,
  ).toBe(415);
  expect((await post({ ...valid, pad: 'x'.repeat(513) })).status).toBe(413);
  const invalid = new Request(url, {
    method: 'POST',
    headers: {
      origin: 'https://bundle.example',
      'content-type': 'application/json',
    },
    body: Uint8Array.of(0xff),
  });
  expect((await POST(invalid)).status).toBe(400);
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('{'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request(url, {
    method: 'POST',
    headers: {
      origin: 'https://bundle.example',
      'content-type': 'application/json',
    },
    body,
    signal: controller.signal,
    duplex: 'half',
  } as RequestInit);
  const pending = POST(request);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  expect((await pending).status).toBe(408);
  expect(cancelled).toBe(true);
  expect(m.record).not.toHaveBeenCalled();
});
it('keeps service refusals and unknown outcomes private/no-store without echoing raw failures', async () => {
  m.record.mockRejectedValueOnce(new PumpPreflightError('Costs changed.', 409));
  expect((await post(valid)).status).toBe(409);
  m.record.mockRejectedValueOnce(Error('secret provider/SQL diagnostic'));
  const r = await post(valid);
  expect(r.status).toBe(503);
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(await r.text()).not.toContain('secret');
  const c = new AbortController();
  c.abort();
  expect(
    (
      await GET(
        new Request(url + '?reviewId=' + reviewId, { signal: c.signal }),
      )
    ).status,
  ).toBe(408);
});
