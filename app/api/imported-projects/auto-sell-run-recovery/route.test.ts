import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { createTursoDatabase } from '@/db/turso';
import {
  initializeAutoSellRunStorageFixture,
  setupAutoSellRunStorageFixture,
  autoSellRunAttemptFixture,
} from '@/test/auto-sell-run-storage-fixture';
import {
  createOwnedAutoSellRun,
  reserveOwnedAutoSellAttempt,
  startOwnedAutoSellPreparation,
  stopOwnedAutoSellRun,
} from '@/lib/auto-sell-run-storage';
const auth = vi.hoisted(() => ({
  owner: 'alice' as string | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => (auth.owner ? { userId: auth.owner } : null),
}));
vi.mock('@/db', () => ({ getD1: () => auth.db }));
import { GET } from './route';

let client: Client;
let fixture: Awaited<ReturnType<typeof setupAutoSellRunStorageFixture>>;
let run: Awaited<ReturnType<typeof createOwnedAutoSellRun>>;
let attempt: Awaited<ReturnType<typeof reserveOwnedAutoSellAttempt>>;
let fetcher: ReturnType<typeof vi.fn>;
const signal = () => new AbortController().signal;
const url = 'https://bundle.test/api/imported-projects/auto-sell-run-recovery';
const get = (
  query = new URLSearchParams({
    runId: run.id,
    attemptId: attempt.id,
  }).toString(),
  init?: RequestInit,
) => GET(new Request(url + '?' + query, init));
const checked = async (response: Response) => {
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = await response.json();
  expect(body).toMatchObject({
    signingAllowed: false,
    executionAllowed: false,
    automaticResumeAllowed: false,
    allowanceReleased: false,
  });
  return body;
};
beforeEach(async () => {
  auth.owner = 'alice';
  client = createClient({ url: ':memory:' });
  auth.db = createTursoDatabase(client);
  await initializeAutoSellRunStorageFixture(auth.db);
  for (const sql of readFileSync(
    'drizzle/0154_auto_sell_run_packets.sql',
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await auth.db.prepare(sql).run();
  fixture = await setupAutoSellRunStorageFixture(auth.db, { owner: 'alice' });
  run = await createOwnedAutoSellRun(
    auth.db,
    'alice',
    fixture.createInput,
    signal(),
  );
  attempt = await reserveOwnedAutoSellAttempt(
    auth.db,
    'alice',
    autoSellRunAttemptFixture(run),
    signal(),
  );
  fetcher = vi.fn(async () => {
    throw Error('Network forbidden in saved-only recovery');
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  expect(fetcher).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  client.close();
});

it('requires sign-in before inspecting any original preparation', async () => {
  auth.owner = null;
  const response = await get();
  expect(response.status).toBe(401);
  await checked(response);
});
it.each([
  '',
  'runId=invalid&attemptId=invalid',
  'runId=one',
  'attemptId=two',
  'runId=one&runId=two&attemptId=three',
  'runId=one&attemptId=two&packet=claimed',
])(
  'refuses incomplete, duplicate or extra recovery selectors (%s)',
  async (query) => {
    const response = await get(query);
    expect(response.status).toBe(400);
    await checked(response);
  },
);
it('reports a reserved attempt without treating it as started, filled or releasable', async () => {
  const response = await get();
  expect(response.status).toBe(200);
  expect(await checked(response)).toMatchObject({
    status: 'not-started',
    runId: run.id,
    attemptId: attempt.id,
    preparationId: attempt.preparationId,
    packet: null,
    summary: null,
  });
  expect(
    (await client.execute('SELECT accounted_low FROM auto_sell_run_heads'))
      .rows[0].accounted_low,
  ).toBe(10);
});
it('keeps an unknown started result distinguishable from no start and retains its allowance', async () => {
  await startOwnedAutoSellPreparation(
    auth.db,
    'alice',
    run.id,
    attempt.id,
    signal(),
  );
  const response = await get();
  expect(response.status).toBe(200);
  expect(await checked(response)).toMatchObject({
    status: 'started-without-result',
    packet: null,
    summary: null,
  });
  expect(
    (await client.execute('SELECT accounted_low FROM auto_sell_run_heads'))
      .rows[0].accounted_low,
  ).toBe(10);
  expect(
    (
      await client.execute(
        'SELECT count(*) AS n FROM auto_sell_run_preparation_starts',
      )
    ).rows[0].n,
  ).toBe(1);
});
it('preserves saved inspection after Stop and archive without reading current provider state', async () => {
  await startOwnedAutoSellPreparation(
    auth.db,
    'alice',
    run.id,
    attempt.id,
    signal(),
  );
  await stopOwnedAutoSellRun(
    auth.db,
    'alice',
    { id: crypto.randomUUID(), runId: run.id, runSha256: run.sha256 },
    signal(),
  );
  await client.execute(
    'UPDATE imported_token_projects SET archived=1,revision=2',
  );
  const response = await get();
  expect(response.status).toBe(200);
  expect(await checked(response)).toMatchObject({
    status: 'started-without-result',
  });
});
it('isolates another account and another attempt without exposing stored metadata', async () => {
  auth.owner = 'bob';
  const foreign = await get();
  expect(foreign.status).toBe(404);
  const body = await checked(foreign);
  expect(JSON.stringify(body)).not.toContain(fixture.profileSha256);
  auth.owner = 'alice';
  const missing = await get(
    new URLSearchParams({
      runId: run.id,
      attemptId: crypto.randomUUID(),
    }).toString(),
  );
  expect(missing.status).toBe(404);
  await checked(missing);
});
it('cancellation cannot imply absence, reset or release a journal hold', async () => {
  const controller = new AbortController();
  controller.abort();
  const response = await get(undefined, { signal: controller.signal });
  expect(response.status).toBe(408);
  await checked(response);
  expect(
    (await client.execute('SELECT accounted_low FROM auto_sell_run_heads'))
      .rows[0].accounted_low,
  ).toBe(10);
});
