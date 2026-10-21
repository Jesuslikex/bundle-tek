import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { warmupSessionV2JournalFixture } from '@/test/warmup-session-v2-journal-fixture';
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
import type { publicWalletWarmupV2Journal } from '@/lib/wallet-warmup-session-v2-journal';
let f: Awaited<ReturnType<typeof warmupSessionV2JournalFixture>>;
const url = 'http://localhost/api/wallet-workspace/warmup/session-v2-journals';
beforeEach(async () => {
  f = await warmupSessionV2JournalFixture();
  mocks.db = f.db;
  mocks.user = { userId: 'owner' };
  mocks.getDb.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No provider in metadata history');
    }),
  );
});
afterEach(() => {
  f?.client.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const record = () => ({
  operation: 'record',
  ...f.rootInput,
  recordRequested: true,
});
const post = (
  value: unknown = record(),
  headers: Record<string, string> = {
    origin: 'http://localhost',
    'content-type': 'application/json',
  },
  signal?: AbortSignal,
) =>
  POST(
    new Request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(value),
      signal,
    }),
  );
it('recovers owned history and exact event receipt without exposing private source', async () => {
  expect((await post()).status).toBe(200);
  const id = crypto.randomUUID();
  const response = await post({
    operation: 'control',
    id,
    journalId: f.journal.id,
    version: 0,
    headSha256: f.journal.headSha256,
    control: 'begin-review',
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const saved = (await response.json()) as {
    journal: ReturnType<typeof publicWalletWarmupV2Journal>;
  };
  expect(saved.journal.commandReceipt?.id).toBe(id);
  expect(saved.journal.signingAllowed).toBe(false);
  expect(saved.journal.snapshot.completedActions).toBe(0);
  expect(saved.journal).not.toHaveProperty('manifest');
  expect(saved.journal).not.toHaveProperty('events');
  expect(
    await (
      await GET(new Request(url + '?id=' + f.journal.id + '&eventId=' + id))
    ).json(),
  ).toEqual(saved);
  expect(fetch).not.toHaveBeenCalled();
});
it('authenticates before SQL and does not reveal another owner history', async () => {
  mocks.user = null;
  expect((await post()).status).toBe(401);
  expect((await GET(new Request(url + '?id=' + f.journal.id))).status).toBe(
    401,
  );
  expect(mocks.getDb).not.toHaveBeenCalled();
  mocks.user = { userId: 'other' };
  expect((await GET(new Request(url + '?id=' + f.journal.id))).status).toBe(
    404,
  );
});
it.each([
  [
    { origin: 'https://foreign.example', 'content-type': 'application/json' },
    403,
  ],
  [{ origin: 'http://localhost', 'content-type': 'text/plain' }, 415],
] as const)(
  'rejects invalid request headers before SQL',
  async (headers, status) => {
    expect((await post(record(), headers)).status).toBe(status);
    expect(mocks.getDb).not.toHaveBeenCalled();
  },
);
it('rejects implicit consent, extra execution fields, duplicate query keys and streamed oversized bodies', async () => {
  expect((await post({ ...record(), recordRequested: false })).status).toBe(
    400,
  );
  expect((await post({ ...record(), signingAllowed: true })).status).toBe(400);
  expect(
    (
      await GET(
        new Request(url + '?id=' + f.journal.id + '&id=' + f.journal.id),
      )
    ).status,
  ).toBe(400);
  expect((await post({ padding: 'x'.repeat(3000) })).status).toBe(413);
  expect(mocks.getDb).not.toHaveBeenCalled();
});
it('returns fixed cancellation guidance with the original IDs recoverable by GET', async () => {
  const controller = new AbortController();
  controller.abort();
  expect((await post(record(), undefined, controller.signal)).status).toBe(408);
  expect((await GET(new Request(url + '?id=' + f.journal.id))).status).toBe(
    200,
  );
});
