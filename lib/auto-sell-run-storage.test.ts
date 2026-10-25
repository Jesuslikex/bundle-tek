import { afterEach, beforeEach, expect, it } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { createHash } from 'node:crypto';
import { createTursoDatabase } from '../db/turso';
import {
  initializeAutoSellRunStorageFixture,
  setupAutoSellRunStorageFixture,
  autoSellRunAttemptFixture,
} from '../test/auto-sell-run-storage-fixture';
import {
  autoSellRunAmountLimbs,
  type AutoSellRunAttempt,
} from './auto-sell-run';
import {
  createOwnedAutoSellRun,
  readOwnedAutoSellRun,
  readOwnedAutoSellAttempts,
  reserveOwnedAutoSellAttempt,
  startOwnedAutoSellPreparation,
  stopOwnedAutoSellRun,
  listOwnedAutoSellRuns,
  requireAutoSellRunPreparationGuard,
} from './auto-sell-run-storage';
let client: Client, db: D1Database;
let f: Awaited<ReturnType<typeof setupAutoSellRunStorageFixture>>;
const signal = () => new AbortController().signal;
beforeEach(async () => {
  client = createClient({ url: 'file::memory:' });
  db = createTursoDatabase(client);
  await initializeAutoSellRunStorageFixture(db);
  f = await setupAutoSellRunStorageFixture(db);
});
afterEach(() => client.close());
const create = () =>
  createOwnedAutoSellRun(db, f.owner, f.createInput, signal());
