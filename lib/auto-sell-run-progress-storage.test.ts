import { beforeEach, afterEach, it, expect, vi } from 'vitest';
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
  startOwnedAutoSellPreparation,
  stopOwnedAutoSellRun,
  readOwnedAutoSellAttempts,
} from './auto-sell-run-storage';
import { readOwnedAutoSellRunProgress } from './auto-sell-run-progress-storage';
import { readAutoSellRunProgress } from './auto-sell-run-progress';
let client: Client,
  db: D1Database,
  f: Awaited<ReturnType<typeof setupAutoSellRunStorageFixture>>;
const signal = () => new AbortController().signal;
beforeEach(async () => {
  client = createClient({ url: 'file::memory:' });
  db = createTursoDatabase(client);
  await initializeAutoSellRunStorageFixture(db);
  f = await setupAutoSellRunStorageFixture(db);
});

it('preserves a delayed Stop sampled before an admitted reservation and preparation start', async () => {
  const run = await createOwnedAutoSellRun(
    db,
    f.owner,
    f.createInput,
    signal(),
  );
  const prepare = db.prepare.bind(db);
  let clockOffset = -1,
    clockFloor = Date.parse(run.createdAt),
    sampledStop = '';
  vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql);
    if (!sql.includes('AS now')) return statement;
    return new Proxy(statement, {
      get(target, key) {
        if (key === 'first')
          return async () => {
            const actual = await target.first<{ now: string }>();
            if (!actual) throw Error('Fixture SQL clock missing');
            const now = new Date(
              Math.max(clockFloor, Date.parse(actual.now) + clockOffset),
            ).toISOString();
            if (clockOffset === -1) sampledStop = now;
            return { now };
          };
        const value: unknown = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
  let releaseStop!: () => void, reachedStop!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    reachedStop = resolve;
  });
  const execute = client.execute.bind(client);
  let gated = false;
  vi.spyOn(client, 'execute').mockImplementation(async (statement) => {
    const value: unknown = statement;
    const sql =
      typeof value === 'string'
        ? value
        : value && typeof value === 'object'
          ? Reflect.get(value, 'sql')
          : null;
    if (
      !gated &&
      typeof sql === 'string' &&
      sql.startsWith('INSERT INTO auto_sell_run_stops')
    ) {
      gated = true;
      reachedStop();
      await gate;
    }
    return execute(statement);
  });
  const stopping = stopOwnedAutoSellRun(
    db,
    f.owner,
    { id: crypto.randomUUID(), runId: run.id, runSha256: run.sha256 },
    signal(),
  );
  await reached;
  clockOffset = 0;
  // Keep strict ordering even on a sub-millisecond fixture run. Every sampled
  // clock stays within the unchanged SQL freshness tolerance; no sleeps.
  clockFloor = Date.parse(sampledStop) + 1;
  const attempt = await reserveOwnedAutoSellAttempt(
    db,
    f.owner,
    autoSellRunAttemptFixture(run),
    signal(),
  );
  await startOwnedAutoSellPreparation(
    db,
    f.owner,
    run.id,
    attempt.id,
    signal(),
  );
  releaseStop();
  const stop = await stopping;
  const original = await readOwnedAutoSellAttempts(
    db,
    f.owner,
    run.id,
    signal(),
  );
  expect(original).toMatchObject({
    stopped: true,
    accounting: { sequence: 1, accountedRaw: '10' },
  });
  expect(Date.parse(stop.createdAt)).toBeGreaterThanOrEqual(
    Date.parse(run.createdAt),
  );
  expect(Date.parse(stop.createdAt)).toBeLessThan(
    Date.parse(attempt.reservedAt),
  );
  expect(Date.parse(stop.createdAt)).toBeLessThan(
    Date.parse(original.preparationStarts[0].createdAt),
  );
  const changes = (await client.execute('SELECT total_changes() AS n')).rows[0]
    .n;
  const evidence = await read();
  const progress = await readAutoSellRunProgress(evidence);
  expect(evidence.run).toEqual(run);
  expect(evidence.attempts).toEqual([attempt]);
  expect(evidence.stop).toEqual(stop);
  expect(progress).toMatchObject({
    lifecycle: 'stopped',
    accounting: { sequence: 1, accountedRaw: '10' },
    allowanceReleased: false,
    signingAllowed: false,
    executionAllowed: false,
    automaticResumeAllowed: false,
  });
  expect(progress.unresolvedAttempts).toMatchObject([
    {
      id: attempt.id,
      preparationId: attempt.preparationId,
      preparationStarted: true,
      inputRaw: '10',
    },
  ]);
  expect((await client.execute('SELECT total_changes() AS n')).rows[0].n).toBe(
    changes,
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  client.close();
});
const read = () =>
  readOwnedAutoSellRunProgress(
    db,
    f.owner,
    f.projectId,
    f.createInput.id,
    signal(),
  );
it('builds complete original evidence and derives gross charged exposure, never sold or released allowance', async () => {
  const run = await createOwnedAutoSellRun(
    db,
    f.owner,
    f.createInput,
    signal(),
  );
  const attempt = await reserveOwnedAutoSellAttempt(
    db,
    f.owner,
    autoSellRunAttemptFixture(run),
    signal(),
  );
  await startOwnedAutoSellPreparation(
    db,
    f.owner,
    run.id,
    attempt.id,
    signal(),
  );
  const batch = db.batch.bind(db);
  let snapshots = 0,
    clockAfter = false;
  vi.spyOn(db, 'batch').mockImplementation(async (statements) => {
    const result = await batch(statements);
    snapshots++;
    return result;
  });
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    if (sql.includes('AS now')) clockAfter = snapshots === 1;
    return prepare(sql);
  });
  const count = (await client.execute('SELECT total_changes() AS n')).rows[0].n;
  const evidence = await read();
  expect(clockAfter).toBe(true);
  expect(snapshots).toBe(2);
  expect(evidence).toMatchObject({
    run,
    attempts: [attempt],
    head: { sequence: 1, headSha256: attempt.sha256 },
    preparationStarts: [{ attemptId: attempt.id }],
    stop: null,
    signingAllowed: false,
    executionAllowed: false,
    automaticResumeAllowed: false,
    allowanceReleased: false,
  });
  expect((await client.execute('SELECT total_changes() AS n')).rows[0].n).toBe(
    count,
  );
  const progress = await readAutoSellRunProgress(evidence);
  expect(progress.accounting.accountedRaw).toBe('10');
  expect(progress.unresolvedAttempts).toHaveLength(1);
  expect(progress.unavailable.finalizedSales).toBe(true);
});

