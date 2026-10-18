import { afterEach, expect, it, vi } from 'vitest';
import { LaunchSaleAllocationError } from '@/lib/launch-sale-allocation';
const m = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: {} as D1Database,
  read: vi.fn(),
  review: vi.fn(),
  record: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({ getChatGPTUser: async () => m.user }));
vi.mock('@/db', () => ({ getD1: () => m.db }));
vi.mock('@/lib/launch-sale-allocation-service', () => ({
  readOwnedLaunchSaleAllocation: m.read,
  reviewOwnedLaunchSaleAllocation: m.review,
  recordOwnedLaunchSaleAllocation: m.record,
}));
import { GET, POST } from './route';
const url =
    'https://bundle.example/api/account-launch-activity/sale-allocations',
  saleReceiptId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  allocations = [{ originId: 'b'.repeat(64), unitsRaw: '5' }],
  record = {
    action: 'record',
    saleReceiptId,
    allocations,
    approved: true,
    policy: 'recorded-launch-units-v1',
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
    new Request(url, {
      method: 'POST',
      headers,
      body: typeof value === 'string' ? value : JSON.stringify(value),
    }),
  );
afterEach(() => {
  m.user = { userId: 'alice' };
  vi.resetAllMocks();
});
it('requires sign-in for reads and writes', async () => {
  m.user = null;
  expect(
    (await GET(new Request(`${url}?saleReceiptId=${saleReceiptId}`))).status,
  ).toBe(401);
  expect((await post(record)).status).toBe(401);
  expect(m.read).not.toHaveBeenCalled();
  expect(m.record).not.toHaveBeenCalled();
});
it('reads one exact saved sale for the signed-in owner', async () => {
  m.read.mockResolvedValue({ saleReceiptId, plan: null });
  const r = await GET(new Request(`${url}?saleReceiptId=${saleReceiptId}`));
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(m.read).toHaveBeenCalledWith(
    m.db,
    'alice',
    saleReceiptId,
    expect.any(AbortSignal),
  );
  for (const q of [
    '',
    '?saleReceiptId=x',
    `?saleReceiptId=${saleReceiptId}&a=1`,
  ])
    expect((await GET(new Request(url + q))).status).toBe(400);
});
it('reviews without saving and records only the exact approved shape', async () => {
  m.review.mockResolvedValue({ sha256: 'c'.repeat(64) });
  const r = await post({ action: 'review', saleReceiptId, allocations });
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({
    executionAllowed: false,
    profitCalculated: false,
  });
  expect(m.record).not.toHaveBeenCalled();
  m.record.mockResolvedValue({
    saleReceiptId,
    plan: { sha256: 'c'.repeat(64) },
  });
  expect((await post(record)).status).toBe(200);
  expect(m.record).toHaveBeenCalledWith(
    m.db,
    'alice',
    saleReceiptId,
    allocations,
    {
      approved: true,
      policy: 'recorded-launch-units-v1',
      planSha256: 'c'.repeat(64),
    },
    expect.any(AbortSignal),
  );
});
it('refuses unapproved, extra-field, foreign-origin and oversized writes', async () => {
  for (const bad of [
    { ...record, approved: false },
    { ...record, policy: 'other' },
    { ...record, planSha256: 'C'.repeat(64) },
    { ...record, extra: 1 },
    { action: 'review', saleReceiptId, allocations, approved: true },
    [record],
  ])
    expect((await post(bad)).status).toBe(400);
  expect(
    (
      await post(record, {
        origin: 'https://evil.example',
        'content-type': 'application/json',
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await post(record, {
        origin: 'https://bundle.example',
        'content-type': 'text/plain',
      })
    ).status,
  ).toBe(415);
  expect((await post('x'.repeat(5000))).status).toBe(413);
  expect((await post('{bad')).status).toBe(400);
  expect(m.record).not.toHaveBeenCalled();
});
it('shows typed refusals and hides unexpected errors', async () => {
  m.record.mockRejectedValueOnce(
    new LaunchSaleAllocationError('Remaining acquisition units changed.'),
  );
  const a = await post(record);
  expect([a.status, ((await a.json()) as { error: string }).error]).toEqual([
    409,
    'Remaining acquisition units changed.',
  ]);
  m.record.mockRejectedValueOnce(new Error('internal SQL detail'));
  const b = await post(record);
  expect(b.status).toBe(503);
  expect(JSON.stringify(await b.json())).not.toContain('SQL');
});
