import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { createTursoDatabase } from '@/db/turso';
import {
  initializeAutoSellRunStorageFixture,
  setupAutoSellRunStorageFixture,
  autoSellRunAttemptFixture,
} from '@/test/auto-sell-run-storage-fixture';
import { readAutoSellRun, readAutoSellRunAttempt } from '@/lib/auto-sell-run';
import { startOwnedAutoSellPreparation } from '@/lib/auto-sell-run-storage';
const auth = vi.hoisted(() => ({
  owner: 'alice' as string | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => (auth.owner ? { userId: auth.owner } : null),
}));
vi.mock('@/db', () => ({ getD1: () => auth.db }));
import { GET, POST } from './route';
const authority = {
  signingAllowed: false,
  executionAllowed: false,
  automaticResumeAllowed: false,
};
const url = 'https://bundle.test/api/imported-projects/auto-sell-runs';
let client: Client,
  fixture: Awaited<ReturnType<typeof setupAutoSellRunStorageFixture>>,
  fetcher: ReturnType<typeof vi.fn>;
const post = (body: unknown, extra: Record<string, string> = {}) =>
  POST(
    new Request(url, {
      method: 'POST',
      headers: {
        origin: 'https://bundle.test',
        'content-type': 'application/json',
        ...extra,
      },
      body: JSON.stringify(body),
    }),
  );
const get = (params: Record<string, string>) =>
  GET(new Request(url + '?' + new URLSearchParams(params)));
