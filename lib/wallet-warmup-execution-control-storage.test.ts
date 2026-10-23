import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { SQLInputValue } from 'node:sqlite';
import { warmupExecutionLeaseFixture } from '../test/warmup-execution-lease-fixture';
import { retainWarmupExecutionWalletLease } from './wallet-warmup-execution-lease';
import { retainWarmupExecutionGenesis } from './wallet-warmup-execution-genesis';
import { auditSavedWarmupExecutionPrefix } from './wallet-warmup-execution-audit';
import {
  retainWarmupExecutionControl as retain,
  readWarmupExecutionControls as read,
  readWarmupExecutionControlRequest as readRequest,
} from './wallet-warmup-execution-control-storage';

type Fixture = Awaited<ReturnType<typeof warmupExecutionLeaseFixture>>;
const fixtures: Fixture[] = [];
const signal = () => new AbortController().signal;
const flags = {
  workerControlApplied: false,
  leaseReleased: false,
  signingAllowed: false,
  executionAllowed: false,
  automaticExecutionAllowed: false,
};
const historyFlags = {
  ...flags,
  runStarted: false,
  currentHeadVerified: false,
  receiptEvidenceVerified: false,
  currentSourceVerified: false,
  financialReservationVerified: false,
};
async function fixture(stage: 'root' | 'lease' | 'genesis' = 'genesis') {
  const f = await warmupExecutionLeaseFixture();
  fixtures.push(f);
  for (const [table, path] of [
    [
      'wallet_warmup_execution_geneses',
      'drizzle/0142_wallet_warmup_execution_geneses.sql',
    ],
    [
      'wallet_warmup_execution_control_heads',
      'drizzle/0143_wallet_warmup_execution_controls.sql',
    ],
  ])
    if (
      !f.sqlite.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(table!)
    )
      f.sqlite.exec(readFileSync(path!, 'utf8'));
  if (stage !== 'root')
    await retainWarmupExecutionWalletLease(f.db, f.owner, f.input, signal());
  if (stage === 'genesis')
    await retainWarmupExecutionGenesis(f.db, f.owner, f.input, signal());
  return f;
}
afterEach(() => {
  for (const f of fixtures.splice(0).reverse()) f.dispose();
  vi.restoreAllMocks();
});
async function history(f: Fixture) {
  const result = await read(f.db, f.owner, f.input.proposalId, signal());
  if (!result) throw Error('Missing actual owned genesis history');
  return result;
}
async function request(
  f: Fixture,
  operation: 'pause' | 'resume' | 'stop' = 'pause',
  id = crypto.randomUUID(),
) {
  const current = await history(f);
  return {
    id,
    ...f.input,
    expectedVersion: current.head.version,
    expectedEventSha256: current.head.eventSha256,
    expectedCheckpointSha256: current.head.checkpointSha256,
    operation,
  };
}
const save = (f: Fixture, value: unknown, s = signal()) =>
  retain(f.db, f.owner, value, s);
