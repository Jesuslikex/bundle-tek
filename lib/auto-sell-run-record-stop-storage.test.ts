import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createClient, type Client } from '@libsql/client';
import { createTursoDatabase } from '@/db/turso';
import {
  initializeAutoSellRunStorageFixture,
  setupAutoSellRunStorageFixture,
  autoSellRunAttemptFixture,
} from '@/test/auto-sell-run-storage-fixture';
import {
  createOwnedAutoSellRun,
  reserveOwnedAutoSellAttempt,
  stopOwnedAutoSellRun,
  readOwnedAutoSellAttempts,
} from './auto-sell-run-storage';
import {
  autoSellRunRecordStopReady,
  readOwnedAutoSellRunRecordStop,
  stopOwnedAutoSellRunRecord,
} from './auto-sell-run-record-stop-storage';
import {
  autoSellRunEnrollmentOwnerScope,
  readAutoSellRunRecordStop,
  readAutoSellRunRecordStopRequest,
} from './auto-sell-run-record-stop';
let client: Client,
  db: D1Database,
  f: Awaited<ReturnType<typeof setupAutoSellRunStorageFixture>>;
const signal = () => new AbortController().signal;
const input = () => ({
  projectId: f.projectId,
  runId: f.createInput.id,
  profileSaveId: f.profileSaveId,
  profileSha256: f.profileSha256,
  consent: 'stop-original-run-record-v1' as const,
});
beforeEach(async () => {
  client = createClient({ url: 'file::memory:' });
  db = createTursoDatabase(client);
  await initializeAutoSellRunStorageFixture(db);
  for (const sql of readFileSync(
    'drizzle/0155_auto_sell_run_record_stops.sql',
    'utf8',
  ).split('--> statement-breakpoint'))
    await db.prepare(sql).run();
  f = await setupAutoSellRunStorageFixture(db);
});
afterEach(() => {
  vi.restoreAllMocks();
  client.close();
});
it('permanently fences an absent original ID without creating a dummy run or consuming the run cap', async () => {
  const result = await stopOwnedAutoSellRunRecord(
    db,
    f.owner,
    input(),
    signal(),
  );
  expect(result).toMatchObject({
    run: null,
    stop: { status: 'creation-fenced', runSha256: null },
  });
  expect(await readAutoSellRunRecordStop(result.stop)).toEqual(result.stop);
  expect(
    await stopOwnedAutoSellRunRecord(db, f.owner, input(), signal()),
  ).toEqual(result);
  await expect(
    createOwnedAutoSellRun(db, f.owner, f.createInput, signal()),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (await client.execute('SELECT count(*) AS n FROM auto_sell_runs')).rows[0]
      .n,
  ).toBe(0);
  const different = { ...f.createInput, id: crypto.randomUUID() };
  expect(
    (await createOwnedAutoSellRun(db, f.owner, different, signal())).id,
  ).toBe(different.id);
});
it('records found runs without changing raw run, original clocks, charged attempts, Stop or accounting', async () => {
  const run = await createOwnedAutoSellRun(
    db,
    f.owner,
    f.createInput,
    signal(),
  );
  await reserveOwnedAutoSellAttempt(
    db,
    f.owner,
    autoSellRunAttemptFixture(run),
    signal(),
  );
  await stopOwnedAutoSellRun(
    db,
    f.owner,
    { id: crypto.randomUUID(), runId: run.id, runSha256: run.sha256 },
    signal(),
  );
  const before = await readOwnedAutoSellAttempts(db, f.owner, run.id, signal());
  const raw = await client.execute('SELECT * FROM auto_sell_runs');
  await client.execute({
    sql: 'UPDATE imported_token_projects SET archived=1,revision=2 WHERE owner_id=?',
    args: [f.owner],
  });
  await client.execute({
    sql: 'UPDATE workspace_wallets SET archived=1,revision=2 WHERE owner_id=?',
    args: [f.owner],
  });
  const result = await stopOwnedAutoSellRunRecord(
    db,
    f.owner,
    input(),
    signal(),
  );
  expect(result).toMatchObject({
    run,
    stop: { status: 'record-found', runSha256: run.sha256 },
  });
  expect(await client.execute('SELECT * FROM auto_sell_runs')).toEqual(raw);
  expect(
    await readOwnedAutoSellAttempts(db, f.owner, run.id, signal()),
  ).toEqual(before);
  expect(
    await createOwnedAutoSellRun(db, f.owner, f.createInput, signal()),
  ).toEqual(run);
});
it('serializes concurrent create and fence with a truthful terminal result in either order', async () => {
  for (const first of ['create', 'stop'] as const) {
    const id = crypto.randomUUID(),
      request = { ...input(), runId: id };
    let result;
    if (first === 'create') {
      await createOwnedAutoSellRun(
        db,
        f.owner,
        { ...f.createInput, id },
        signal(),
      );
      result = await stopOwnedAutoSellRunRecord(db, f.owner, request, signal());
      expect(result.stop?.status).toBe('record-found');
    } else {
      result = await stopOwnedAutoSellRunRecord(db, f.owner, request, signal());
      await expect(
        createOwnedAutoSellRun(db, f.owner, { ...f.createInput, id }, signal()),
      ).rejects.toMatchObject({ status: 409 });
      expect(result.stop?.status).toBe('creation-fenced');
    }
  }
  const id = crypto.randomUUID();
  const [creation, stopping] = await Promise.allSettled([
    createOwnedAutoSellRun(db, f.owner, { ...f.createInput, id }, signal()),
    stopOwnedAutoSellRunRecord(
      db,
      f.owner,
      { ...input(), runId: id },
      signal(),
    ),
  ]);
  expect(stopping.status).toBe('fulfilled');
  const snapshot = await readOwnedAutoSellRunRecordStop(
    db,
    f.owner,
    id,
    signal(),
  );
  expect(snapshot.stop?.status).toBe(
    creation.status === 'fulfilled' ? 'record-found' : 'creation-fenced',
  );
});
it('recovers a committed fence after a lost database reply and replays before changed current sources', async () => {
  const execute = client.execute.bind(client);
  let lost = false;
  vi.spyOn(client, 'execute').mockImplementation(async (statement) => {
    const result = await execute(statement);
    const s: unknown = statement;
    const sql =
      typeof s === 'string'
        ? s
        : s && typeof s === 'object'
          ? Reflect.get(s, 'sql')
          : null;
    if (
      !lost &&
      typeof sql === 'string' &&
      sql.startsWith('INSERT INTO auto_sell_run_record_stops(')
    ) {
      lost = true;
      throw Error('reply lost');
    }
    return result;
  });
  const first = await stopOwnedAutoSellRunRecord(
    db,
    f.owner,
    input(),
    signal(),
  );
  expect(lost).toBe(true);
  await client.execute({
    sql: 'DELETE FROM imported_token_projects WHERE owner_id=?',
    args: [f.owner],
  });
  expect(
    await stopOwnedAutoSellRunRecord(db, f.owner, input(), signal()),
  ).toEqual(first);
});
it('refuses conflicting original configuration and isolates the owner namespace', async () => {
  await stopOwnedAutoSellRunRecord(db, f.owner, input(), signal());
  await expect(
    stopOwnedAutoSellRunRecord(
      db,
      f.owner,
      { ...input(), profileSha256: 'a'.repeat(64) },
      signal(),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    await readOwnedAutoSellRunRecordStop(
      db,
      'other-owner',
      input().runId,
      signal(),
    ),
  ).toEqual({ stop: null, run: null });
  const second = await stopOwnedAutoSellRunRecord(
    db,
    'other-owner',
    input(),
    signal(),
  );
  expect(second.stop?.status).toBe('creation-fenced');
  expect(await autoSellRunEnrollmentOwnerScope(f.owner)).not.toBe(
    await autoSellRunEnrollmentOwnerScope('other-owner'),
  );
});
it('refuses existing-run mismatches and schema drift without publishing a false terminal receipt', async () => {
  await createOwnedAutoSellRun(db, f.owner, f.createInput, signal());
  await expect(
    stopOwnedAutoSellRunRecord(
      db,
      f.owner,
      { ...input(), projectId: crypto.randomUUID() },
      signal(),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (
      await client.execute(
        'SELECT count(*) AS n FROM auto_sell_run_record_stops',
      )
    ).rows[0].n,
  ).toBe(0);
  await autoSellRunRecordStopReady(db, signal());
  await client.execute('DROP TRIGGER auto_sell_runs_record_stop_fence');
  await expect(autoSellRunRecordStopReady(db, signal())).rejects.toMatchObject({
    status: 503,
  });
  await client.execute(
    'CREATE TRIGGER auto_sell_runs_record_stop_fence BEFORE INSERT ON auto_sell_runs BEGIN SELECT 1; END',
  );
  await expect(autoSellRunRecordStopReady(db, signal())).rejects.toMatchObject({
    status: 503,
  });
});
it('rejects malformed consent, extra authority, accessors and receipt tampering', async () => {
  for (const value of [
    { ...input(), consent: false },
    { ...input(), signingAllowed: true },
    { ...input(), runId: 'bad' },
  ])
    expect(() => readAutoSellRunRecordStopRequest(value)).toThrow();
  const getter = vi.fn(() => f.projectId);
  const value = { ...input() };
  Object.defineProperty(value, 'projectId', { get: getter, enumerable: true });
  expect(() => readAutoSellRunRecordStopRequest(value)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  const saved = await stopOwnedAutoSellRunRecord(
    db,
    f.owner,
    input(),
    signal(),
  );
  for (const mutation of [
    { requestSha256: 'f'.repeat(64) },
    { runSha256: 'a'.repeat(64) },
    { status: 'record-found' },
    { signingAllowed: true },
    { createdAt: 'not a date' },
  ])
    await expect(
      readAutoSellRunRecordStop({ ...saved.stop, ...mutation }),
    ).rejects.toThrow();
});
it('keeps committed stop recovery available after cancellation rather than assuming no write', async () => {
  const controller = new AbortController(),
    execute = client.execute.bind(client);
  let cancelled = false;
  vi.spyOn(client, 'execute').mockImplementation(async (statement) => {
    const r = await execute(statement);
    const s: unknown = statement;
    const sql =
      typeof s === 'string'
        ? s
        : s && typeof s === 'object'
          ? Reflect.get(s, 'sql')
          : null;
    if (
      !cancelled &&
      typeof sql === 'string' &&
      sql.startsWith('INSERT INTO auto_sell_run_record_stops(')
    ) {
      cancelled = true;
      controller.abort();
    }
    return r;
  });
  await expect(
    stopOwnedAutoSellRunRecord(db, f.owner, input(), controller.signal),
  ).rejects.toMatchObject({ status: 408 });
  expect(
    (await readOwnedAutoSellRunRecordStop(db, f.owner, input().runId, signal()))
      .stop?.status,
  ).toBe('creation-fenced');
});

it('enforces the SQL-time 1000-stop cap under a last-slot race and replays the original receipt at capacity', async () => {
  const original = await stopOwnedAutoSellRunRecord(
    db,
    f.owner,
    input(),
    signal(),
  );
  await client.batch(
    Array.from({ length: 998 }, () => ({
      sql: "INSERT INTO auto_sell_run_record_stops(owner_id,run_id,project_id,profile_save_id,profile_sha256,request_sha256,status,run_sha256,created_at) VALUES(?,?,?,?,?,?,'creation-fenced',NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
      args: [
        f.owner,
        crypto.randomUUID(),
        f.projectId,
        f.profileSaveId,
        f.profileSha256,
        'a'.repeat(64),
      ],
    })),
    'write',
  );
  const results = await Promise.allSettled([
    stopOwnedAutoSellRunRecord(
      db,
      f.owner,
      { ...input(), runId: crypto.randomUUID() },
      signal(),
    ),
    stopOwnedAutoSellRunRecord(
      db,
      f.owner,
      { ...input(), runId: crypto.randomUUID() },
      signal(),
    ),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(
    (
      await client.execute(
        'SELECT count(*) AS n FROM auto_sell_run_record_stops',
      )
    ).rows[0].n,
  ).toBe(1000);
  expect(
    await stopOwnedAutoSellRunRecord(db, f.owner, input(), signal()),
  ).toEqual(original);
  expect(
    (await client.execute('SELECT count(*) AS n FROM auto_sell_runs')).rows[0]
      .n,
  ).toBe(0);
});
