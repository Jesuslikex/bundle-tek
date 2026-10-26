import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { createTursoDatabase } from '@/db/turso';
import {
  initializeAutoSellRunStorageFixture,
  setupAutoSellRunStorageFixture,
  autoSellRunAttemptFixture,
} from '@/test/auto-sell-run-storage-fixture';
import { readAutoSellRun } from '@/lib/auto-sell-run';

const auth = vi.hoisted(() => ({
  owner: 'alice' as string | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => (auth.owner ? { userId: auth.owner } : null),
}));
vi.mock('@/db', () => ({ getD1: () => auth.db }));
import { GET, POST } from '@/app/api/imported-projects/auto-sell-runs/route';
import {
  GET as profileGET,
  POST as profilePOST,
} from '@/app/api/imported-projects/auto-sell-profiles/route';

const url = 'https://bundle.test/api/imported-projects/auto-sell-runs';
const profileUrl =
  'https://bundle.test/api/imported-projects/auto-sell-profiles';
const authority = {
  signingAllowed: false,
  executionAllowed: false,
  automaticResumeAllowed: false,
};
function statementSql(statement: unknown) {
  if (typeof statement === 'string') return statement;
  if (statement !== null && typeof statement === 'object') {
    const sql: unknown = Reflect.get(statement, 'sql');
    if (typeof sql === 'string') return sql;
  }
  return '';
}
let client: Client;
let fixture: Awaited<ReturnType<typeof setupAutoSellRunStorageFixture>>;
let fetcher: ReturnType<typeof vi.fn>;
function request(body: unknown, target = url) {
  return new Request(target, {
    method: 'POST',
    headers: {
      origin: 'https://bundle.test',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}
const create = (input = fixture.createInput) =>
  POST(request({ action: 'create', ...input }));
const get = (runId = fixture.createInput.id) =>
  GET(new Request(url + '?' + new URLSearchParams({ runId })));
async function body(response: Response, status = 200) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const result = (await response.json()) as Record<string, unknown>;
  expect(result).toMatchObject(authority);
  return result;
}
const count = async (table: string) =>
  (await client.execute('SELECT count(*) AS n FROM ' + table)).rows[0].n;
async function noPreparation() {
  for (const table of [
    'auto_sell_run_attempts',
    'auto_sell_run_preparation_starts',
    'imported_swap_preparations',
    'imported_swap_signing_intents',
  ])
    expect(await count(table)).toBe(0);
}
beforeEach(async () => {
  auth.owner = 'alice';
  client = createClient({ url: 'file::memory:' });
  auth.db = createTursoDatabase(client);
  await initializeAutoSellRunStorageFixture(auth.db);
  fixture = await setupAutoSellRunStorageFixture(auth.db, { owner: 'alice' });
  fetcher = vi.fn(async () => {
    throw Error('Enrollment must not call providers');
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  expect(fetcher).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  client.close();
});

it('reads the exact approved saved profile, loses the create reply, then recovers and replays the same empty run', async () => {
  const profile = await body(
    await profileGET(
      new Request(
        profileUrl +
          '?' +
          new URLSearchParams({
            projectId: fixture.projectId,
            id: fixture.profileSaveId,
          }),
      ),
    ),
  );
  expect(profile.profile).toEqual(fixture.profile);
  const initial = await create();
  expect(initial.status).toBe(200); // The transport loses this response; no client JSON is used.
  const before = (await client.execute('SELECT total_changes() AS n')).rows[0]
    .n;
  const recovered = await body(await get());
  const run = await readAutoSellRun(recovered.run);
  expect(run).toMatchObject({
    id: fixture.createInput.id,
    profile: fixture.profile,
    ...authority,
  });
  expect(recovered.accounting).toMatchObject({
    sequence: 0,
    accountedRaw: '0',
    headSha256: run.sha256,
  });
  expect(recovered.preparationStarts).toEqual([]);
  expect(recovered.stopped).toBe(false);
  expect((await client.execute('SELECT total_changes() AS n')).rows[0].n).toBe(
    before,
  );
  expect((await body(await create())).run).toEqual(run);
  const index = await body(
    await GET(
      new Request(
        url +
          '?' +
          new URLSearchParams({ projectId: fixture.projectId, index: '1' }),
      ),
    ),
  );
  expect(index).toMatchObject({
    projectId: fixture.projectId,
    runs: [{ id: run.id, runSha256: run.sha256 }],
    nextCursor: null,
  });
  expect(await count('auto_sell_runs')).toBe(1);
  await noPreparation();
});

it('recovers a database response lost after the actual INSERT commits without creating a second run or new clock', async () => {
  const execute = client.execute.bind(client);
  let lost = false;
  vi.spyOn(client, 'execute').mockImplementation(async (statement) => {
    const result = await execute(statement);
    if (
      !lost &&
      statementSql(statement).startsWith('INSERT INTO auto_sell_runs(')
    ) {
      lost = true;
      throw Error('Commit response lost');
    }
    return result;
  });
  const first = await body(await create());
  expect(lost).toBe(true);
  expect((await body(await get())).run).toEqual(first.run);
  expect((await body(await create())).run).toEqual(first.run);
  expect(await count('auto_sell_runs')).toBe(1);
  await noPreparation();
});

it('converges two same-ID create requests to one immutable original run', async () => {
  const responses = await Promise.all([create(), create()]);
  const [a, b] = await Promise.all(responses.map((r) => body(r)));
  expect(a.run).toEqual(b.run);
  expect(await count('auto_sell_runs')).toBe(1);
  expect(await count('auto_sell_run_heads')).toBe(1);
  expect(await count('auto_sell_run_strategy_heads')).toBe(3);
  await noPreparation();
});

it('recovers the original ID after cancellation immediately after commit without assuming a failed save', async () => {
  const controller = new AbortController();
  const execute = client.execute.bind(client);
  let interrupted = false;
  vi.spyOn(client, 'execute').mockImplementation(async (statement) => {
    const result = await execute(statement);
    if (
      !interrupted &&
      statementSql(statement).startsWith('INSERT INTO auto_sell_runs(')
    ) {
      interrupted = true;
      controller.abort();
    }
    return result;
  });
  const initial = request({ action: 'create', ...fixture.createInput });
  await body(
    await POST(new Request(initial, { signal: controller.signal })),
    408,
  );
  expect(interrupted).toBe(true);
  const recovery = await body(await get());
  const run = await readAutoSellRun(recovery.run);
  expect(run.id).toBe(fixture.createInput.id);
  expect((await body(await create())).run).toEqual(run);
  expect(await count('auto_sell_runs')).toBe(1);
  await noPreparation();
});

it('rejects the same ID bound to another saved profile while preserving its original record', async () => {
  const original = await body(await create());
  const saved = await body(
    await profilePOST(
      request(
        {
          action: 'save',
          id: crypto.randomUUID(),
          profileId: fixture.profile.profileId,
          expectedVersion: fixture.profile.version,
          terms: {
            ...fixture.profile.terms,
            name: 'Different explicitly saved configuration',
          },
        },
        profileUrl,
      ),
    ),
  );
  const profile = saved.profile as typeof fixture.profile;
  await body(
    await create({
      ...fixture.createInput,
      profileSaveId: profile.id,
      profileSha256: profile.sha256,
    }),
    409,
  );
  expect((await body(await get())).run).toEqual(original.run);
  expect(await count('auto_sell_runs')).toBe(1);
  await noPreparation();
});

it.each(['project', 'selected-wallet', 'roster-race'] as const)(
  'refuses changed %s before publication without recording a run',
  async (kind) => {
    if (kind === 'project')
      await client.execute(
        "UPDATE imported_token_projects SET revision=2 WHERE owner_id='alice'",
      );
    if (kind === 'selected-wallet')
      await client.execute({
        sql: 'UPDATE workspace_wallets SET revision=2 WHERE owner_id=? AND address=?',
        args: ['alice', fixture.wallet],
      });
    if (kind === 'roster-race') {
      const execute = client.execute.bind(client);
      let changed = false;
      vi.spyOn(client, 'execute').mockImplementation(async (statement) => {
        if (
          !changed &&
          statementSql(statement).startsWith('INSERT INTO auto_sell_runs(')
        ) {
          changed = true;
          await execute(
            "UPDATE workspace_wallets SET revision=2 WHERE owner_id='alice' AND archived=1",
          );
        }
        return execute(statement);
      });
    }
    await body(await create(), 409);
    await body(await get(), 404);
    expect(await count('auto_sell_runs')).toBe(0);
    await noPreparation();
  },
);

it('keeps original source, clocks and zero exposure recoverable after Stop and project/wallet archive', async () => {
  const original = await readAutoSellRun((await body(await create())).run);
  await body(
    await POST(
      request({
        action: 'stop',
        id: crypto.randomUUID(),
        runId: original.id,
        runSha256: original.sha256,
        consent: 'stop-auto-sell-run-v1',
      }),
    ),
  );
  await client.execute(
    "UPDATE imported_token_projects SET archived=1,revision=2 WHERE owner_id='alice'",
  );
  await client.execute(
    "UPDATE workspace_wallets SET archived=1,revision=2 WHERE owner_id='alice'",
  );
  const recovery = await body(await get());
  expect(recovery).toMatchObject({
    run: original,
    stopped: true,
    accounting: { sequence: 0, accountedRaw: '0' },
  });
  expect((await body(await create())).run).toEqual(original);
  await body(
    await create({ ...fixture.createInput, id: crypto.randomUUID() }),
    409,
  );
  await noPreparation();
});

it('enforces the 100-run cap atomically for competing final slots and still permits exact replay', async () => {
  const original = await body(await create());
  for (let n = 1; n < 99; n++)
    await body(
      await create({ ...fixture.createInput, id: crypto.randomUUID() }),
    );
  const responses = await Promise.all([
    create({ ...fixture.createInput, id: crypto.randomUUID() }),
    create({ ...fixture.createInput, id: crypto.randomUUID() }),
  ]);
  expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([
    200, 409,
  ]);
  expect(await count('auto_sell_runs')).toBe(100);
  expect((await body(await create())).run).toEqual(original.run);
  await noPreparation();
});

it('does not reset held allowance on create replay, and forbids a fresh overlapping same-token run even after Stop', async () => {
  const run = await readAutoSellRun((await body(await create())).run);
  await body(
    await POST(
      request({ action: 'reserve', attempt: autoSellRunAttemptFixture(run) }),
    ),
  );
  await body(
    await POST(
      request({
        action: 'stop',
        id: crypto.randomUUID(),
        runId: run.id,
        runSha256: run.sha256,
        consent: 'stop-auto-sell-run-v1',
      }),
    ),
  );
  const before = await body(await get());
  expect(before.accounting).toMatchObject({ sequence: 1, accountedRaw: '10' });
  expect((await body(await create())).run).toEqual(run);
  const after = await body(await get());
  expect(after).toEqual(before);
  await body(
    await create({ ...fixture.createInput, id: crypto.randomUUID() }),
    409,
  );
  expect(await count('auto_sell_runs')).toBe(1);
  expect(await count('auto_sell_run_attempts')).toBe(1);
  expect(await count('auto_sell_run_preparation_starts')).toBe(0);
  expect(await count('imported_swap_preparations')).toBe(0);
  expect(await count('imported_swap_signing_intents')).toBe(0);
});

it('isolates original-ID enrollment and recovery by owner, including the same run UUID', async () => {
  const alice = await readAutoSellRun((await body(await create())).run);
  auth.owner = 'bob';
  await body(await get(alice.id), 404);
  await body(await create(), 404);
  const bob = await setupAutoSellRunStorageFixture(auth.db, { owner: 'bob' });
  const bobRun = await readAutoSellRun(
    (await body(await create({ ...bob.createInput, id: alice.id }))).run,
  );
  expect(bobRun.profile.terms.projectId).toBe(bob.projectId);
  expect(bobRun.sha256).not.toBe(alice.sha256);
  auth.owner = 'alice';
  expect((await body(await get(alice.id))).run).toEqual(alice);
  expect(await count('auto_sell_runs')).toBe(2);
  await noPreparation();
});
