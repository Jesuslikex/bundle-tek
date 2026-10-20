import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { warmupSessionConsentFixture } from '@/test/warmup-session-consent-fixture';
const mocks = vi.hoisted(() => ({
  user: { userId: 'owner' } as { userId: string } | null,
  db: null as unknown as D1Database,
  reads: 0,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({
  getD1: () => {
    mocks.reads++;
    return mocks.db;
  },
}));
import { GET, POST } from './route';
let fixture: Awaited<ReturnType<typeof warmupSessionConsentFixture>>;
const url = 'http://localhost/api/wallet-workspace/warmup/session-consents';
const headers = {
  origin: 'http://localhost',
  'content-type': 'application/json',
};
beforeEach(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No provider permitted');
    }),
  );
  fixture = await warmupSessionConsentFixture();
  mocks.user = { userId: 'owner' };
  mocks.db = fixture.db;
  mocks.reads = 0;
});
afterEach(() => {
  fixture?.client.close();
  vi.unstubAllGlobals();
});
const reviewBody = () => {
  const { id: _id, termsSha256: _hash, ...selection } = fixture.input;
  return { operation: 'review', ...selection };
};
const saveBody = () => ({
  operation: 'save',
  ...fixture.input,
  approved: true,
});
const post = (
  body: unknown = saveBody(),
  extra: Record<string, string> = headers,
  signal?: AbortSignal,
) =>
  POST(
    new Request(url, {
      method: 'POST',
      headers: extra,
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal,
    }),
  );
const get = (query = 'id=' + fixture.input.id, signal?: AbortSignal) =>
  GET(new Request(url + '?' + query, { signal }));
const count = async () =>
  (await fixture.db
    .prepare('SELECT count(*) AS n FROM wallet_warmup_session_consents')
    .first<{ n: number }>())!.n;
it('authenticates all operations before database access', async () => {
  mocks.user = null;
  expect((await post()).status).toBe(401);
  expect((await post(reviewBody())).status).toBe(401);
  expect((await get()).status).toBe(401);
  expect(mocks.reads).toBe(0);
});
it.each([
  ['missing', {}, 403],
  ['cross-origin', { ...headers, origin: 'https://elsewhere.example' }, 403],
  ['html', { ...headers, 'content-type': 'text/html' }, 415],
  ['jsonp', { ...headers, 'content-type': 'application/jsonp' }, 415],
] as const)(
  'refuses %s writes before storage',
  async (_kind, values, status) => {
    expect((await post(saveBody(), values)).status).toBe(status);
    expect(mocks.reads).toBe(0);
  },
);
it.each(['unchecked', 'owner', 'extra', 'missing', 'operation'] as const)(
  'refuses invalid explicit consent body: %s',
  async (kind) => {
    const body: Record<string, unknown> = { ...saveBody() };
    if (kind === 'unchecked') body.approved = false;
    if (kind === 'owner') body.owner = 'other';
    if (kind === 'extra') body.signingAllowed = true;
    if (kind === 'missing') delete body.termsSha256;
    if (kind === 'operation') body.operation = 'start';
    expect((await post(body)).status).toBe(400);
    expect(mocks.reads).toBe(0);
    expect(await count()).toBe(0);
  },
);
it('bounds UTF-8 body bytes and rejects malformed JSON or non-object bodies', async () => {
  expect(
    (await post(JSON.stringify({ padding: 'é'.repeat(1100) }))).status,
  ).toBe(413);
  expect((await post('<html>oops')).status).toBe(400);
  expect((await post('[]')).status).toBe(400);
  expect(mocks.reads).toBe(0);
});
it('previews exact owner-scoped terms without writing, then saves only a separately approved hash', async () => {
  const reviewed = await post(reviewBody());
  expect(reviewed.status).toBe(200);
  expect(reviewed.headers.get('cache-control')).toBe('no-store');
  const data = (await reviewed.json()) as {
    consentReview: typeof fixture.prepared;
  };
  expect(data.consentReview).toEqual({
    ...fixture.prepared,
    reviewCreatedAt: fixture.retainedReview.createdAt,
  });
  expect(data.consentReview.terms.signingAllowed).toBe(false);
  expect(await count()).toBe(0);
  const saved = await post();
  expect(saved.status).toBe(200);
  const result = (await saved.json()) as {
    consent: { id: string; terms: { automaticExecutionAllowed: boolean } };
  };
  expect(result.consent.id).toBe(fixture.input.id);
  expect(result.consent.terms.automaticExecutionAllowed).toBe(false);
  const recovered = await get();
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toEqual(result);
  expect(await count()).toBe(1);
  expect(fetch).not.toHaveBeenCalled();
});
it('isolates reads and writes by the verified owner', async () => {
  await post();
  mocks.user = { userId: 'other' };
  expect((await get()).status).toBe(404);
  expect((await post(reviewBody())).status).toBe(409);
  expect((await post()).status).toBe(409);
  expect(await count()).toBe(1);
});
it.each([
  'id=wrong',
  'id=A0000000-0000-4000-8000-000000000001',
  'id=a&id=b',
  'other=value',
])('requires one canonical recovery ID: %s', async (query) => {
  expect((await get(query)).status).toBe(400);
  expect(mocks.reads).toBe(0);
});
it('returns a genuine missing record as 404 without issuing a save', async () => {
  expect((await get()).status).toBe(404);
  expect(await count()).toBe(0);
});
it('recovers the same history after archival without reapproving it', async () => {
  const saved = await post();
  const body = await saved.json();
  await fixture.db
    .prepare('UPDATE wallet_warmup_plans SET archived=1,revision=2')
    .run();
  expect(await (await get()).json()).toEqual(body);
  expect(await (await post()).json()).toEqual(body);
  expect(await count()).toBe(1);
});
it('reports changed hashes as controlled conflicts with no approval', async () => {
  expect(
    (await post({ ...saveBody(), termsSha256: 'a'.repeat(64) })).status,
  ).toBe(409);
  expect(await count()).toBe(0);
});
it('refuses cancellation before body/database work', async () => {
  const c = new AbortController();
  c.abort();
  expect((await post(saveBody(), headers, c.signal)).status).toBe(408);
  expect((await get(undefined, c.signal)).status).toBe(408);
  expect(mocks.reads).toBe(0);
});
it('sanitizes unknown storage failures and exposes no HTML parser details', async () => {
  mocks.db = {
    prepare: () => {
      throw Error('<html>private provider diagnostic token=secret</html>');
    },
  } as unknown as D1Database;
  const response = await post(reviewBody());
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toMatch(
    /private|token=|<html>/,
  );
});
it('fails closed when the latest immutable guard is missing', async () => {
  await fixture.db
    .prepare('DROP TRIGGER wallet_warmup_session_consents_bounds')
    .run();
  expect((await post()).status).toBe(503);
  expect(await count()).toBe(0);
});