async function count(table: string) {
  return (await db
    .prepare(`SELECT count(*) AS n FROM ${table}`)
    .first<{ n: number }>())!.n;
}
async function stop(run: Awaited<ReturnType<typeof create>>) {
  return stopOwnedAutoSellRun(
    db,
    f.owner,
    { id: crypto.randomUUID(), runId: run.id, runSha256: run.sha256 },
    signal(),
  );
}
it('retains original server clocks, complete archived-inclusive ownership and false authority', async () => {
  const run = await create();
  expect(run).toMatchObject({
    profile: f.profile,
    signingAllowed: false,
    executionAllowed: false,
    automaticResumeAllowed: false,
  });
  expect(run.ownWallets).toHaveLength(2);
  expect(run.ownWallets.some((w) => w.archived)).toBe(true);
  expect(await create()).toEqual(run);
  expect(await count('auto_sell_runs')).toBe(1);
  expect(
    (await readOwnedAutoSellAttempts(db, f.owner, run.id, signal())).accounting,
  ).toMatchObject({ sequence: 0, headSha256: run.sha256, accountedRaw: '0' });
});
it('preserves original-ID replay and history after current project or wallet changes', async () => {
  const run = await create();
  await db
    .prepare(
      'UPDATE imported_token_projects SET archived=1,revision=2 WHERE owner_id=?',
    )
    .bind(f.owner)
    .run();
  await db
    .prepare('UPDATE workspace_wallets SET revision=2 WHERE owner_id=?')
    .bind(f.owner)
    .run();
  expect(await create()).toEqual(run);
  expect(await readOwnedAutoSellRun(db, f.owner, run.id, signal())).toEqual(
    run,
  );
  await expect(
    createOwnedAutoSellRun(
      db,
      f.owner,
      { ...f.createInput, id: crypto.randomUUID() },
      signal(),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (await readOwnedAutoSellAttempts(db, f.owner, run.id, signal())).attempts,
  ).toEqual([]);
});
it('atomically charges exact reservation amounts above signed 64-bit and JS integer precision', async () => {
  const run = await create(),
    n = '18446744073709551615';
  const first = await reserveOwnedAutoSellAttempt(
    db,
    f.owner,
    autoSellRunAttemptFixture(run, {
      inputRaw: n,
      occurrence: { kind: 'counter', sourceIds: ['one'], bufferedRaw: n },
    }),
    signal(),
  );
  const second = await reserveOwnedAutoSellAttempt(
    db,
    f.owner,
    autoSellRunAttemptFixture(run, {
      expectedSequence: 1,
      expectedHeadSha256: first.sha256,
      inputRaw: n,
      occurrence: { kind: 'counter', sourceIds: ['two'], bufferedRaw: n },
    }),
    signal(),
  );
  const history = await readOwnedAutoSellAttempts(
    db,
    f.owner,
    run.id,
    signal(),
  );
  expect(history.accounting.accountedRaw).toBe((2n * BigInt(n)).toString());
  expect(history.accounting.headSha256).toBe(second.sha256);
  expect(
    history.accounting.strategies.find((s) => s.id === 'counter')?.claimedKeys,
  ).toEqual(['counter:one', 'counter:two']);
});
it('does not double-charge duplicate or concurrent identical original requests', async () => {
  const run = await create(),
    request = autoSellRunAttemptFixture(run);
  const [a, b] = await Promise.all([
    reserveOwnedAutoSellAttempt(db, f.owner, request, signal()),
    reserveOwnedAutoSellAttempt(db, f.owner, request, signal()),
  ]);
  expect(a).toEqual(b);
  expect(await count('auto_sell_run_attempts')).toBe(1);
  expect(
    (await readOwnedAutoSellAttempts(db, f.owner, run.id, signal())).accounting
      .accountedRaw,
  ).toBe('10');
  await expect(
    reserveOwnedAutoSellAttempt(
      db,
      f.owner,
      { ...request, inputRaw: '11' },
      signal(),
    ),
  ).rejects.toMatchObject({ status: 409 });
});
it('serializes competing head reservations with one winning allowance', async () => {
  const run = await create();
  const outcomes = await Promise.allSettled([
    reserveOwnedAutoSellAttempt(
      db,
      f.owner,
      autoSellRunAttemptFixture(run),
      signal(),
    ),
    reserveOwnedAutoSellAttempt(
      db,
      f.owner,
      autoSellRunAttemptFixture(run, {
        occurrence: {
          kind: 'counter',
          sourceIds: ['different'],
          bufferedRaw: '10',
        },
      }),
      signal(),
    ),
  ]);
  expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
  expect(
    (await readOwnedAutoSellAttempts(db, f.owner, run.id, signal())).accounting
      .accountedRaw,
  ).toBe('10');
});
it('serializes reservations across two pre-created same-wallet/mint roots', async () => {
  const firstRun = await create();
  const secondRun = await createOwnedAutoSellRun(
    db,
    f.owner,
    { ...f.createInput, id: crypto.randomUUID() },
    signal(),
  );
  const results = await Promise.allSettled([
    reserveOwnedAutoSellAttempt(
      db,
      f.owner,
      autoSellRunAttemptFixture(firstRun),
      signal(),
    ),
    reserveOwnedAutoSellAttempt(
      db,
      f.owner,
      autoSellRunAttemptFixture(secondRun),
      signal(),
    ),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  const histories = await Promise.all([
    readOwnedAutoSellAttempts(db, f.owner, firstRun.id, signal()),
    readOwnedAutoSellAttempts(db, f.owner, secondRun.id, signal()),
  ]);
  expect(
    histories.map((h) => h.accounting.sequence).sort((a, b) => a - b),
  ).toEqual([0, 1]);
  expect(histories.map((h) => h.accounting.accountedRaw).sort()).toEqual([
    '0',
    '10',
  ]);
  const untouched = histories.find((h) => h.accounting.sequence === 0)!;
  expect(untouched.accounting.headSha256).toBe(untouched.run.sha256);
});
it('keeps occurrence claims, prevents repeated targets and holds DCA timing without catch-up', async () => {
  const run = await create();
  const first = await reserveOwnedAutoSellAttempt(
    db,
    f.owner,
    autoSellRunAttemptFixture(run, {
      strategyId: 'limit',
      inputRaw: '7',
      occurrence: { kind: 'limit', ids: ['first', 'second'] },
    }),
    signal(),
  );
  await expect(
    reserveOwnedAutoSellAttempt(
      db,
      f.owner,
      autoSellRunAttemptFixture(run, {
        expectedSequence: 1,
        expectedHeadSha256: first.sha256,
        strategyId: 'limit',
        inputRaw: '3',
        occurrence: { kind: 'limit', ids: ['first'] },
      }),
      signal(),
    ),
  ).rejects.toMatchObject({ status: 409 });
  const dca = await reserveOwnedAutoSellAttempt(
    db,
    f.owner,
    autoSellRunAttemptFixture(run, {
      expectedSequence: 1,
      expectedHeadSha256: first.sha256,
      strategyId: 'dca',
      occurrence: { kind: 'dca', index: 0, drawRaw: '10' },
    }),
    signal(),
  );
  await expect(
    reserveOwnedAutoSellAttempt(
      db,
      f.owner,
      autoSellRunAttemptFixture(run, {
        expectedSequence: 2,
        expectedHeadSha256: dca.sha256,
        strategyId: 'dca',
        occurrence: { kind: 'dca', index: 1, drawRaw: '10' },
      }),
      signal(),
    ),
  ).rejects.toMatchObject({ status: 409 });
  const state = (
    await readOwnedAutoSellAttempts(db, f.owner, run.id, signal())
  ).accounting.strategies.find((s) => s.id === 'dca')!;
  expect(state.nextDcaIndex).toBe(1);
  expect(Date.parse(state.nextDcaAt!) - Date.parse(dca.reservedAt)).toBe(
    10_000,
  );
});
it('stops original runs without releasing allowance and prevents a new same-wallet/mint reset', async () => {
  const run = await create(),
    request = autoSellRunAttemptFixture(run),
    a = await reserveOwnedAutoSellAttempt(db, f.owner, request, signal());
  const stopped = await stop(run);
  expect(stopped).toMatchObject({
    runId: run.id,
    runSha256: run.sha256,
    signingAllowed: false,
    executionAllowed: false,
    automaticResumeAllowed: false,
  });
  expect(
    await reserveOwnedAutoSellAttempt(db, f.owner, request, signal()),
  ).toEqual(a);
  await expect(
    reserveOwnedAutoSellAttempt(
      db,
      f.owner,
      autoSellRunAttemptFixture(run, {
        expectedSequence: 1,
        expectedHeadSha256: a.sha256,
        occurrence: { kind: 'counter', sourceIds: ['next'], bufferedRaw: '10' },
      }),
      signal(),
    ),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    createOwnedAutoSellRun(
      db,
      f.owner,
      { ...f.createInput, id: crypto.randomUUID() },
      signal(),
    ),
  ).rejects.toMatchObject({ status: 409 });
  const history = await readOwnedAutoSellAttempts(
    db,
    f.owner,
    run.id,
    signal(),
  );
  expect(history.stopped).toBe(true);
  expect(history.accounting.accountedRaw).toBe('10');
  expect(history.stop).toEqual(stopped);
});
it('retains exact stop ID recovery after project archival and rejects a different stop ID', async () => {
  const run = await create(),
    input = { id: crypto.randomUUID(), runId: run.id, runSha256: run.sha256 };
  const stopped = await stopOwnedAutoSellRun(db, f.owner, input, signal());
  await db
    .prepare('UPDATE imported_token_projects SET archived=1 WHERE owner_id=?')
    .bind(f.owner)
    .run();
  expect(await stopOwnedAutoSellRun(db, f.owner, input, signal())).toEqual(
    stopped,
  );
  await expect(
    stopOwnedAutoSellRun(
      db,
      f.owner,
      { ...input, id: crypto.randomUUID() },
      signal(),
    ),
  ).rejects.toMatchObject({ status: 409 });
});
it('keeps foreign run IDs invisible and requires exact original configuration binding', async () => {
  const run = await create();
  expect(
    await readOwnedAutoSellRun(db, 'other-owner', run.id, signal()),
  ).toBeNull();
  await expect(
    readOwnedAutoSellAttempts(db, 'other-owner', run.id, signal()),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    createOwnedAutoSellRun(
      db,
      f.owner,
      { ...f.createInput, profileSha256: 'b'.repeat(64) },
      signal(),
    ),
  ).rejects.toMatchObject({ status: 409 });
});
it('reserves a fixed preparation ID before provider work and irreversibly records one start', async () => {
  const run = await create(),
    a = await reserveOwnedAutoSellAttempt(
      db,
      f.owner,
      autoSellRunAttemptFixture(run),
      signal(),
    );
  const guard = await startOwnedAutoSellPreparation(
    db,
    f.owner,
    run.id,
    a.id,
    signal(),
  );
  expect(guard).toMatchObject({
    preparationId: a.preparationId,
    runId: run.id,
    attemptId: a.id,
    inputRaw: '10',
    maxSlippageBps: 50,
  });
  expect(() => requireAutoSellRunPreparationGuard(guard)).not.toThrow();
  expect(() => requireAutoSellRunPreparationGuard({ ...guard })).toThrow();
  await expect(
    startOwnedAutoSellPreparation(db, f.owner, run.id, a.id, signal()),
  ).rejects.toMatchObject({ status: 409 });
  const h = await readOwnedAutoSellAttempts(db, f.owner, run.id, signal());
  expect(h.preparationStarts).toHaveLength(1);
  expect(h.accounting.accountedRaw).toBe('10');
});
it('refuses preparation start after source/roster changes while retaining the charged attempt', async () => {
  const run = await create(),
    a = await reserveOwnedAutoSellAttempt(
      db,
      f.owner,
      autoSellRunAttemptFixture(run),
      signal(),
    );
  await db
    .prepare(
      'UPDATE workspace_wallets SET revision=revision+1 WHERE owner_id=? AND archived=1',
    )
    .bind(f.owner)
    .run();
  await expect(
    startOwnedAutoSellPreparation(db, f.owner, run.id, a.id, signal()),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (await readOwnedAutoSellAttempts(db, f.owner, run.id, signal())).accounting
      .accountedRaw,
  ).toBe('10');
  expect(await count('auto_sell_run_preparation_starts')).toBe(0);
});
it('preserves append-only records and CAS heads with recursive triggers disabled', async () => {
  const run = await create(),
    a = await reserveOwnedAutoSellAttempt(
      db,
      f.owner,
      autoSellRunAttemptFixture(run),
      signal(),
    );
  await client.execute('PRAGMA recursive_triggers=OFF');
  for (const table of [
    'auto_sell_runs',
    'auto_sell_run_attempts',
    'auto_sell_run_occurrences',
    'auto_sell_run_heads',
    'auto_sell_run_strategy_heads',
  ]) {
    await expect(
      client.execute(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`),
    ).rejects.toThrow();
    await expect(client.execute(`DELETE FROM ${table}`)).rejects.toThrow();
    await expect(
      client.execute(`INSERT OR REPLACE INTO ${table}(rowid) VALUES(1)`),
    ).rejects.toThrow();
  }
  await expect(
    client.execute('UPDATE auto_sell_run_heads SET accounted_low=0'),
  ).rejects.toThrow();
  await expect(
    client.execute('UPDATE auto_sell_run_strategy_heads SET accounted_low=0'),
  ).rejects.toThrow();
  expect(
    (await readOwnedAutoSellAttempts(db, f.owner, run.id, signal())).accounting
      .headSha256,
  ).toBe(a.sha256);
});
it('indexes retained runs with stable bounded owner/project keyset pages', async () => {
  for (let i = 0; i < 21; i++)
    await createOwnedAutoSellRun(
      db,
      f.owner,
      { ...f.createInput, id: crypto.randomUUID() },
      signal(),
    );
  const first = await listOwnedAutoSellRuns(
    db,
    f.owner,
    f.projectId,
    null,
    signal(),
  );
  expect(first.runs).toHaveLength(20);
  expect(first.nextCursor).not.toBeNull();
  const next = await listOwnedAutoSellRuns(
    db,
    f.owner,
    f.projectId,
    first.nextCursor,
    signal(),
  );
  expect(next.runs).toHaveLength(1);
  expect(next.nextCursor).toBeNull();
  expect(new Set([...first.runs, ...next.runs].map((r) => r.id)).size).toBe(21);
});
it('retains and replays the full 1000-attempt bounded journal with no accounting reset', async () => {
  const run = await create(),
    at = (await db
      .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now")
      .first<{ now: string }>())!.now;
  let previous = run.sha256;
  for (let n = 1; n <= 1000; n++) {
    const body = {
      format: 'auto-sell-run-attempt-v1' as const,
      id: crypto.randomUUID(),
      runId: run.id,
      runSha256: run.sha256,
      sequence: n,
      previousSha256: previous,
      strategyId: 'counter',
      wallet: f.wallet,
      walletRevision: 1,
      inputRaw: '1',
      occurrence: {
        kind: 'counter' as const,
        sourceIds: ['event-' + n],
        bufferedRaw: '1',
      },
      preparationId: crypto.randomUUID(),
      reservedAt: at,
      signingAllowed: false as const,
      executionAllowed: false as const,
      automaticResumeAllowed: false as const,
    };
    const sha256 = createHash('sha256')
      .update(JSON.stringify(['auto-sell-run-attempt-v1', body]))
      .digest('hex');
    const a: AutoSellRunAttempt = { ...body, sha256 },
      limbs = autoSellRunAmountLimbs(a.inputRaw);
    await db
      .prepare(
        'INSERT INTO auto_sell_run_attempts(owner_id,id,run_id,sequence,previous_sha256,sha256,strategy_id,wallet,wallet_revision,input_raw,amount_high,amount_middle,amount_low,preparation_id,document,reserved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        f.owner,
        a.id,
        a.runId,
        a.sequence,
        a.previousSha256,
        a.sha256,
        a.strategyId,
        a.wallet,
        a.walletRevision,
        a.inputRaw,
        limbs.high,
        limbs.middle,
        limbs.low,
        a.preparationId,
        JSON.stringify(a),
        at,
      )
      .run();
    previous = sha256;
  }
  const h = await readOwnedAutoSellAttempts(db, f.owner, run.id, signal());
  expect(h.attempts).toHaveLength(1000);
  expect(h.accounting.accountedRaw).toBe('1000');
  const last = h.attempts.at(-1)!;
  expect(
    await reserveOwnedAutoSellAttempt(
      db,
      f.owner,
      autoSellRunAttemptFixture(run, {
        id: last.id,
        expectedSequence: 999,
        expectedHeadSha256: last.previousSha256,
        inputRaw: '1',
        occurrence: last.occurrence,
      }),
      signal(),
    ),
  ).toEqual(last);
  await expect(
    reserveOwnedAutoSellAttempt(
      db,
      f.owner,
      autoSellRunAttemptFixture(run, {
        expectedSequence: 1000,
        expectedHeadSha256: last.sha256,
        inputRaw: '1',
        occurrence: {
          kind: 'counter',
          sourceIds: ['over-cap'],
          bufferedRaw: '1',
        },
      }),
      signal(),
    ),
  ).rejects.toMatchObject({ status: 400 });
});