const count = (f: Fixture, table: string) =>
  Number(f.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
const events = (f: Fixture) =>
  f.sqlite
    .prepare(
      'SELECT * FROM wallet_warmup_execution_control_events ORDER BY sequence',
    )
    .all();
const lease = (f: Fixture) =>
  f.sqlite.prepare('SELECT * FROM wallet_warmup_execution_wallet_leases').all();
const eventInserts = (f: Fixture, start = 0) =>
  f.statements
    .slice(start)
    .filter((s) =>
      s.startsWith('INSERT INTO wallet_warmup_execution_control_events'),
    );
const intentInserts = (f: Fixture, start = 0) =>
  f.statements
    .slice(start)
    .filter((s) =>
      s.startsWith('INSERT INTO wallet_warmup_execution_control_intents'),
    );

// Actual native full production migration chain, genuine retained proposal,
// approval/root/lease/genesis, real control derivation/replay and SQL triggers.
// All original collector inputs are synthetic: no provider or human proof.
it('reads a virtual original genesis without seeding a mutable head or fetching providers', async () => {
  const f = await fixture(),
    before = f.statements.length,
    calls = f.providerCalls();
  const h = await history(f);
  expect(h).toMatchObject({
    format: 'wallet-warmup-execution-controls-v1',
    ...f.input,
    recordedEvents: 0,
    headRecorded: false,
    scope: 'durable-control-history-only',
    ...historyFlags,
  });
  expect(h.head.version).toBe(0);
  expect(count(f, 'wallet_warmup_execution_control_heads')).toBe(0);
  expect(
    f.statements.slice(before).some((s) => /^(INSERT|UPDATE|DELETE)/.test(s)),
  ).toBe(false);
  expect(f.providerCalls()).toBe(calls);
});
it('persists pause, resume and stop as exact full-prefix shared audit history without applying worker controls or releasing leases', async () => {
  const f = await fixture(),
    originalLease = lease(f),
    calls = f.providerCalls();
  for (const [index, operation] of (
    ['pause', 'resume', 'stop'] as const
  ).entries()) {
    f.advance(1);
    const input = await request(f, operation),
      saved = await save(f, input);
    expect(saved.request).toMatchObject({
      ...input,
      status: 'control-recorded',
      sequence: index + 1,
      scope: 'durable-control-request-only',
      ...flags,
    });
    expect(saved.request.eventSha256).toBe(saved.history.head.eventSha256);
    expect(saved.request.recordedAt).toBe(f.sqlClock());
    expect(saved.request.modelAt).toBe(f.sqlClock());
    expect(saved.history).toMatchObject({
      recordedEvents: index + 1,
      headRecorded: true,
      ...historyFlags,
    });
    expect(saved.history.projection.snapshot.phase).toBe(
      operation === 'pause'
        ? 'paused'
        : operation === 'resume'
          ? 'queued'
          : 'stopped',
    );
    const prefix = events(f).map((e) => String(e.wire));
    const audited = await auditSavedWarmupExecutionPrefix(
      f.approval.root,
      f.approval.approval,
      {
        id: f.input.proposalId,
        ownerId: f.owner,
        consentId: f.approval.consentId,
        reviewId: f.approval.reviewId,
        rootSha256: f.input.rootSha256,
      },
      saved.history.head,
      prefix,
      signal(),
    );
    expect(saved.history.checkpoint).toEqual(audited.checkpoint);
    expect(saved.history.projection).toEqual(audited.projection);
    expect(saved.history.wireBytes).toBe(
      prefix.reduce(
        (sum, w) => sum + new TextEncoder().encode(w).byteLength,
        0,
      ),
    );
    expect(await readRequest(f.db, f.owner, input.id, signal())).toEqual(
      saved.request,
    );
    expect(lease(f)).toEqual(originalLease);
  }
  expect(count(f, 'wallet_warmup_execution_control_heads')).toBe(1);
  expect(events(f)).toHaveLength(3);
  expect(f.providerCalls()).toBe(calls);
});
it.each(['root', 'lease'] as const)(
  'without an original genesis (%s stage), reading is null and retaining cannot create a lease or genesis implicitly',
  async (stage) => {
    const f = await fixture(stage),
      before = f.statements.length,
      originalLease = lease(f);
    expect(await read(f.db, f.owner, f.input.proposalId, signal())).toBeNull();
    await expect(
      save(f, {
        id: crypto.randomUUID(),
        ...f.input,
        expectedVersion: 0,
        expectedEventSha256: 'a'.repeat(64),
        expectedCheckpointSha256: 'b'.repeat(64),
        operation: 'pause',
      }),
    ).rejects.toThrow();
    expect(count(f, 'wallet_warmup_execution_geneses')).toBe(0);
    expect(count(f, 'wallet_warmup_execution_control_intents')).toBe(0);
    expect(lease(f)).toEqual(originalLease);
    expect(
      f.statements.slice(before).some((s) => /^(INSERT|UPDATE|DELETE)/.test(s)),
    ).toBe(false);
  },
);
it('enforces owner and exact proposal/request identity without leaking another owner history', async () => {
  const f = await fixture(),
    input = await request(f);
  expect(
    await read(f.db, 'other-owner', input.proposalId, signal()),
  ).toBeNull();
  expect(await readRequest(f.db, 'other-owner', input.id, signal())).toBeNull();
  expect(await read(f.db, f.owner, crypto.randomUUID(), signal())).toBeNull();
  await expect(retain(f.db, 'other-owner', input, signal())).rejects.toThrow();
  await expect(
    save(f, { ...input, proposalId: crypto.randomUUID() }),
  ).rejects.toThrow();
  expect(events(f)).toHaveLength(0);
});
it.each([
  'rootSha256',
  'manifestSha256',
  'expectedVersion',
  'expectedEventSha256',
  'expectedCheckpointSha256',
] as const)(
  'refuses a changed exact %s rather than rebasing the control',
  async (key) => {
    const f = await fixture(),
      input = await request(f);
    await expect(
      save(f, {
        ...input,
        [key]: key === 'expectedVersion' ? 1 : 'f'.repeat(64),
      }),
    ).rejects.toThrow();
    expect(events(f)).toHaveLength(0);
  },
);
it.each([
  'now',
  'modelAt',
  'head',
  'checkpoint',
  'ownerId',
  'signature',
  'executionAllowed',
] as const)(
  'refuses caller-supplied %s before writing a request',
  async (key) => {
    const f = await fixture(),
      input = await request(f),
      before = f.statements.length;
    await expect(save(f, { ...input, [key]: 'untrusted' })).rejects.toThrow();
    expect(
      f.statements.slice(before).some((s) => /^(INSERT|UPDATE|DELETE)/.test(s)),
    ).toBe(false);
    expect(events(f)).toHaveLength(0);
  },
);
it.each(['reserve', 'qualify', 'authorize', 'dispatch-intent', 'settle'])(
  'never accepts a financial/qualification operation %s',
  async (operation) => {
    const f = await fixture(),
      input = await request(f);
    await expect(save(f, { ...input, operation })).rejects.toThrow();
    expect(events(f)).toHaveLength(0);
  },
);
it('reuses one original request ID without repeating writes or rebasing after history advances', async () => {
  const f = await fixture(),
    input = await request(f),
    one = await save(f, input);
  f.advance(1);
  await save(f, await request(f, 'resume'));
  const before = f.statements.length,
    two = await save(f, input);
  expect(two.request).toEqual(one.request);
  expect(two.request.superseded).toBe(false);
  expect(
    (await readRequest(f.db, f.owner, input.id, signal()))!.superseded,
  ).toBe(false);
  expect(two.history.head.version).toBe(2);
  expect(
    f.statements.slice(before).some((s) => /^(INSERT|UPDATE|DELETE)/.test(s)),
  ).toBe(false);
  await expect(save(f, { ...input, operation: 'stop' })).rejects.toThrow();
  expect(events(f)).toHaveLength(2);
});
it('refuses invalid phases before seeding a fresh head or retaining useless requests', async () => {
  const f = await fixture();
  const assertNoWrites = async (operation: 'pause' | 'resume' | 'stop') => {
    const input = await request(f, operation),
      before = f.statements.length;
    const counts = [
      'wallet_warmup_execution_control_heads',
      'wallet_warmup_execution_control_intents',
      'wallet_warmup_execution_control_events',
    ].map((table) => count(f, table));
    await expect(save(f, input)).rejects.toThrow();
    expect(
      f.statements.slice(before).some((s) => /^(INSERT|UPDATE|DELETE)/.test(s)),
    ).toBe(false);
    expect(
      [
        'wallet_warmup_execution_control_heads',
        'wallet_warmup_execution_control_intents',
        'wallet_warmup_execution_control_events',
      ].map((table) => count(f, table)),
    ).toEqual(counts);
    expect(await readRequest(f.db, f.owner, input.id, signal())).toBeNull();
  };
  await assertNoWrites('resume');
  expect(count(f, 'wallet_warmup_execution_control_heads')).toBe(0);
  await save(f, await request(f, 'pause'));
  await assertNoWrites('pause');
  await save(f, await request(f, 'stop'));
  for (const operation of ['pause', 'resume', 'stop'] as const)
    await assertNoWrites(operation);
  expect(events(f)).toHaveLength(2);
  expect((await history(f)).projection.snapshot.phase).toBe('stopped');
});

it('records late stop after original expiry without renewing time or releasing the original hold', async () => {
  const f = await fixture(),
    originalLease = lease(f);
  f.advance(86400000);
  const saved = await save(f, await request(f, 'stop'));
  expect(saved.history.projection.snapshot.phase).toBe('stopped');
  expect(saved.history.projection.snapshot.expiresAt).toBe(
    f.approval.approval.sessionExpiresAt,
  );
  expect(saved.history).toMatchObject(historyFlags);
  expect(lease(f)).toEqual(originalLease);
});
it.each(['pause', 'resume'] as const)(
  'keeps a durable %s intent at its original SQL time and refuses applying it at exact session expiry',
  async (operation) => {
    const f = await fixture();
    if (operation === 'resume') await save(f, await request(f, 'pause'));
    const input = await request(f, operation),
      controller = new AbortController(),
      beforeEvents = events(f).length;
    f.setAfter((sql, op) => {
      if (
        op === 'run' &&
        sql.startsWith('INSERT INTO wallet_warmup_execution_control_intents')
      ) {
        f.setAfter();
        controller.abort();
      }
    });
    await expect(save(f, input, controller.signal)).rejects.toThrow();
    const staged = await readRequest(f.db, f.owner, input.id, signal());
    expect(staged).toMatchObject({
      ...input,
      status: 'intent-recorded',
      sequence: null,
      eventSha256: null,
      recordedAt: null,
      ...flags,
    });
    expect(events(f)).toHaveLength(beforeEvents);
    f.advance(
      Date.parse(f.approval.approval.sessionExpiresAt) -
        Date.parse(f.sqlClock()),
    );
    expect(f.sqlClock()).toBe(f.approval.approval.sessionExpiresAt);
    const refused = await save(f, input);
    expect(refused.request).toEqual(staged);
    expect(refused.history.head.version).toBe(beforeEvents);
    expect(await readRequest(f.db, f.owner, input.id, signal())).toEqual(
      staged,
    );
    expect(events(f)).toHaveLength(beforeEvents);
  },
);

it('an explicit same-ID retry can complete an unexpired original staged intent without renewing its model timestamp', async () => {
  const f = await fixture(),
    input = await request(f),
    controller = new AbortController();
  f.setAfter((sql, op) => {
    if (
      op === 'run' &&
      sql.startsWith('INSERT INTO wallet_warmup_execution_control_intents')
    ) {
      f.setAfter();
      controller.abort();
    }
  });
  await expect(save(f, input, controller.signal)).rejects.toThrow();
  const staged = await readRequest(f.db, f.owner, input.id, signal());
  f.advance(5);
  const saved = await save(f, input);
  expect(saved.request).toMatchObject({
    ...input,
    status: 'control-recorded',
    modelAt: staged!.modelAt,
  });
  expect(saved.request.recordedAt).toBe(f.sqlClock());
  expect(saved.request.recordedAt).not.toBe(saved.request.modelAt);
  expect(events(f)).toHaveLength(1);
  expect(intentInserts(f)).toHaveLength(1);
});
it('a committed intent reply loss returns staged metadata without automatically writing an event', async () => {
  const f = await fixture(),
    input = await request(f),
    before = f.statements.length;
  let lost = false;
  f.setAfter((sql, op) => {
    if (
      op === 'run' &&
      sql.startsWith('INSERT INTO wallet_warmup_execution_control_intents')
    ) {
      f.setAfter();
      lost = true;
      throw Error('Synthetic committed intent reply lost');
    }
  });
  const staged = await save(f, input);
  expect(lost).toBe(true);
  expect(staged.request).toMatchObject({
    ...input,
    status: 'intent-recorded',
    sequence: null,
    eventSha256: null,
    recordedAt: null,
    ...flags,
  });
  expect(staged.history.head.version).toBe(0);
  expect(eventInserts(f, before)).toHaveLength(0);
  expect(intentInserts(f, before)).toHaveLength(1);
  expect(events(f)).toHaveLength(0);
  const completed = await save(f, input);
  expect(completed.request).toMatchObject({
    id: input.id,
    status: 'control-recorded',
    modelAt: staged.request.modelAt,
  });
  expect(intentInserts(f, before)).toHaveLength(1);
  expect(eventInserts(f, before)).toHaveLength(1);
});

it('recovers one event after its committed reply is lost without another event INSERT', async () => {
  const f = await fixture(),
    input = await request(f),
    before = f.statements.length;
  let lost = false;
  f.setAfter((sql, op) => {
    if (
      op === 'run' &&
      sql.startsWith('INSERT INTO wallet_warmup_execution_control_events')
    ) {
      f.setAfter();
      lost = true;
      throw Error('Synthetic event reply lost');
    }
  });
  const saved = await save(f, input);
  expect(lost).toBe(true);
  expect(saved.request).toMatchObject({
    id: input.id,
    status: 'control-recorded',
  });
  expect(events(f)).toHaveLength(1);
  expect(eventInserts(f, before)).toHaveLength(1);
  expect(await readRequest(f.db, f.owner, input.id, signal())).toEqual(
    saved.request,
  );
});
it('cancellation after event commit preserves the original request and atomically advanced head for saved-only recovery', async () => {
  const f = await fixture(),
    input = await request(f),
    controller = new AbortController();
  f.setAfter((sql, op) => {
    if (
      op === 'run' &&
      sql.startsWith('INSERT INTO wallet_warmup_execution_control_events')
    ) {
      f.setAfter();
      controller.abort();
    }
  });
  await expect(save(f, input, controller.signal)).rejects.toThrow();
  expect(events(f)).toHaveLength(1);
  expect((await history(f)).head.version).toBe(1);
  expect(await readRequest(f.db, f.owner, input.id, signal())).toMatchObject({
    ...input,
    status: 'control-recorded',
    sequence: 1,
    ...flags,
  });
  const before = f.statements.length;
  await save(f, input);
  expect(eventInserts(f, before)).toHaveLength(0);
});
it('two distinct requests at one expected head cannot both advance or silently rebase', async () => {
  const f = await fixture(),
    one = await request(f),
    two = { ...one, id: crypto.randomUUID() };
  await Promise.allSettled([save(f, one), save(f, two)]);
  expect(events(f)).toHaveLength(1);
  const h = await history(f);
  expect(h.head.version).toBe(1);
  const requests = await Promise.all([
    readRequest(f.db, f.owner, one.id, signal()),
    readRequest(f.db, f.owner, two.id, signal()),
  ]);
  expect(requests.filter((r) => r?.status === 'control-recorded')).toHaveLength(
    1,
  );
  for (const r of requests) if (r) expect(r.expectedVersion).toBe(0);
  const losing = requests[0]?.status === 'control-recorded' ? two : one;
  await Promise.allSettled([save(f, losing)]);
  expect(events(f)).toHaveLength(1);
  expect((await history(f)).head).toEqual(h.head);
});
it('a genuine concurrent winning stop leaves the stale staged pause unapplied with no orphan event or rebased head', async () => {
  const f = await fixture(),
    pause = await request(f),
    stop = { ...pause, id: crypto.randomUUID(), operation: 'stop' as const };
  let competed = false;
  f.setBefore(async (sql, op) => {
    if (
      op === 'run' &&
      sql.startsWith('INSERT INTO wallet_warmup_execution_control_events')
    ) {
      f.setBefore();
      competed = true;
      await save(f, stop);
    }
  });
  await Promise.allSettled([save(f, pause)]);
  expect(competed).toBe(true);
  expect(events(f)).toHaveLength(1);
  expect(events(f)[0]!.id).toBe(stop.id);
  expect((await history(f)).projection.snapshot.phase).toBe('stopped');
  expect(await readRequest(f.db, f.owner, pause.id, signal())).toMatchObject({
    id: pause.id,
    status: 'intent-recorded',
    expectedVersion: 0,
    sequence: null,
    superseded: true,
  });
});
it('actual SQL forbids arbitrary head jumps and replacing or deleting committed intent/event history', async () => {
  const f = await fixture(),
    saved = await save(f, await request(f));
  for (const table of [
    'wallet_warmup_execution_control_intents',
    'wallet_warmup_execution_control_events',
  ]) {
    const row = f.sqlite.prepare(`SELECT * FROM ${table}`).get()!,
      keys = Object.keys(row);
    expect(() =>
      f.sqlite
        .prepare(
          `INSERT OR REPLACE INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`,
        )
        .run(...(Object.values(row) as SQLInputValue[])),
    ).toThrow();
    expect(() => f.sqlite.exec(`UPDATE ${table} SET id=id`)).toThrow();
    expect(() => f.sqlite.exec(`DELETE FROM ${table}`)).toThrow();
  }
  expect(() =>
    f.sqlite.exec(
      'UPDATE wallet_warmup_execution_control_heads SET version=version+1',
    ),
  ).toThrow();
  expect(() =>
    f.sqlite.exec('DELETE FROM wallet_warmup_execution_control_heads'),
  ).toThrow();
  expect((await history(f)).head).toEqual(saved.history.head);
  expect(events(f)).toHaveLength(1);
  expect(f.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
it.each(['foreign-keys-disabled', 'missing-control-guard'] as const)(
  'refuses %s before writing any request or event',
  async (kind) => {
    const f = await fixture(),
      input = await request(f);
    if (kind === 'foreign-keys-disabled')
      f.sqlite.exec('PRAGMA foreign_keys=OFF');
    else f.sqlite.exec('DROP TRIGGER warmup_execution_control_event_advance');
    const before = f.statements.length,
      calls = f.providerCalls();
    await expect(save(f, input)).rejects.toThrow();
    expect(
      f.statements.slice(before).some((s) => /^(INSERT|UPDATE|DELETE)/.test(s)),
    ).toBe(false);
    expect(events(f)).toHaveLength(0);
    expect(f.providerCalls()).toBe(calls);
  },
);
it('cancellation as the final post-derivation head read resolves preserves the intent without starting an event INSERT', async () => {
  const f = await fixture(),
    input = await request(f),
    controller = new AbortController(),
    before = f.statements.length;
  let staged = false,
    headReads = 0;
  const reason = Error('Synthetic final-head cancellation');
  f.setAfter((sql, op) => {
    if (
      op === 'run' &&
      sql.startsWith('INSERT INTO wallet_warmup_execution_control_intents')
    )
      staged = true;
    if (
      staged &&
      op === 'first' &&
      sql.startsWith(
        'SELECT * FROM wallet_warmup_execution_control_heads WHERE',
      )
    ) {
      headReads++;
      // Request reconstruction checks its head three times; the fourth is the
      // exact final CAS-head read after real derivation and before event INSERT.
      if (headReads === 4) {
        f.setAfter();
        controller.abort(reason);
      }
    }
  });
  await expect(save(f, input, controller.signal)).rejects.toBe(reason);
  expect(headReads).toBe(4);
  expect(intentInserts(f, before)).toHaveLength(1);
  expect(eventInserts(f, before)).toHaveLength(0);
  expect(events(f)).toHaveLength(0);
  expect(await readRequest(f.db, f.owner, input.id, signal())).toMatchObject({
    ...input,
    status: 'intent-recorded',
    sequence: null,
  });
  expect((await history(f)).head.version).toBe(0);
});

it('a null owned request read still preserves caller cancellation arriving with its SQL response', async () => {
  const f = await fixture(),
    controller = new AbortController(),
    before = f.statements.length;
  const reason = Error('Synthetic null-request cancellation');
  let reached = false;
  f.setAfter((sql, op) => {
    if (
      op === 'first' &&
      sql.startsWith(
        'SELECT * FROM wallet_warmup_execution_control_intents WHERE',
      )
    ) {
      f.setAfter();
      reached = true;
      controller.abort(reason);
    }
  });
  await expect(
    readRequest(f.db, f.owner, crypto.randomUUID(), controller.signal),
  ).rejects.toBe(reason);
  expect(reached).toBe(true);
  expect(
    f.statements.slice(before).some((s) => /^(INSERT|UPDATE|DELETE)/.test(s)),
  ).toBe(false);
  expect(events(f)).toHaveLength(0);
});

it('reuses one fully verified original proof within a public call and rebuilds it on each later public call', async () => {
  const f = await fixture();
  const counts = (start: number) => {
    const queries = f.statements.slice(start);
    return {
      stage: queries.filter((sql) =>
        sql.includes(
          'FROM wallet_warmup_execution_proposal_stages WHERE owner_id=? AND id=?',
        ),
      ).length,
      chunkMetadata: queries.filter((sql) =>
        sql.startsWith(
          'SELECT chunk_index,length(data) AS byte_length,sha256 FROM wallet_warmup_execution_proposal_chunks',
        ),
      ).length,
      chunkData: queries.filter((sql) =>
        sql.startsWith(
          'SELECT data FROM wallet_warmup_execution_proposal_chunks',
        ),
      ).length,
    };
  };
  let before = f.statements.length;
  const initial = await history(f),
    once = counts(before);
  expect(once.stage).toBeGreaterThan(0);
  expect(once.chunkMetadata).toBeGreaterThan(0);
  expect(once.chunkData).toBeGreaterThan(0);
  const input = {
    id: crypto.randomUUID(),
    ...f.input,
    expectedVersion: initial.head.version,
    expectedEventSha256: initial.head.eventSha256,
    expectedCheckpointSha256: initial.head.checkpointSha256,
    operation: 'pause' as const,
  };
  before = f.statements.length;
  const saved = await save(f, input);
  // Retain performs several complete-prefix/head checks, but expensive original
  // proposal/chunk admission is exactly one public-read proof, not one per check.
  expect(counts(before)).toEqual(once);
  expect(saved.request.status).toBe('control-recorded');
  before = f.statements.length;
  expect((await history(f)).head).toEqual(saved.history.head);
  expect(counts(before)).toEqual(once);
  before = f.statements.length;
  expect(await readRequest(f.db, f.owner, input.id, signal())).toEqual(
    saved.request,
  );
  expect(counts(before)).toEqual(once);
  before = f.statements.length;
  expect((await save(f, input)).request).toEqual(saved.request);
  expect(counts(before)).toEqual(once);
});

it('refuses a legal-looking changed original header after derivation instead of trusting request-local proof reuse', async () => {
  const f = await fixture(),
    input = await request(f),
    before = f.statements.length,
    calls = f.providerCalls();
  const original = f.sqlite
    .prepare('SELECT * FROM wallet_warmup_execution_geneses')
    .get()!;
  let staged = false,
    headerReads = 0,
    corrupted = false;
  f.setAfter((sql, op) => {
    if (
      op === 'run' &&
      sql.startsWith('INSERT INTO wallet_warmup_execution_control_intents')
    )
      staged = true;
  });
  const prepare = f.db.prepare.bind(f.db);
  const spy = vi.spyOn(f.db, 'prepare').mockImplementation((sql: string) => {
    const statement = prepare(sql);
    if (!sql.startsWith('SELECT * FROM wallet_warmup_execution_geneses WHERE'))
      return statement;
    const bind = statement.bind.bind(statement);
    statement.bind = (...values: unknown[]) => {
      const bound = bind(...values),
        first = bound.first.bind(bound);
      bound.first = (async (...args: Parameters<typeof first>) => {
        const row = await first(...args);
        if (staged) {
          headerReads++;
          if (
            headerReads === 2 &&
            row &&
            typeof row === 'object' &&
            'recorded_at' in row
          ) {
            corrupted = true;
            // Intercept only a returned scalar header; all production SQL guards
            // and stored rows remain unchanged. The replacement is canonical.
            return {
              ...row,
              recorded_at: new Date(
                Date.parse(String(row.recorded_at)) + 1,
              ).toISOString(),
            };
          }
        }
        return row;
      }) as typeof bound.first;
      return bound;
    };
    return statement;
  });
  await expect(save(f, input)).rejects.toThrow();
  expect(corrupted).toBe(true);
  expect(headerReads).toBe(2);
  expect(intentInserts(f, before)).toHaveLength(1);
  expect(eventInserts(f, before)).toHaveLength(0);
  expect(events(f)).toHaveLength(0);
  expect(
    f.sqlite.prepare('SELECT * FROM wallet_warmup_execution_geneses').get(),
  ).toEqual(original);
  expect(f.providerCalls()).toBe(calls);
  spy.mockRestore();
  f.setAfter();
  expect(await readRequest(f.db, f.owner, input.id, signal())).toMatchObject({
    ...input,
    status: 'intent-recorded',
    sequence: null,
  });
  expect((await history(f)).head.version).toBe(0);
});

it('an already aborted request performs no SQL or provider work', async () => {
  const f = await fixture(),
    input = await request(f),
    controller = new AbortController(),
    before = f.statements.length,
    calls = f.providerCalls();
  controller.abort();
  await expect(save(f, input, controller.signal)).rejects.toThrow();
  expect(f.statements.length).toBe(before);
  expect(f.providerCalls()).toBe(calls);
});
