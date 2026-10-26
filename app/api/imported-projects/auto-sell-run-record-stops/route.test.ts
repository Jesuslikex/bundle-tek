import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createClient, type Client } from '@libsql/client';
import { createTursoDatabase } from '@/db/turso';
import {
  initializeAutoSellRunStorageFixture,
  setupAutoSellRunStorageFixture,
} from '@/test/auto-sell-run-storage-fixture';
import { autoSellRunEnrollmentOwnerScope } from '@/lib/auto-sell-run-record-stop';
const state = vi.hoisted(() => ({
  owner: 'alice' as string | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => (state.owner ? { userId: state.owner } : null),
}));
vi.mock('@/db', () => ({ getD1: () => state.db }));
import { GET, POST } from './route';
const url =
  'https://bundle.test/api/imported-projects/auto-sell-run-record-stops';
let client: Client,
  f: Awaited<ReturnType<typeof setupAutoSellRunStorageFixture>>,
  fetcher: ReturnType<typeof vi.fn>;
const get = (query: string) => GET(new Request(url + '?' + query));
const input = () => ({
  projectId: f.projectId,
  runId: f.createInput.id,
  profileSaveId: f.profileSaveId,
  profileSha256: f.profileSha256,
  consent: 'stop-original-run-record-v1',
});
const post = (value: unknown = input(), headers: Record<string, string> = {}) =>
  POST(
    new Request(url, {
      method: 'POST',
      headers: {
        origin: 'https://bundle.test',
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(value),
    }),
  );
async function body(response: Response, status = 200) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const b = (await response.json()) as Record<string, unknown>;
  expect(b).toMatchObject({
    signingAllowed: false,
    executionAllowed: false,
    automaticResumeAllowed: false,
  });
  return b;
}
beforeEach(async () => {
  state.owner = 'alice';
  client = createClient({ url: 'file::memory:' });
  state.db = createTursoDatabase(client);
  await initializeAutoSellRunStorageFixture(state.db);
  for (const sql of readFileSync(
    'drizzle/0155_auto_sell_run_record_stops.sql',
    'utf8',
  ).split('--> statement-breakpoint'))
    await state.db.prepare(sql).run();
  f = await setupAutoSellRunStorageFixture(state.db, { owner: 'alice' });
  fetcher = vi.fn(async () => {
    throw Error('No providers in record-stop API');
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  expect(fetcher).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  client.close();
});
it('reports exact schema capability and owner scope without writes', async () => {
  const before = (await client.execute('SELECT total_changes() AS n')).rows[0]
    .n;
  expect(await body(await get('capability=1'))).toEqual({
    ownerScope: await autoSellRunEnrollmentOwnerScope('alice'),
    recordStopSupported: true,
    signingAllowed: false,
    executionAllowed: false,
    automaticResumeAllowed: false,
  });
  expect((await client.execute('SELECT total_changes() AS n')).rows[0].n).toBe(
    before,
  );
});
it('distinguishes nonterminal absence from an immutable fence and recovers the same receipt', async () => {
  expect(await body(await get('runId=' + input().runId))).toMatchObject({
    stop: null,
    run: null,
  });
  const saved = await body(await post());
  expect(saved).toMatchObject({
    run: null,
    stop: { status: 'creation-fenced' },
  });
  expect(await body(await get('runId=' + input().runId))).toEqual(saved);
  expect(await body(await post())).toEqual(saved);
  expect(JSON.stringify(saved)).not.toContain('alice');
});
it('requires auth and owner isolation', async () => {
  await body(await post());
  state.owner = 'bob';
  expect(await body(await get('runId=' + input().runId))).toMatchObject({
    run: null,
    stop: null,
  });
  state.owner = null;
  await body(await get('capability=1'), 401);
  await body(await post(), 401);
});
it.each([
  '',
  'capability=0',
  'capability=1&capability=1',
  'capability=1&runId=x',
  'runId=x',
  'runId=x&runId=y',
  'runId=x&extra=1',
])('refuses malformed read %s', async (query) => {
  await body(await get(query), 400);
});
it.each([
  { consent: false },
  { extra: 1 },
  { runId: 'bad' },
  { signingAllowed: true },
])('refuses malformed approval %#', async (mutation) => {
  await body(await post({ ...input(), ...mutation }), 400);
  expect(
    (
      await client.execute(
        'SELECT count(*) AS n FROM auto_sell_run_record_stops',
      )
    ).rows[0].n,
  ).toBe(0);
});
it('requires same-origin bounded JSON and explicit consent', async () => {
  await body(await post(input(), { origin: 'https://other.test' }), 403);
  await body(await post(input(), { 'content-type': 'text/plain' }), 415);
  await body(await post({ ...input(), padding: 'x'.repeat(2048) }), 400);
});
it('fails closed after capability schema drift and on abort', async () => {
  await body(await get('capability=1'));
  await client.execute('DROP TRIGGER auto_sell_runs_record_stop_fence');
  await body(await get('capability=1'), 503);
  await body(await post(), 503);
  const controller = new AbortController();
  controller.abort();
  await body(
    await GET(
      new Request(url + '?runId=' + input().runId, {
        signal: controller.signal,
      }),
    ),
    408,
  );
});