const json = async (response: Response) => {
  expect(response.headers.get('cache-control')).toBe('no-store');
  const value = (await response.json()) as Record<string, unknown>;
  expect(value).toMatchObject(authority);
  return value;
};
const create = () => post({ action: 'create', ...fixture.createInput });
async function root() {
  const response = await create();
  expect(response.status).toBe(200);
  return readAutoSellRun((await json(response)).run);
}
beforeEach(async () => {
  auth.owner = 'alice';
  client = createClient({ url: 'file::memory:' });
  auth.db = createTursoDatabase(client);
  await initializeAutoSellRunStorageFixture(auth.db);
  fixture = await setupAutoSellRunStorageFixture(auth.db, { owner: 'alice' });
  fetcher = vi.fn(async () => {
    throw Error('Provider calls forbidden in journal HTTP tests');
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  expect(fetcher).not.toHaveBeenCalled();
  client.close();
  vi.unstubAllGlobals();
});

it('requires authentication before reading or writing a run', async () => {
  auth.owner = null;
  const a = await create(),
    b = await get({ projectId: fixture.projectId });
  expect(a.status).toBe(401);
  expect(b.status).toBe(401);
  await json(a);
  await json(b);
  expect(
    (await client.execute('SELECT count(*) AS n FROM auto_sell_runs')).rows[0]
      .n,
  ).toBe(0);
});
it.each(['https://elsewhere.test', 'null', ''])(
  'requires same-origin journal approval (%s)',
  async (origin) => {
    const r = await post(
      { action: 'create', ...fixture.createInput },
      { origin },
    );
    expect(r.status).toBe(403);
    await json(r);
  },
);
it.each(['text/plain', 'application/jsonp', 'application/json-invalid'])(
  'refuses non-JSON %s',
  async (type) => {
    expect(
      (
        await post(
          { action: 'create', ...fixture.createInput },
          { 'content-type': type },
        )
      ).status,
    ).toBe(415);
  },
);
it.each([
  null,
  [],
  {},
  { action: 'sign' },
  { action: 'submit' },
  { action: 'prepare' },
  { action: 'create' },
  { action: 'reserve' },
  { action: 'stop' },
])('refuses incomplete or authority-seeking request %#', async (value) => {
  const r = await post(value);
  expect(r.status).toBe(400);
  await json(r);
});
it('refuses additional authority/progress assertions instead of enabling them', async () => {
  for (const extra of [
    { signingAllowed: true },
    { executionAllowed: true },
    { soldRaw: '0' },
    { automaticResumeAllowed: true },
  ]) {
    const r = await post({
      action: 'create',
      ...fixture.createInput,
      ...extra,
    });
    expect(r.status).toBe(400);
    await json(r);
  }
});
it('requires separate exact recording and stopping consent', async () => {
  expect(
    (await post({ action: 'create', ...fixture.createInput, consent: false }))
      .status,
  ).toBe(400);
  const run = await root();
  expect(
    (
      await post({
        action: 'stop',
        id: crypto.randomUUID(),
        runId: run.id,
        runSha256: run.sha256,
        consent: false,
      })
    ).status,
  ).toBe(400);
});
it('enforces the actual byte limit before source writes', async () => {
  const r = await post({
    action: 'create',
    ...fixture.createInput,
    extra: 'x'.repeat(32769),
  });
  expect(r.status).toBe(400);
  expect(
    (await client.execute('SELECT count(*) AS n FROM auto_sell_runs')).rows[0]
      .n,
  ).toBe(0);
});
it('records only an owned, exact saved configuration and keeps every authority false', async () => {
  const run = await root();
  expect(run.profile.id).toBe(fixture.profileSaveId);
  expect(run.profile.sha256).toBe(fixture.profileSha256);
  expect(run.ownWallets).toHaveLength(2);
  expect(run).toMatchObject(authority);
  const again = await create();
  expect(again.status).toBe(200);
  expect((await json(again)).run).toEqual(run);
  expect(
    (await client.execute('SELECT count(*) AS n FROM auto_sell_runs')).rows[0]
      .n,
  ).toBe(1);
  expect(
    (
      await client.execute(
        'SELECT count(*) AS n FROM imported_swap_signing_intents',
      )
    ).rows[0].n,
  ).toBe(0);
});
it('keeps another owner from reading, reserving or stopping a captured run', async () => {
  const run = await root();
  auth.owner = 'bob';
  expect((await get({ runId: run.id })).status).toBe(404);
  expect(
    (await post({ action: 'reserve', attempt: autoSellRunAttemptFixture(run) }))
      .status,
  ).toBe(404);
  expect(
    (
      await post({
        action: 'stop',
        id: crypto.randomUUID(),
        runId: run.id,
        runSha256: run.sha256,
        consent: 'stop-auto-sell-run-v1',
      })
    ).status,
  ).toBe(409);
  expect(
    (await client.execute('SELECT state FROM auto_sell_run_heads')).rows[0]
      .state,
  ).toBe('open');
  expect(
    (await client.execute('SELECT count(*) AS n FROM auto_sell_run_stops'))
      .rows[0].n,
  ).toBe(0);
  expect((await get({ projectId: fixture.projectId })).status).toBe(200);
  expect(
    (await json(await get({ projectId: fixture.projectId }))).runs,
  ).toEqual([]);
});
it('recovers the same reservation by original IDs without preparing or double charging', async () => {
  const run = await root(),
    input = autoSellRunAttemptFixture(run);
  const a = await post({ action: 'reserve', attempt: input });
  expect(a.status).toBe(200);
  const original = await readAutoSellRunAttempt((await json(a)).attempt);
  const repeat = await post({ action: 'reserve', attempt: input });
  expect(repeat.status).toBe(200);
  expect((await json(repeat)).attempt).toEqual(original);
  const exact = await get({ runId: run.id, attemptId: original.id });
  expect(exact.status).toBe(200);
  expect((await json(exact)).attempt).toEqual(original);
  const history = await json(await get({ runId: run.id }));
  expect(history.accounting).toMatchObject({
    sequence: 1,
    accountedRaw: '10',
    strategies: [
      { id: 'counter', claimedKeyCount: 1 },
      { id: 'dca', claimedKeyCount: 0 },
      { id: 'limit', claimedKeyCount: 0 },
    ],
  });
  expect(Object.hasOwn(history, 'attempts')).toBe(false);
  expect(history.preparationStarts).toEqual([]);
  expect(
    (
      await client.execute(
        'SELECT count(*) AS n FROM imported_swap_preparations',
      )
    ).rows[0].n,
  ).toBe(0);
});
it('rejects same-ID substitution and duplicate occurrence claims', async () => {
  const run = await root(),
    input = autoSellRunAttemptFixture(run);
  const a = await readAutoSellRunAttempt(
    (await json(await post({ action: 'reserve', attempt: input }))).attempt,
  );
  expect(
    (await post({ action: 'reserve', attempt: { ...input, inputRaw: '9' } }))
      .status,
  ).toBe(409);
  expect(
    (
      await post({
        action: 'reserve',
        attempt: {
          ...input,
          id: crypto.randomUUID(),
          expectedSequence: 1,
          expectedHeadSha256: a.sha256,
        },
      })
    ).status,
  ).toBe(409);
  expect((await json(await get({ runId: run.id }))).accounting).toMatchObject({
    sequence: 1,
    accountedRaw: '10',
  });
});
it('stops new work while preserving charged exposure and original attempt recovery', async () => {
  const run = await root();
  const a = await readAutoSellRunAttempt(
    (
      await json(
        await post({
          action: 'reserve',
          attempt: autoSellRunAttemptFixture(run),
        }),
      )
    ).attempt,
  );
  const request = {
    action: 'stop',
    id: crypto.randomUUID(),
    runId: run.id,
    runSha256: run.sha256,
    consent: 'stop-auto-sell-run-v1',
  };
  const stopped = await post(request);
  expect(stopped.status).toBe(200);
  const original = await json(stopped);
  expect((await json(await post(request))).stop).toEqual(original.stop);
  const history = await json(await get({ runId: run.id }));
  expect(history.stopped).toBe(true);
  expect(history.accounting).toMatchObject({ accountedRaw: '10' });
  expect((await get({ runId: run.id, attemptId: a.id })).status).toBe(200);
  expect(
    (
      await post({
        action: 'reserve',
        attempt: autoSellRunAttemptFixture(run, {
          id: crypto.randomUUID(),
          expectedSequence: 1,
          expectedHeadSha256: a.sha256,
          occurrence: {
            kind: 'counter',
            sourceIds: ['other'],
            bufferedRaw: '1',
          },
          inputRaw: '1',
        }),
      })
    ).status,
  ).toBe(409);
});
it('refuses a fresh run on the same token/wallet while a stopped run retains unresolved exposure', async () => {
  const run = await root();
  await post({ action: 'reserve', attempt: autoSellRunAttemptFixture(run) });
  await post({
    action: 'stop',
    id: crypto.randomUUID(),
    runId: run.id,
    runSha256: run.sha256,
    consent: 'stop-auto-sell-run-v1',
  });
  expect(
    (
      await post({
        action: 'create',
        ...fixture.createInput,
        id: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
  expect((await create()).status).toBe(200);
});
it('does not let two previously empty runs double reserve the same token and wallet', async () => {
  const first = await root();
  const secondReply = await post({
    action: 'create',
    ...fixture.createInput,
    id: crypto.randomUUID(),
  });
  expect(secondReply.status).toBe(200);
  const second = await readAutoSellRun((await json(secondReply)).run);
  const initial = autoSellRunAttemptFixture(first);
  expect((await post({ action: 'reserve', attempt: initial })).status).toBe(
    200,
  );
  expect(
    (
      await post({
        action: 'reserve',
        attempt: autoSellRunAttemptFixture(second),
      })
    ).status,
  ).toBe(409);
  expect(
    (await json(await get({ runId: second.id }))).accounting,
  ).toMatchObject({ sequence: 0, accountedRaw: '0' });
  expect((await post({ action: 'reserve', attempt: initial })).status).toBe(
    200,
  );
  expect((await json(await get({ runId: first.id }))).accounting).toMatchObject(
    { sequence: 1, accountedRaw: '10' },
  );
});
it('reads orphaned original history and permits stop after current context changes', async () => {
  const run = await root();
  await client.execute({
    sql: 'UPDATE imported_token_projects SET archived=1,revision=2 WHERE owner_id=? AND id=?',
    args: ['alice', fixture.projectId],
  });
  await client.execute(
    "UPDATE workspace_wallets SET archived=1,revision=2 WHERE owner_id='alice'",
  );
  expect((await get({ runId: run.id })).status).toBe(200);
  expect(
    (await post({ action: 'reserve', attempt: autoSellRunAttemptFixture(run) }))
      .status,
  ).toBe(409);
  expect(
    (
      await post({
        action: 'stop',
        id: crypto.randomUUID(),
        runId: run.id,
        runSha256: run.sha256,
        consent: 'stop-auto-sell-run-v1',
      })
    ).status,
  ).toBe(200);
});
it.each([
  {},
  { runId: 'bad' },
  { attemptId: crypto.randomUUID() },
  { projectId: 'bad' },
  { projectId: 'x', beforeId: 'x' },
  { runId: crypto.randomUUID(), projectId: 'x' },
  { runId: crypto.randomUUID(), beforeAt: 'x' },
  { runId: crypto.randomUUID(), attemptId: 'bad' },
])('refuses malformed history lookup %#', async (query) => {
  const r = await get(query as Record<string, string>);
  expect(r.status).toBe(400);
  await json(r);
});
it('refuses duplicate/unknown query coordinates', async () => {
  for (const query of [
    '?runId=a&runId=b',
    '?projectId=a&extra=1',
    '?runId=a&sign=true',
  ])
    expect((await GET(new Request(url + query))).status).toBe(400);
});
it('returns a complete lean owner index without exposing source documents', async () => {
  const run = await root();
  const response = await get({ projectId: fixture.projectId });
  expect(response.status).toBe(200);
  const value = await json(response);
  expect(value.runs).toMatchObject([
    {
      id: run.id,
      profileSaveId: fixture.profileSaveId,
      attemptCount: 0,
      accountedRaw: '0',
      stopped: false,
    },
  ]);
  expect(JSON.stringify(value)).not.toContain('source_document');
  expect(JSON.stringify(value)).not.toContain('ownWallets');
  expect(value.nextCursor).toBeNull();
});
it('returns408 for an aborted request and retains no unconfirmed new root', async () => {
  const controller = new AbortController();
  controller.abort();
  const r = await POST(
    new Request(url, {
      method: 'POST',
      headers: {
        origin: 'https://bundle.test',
        'content-type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({ action: 'create', ...fixture.createInput }),
    }),
  );
  expect(r.status).toBe(408);
  await json(r);
  expect(
    (await client.execute('SELECT count(*) AS n FROM auto_sell_runs')).rows[0]
      .n,
  ).toBe(0);
});
async function appendAttempts(
  run: Awaited<ReturnType<typeof root>>,
  count: number,
) {
  const attempts: Awaited<ReturnType<typeof readAutoSellRunAttempt>>[] = [];
  let previous = run.sha256;
  for (let n = 0; n < count; n++) {
    const response = await post({
      action: 'reserve',
      attempt: autoSellRunAttemptFixture(run, {
        expectedSequence: n,
        expectedHeadSha256: previous,
        occurrence: {
          kind: 'counter',
          sourceIds: ['opaque-source-' + n],
          bufferedRaw: '10',
        },
      }),
    });
    expect(response.status).toBe(200);
    const attempt = await readAutoSellRunAttempt(
      (await json(response)).attempt,
    );
    attempts.push(attempt);
    previous = attempt.sha256;
  }
  return attempts;
}
it('adds an explicitly bound read-only index without changing the original index response', async () => {
  const run = await root();
  const original = await json(await get({ projectId: fixture.projectId }));
  const index = await json(
    await get({ projectId: fixture.projectId, index: '1' }),
  );
  expect(index).toEqual({ projectId: fixture.projectId, ...original });
  expect(original).not.toHaveProperty('projectId');
  expect(index.runs).toMatchObject([{ id: run.id }]);
});
it('pages the complete owned attempt journal with original context, hashes and exact start markers', async () => {
  const run = await root(),
    attempts = await appendAttempts(run, 25);
  await startOwnedAutoSellPreparation(
    auth.db,
    'alice',
    run.id,
    attempts[24].id,
    new AbortController().signal,
  );
  const before = (await client.execute('SELECT total_changes() AS n')).rows[0]
    .n;
  const first = await json(await get({ runId: run.id, attempts: '1' }));
  expect(first).toMatchObject({
    runId: run.id,
    runSha256: run.sha256,
    context: {
      projectId: fixture.projectId,
      projectRevision: 1,
      mint: fixture.mint,
      decimals: 0,
    },
    accounting: {
      sequence: 25,
      headSha256: attempts[24].sha256,
      accountedRaw: '250',
    },
    stopped: false,
    nextBeforeSequence: 6,
  });
  const rows = first.attempts as Record<string, unknown>[];
  expect(rows.map((r) => r.sequence)).toEqual(
    Array.from({ length: 20 }, (_, n) => 25 - n),
  );
  expect(rows[0]).toEqual({
    id: attempts[24].id,
    sequence: 25,
    attemptSha256: attempts[24].sha256,
    strategyId: 'counter',
    wallet: fixture.wallet,
    walletRevision: 1,
    inputRaw: '10',
    preparationId: attempts[24].preparationId,
    reservedAt: attempts[24].reservedAt,
    preparationStarted: true,
  });
  expect(rows.slice(1).every((r) => r.preparationStarted === false)).toBe(true);
  for (const row of rows)
    expect(Object.keys(row).sort()).toEqual(
      [
        'id',
        'sequence',
        'attemptSha256',
        'strategyId',
        'wallet',
        'walletRevision',
        'inputRaw',
        'preparationId',
        'reservedAt',
        'preparationStarted',
      ].sort(),
    );
  expect(JSON.stringify(first)).not.toContain('opaque-source-');
  expect(JSON.stringify(first)).not.toContain('transaction');
  const second = await json(
    await get({ runId: run.id, attempts: '1', beforeSequence: '6' }),
  );
  const older = second.attempts as Record<string, unknown>[];
  expect(older.map((r) => r.sequence)).toEqual([5, 4, 3, 2, 1]);
  expect(second.nextBeforeSequence).toBeNull();
  expect(new Set([...rows, ...older].map((r) => r.id)).size).toBe(25);
  expect((await client.execute('SELECT total_changes() AS n')).rows[0].n).toBe(
    before,
  );
});
it('returns an empty valid first page and accepts cursor one only when that attempt actually exists', async () => {
  const run = await root();
  const empty = await json(await get({ runId: run.id, attempts: '1' }));
  expect(empty.attempts).toEqual([]);
  expect(empty.nextBeforeSequence).toBeNull();
  expect(
    (await get({ runId: run.id, attempts: '1', beforeSequence: '1' })).status,
  ).toBe(400);
  await appendAttempts(run, 1);
  const final = await json(
    await get({ runId: run.id, attempts: '1', beforeSequence: '1' }),
  );
  expect(final.attempts).toEqual([]);
  expect(final.nextBeforeSequence).toBeNull();
  expect(
    (await get({ runId: run.id, attempts: '1', beforeSequence: '2' })).status,
  ).toBe(400);
});
it('keeps stopped and archived-source attempts readable with the original context', async () => {
  const run = await root(),
    [attempt] = await appendAttempts(run, 1);
  await post({
    action: 'stop',
    id: crypto.randomUUID(),
    runId: run.id,
    runSha256: run.sha256,
    consent: 'stop-auto-sell-run-v1',
  });
  await client.execute({
    sql: 'UPDATE imported_token_projects SET archived=1,revision=2 WHERE owner_id=?',
    args: ['alice'],
  });
  await client.execute({
    sql: 'UPDATE workspace_wallets SET archived=1,revision=2 WHERE owner_id=?',
    args: ['alice'],
  });
  const page = await json(await get({ runId: run.id, attempts: '1' }));
  expect(page).toMatchObject({
    stopped: true,
    context: {
      projectId: fixture.projectId,
      projectRevision: 1,
      mint: fixture.mint,
      decimals: 0,
    },
    attempts: [{ id: attempt.id, inputRaw: '10', preparationStarted: false }],
  });
});
it('refuses a corrupted older attempt outside the first page rather than returning partial valid rows', async () => {
  const run = await root();
  await appendAttempts(run, 21);
  const trigger = (
    await client.execute(
      "SELECT sql FROM sqlite_master WHERE name='auto_sell_run_attempts_no_update'",
    )
  ).rows[0].sql;
  expect(typeof trigger).toBe('string');
  await client.execute('DROP TRIGGER auto_sell_run_attempts_no_update');
  await client.execute({
    sql: "UPDATE auto_sell_run_attempts SET document=json_set(document,'$.inputRaw','11') WHERE owner_id=? AND run_id=? AND sequence=1",
    args: ['alice', run.id],
  });
  if (typeof trigger !== 'string') throw Error('Fixture trigger missing');
  await client.execute(trigger);
  const response = await get({ runId: run.id, attempts: '1' });
  expect(response.status).toBe(409);
  const body = await json(response);
  expect(body).not.toHaveProperty('attempts');
});
it.each([
  '0',
  '01',
  '-1',
  '+1',
  '1.0',
  '1e0',
  '1001',
  '9007199254740992',
  ' ',
  'NaN',
  'Infinity',
])('refuses noncanonical attempt cursor %s', async (beforeSequence) => {
  const run = await root();
  const r = await get({ runId: run.id, attempts: '1', beforeSequence });
  expect(r.status).toBe(400);
  await json(r);
});
it.each([
  'attempts=1',
  'runId=bad&attempts=1',
  'runId=x&attempts=0',
  'runId=x&attempts=true',
  'runId=x&beforeSequence=1',
  'runId=x&attempts=1&attemptId=x',
  'runId=x&attempts=1&projectId=x',
  'runId=x&attempts=1&attempts=1',
  'runId=x&runId=y&attempts=1',
  'runId=x&attempts=1&beforeSequence=1&beforeSequence=1',
  'runId=x&attempts=1&beforeId=x',
  'runId=x&attempts=1&index=1',
  'runId=x&attempts=1&extra=1',
  'index=1',
  'projectId=bad&index=1',
  'projectId=x&index=0',
  'projectId=x&index=true',
  'projectId=x&index=1&index=1',
  'projectId=x&projectId=y&index=1',
  'projectId=x&index=1&runId=x',
  'projectId=x&index=1&beforeId=x',
  'projectId=x&index=1&beforeAt=x',
  'projectId=x&index=1&extra=1',
])(
  'refuses mixed, duplicate or malformed new read coordinates %#',
  async (query) => {
    const response = await GET(new Request(url + '?' + query));
    expect(response.status).toBe(400);
    await json(response);
  },
);
it('keeps new read routes owner-isolated and refuses foreign index cursors', async () => {
  const run = await root();
  await appendAttempts(run, 1);
  auth.owner = 'bob';
  expect((await get({ runId: run.id, attempts: '1' })).status).toBe(404);
  const index = await json(
    await get({ projectId: fixture.projectId, index: '1' }),
  );
  expect(index).toMatchObject({
    projectId: fixture.projectId,
    runs: [],
    nextCursor: null,
  });
  expect(
    (
      await get({
        projectId: fixture.projectId,
        index: '1',
        beforeId: run.id,
        beforeAt: run.createdAt,
      })
    ).status,
  ).toBe(400);
  auth.owner = null;
  expect((await get({ runId: run.id, attempts: '1' })).status).toBe(401);
  expect((await get({ projectId: fixture.projectId, index: '1' })).status).toBe(
    401,
  );
});
it('maps cancelled new saved reads to408 without changing any journal record', async () => {
  const run = await root(),
    controller = new AbortController();
  controller.abort();
  for (const query of [
    new URLSearchParams({ runId: run.id, attempts: '1' }),
    new URLSearchParams({ projectId: fixture.projectId, index: '1' }),
  ]) {
    const response = await GET(
      new Request(url + '?' + query, { signal: controller.signal }),
    );
    expect(response.status).toBe(408);
    await json(response);
  }
  expect((await json(await get({ runId: run.id }))).accounting).toMatchObject({
    sequence: 0,
    accountedRaw: '0',
  });
});