it.each(['stop', 'start', 'append'] as const)(
  'refuses a concurrent %s across the SQL-clock bracket without retrying',
  async (kind) => {
    const run = await createOwnedAutoSellRun(
      db,
      f.owner,
      f.createInput,
      signal(),
    );
    const attempt = await reserveOwnedAutoSellAttempt(
      db,
      f.owner,
      autoSellRunAttemptFixture(run),
      signal(),
    );
    const batch = db.batch.bind(db);
    let snapshots = 0,
      insideMutation = false;
    vi.spyOn(db, 'batch').mockImplementation(async (statements) => {
      if (!insideMutation) snapshots++;
      return batch(statements);
    });
    const execute = client.execute.bind(client);
    let mutated = false;
    vi.spyOn(client, 'execute').mockImplementation(async (statement) => {
      const result = await execute(statement);
      const value: unknown = statement;
      const sql =
        typeof value === 'string'
          ? value
          : value && typeof value === 'object'
            ? Reflect.get(value, 'sql')
            : null;
      if (!mutated && typeof sql === 'string' && sql.includes('AS now')) {
        mutated = true;
        insideMutation = true;
        try {
          if (kind === 'stop')
            await stopOwnedAutoSellRun(
              db,
              f.owner,
              { id: crypto.randomUUID(), runId: run.id, runSha256: run.sha256 },
              signal(),
            );
          if (kind === 'start')
            await startOwnedAutoSellPreparation(
              db,
              f.owner,
              run.id,
              attempt.id,
              signal(),
            );
          if (kind === 'append')
            await reserveOwnedAutoSellAttempt(
              db,
              f.owner,
              autoSellRunAttemptFixture(run, {
                expectedSequence: 1,
                expectedHeadSha256: attempt.sha256,
                occurrence: {
                  kind: 'counter',
                  sourceIds: ['new-observation'],
                  bufferedRaw: '10',
                },
              }),
              signal(),
            );
        } finally {
          insideMutation = false;
        }
      }
      return result;
    });
    await expect(read()).rejects.toMatchObject({
      status: 503,
      message: expect.stringMatching(/changed during inspection/),
    });
    expect(mutated).toBe(true);
    expect(snapshots).toBe(2);
  },
);
it('retains historical original source after Stop, archive and wallet revision changes', async () => {
  const run = await createOwnedAutoSellRun(
    db,
    f.owner,
    f.createInput,
    signal(),
  );
  await stopOwnedAutoSellRun(
    db,
    f.owner,
    { id: crypto.randomUUID(), runId: run.id, runSha256: run.sha256 },
    signal(),
  );
  await client.execute({
    sql: 'UPDATE imported_token_projects SET archived=1,revision=2 WHERE owner_id=?',
    args: [f.owner],
  });
  await client.execute({
    sql: 'UPDATE workspace_wallets SET archived=1,revision=2 WHERE owner_id=?',
    args: [f.owner],
  });
  const evidence = await read();
  expect(evidence.run).toEqual(run);
  expect(evidence.stop?.runId).toBe(run.id);
  expect((await readAutoSellRunProgress(evidence)).lifecycle).toBe('stopped');
});
it('refuses foreign owners and project association and malformed IDs', async () => {
  await createOwnedAutoSellRun(db, f.owner, f.createInput, signal());
  await expect(
    readOwnedAutoSellRunProgress(
      db,
      'other',
      f.projectId,
      f.createInput.id,
      signal(),
    ),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    readOwnedAutoSellRunProgress(
      db,
      f.owner,
      crypto.randomUUID(),
      f.createInput.id,
      signal(),
    ),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    readOwnedAutoSellRunProgress(db, f.owner, f.projectId, 'bad', signal()),
  ).rejects.toMatchObject({ status: 400 });
});
it.each(['head', 'start', 'stop'] as const)(
  'refuses corrupted %s evidence rather than returning partial progress',
  async (kind) => {
    const run = await createOwnedAutoSellRun(
      db,
      f.owner,
      f.createInput,
      signal(),
    );
    const attempt = await reserveOwnedAutoSellAttempt(
      db,
      f.owner,
      autoSellRunAttemptFixture(run),
      signal(),
    );
    if (kind === 'head') {
      await client.execute('DROP TRIGGER auto_sell_run_heads_update');
      await client.execute('UPDATE auto_sell_run_heads SET accounted_low=0');
    }
    if (kind === 'start') {
      await startOwnedAutoSellPreparation(
        db,
        f.owner,
        run.id,
        attempt.id,
        signal(),
      );
      await client.execute(
        'DROP TRIGGER auto_sell_run_preparation_starts_no_update',
      );
      await client.execute(
        "UPDATE auto_sell_run_preparation_starts SET head_sha256='bad'",
      );
    }
    if (kind === 'stop') {
      await stopOwnedAutoSellRun(
        db,
        f.owner,
        { id: crypto.randomUUID(), runId: run.id, runSha256: run.sha256 },
        signal(),
      );
      await client.execute('DROP TRIGGER auto_sell_run_stops_no_update');
      await client.execute("UPDATE auto_sell_run_stops SET run_sha256='bad'");
    }
    await expect(read()).rejects.toMatchObject({ status: 503 });
  },
);
it('cancels before reading and after the source snapshot without returning restored progress', async () => {
  await createOwnedAutoSellRun(db, f.owner, f.createInput, signal());
  const controller = new AbortController();
  controller.abort();
  await expect(
    readOwnedAutoSellRunProgress(
      db,
      f.owner,
      f.projectId,
      f.createInput.id,
      controller.signal,
    ),
  ).rejects.toMatchObject({ status: 408 });
  const later = new AbortController(),
    batch = db.batch.bind(db);
  vi.spyOn(db, 'batch').mockImplementation(async (statements) => {
    const result = await batch(statements);
    later.abort();
    return result;
  });
  await expect(
    readOwnedAutoSellRunProgress(
      db,
      f.owner,
      f.projectId,
      f.createInput.id,
      later.signal,
    ),
  ).rejects.toMatchObject({ status: 408 });
});
