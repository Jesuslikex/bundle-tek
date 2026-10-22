import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { warmupV2RuntimeFixture } from '@/test/warmup-session-v2-runtime-fixture';
const mocks = vi.hoisted(() => ({
  db: null as unknown as D1Database,
  user: { userId: 'owner' } as { userId: string } | null,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/server-env', () => ({
  env: { JUPITER_API_KEY: 'synthetic-key' },
}));
import { GET } from './route';
import { GET as previewGET } from '../session-v2-attempts/route';
import { GET as runtimeGET } from '../session-v2-runtime-attempts/route';
import {
  prepareWalletWarmupV2RuntimeAttempt,
  prepareWalletWarmupV2Attempt,
} from '@/lib/wallet-warmup-session-v2-attempts';
const url =
  'http://localhost/api/wallet-workspace/warmup/session-v2-read-history';
let f: Awaited<ReturnType<typeof warmupV2RuntimeFixture>>;
const signal = () => new AbortController().signal;
beforeEach(async () => {
  f = await warmupV2RuntimeFixture();
  mocks.db = f.db;
  mocks.user = { userId: 'owner' };
});
afterEach(() => {
  f.client.close();
  vi.restoreAllMocks();
});
const get = (query: string) => GET(new Request(url + query));
it.each([
  'history-id',
  'history-page',
  'preview-id',
  'preview-page',
  'runtime-id',
] as const)(
  'reports temporary clock skew on %s without a provider request or deadline renewal',
  async (kind) => {
    const input = f.selection(),
      callback = vi.fn(async () => {
        throw Error('synthetic refusal');
      });
    const saved = await prepareWalletWarmupV2Attempt(
      f.db,
      'owner',
      input,
      true,
      signal(),
      'synthetic-key',
      () => callback,
    );
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse(f.v2Journal.createdAt) - 1);
    try {
      const query = kind.endsWith('page')
        ? '?journalId=' + input.journalId
        : '?id=' + input.id;
      const result = kind.startsWith('history')
        ? await get(query)
        : kind === 'runtime-id'
          ? await runtimeGET(new Request(url + query))
          : await previewGET(new Request(url + query));
      expect(result.status).toBe(409);
      expect(result.headers.get('cache-control')).toBe('no-store');
      expect(await result.json()).toEqual({
        code: 'WARMUP_HISTORY_CLOCK_AHEAD',
        error:
          'Saved history is ahead of this server clock. Recover the same ID shortly.',
      });
    } finally {
      now.mockRestore();
    }
    const recovered = await get('?id=' + input.id);
    expect(recovered.status).toBe(200);
    const body = (await recovered.json()) as {
      attempt: { id: string; leaseExpiresAt: string };
    };
    expect(body.attempt.id).toBe(input.id);
    expect(body.attempt.leaseExpiresAt).toBe(saved.lease.expires_at);
    expect(callback).toHaveBeenCalledOnce();
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.raw.prepare).not.toHaveBeenCalled();
  },
);
it('requires authentication and isolates absent IDs and other owners', async () => {
  mocks.user = null;
  expect((await get('?id=' + crypto.randomUUID())).status).toBe(401);
  mocks.user = { userId: 'owner' };
  expect((await get('?id=' + crypto.randomUUID())).status).toBe(404);
  const input = f.selection();
  await prepareWalletWarmupV2RuntimeAttempt(
    f.db,
    'owner',
    input,
    true,
    signal(),
    'synthetic-key',
    f.factory,
  );
  mocks.user = { userId: 'other' };
  expect((await get('?id=' + input.id)).status).toBe(404);
  expect(f.factory).toHaveBeenCalledOnce();
});
it.each([
  '?id=bad',
  '?journalId=bad',
  '?id=one&id=two',
  '?before=1',
  '?journalId=00000000-0000-4000-8000-000000000000&before=0',
  '?id=00000000-0000-4000-8000-000000000000&wallet=hidden',
])('refuses invalid selectors: %s', async (query) => {
  expect((await get(query)).status).toBe(400);
  expect(f.factory).not.toHaveBeenCalled();
});
it('recovers runtime IDs and mode-aware history after Stop, while legacy preview GET refuses mislabelling them', async () => {
  const input = f.selection();
  await prepareWalletWarmupV2RuntimeAttempt(
    f.db,
    'owner',
    input,
    true,
    signal(),
    'synthetic-key',
    f.factory,
  );
  await f.control('stop');
  const statements = vi.spyOn(f.db, 'prepare');
  const result = await get('?id=' + input.id),
    value = (await result.json()) as {
      mode: string;
      runtime: { effectiveExpiresAt: string };
      attempt: { preview: { packetSha256: string } };
    };
  expect(result.status).toBe(200);
  expect(result.headers.get('cache-control')).toBe('no-store');
  expect(value.mode).toBe('runtime');
  expect(value.runtime.effectiveExpiresAt).toBeTruthy();
  expect(
    statements.mock.calls.filter(([sql]) =>
      sql.startsWith(
        'SELECT * FROM wallet_warmup_session_v2_attempts WHERE owner_id=? AND journal_id=? AND sequence>=?',
      ),
    ),
  ).toHaveLength(1);
  const history = await get('?journalId=' + input.journalId),
    page = (await history.json()) as {
      page: { requests: { id: string; mode: string }[] };
    };
  expect(page.page.requests).toMatchObject([{ id: input.id, mode: 'runtime' }]);
  const legacy = await previewGET(new Request(url + '?id=' + input.id));
  expect(legacy.status).toBe(409);
  expect(await legacy.json()).not.toHaveProperty('recoveryId');
  expect(
    (await previewGET(new Request(url + '?journalId=' + input.journalId)))
      .status,
  ).toBe(409);
  expect(f.factory).toHaveBeenCalledOnce();
  expect(f.raw.prepare).toHaveBeenCalledOnce();
  expect(JSON.stringify(value)).not.toContain('unsigned_transaction');
});
it('recovers previews through the new saved-only path without converting their purpose', async () => {
  const input = f.selection(),
    factory = vi.fn(() => async () => {
      throw Error('synthetic refusal');
    });
  await prepareWalletWarmupV2Attempt(
    f.db,
    'owner',
    input,
    true,
    signal(),
    'synthetic-key',
    factory,
  );
  const result = await get('?id=' + input.id);
  expect(await result.json()).toMatchObject({
    mode: 'preview',
    attempt: { id: input.id, outcome: { kind: 'refused' } },
  });
  expect((await previewGET(new Request(url + '?id=' + input.id))).status).toBe(
    200,
  );
  expect(
    await (await get('?journalId=' + input.journalId)).json(),
  ).toMatchObject({ page: { requests: [{ id: input.id, mode: 'preview' }] } });
  expect(factory).toHaveBeenCalledOnce();
  expect(f.raw.prepare).not.toHaveBeenCalled();
});
it('cancellation refuses recovery without creating provider work', async () => {
  const abort = new AbortController();
  abort.abort();
  expect(
    (
      await GET(
        new Request(url + '?id=' + crypto.randomUUID(), {
          signal: abort.signal,
        }),
      )
    ).status,
  ).toBe(408);
  expect(f.factory).not.toHaveBeenCalled();
});
