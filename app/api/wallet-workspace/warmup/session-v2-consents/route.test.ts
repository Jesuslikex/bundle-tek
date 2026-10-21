import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { warmupSessionV2ConsentFixture } from '@/test/warmup-session-v2-consent-fixture';
import { retainWalletWarmupSessionConsent } from '@/lib/wallet-warmup-session-consent';
const mocks = vi.hoisted(() => ({
  db: null as unknown as D1Database,
  user: { userId: 'owner' } as { userId: string } | null,
  getDb: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({
  getD1: () => {
    mocks.getDb();
    return mocks.db;
  },
}));
import { GET, POST } from './route';
let f: Awaited<ReturnType<typeof warmupSessionV2ConsentFixture>>;
const url = 'http://localhost/api/wallet-workspace/warmup/session-v2-consents';
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  f = await warmupSessionV2ConsentFixture();
  mocks.db = f.db;
  mocks.user = { userId: 'owner' };
  mocks.getDb.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('Metadata approval must not call a provider');
    }),
  );
});
afterEach(() => {
  f?.client.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const reviewBody = () => ({ operation: 'review', ...f.selection });
const saveBody = () => ({ operation: 'save', ...f.v2Input, approved: true });
function post(
  value: unknown = reviewBody(),
  headers: Record<string, string> = {
    origin: 'http://localhost',
    'content-type': 'application/json',
  },
  signal?: AbortSignal,
) {
  return POST(
    new Request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(value),
      signal,
    }),
  );
}
it('reviews and saves exact v2 policy with separate approval, then recovers the owned immutable record', async () => {
  const preview = await post();
  expect(preview.status).toBe(200);
  expect(
    ((await preview.json()) as { consentReview: unknown }).consentReview,
  ).toEqual({ ...f.v2Prepared, reviewCreatedAt: f.retainedReview.createdAt });
  const response = await post(saveBody());
  expect(response.status).toBe(200);
  const saved = (await response.json()) as {
    consent: { id: string; terms: typeof f.v2Prepared.terms };
  };
  expect(saved.consent.terms).toEqual(f.v2Prepared.terms);
  expect(response.headers.get('cache-control')).toBe('no-store');
  vi.setSystemTime(Date.now() + 3600000);
  expect(
    await (await GET(new Request(url + '?id=' + f.v2Input.id))).json(),
  ).toEqual(saved);
  expect(await (await post(saveBody())).json()).toEqual(saved);
  expect(fetch).not.toHaveBeenCalled();
});
it('requires auth before SQL for both operations', async () => {
  mocks.user = null;
  expect((await post()).status).toBe(401);
  expect((await GET(new Request(url + '?id=' + f.v2Input.id))).status).toBe(
    401,
  );
  expect(mocks.getDb).not.toHaveBeenCalled();
});
it.each([
  [
    { origin: 'https://elsewhere.example', 'content-type': 'application/json' },
    403,
  ],
  [{ 'content-type': 'application/json' }, 403],
  [{ origin: 'http://localhost', 'content-type': 'text/plain' }, 415],
  [{ origin: 'http://localhost', 'content-type': 'application/jsonp' }, 415],
] as const)('refuses origin or media %j', async (headers, status) => {
  expect((await post(reviewBody(), headers)).status).toBe(status);
  expect(mocks.getDb).not.toHaveBeenCalled();
});
it.each([
  null,
  [],
  {},
  { operation: 'save', approved: false },
  { operation: 'review', policy: {} },
  { operation: 'save', approved: true, transaction: 'private' },
])('refuses malformed or supplied authority %j before SQL', async (body) => {
  expect((await post(body)).status).toBe(400);
  expect(mocks.getDb).not.toHaveBeenCalled();
});
it('refuses client-selected policy and signatures on otherwise valid requests', async () => {
  for (const value of [
    { ...reviewBody(), policy: f.v2Prepared.terms.policy },
    { ...saveBody(), signature: 'secret' },
    { ...saveBody(), approved: false },
  ])
    expect((await post(value)).status).toBe(400);
  expect(mocks.getDb).not.toHaveBeenCalled();
});
it('bounds UTF-8 input, sanitizes HTML and rejects cancellation before SQL', async () => {
  expect(
    (await post({ ...reviewBody(), extra: 'x'.repeat(3000) })).status,
  ).toBe(413);
  expect(
    (
      await POST(
        new Request(url, {
          method: 'POST',
          headers: {
            origin: 'http://localhost',
            'content-type': 'application/json',
          },
          body: '<html>private</html>',
        }),
      )
    ).status,
  ).toBe(400);
  const c = new AbortController();
  c.abort();
  expect((await post(reviewBody(), undefined, c.signal)).status).toBe(408);
  expect(mocks.getDb).not.toHaveBeenCalled();
});
it.each([
  '',
  '?other=x',
  '?id=wrong',
  '?id=A0000000-0000-4000-8000-000000000000',
  '?id=00000000-0000-4000-8000-000000000007&id=00000000-0000-4000-8000-000000000008',
  '?id=00000000-0000-4000-8000-000000000007&extra=1',
])('refuses invalid GET %s before SQL', async (suffix) => {
  expect((await GET(new Request(url + suffix))).status).toBe(400);
  expect(mocks.getDb).not.toHaveBeenCalled();
});
it('returns identical absence for foreign and missing IDs', async () => {
  expect((await post(saveBody())).status).toBe(200);
  mocks.user = { userId: 'other' };
  const foreign = await GET(new Request(url + '?id=' + f.v2Input.id));
  expect(foreign.status).toBe(404);
  mocks.user = { userId: 'owner' };
  const missing = await GET(
    new Request(url + '?id=00000000-0000-4000-8000-000000000099'),
  );
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual(await foreign.json());
});
it('refuses stale initial reviews and returns an existing original ID for competing saves', async () => {
  expect((await post(saveBody())).status).toBe(200);
  const conflict = await post({ ...saveBody(), id: crypto.randomUUID() });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ recoveryId: f.v2Input.id });
  vi.setSystemTime(Date.now() + 61000);
  expect((await post()).status).toBe(409);
  const late = await post({ ...saveBody(), id: crypto.randomUUID() });
  expect(late.status).toBe(409);
  expect(await late.json()).toMatchObject({ recoveryId: f.v2Input.id });
});
it('maps definite source/hash/deadline refusals to controlled409 rather than uncertain503', async () => {
  for (const value of [
    { ...reviewBody(), reviewSha256: 'f'.repeat(64) },
    { ...reviewBody(), reviewId: crypto.randomUUID() },
    {
      ...reviewBody(),
      sessionExpiresAt: new Date(Date.now() - 1).toISOString(),
    },
    {
      ...reviewBody(),
      sessionExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
  ]) {
    const response = await post(value);
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain('could not be confirmed');
  }
});
it('does not offer unsaveable versioned terms for an already legacy-approved review', async () => {
  await retainWalletWarmupSessionConsent(
    f.db,
    'owner',
    f.input,
    true,
    new AbortController().signal,
  );
  const response = await post();
  expect(response.status).toBe(409);
  expect(await response.text()).toContain('already has legacy approval');
});
it('sanitizes storage failures and releases no partial terms', async () => {
  mocks.db = {
    prepare: () => {
      throw Error('<html>private database path</html>');
    },
  } as unknown as D1Database;
  const response = await post();
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('private');
});
