import { expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { createHash } from 'node:crypto';
import { Miniflare } from 'miniflare';
import { createTursoDatabase } from '../db/turso';
import {
  initializeAutoSellRunStorageFixture,
  setupAutoSellRunStorageFixture,
  autoSellRunAttemptFixture,
} from './auto-sell-run-storage-fixture';
import {
  createOwnedAutoSellRun,
  readOwnedAutoSellAttempts,
  reserveOwnedAutoSellAttempt,
  startOwnedAutoSellPreparation,
  stopOwnedAutoSellRun,
} from '../lib/auto-sell-run-storage';
import {
  autoSellRunAmountLimbs,
  type AutoSellRunAttempt,
} from '../lib/auto-sell-run';
import {
  saveSwapPreparation,
  type SwapPreparationSummary,
} from '../lib/imported-swap-preparation-history';

const signal = () => new AbortController().signal;
async function exercise(db: D1Database) {
  await exerciseRawRootAdmission(db);
  await exerciseOriginalStrategyDurationLimits(db);
  const f = await setupAutoSellRunStorageFixture(db),
    run = await createOwnedAutoSellRun(db, f.owner, f.createInput, signal());
  const reserve = autoSellRunAttemptFixture(run),
    first = await reserveOwnedAutoSellAttempt(db, f.owner, reserve, signal());
  const oldHeads = await db
    .prepare('SELECT * FROM auto_sell_run_heads WHERE owner_id=? AND run_id=?')
    .bind(f.owner, run.id)
    .first();
  const malformed = {
    ...first,
    id: crypto.randomUUID(),
    sequence: 2,
    previousSha256: first.sha256,
    preparationId: crypto.randomUUID(),
    sha256: 'b'.repeat(64),
  };
  const insert = async (a: AutoSellRunAttempt) => {
    const n = autoSellRunAmountLimbs(a.inputRaw);
    return db
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
        n.high,
        n.middle,
        n.low,
        a.preparationId,
        JSON.stringify(a),
        a.reservedAt,
      )
      .run();
  };
  // Duplicate occurrence causes the entire append, both accounting heads and
  // every claim to roll back, even though it is found after the head update.
  await expect(insert(malformed)).rejects.toThrow();
  for (const occurrence of [
    { kind: 'counter', sourceIds: [], bufferedRaw: '10' },
    { kind: 'counter', sourceIds: null, bufferedRaw: '10' },
    { kind: 'counter', sourceIds: ['same', 'same'], bufferedRaw: '10' },
    { kind: 'counter', sourceIds: [7], bufferedRaw: '10' },
    { kind: 'counter', sourceIds: ['x'.repeat(129)], bufferedRaw: '10' },
    {
      kind: 'counter',
      sourceIds: Array.from({ length: 129 }, (_, i) => 'key-' + i),
      bufferedRaw: '10',
    },
    { kind: 'limit', ids: [] },
    { kind: 'limit', ids: ['first', 'first'] },
    { kind: 'limit', ids: ['not-in-the-profile'] },
    { kind: 'limit', ids: [{}] },
  ]) {
    const hostile = {
      ...malformed,
      id: crypto.randomUUID(),
      preparationId: crypto.randomUUID(),
      strategyId: occurrence.kind === 'limit' ? 'limit' : 'counter',
      occurrence,
    } as unknown as AutoSellRunAttempt;
    await expect(insert(hostile)).rejects.toThrow(/occurrence invalid/);
  }
  expect(
    await db
      .prepare(
        'SELECT * FROM auto_sell_run_heads WHERE owner_id=? AND run_id=?',
      )
      .bind(f.owner, run.id)
      .first(),
  ).toEqual(oldHeads);
  expect(
    (await readOwnedAutoSellAttempts(db, f.owner, run.id, signal())).attempts,
  ).toHaveLength(1);
  const guard = await startOwnedAutoSellPreparation(
    db,
    f.owner,
    run.id,
    first.id,
    signal(),
  );
  await expect(
    startOwnedAutoSellPreparation(db, f.owner, run.id, first.id, signal()),
  ).rejects.toMatchObject({ status: 409 });
  const summary = {
    executionAllowed: false,
    instructionsVerified: false,
    side: 'Sell',
    wallet: f.wallet,
    inputMint: f.mint,
    outputMint: 'So11111111111111111111111111111111111111112',
    inAmountRaw: '10',
    slippageBps: 50,
    transaction: { sha256: 'c'.repeat(64) },
  };
  const publish = (preparationId: string, document: unknown = summary) =>
    db
      .prepare(
        'INSERT INTO imported_swap_preparations(id,owner_id,project_id,project_revision,wallet_address,wallet_revision,document,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .bind(
        preparationId,
        f.owner,
        f.projectId,
        1,
        f.wallet,
        1,
        JSON.stringify(document),
        new Date().toISOString(),
      )
      .run();
  for (const change of [
    { inAmountRaw: '9' },
    { wallet: 'SysvarRent111111111111111111111111111111111' },
    { side: 'Buy' },
    { slippageBps: 0 },
    { slippageBps: 50.5 },
    { slippageBps: 51 },
    { acquisition: null },
  ])
    await expect(
      publish(guard.preparationId, { ...summary, ...change }),
    ).rejects.toThrow();
  await publish(guard.preparationId);
  for (const createdAt of [
    'not-a-clock',
    new Date(Date.now() - 120000).toISOString(),
    new Date(Date.now() + 120000).toISOString(),
  ])
    await expect(
      db
        .prepare(
          'INSERT INTO auto_sell_run_stops(owner_id,id,run_id,run_sha256,created_at) VALUES(?,?,?,?,?)',
        )
        .bind(f.owner, crypto.randomUUID(), run.id, run.sha256, createdAt)
        .run(),
    ).rejects.toThrow();
  await expect(
    db
      .prepare(
        'INSERT INTO imported_swap_signing_intents VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        crypto.randomUUID(),
        f.owner,
        guard.preparationId,
        f.wallet,
        '{}',
        'awaiting_signature',
        null,
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run(),
  ).rejects.toThrow(/signing remains disabled/);
  await db.prepare('PRAGMA recursive_triggers=OFF').run();
  const target = (await db
    .prepare('SELECT rowid AS rid FROM imported_swap_preparations WHERE id=?')
    .bind(guard.preparationId)
    .first<{ rid: number }>())!.rid;
  for (const alias of ['rowid', 'oid', '_rowid_']) {
    for (const table of [
      'auto_sell_runs',
      'auto_sell_run_attempts',
      'auto_sell_run_occurrences',
      'auto_sell_run_preparation_starts',
      'auto_sell_run_heads',
      'auto_sell_run_strategy_heads',
    ])
      await expect(
        db.prepare(`SELECT ${alias} FROM ${table} LIMIT 1`).first(),
      ).rejects.toThrow();
    await expect(
      db
        .prepare(
          `INSERT OR REPLACE INTO imported_swap_preparations(${alias},id,owner_id,project_id,project_revision,wallet_address,wallet_revision,document,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          target,
          crypto.randomUUID(),
          f.owner,
          f.projectId,
          1,
          f.wallet,
          1,
          JSON.stringify(summary),
          new Date().toISOString(),
        )
        .run(),
    ).rejects.toThrow();
  }
  await expect(
    db
      .prepare('UPDATE imported_swap_preparations SET document=? WHERE id=?')
      .bind('{}', guard.preparationId)
      .run(),
  ).rejects.toThrow();
  await expect(
    db
      .prepare('DELETE FROM imported_swap_preparations WHERE id=?')
      .bind(guard.preparationId)
      .run(),
  ).rejects.toThrow();
  const stopped = await stopOwnedAutoSellRun(
    db,
    f.owner,
    { id: crypto.randomUUID(), runId: run.id, runSha256: run.sha256 },
    signal(),
  );
  expect(
    (await readOwnedAutoSellAttempts(db, f.owner, run.id, signal())).accounting
      .accountedRaw,
  ).toBe('10');
  expect(
    await reserveOwnedAutoSellAttempt(db, f.owner, reserve, signal()),
  ).toEqual(first);
  await expect(
    createOwnedAutoSellRun(
      db,
      f.owner,
      { ...f.createInput, id: crypto.randomUUID() },
      signal(),
    ),
  ).rejects.toMatchObject({ status: 409 });
  for (const table of [
    'auto_sell_runs',
    'auto_sell_run_attempts',
    'auto_sell_run_occurrences',
    'auto_sell_run_preparation_starts',
    'auto_sell_run_stops',
    'auto_sell_run_heads',
    'auto_sell_run_strategy_heads',
  ]) {
    await expect(
      db
        .prepare(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`)
        .run(),
    ).rejects.toThrow();
    await expect(db.prepare(`DELETE FROM ${table}`).run()).rejects.toThrow();
  }
  expect(
    (await readOwnedAutoSellAttempts(db, f.owner, run.id, signal())).stop,
  ).toEqual(stopped);
  // Server-loaded caps constrain direct SQL as well as the domain service.
  const capped = await setupAutoSellRunStorageFixture(db, {
    terms(t) {
      t.configuration.session.endMaxTokenAmount = '13';
      t.configuration.strategies[0].endMaxTokenAmount = '11';
      return t;
    },
  });
  const capRun = await createOwnedAutoSellRun(
    db,
    capped.owner,
    capped.createInput,
    signal(),
  );
  const capFirst = await reserveOwnedAutoSellAttempt(
    db,
    capped.owner,
    autoSellRunAttemptFixture(capRun),
    signal(),
  );
  const capSecond = await reserveOwnedAutoSellAttempt(
    db,
    capped.owner,
    autoSellRunAttemptFixture(capRun, {
      expectedSequence: 1,
      expectedHeadSha256: capFirst.sha256,
      inputRaw: '1',
      occurrence: { kind: 'counter', sourceIds: ['two'], bufferedRaw: '10' },
    }),
    signal(),
  );
  const capBad = {
    ...capSecond,
    id: crypto.randomUUID(),
    sequence: 3,
    previousSha256: capSecond.sha256,
    preparationId: crypto.randomUUID(),
    occurrence: {
      kind: 'counter' as const,
      sourceIds: ['three'],
      bufferedRaw: '1',
    },
    sha256: 'd'.repeat(64),
  };
  const limbs = autoSellRunAmountLimbs(capBad.inputRaw);
  await expect(
    db
      .prepare(
        'INSERT INTO auto_sell_run_attempts(owner_id,id,run_id,sequence,previous_sha256,sha256,strategy_id,wallet,wallet_revision,input_raw,amount_high,amount_middle,amount_low,preparation_id,document,reserved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        capped.owner,
        capBad.id,
        capBad.runId,
        capBad.sequence,
        capBad.previousSha256,
        capBad.sha256,
        capBad.strategyId,
        capBad.wallet,
        capBad.walletRevision,
        capBad.inputRaw,
        limbs.high,
        limbs.middle,
        limbs.low,
        capBad.preparationId,
        JSON.stringify(capBad),
        capBad.reservedAt,
      )
      .run(),
  ).rejects.toThrow();
  expect(
    (await readOwnedAutoSellAttempts(db, capped.owner, capRun.id, signal()))
      .accounting.accountedRaw,
  ).toBe('11');
  // No SQL integer/float cast of the raw amount is used above 2^63.
  const big = await setupAutoSellRunStorageFixture(db),
    bigRun = await createOwnedAutoSellRun(
      db,
      big.owner,
      big.createInput,
      signal(),
    ),
    u64 = '18446744073709551615';
  const bigFirst = await reserveOwnedAutoSellAttempt(
    db,
    big.owner,
    autoSellRunAttemptFixture(bigRun, {
      inputRaw: u64,
      occurrence: { kind: 'counter', sourceIds: ['big-one'], bufferedRaw: u64 },
    }),
    signal(),
  );
  await reserveOwnedAutoSellAttempt(
    db,
    big.owner,
    autoSellRunAttemptFixture(bigRun, {
      expectedSequence: 1,
      expectedHeadSha256: bigFirst.sha256,
      inputRaw: u64,
      occurrence: { kind: 'counter', sourceIds: ['big-two'], bufferedRaw: u64 },
    }),
    signal(),
  );
  expect(
    (await readOwnedAutoSellAttempts(db, big.owner, bigRun.id, signal()))
      .accounting.accountedRaw,
  ).toBe((2n * BigInt(u64)).toString());
  await exerciseUnfinishedPreparationSerialization(db);
  await exerciseCrossRunReservationRace(db);
}
async function exerciseOriginalStrategyDurationLimits(db: D1Database) {
  for (const seconds of [86401, 30 * 86400]) {
    const f = await setupAutoSellRunStorageFixture(db, {
      terms(t) {
        t.configuration.session.endDurationSeconds = 0;
        t.configuration.strategies[0].endDurationSeconds = seconds;
        return t;
      },
    });
    const run = await createOwnedAutoSellRun(
      db,
      f.owner,
      f.createInput,
      signal(),
    );
    expect(run.endsAt).toBeNull();
    expect(run.limits.strategies.find((s) => s.id === 'counter')?.endsAt).toBe(
      new Date(Date.parse(run.activeAt) + seconds * 1000).toISOString(),
    );
    const attempt = await reserveOwnedAutoSellAttempt(
      db,
      f.owner,
      autoSellRunAttemptFixture(run),
      signal(),
    );
    expect(attempt.inputRaw).toBe('10');
    expect(
      (await readOwnedAutoSellAttempts(db, f.owner, run.id, signal()))
        .accounting.accountedRaw,
    ).toBe('10');
  }
  await expect(
    setupAutoSellRunStorageFixture(db, {
      terms(t) {
        t.configuration.strategies[0].endDurationSeconds = 30 * 86400 + 1;
        return t;
      },
    }),
  ).rejects.toThrow();
}
async function exerciseRawRootAdmission(db: D1Database) {
  const f = await setupAutoSellRunStorageFixture(db),
    run = await createOwnedAutoSellRun(db, f.owner, f.createInput, signal());
  const row = (await db
    .prepare('SELECT * FROM auto_sell_runs WHERE owner_id=? AND id=?')
    .bind(f.owner, run.id)
    .first<Record<string, unknown>>())!;
  const limits = (document: Record<string, unknown>) =>
    document.limits as {
      sessionRaw?: unknown;
      strategies: Record<string, unknown>[];
    };
  const bad: Array<[string, (document: Record<string, unknown>) => void]> = [
    [
      'run cap invalid',
      (d) => {
        limits(d).sessionRaw = '1'.repeat(28);
      },
    ],
    [
      'run cap invalid',
      (d) => {
        limits(d).sessionRaw = '00';
      },
    ],
    [
      'run cap invalid',
      (d) => {
        limits(d).sessionRaw = '01';
      },
    ],
    [
      'run cap invalid',
      (d) => {
        limits(d).sessionRaw = '18446744073709551616';
      },
    ],
    [
      'run cap invalid',
      (d) => {
        limits(d).sessionRaw = '1e2';
      },
    ],
    [
      'run cap invalid',
      (d) => {
        limits(d).sessionRaw = 12;
      },
    ],
    [
      'run cap invalid',
      (d) => {
        delete limits(d).sessionRaw;
      },
    ],
    [
      'strategy cap invalid',
      (d) => {
        limits(d).strategies[0].capRaw = '9'.repeat(28);
      },
    ],
    [
      'strategy cap invalid',
      (d) => {
        limits(d).strategies[0].capRaw = '0001';
      },
    ],
    [
      'strategy cap invalid',
      (d) => {
        limits(d).strategies[0].capRaw = '18446744073709551616';
      },
    ],
    [
      'strategy cap invalid',
      (d) => {
        limits(d).strategies[0].capRaw = 1.2;
      },
    ],
    [
      'strategy cap invalid',
      (d) => {
        delete limits(d).strategies[0].capRaw;
      },
    ],
    [
      'run lifetime invalid',
      (d) => {
        d.activeAt = new Date(
          Date.parse(String(d.createdAt)) + 1000,
        ).toISOString();
      },
    ],
    [
      'run lifetime invalid',
      (d) => {
        d.endsAt = new Date(
          Date.parse(String(d.activeAt)) + 1000,
        ).toISOString();
      },
    ],
    [
      'run lifetime invalid',
      (d) => {
        delete d.endsAt;
      },
    ],
    [
      'strategy limits invalid',
      (d) => {
        limits(d).strategies[0].endsAt = new Date(
          Date.parse(String(d.activeAt)) + 1000,
        ).toISOString();
      },
    ],
    [
      'strategy limits invalid',
      (d) => {
        delete limits(d).strategies[0].endsAt;
      },
    ],
    [
      'strategy limits invalid',
      (d) => {
        limits(d).strategies[0].id = 'not-in-the-profile';
      },
    ],
    [
      'strategy limits invalid',
      (d) => {
        limits(d).strategies[1].id = limits(d).strategies[0].id;
      },
    ],
    [
      'strategy limits invalid',
      (d) => {
        limits(d).strategies.pop();
      },
    ],
  ];
  const append = async (
    mutate?: (document: Record<string, unknown>) => void,
  ) => {
    const stamp = (await db
      .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now")
      .first<{ now: string }>())!.now;
    const document = structuredClone(run) as unknown as Record<string, unknown>;
    document.id = crypto.randomUUID();
    document.createdAt = stamp;
    document.activeAt = stamp;
    document.endsAt = null;
    mutate?.(document);
    const { sha256: _old, ...body } = document;
    const sha256 = createHash('sha256')
      .update(JSON.stringify(['auto-sell-run-v1', body]))
      .digest('hex');
    const final = { ...body, sha256 };
    await db
      .prepare(
        'INSERT INTO auto_sell_runs(owner_id,id,project_id,project_revision,profile_save_id,profile_sha256,document,sha256,source_document,own_wallets_json,created_at,active_at,ends_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        f.owner,
        document.id,
        row.project_id,
        row.project_revision,
        row.profile_save_id,
        row.profile_sha256,
        JSON.stringify(final),
        sha256,
        row.source_document,
        row.own_wallets_json,
        document.createdAt,
        document.activeAt,
        document.endsAt ?? null,
      )
      .run();
    return String(document.id);
  };
  for (const [message, mutate] of bad)
    await expect(append(mutate)).rejects.toThrow(new RegExp(message));
  expect(
    (await db
      .prepare('SELECT count(*) AS n FROM auto_sell_runs WHERE owner_id=?')
      .bind(f.owner)
      .first<{ n: number }>())!.n,
  ).toBe(1);
  expect(
    (await readOwnedAutoSellAttempts(db, f.owner, run.id, signal())).accounting
      .sequence,
  ).toBe(0);
  const positive = await append();
  expect(
    (await readOwnedAutoSellAttempts(db, f.owner, positive, signal()))
      .accounting.accountedRaw,
  ).toBe('0');
}
async function exerciseCrossRunReservationRace(db: D1Database) {
  const f = await setupAutoSellRunStorageFixture(db);
  const runA = await createOwnedAutoSellRun(
    db,
    f.owner,
    f.createInput,
    signal(),
  );
  const runB = await createOwnedAutoSellRun(
    db,
    f.owner,
    { ...f.createInput, id: crypto.randomUUID() },
    signal(),
  );
  const requestA = autoSellRunAttemptFixture(runA),
    requestB = autoSellRunAttemptFixture(runB);
  const results = await Promise.allSettled([
    reserveOwnedAutoSellAttempt(db, f.owner, requestA, signal()),
    reserveOwnedAutoSellAttempt(db, f.owner, requestB, signal()),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const rejection = results.find((r) => r.status === 'rejected');
  expect(rejection?.status).toBe('rejected');
  if (rejection?.status === 'rejected')
    expect(rejection.reason).toMatchObject({ status: 409 });
  const a = await readOwnedAutoSellAttempts(db, f.owner, runA.id, signal());
  const b = await readOwnedAutoSellAttempts(db, f.owner, runB.id, signal());
  expect(
    [a.accounting.sequence, b.accounting.sequence].sort((a, b) => a - b),
  ).toEqual([0, 1]);
  const winner = a.accounting.sequence ? a : b,
    loser = a.accounting.sequence ? b : a;
  expect(winner.accounting.accountedRaw).toBe('10');
  expect(loser.accounting.accountedRaw).toBe('0');
  expect(loser.accounting.headSha256).toBe(loser.run.sha256);
  await stopOwnedAutoSellRun(
    db,
    f.owner,
    {
      id: crypto.randomUUID(),
      runId: winner.run.id,
      runSha256: winner.run.sha256,
    },
    signal(),
  );
  await expect(
    reserveOwnedAutoSellAttempt(
      db,
      f.owner,
      loser.run.id === runA.id ? requestA : requestB,
      signal(),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (await readOwnedAutoSellAttempts(db, f.owner, loser.run.id, signal()))
      .accounting.sequence,
  ).toBe(0);
}
async function exerciseUnfinishedPreparationSerialization(db: D1Database) {
  const f = await setupAutoSellRunStorageFixture(db),
    run = await createOwnedAutoSellRun(db, f.owner, f.createInput, signal());
  const a = await reserveOwnedAutoSellAttempt(
    db,
    f.owner,
    autoSellRunAttemptFixture(run),
    signal(),
  );
  const b = await reserveOwnedAutoSellAttempt(
    db,
    f.owner,
    autoSellRunAttemptFixture(run, {
      expectedSequence: 1,
      expectedHeadSha256: a.sha256,
      occurrence: { kind: 'counter', sourceIds: ['second'], bufferedRaw: '10' },
    }),
    signal(),
  );
  for (const createdAt of [
    'invalid',
    new Date(Date.now() - 120000).toISOString(),
    new Date(Date.now() + 120000).toISOString(),
  ])
    await expect(
      db
        .prepare(
          'INSERT INTO auto_sell_run_preparation_starts(owner_id,run_id,attempt_id,preparation_id,head_sequence,head_sha256,created_at) VALUES(?,?,?,?,?,?,?)',
        )
        .bind(f.owner, run.id, a.id, a.preparationId, 2, b.sha256, createdAt)
        .run(),
    ).rejects.toThrow(/clock invalid/);
  const guard = await startOwnedAutoSellPreparation(
    db,
    f.owner,
    run.id,
    a.id,
    signal(),
  );
  expect(guard.headSequence).toBe(2);
  expect(guard.headSha256).toBe(b.sha256);
  const next = autoSellRunAttemptFixture(run, {
    expectedSequence: 2,
    expectedHeadSha256: b.sha256,
    occurrence: { kind: 'counter', sourceIds: ['third'], bufferedRaw: '10' },
  });
  await expect(
    reserveOwnedAutoSellAttempt(db, f.owner, next, signal()),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    startOwnedAutoSellPreparation(db, f.owner, run.id, b.id, signal()),
  ).rejects.toMatchObject({ status: 409 });
  const held = await readOwnedAutoSellAttempts(db, f.owner, run.id, signal());
  expect(held.accounting.sequence).toBe(2);
  expect(held.accounting.accountedRaw).toBe('20');
  expect(held.preparationStarts).toHaveLength(1);
  // The old 0153-only fixture retains SQL association coverage. The current
  // writer requires original packet bytes and must refuse this old projection.
  const document = {
    executionAllowed: false,
    instructionsVerified: false,
    side: 'Sell',
    wallet: f.wallet,
    inputMint: f.mint,
    outputMint: 'So11111111111111111111111111111111111111112',
    inAmountRaw: '10',
    slippageBps: 50,
    transaction: { sha256: 'c'.repeat(64) },
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  } as unknown as SwapPreparationSummary;
  await expect(
    saveSwapPreparation(
      db,
      f.owner,
      {
        projectId: f.projectId,
        projectRevision: 1,
        wallet: f.wallet,
        walletRevision: 1,
      },
      document,
      undefined,
      undefined,
      undefined,
      guard,
    ),
  ).rejects.toThrow();
  expect(
    await db
      .prepare('SELECT id FROM imported_swap_preparations WHERE id=?')
      .bind(a.preparationId)
      .first(),
  ).toBeNull();
  // Simulate a historical pre-0154 summary with the unchanged 0153 guards.
  // Exact packet atomicity is covered separately by the new packet engines.
  await db
    .prepare(
      'INSERT INTO imported_swap_preparations(id,owner_id,project_id,project_revision,wallet_address,wallet_revision,document,created_at) VALUES(?,?,?,?,?,?,?,?)',
    )
    .bind(
      a.preparationId,
      f.owner,
      f.projectId,
      1,
      f.wallet,
      1,
      JSON.stringify(document),
      new Date().toISOString(),
    )
    .run();
  const c = await reserveOwnedAutoSellAttempt(db, f.owner, next, signal());
  expect(c.sequence).toBe(3);
  const secondGuard = await startOwnedAutoSellPreparation(
    db,
    f.owner,
    run.id,
    b.id,
    signal(),
  );
  expect(secondGuard.preparationId).toBe(b.preparationId);
  expect(secondGuard.headSequence).toBe(3);
  expect(
    (await readOwnedAutoSellAttempts(db, f.owner, run.id, signal())).accounting
      .accountedRaw,
  ).toBe('30');
}
it.each(['native-turso', 'local-d1'] as const)(
  'composes actual run journal guards and raw preparation persistence on %s',
  async (engine) => {
    const client =
      engine === 'native-turso'
        ? createClient({ url: 'file::memory:' })
        : undefined;
    let mf: Miniflare | undefined;
    try {
      const db = client
        ? createTursoDatabase(client)
        : ((await (mf = new Miniflare({
            telemetry: { enabled: false },
            workers: [
              {
                config: {
                  name: 'auto-sell-run-local',
                  type: 'worker',
                  compatibilityDate: '2026-09-01',
                  manifest: {
                    mainModule: 'index.js',
                    modules: {
                      'index.js': {
                        type: 'esm',
                        contents:
                          'export default {fetch(){return new Response("local bookkeeping only")}}',
                      },
                    },
                  },
                  env: { DB: { type: 'd1', id: 'auto-sell-run-local' } },
                },
              },
            ],
          })).getD1Database(
            'DB',
            'auto-sell-run-local',
          )) as unknown as D1Database);
      await initializeAutoSellRunStorageFixture(db);
      await exercise(db);
    } finally {
      client?.close();
      await mf?.dispose();
    }
  },
);
