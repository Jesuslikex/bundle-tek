import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { createHash } from 'node:crypto';
import { createTursoDatabase } from '@/db/turso';
import {
  initializeAutoSellRunStorageFixture,
  setupAutoSellRunStorageFixture,
  autoSellRunAttemptFixture,
} from '@/test/auto-sell-run-storage-fixture';
import {
  createOwnedAutoSellRun,
  reserveOwnedAutoSellAttempt,
} from '@/lib/auto-sell-run-storage';
import { autoSellRunEnrollmentOwnerScope } from '@/lib/auto-sell-run-record-stop';
import { readAutoSellRunProgress } from '@/lib/auto-sell-run-progress';
const state = vi.hoisted(() => ({
  owner: 'alice' as string | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => (state.owner ? { userId: state.owner } : null),
}));
vi.mock('@/db', () => ({ getD1: () => state.db }));
import { GET } from './route';
const base = 'https://bundle.test/api/imported-projects/auto-sell-run-progress';
let client: Client,
  f: Awaited<ReturnType<typeof setupAutoSellRunStorageFixture>>,
  fetcher: ReturnType<typeof vi.fn>;
const signal = () => new AbortController().signal;
const query = () =>
  new URLSearchParams({
    projectId: f.projectId,
    runId: f.createInput.id,
  }).toString();
const get = (q = query()) => GET(new Request(base + '?' + q));
async function body(response: Response, status = 200) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const value = (await response.json()) as Record<string, unknown>;
  expect(value).toMatchObject({
    signingAllowed: false,
    executionAllowed: false,
    automaticResumeAllowed: false,
    allowanceReleased: false,
  });
  return value;
}
beforeEach(async () => {
  state.owner = 'alice';
  client = createClient({ url: 'file::memory:' });
  state.db = createTursoDatabase(client);
  await initializeAutoSellRunStorageFixture(state.db);
  f = await setupAutoSellRunStorageFixture(state.db, { owner: 'alice' });
  fetcher = vi.fn(async () => {
    throw Error('Saved progress forbids provider calls');
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  expect(fetcher).not.toHaveBeenCalled();
  client.close();
  vi.unstubAllGlobals();
});
it('returns a complete owner-scoped independently replayable read-only envelope without raw owner IDs', async () => {
  const run = await createOwnedAutoSellRun(
    state.db,
    'alice',
    f.createInput,
    signal(),
  );
  await reserveOwnedAutoSellAttempt(
    state.db,
    'alice',
    autoSellRunAttemptFixture(run),
    signal(),
  );
  const before = (await client.execute('SELECT total_changes() AS n')).rows[0]
    .n;
  const value = await body(await get());
  expect(value.ownerScope).toBe(await autoSellRunEnrollmentOwnerScope('alice'));
  const parsed = await readAutoSellRunProgress(value.evidence);
  expect(parsed.accounting.accountedRaw).toBe('10');
  expect(parsed.unresolvedAttempts).toHaveLength(1);
  expect(Object.keys(value).sort()).toEqual([
    'allowanceReleased',
    'automaticResumeAllowed',
    'evidence',
    'executionAllowed',
    'ownerScope',
    'signingAllowed',
  ]);
  expect((await client.execute('SELECT total_changes() AS n')).rows[0].n).toBe(
    before,
  );
  expect(JSON.stringify(value)).not.toContain('alice');
});
it('requires authentication and refuses foreign owners or mismatched project association', async () => {
  await createOwnedAutoSellRun(state.db, 'alice', f.createInput, signal());
  state.owner = 'bob';
  await body(await get(), 404);
  state.owner = 'alice';
  await body(
    await get(
      new URLSearchParams({
        projectId: crypto.randomUUID(),
        runId: f.createInput.id,
      }).toString(),
    ),
    404,
  );
  state.owner = null;
  await body(await get(), 401);
});
it.each([
  '',
  'projectId=x',
  'runId=x',
  'projectId=x&runId=y',
  'projectId=x&projectId=y&runId=z',
  'projectId=x&runId=y&runId=z',
  'projectId=x&runId=y&resume=1',
  'projectId=x&runId=y&beforeSequence=1',
])('rejects malformed or partial read %s', async (q) => {
  await body(await get(q), 400);
});
it('reports missing history, cancellation and corruption without returning partial evidence', async () => {
  await body(await get(), 404);
  await createOwnedAutoSellRun(state.db, 'alice', f.createInput, signal());
  const controller = new AbortController();
  controller.abort();
  await body(
    await GET(new Request(base + '?' + query(), { signal: controller.signal })),
    408,
  );
  await client.execute('DROP TRIGGER auto_sell_run_heads_update');
  await client.execute("UPDATE auto_sell_run_heads SET head_sha256='bad'");
  const failed = await body(await get(), 503);
  expect(failed).not.toHaveProperty('evidence');
  expect(JSON.stringify(failed)).not.toContain('SQLITE');
});
it('refuses an over-capacity complete valid journal without truncating its attempts', async () => {
  const run = await createOwnedAutoSellRun(
    state.db,
    'alice',
    f.createInput,
    signal(),
  );
  let head = run.sha256;
  const at = (await state.db
    .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now")
    .first<{ now: string }>())!.now;
  for (let n = 0; n < 70; n++) {
    // Publish valid fixtures through the real immutable append/claim/accounting
    // triggers, avoiding repeated whole-history reads during fixture setup.
    const entry = {
      format: 'auto-sell-run-attempt-v1',
      id: crypto.randomUUID(),
      runId: run.id,
      runSha256: run.sha256,
      sequence: n + 1,
      previousSha256: head,
      strategyId: 'counter',
      wallet: f.wallet,
      walletRevision: 1,
      inputRaw: '1',
      occurrence: {
        kind: 'counter',
        sourceIds: Array.from(
          { length: 128 },
          (_, i) => `event-${n}-${i}-` + 'x'.repeat(105),
        ),
        bufferedRaw: '1',
      },
      preparationId: crypto.randomUUID(),
      reservedAt: at,
      signingAllowed: false,
      executionAllowed: false,
      automaticResumeAllowed: false,
    };
    const sha256 = createHash('sha256')
      .update(JSON.stringify(['auto-sell-run-attempt-v1', entry]))
      .digest('hex');
    await state.db
      .prepare(
        'INSERT INTO auto_sell_run_attempts(owner_id,id,run_id,sequence,previous_sha256,sha256,strategy_id,wallet,wallet_revision,input_raw,amount_high,amount_middle,amount_low,preparation_id,document,reserved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        'alice',
        entry.id,
        run.id,
        entry.sequence,
        head,
        sha256,
        'counter',
        f.wallet,
        1,
        '1',
        0,
        0,
        1,
        entry.preparationId,
        JSON.stringify({ ...entry, sha256 }),
        at,
      )
      .run();
    head = sha256;
  }
  const before = (await client.execute('SELECT total_changes() AS n')).rows[0]
    .n;
  const result = await body(await get(), 409);
  expect(result).not.toHaveProperty('evidence');
  expect(result.error).toMatch(/complete.*capacity/i);
  expect((await client.execute('SELECT total_changes() AS n')).rows[0].n).toBe(
    before,
  );
  expect(
    (await client.execute('SELECT count(*) AS n FROM auto_sell_run_attempts'))
      .rows[0].n,
  ).toBe(70);
}, 30000);
