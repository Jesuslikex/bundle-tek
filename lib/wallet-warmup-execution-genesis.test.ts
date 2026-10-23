import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { warmupExecutionLeaseFixture } from '../test/warmup-execution-lease-fixture';
import { retainWarmupExecutionWalletLease } from './wallet-warmup-execution-lease';
import {
  warmupExecutionAuditGenesis,
  auditSavedWarmupExecutionPrefix,
} from './wallet-warmup-execution-audit';
import {
  retainWarmupExecutionGenesis as retain,
  readWarmupExecutionGenesis as read,
} from './wallet-warmup-execution-genesis';

type Fixture = Awaited<ReturnType<typeof warmupExecutionLeaseFixture>>;
const fixtures: Fixture[] = [];
const signal = () => new AbortController().signal;
const flags = {
  recordedEvents: 0,
  runStarted: false,
  currentHeadVerified: false,
  receiptEvidenceVerified: false,
  currentSourceVerified: false,
  financialReservationVerified: false,
  signingAllowed: false,
  executionAllowed: false,
  automaticExecutionAllowed: false,
};
async function fixture(withLease = true) {
  const f = await warmupExecutionLeaseFixture();
  fixtures.push(f);
  if (
    !f.sqlite
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE name='wallet_warmup_execution_geneses'",
      )
      .get()
  )
    f.sqlite.exec(
      readFileSync('drizzle/0142_wallet_warmup_execution_geneses.sql', 'utf8'),
    );
  const lease = withLease
    ? await retainWarmupExecutionWalletLease(f.db, f.owner, f.input, signal())
    : null;
  return { ...f, lease };
}
afterEach(() => {
  for (const f of fixtures.splice(0).reverse()) f.dispose();
  vi.restoreAllMocks();
});
const save = (f: Fixture, value: unknown = f.input, s = signal()) =>
  retain(f.db, f.owner, value, s);
const count = (f: Fixture) =>
  Number(
    f.sqlite
      .prepare('SELECT count(*) AS n FROM wallet_warmup_execution_geneses')
      .get()!.n,
  );
function selector(f: Fixture) {
  return {
    id: f.input.proposalId,
    ownerId: f.owner,
    consentId: f.approval.consentId,
    reviewId: f.approval.reviewId,
    rootSha256: f.input.rootSha256,
  };
}
async function expected(f: Awaited<ReturnType<typeof fixture>>) {
  return warmupExecutionAuditGenesis(
    f.approval.root,
    f.approval.approval,
    selector(f),
    f.lease!.createdAt,
    signal(),
  );
}
async function raw(f: Awaited<ReturnType<typeof fixture>>) {
  const genesis = await expected(f);
  return {
    owner_id: f.owner,
    proposal_id: f.input.proposalId,
    root_sha256: f.input.rootSha256,
    manifest_sha256: f.input.manifestSha256,
    lease_created_at: f.lease!.createdAt,
    version: 0,
    event_sha256: genesis.head.eventSha256,
    checkpoint_sha256: genesis.head.checkpointSha256,
    recorded_at: f.sqlClock(),
  };
}
function insert(
  f: Fixture,
  row: Record<string, string | number>,
  verb = 'INSERT',
) {
  const keys = Object.keys(row);
  return f.sqlite
    .prepare(
      `${verb} INTO wallet_warmup_execution_geneses(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`,
    )
    .run(...Object.values(row));
}

it('binds the genuine retained root and lease to the existing version-zero audit using original SQL lease time', async () => {
  const f = await fixture(),
    calls = f.providerCalls();
  expect(await read(f.db, f.owner, f.input.proposalId, signal())).toBeNull();
  f.advance(7);
  const initial = await expected(f),
    saved = await save(f);
  expect(saved).toEqual({
    format: 'wallet-warmup-execution-genesis-v1',
    ...f.input,
    leaseCreatedAt: f.lease!.createdAt,
    recordedAt: f.sqlClock(),
    head: initial.head,
    checkpoint: initial.checkpoint,
    scope: 'durable-initial-audit-only',
    ...flags,
  });
  expect(saved.head.createdAt).toBe(f.lease!.createdAt);
  expect(saved.recordedAt).not.toBe(saved.head.createdAt);
  expect(saved.head.version).toBe(0);
  expect(saved.checkpoint).toMatchObject({
    resumable: false,
    scope: 'audit-summary-not-resumable',
  });
  const replayed = await auditSavedWarmupExecutionPrefix(
    f.approval.root,
    f.approval.approval,
    selector(f),
    saved.head,
    [],
    signal(),
  );
  expect(replayed.head).toEqual(saved.head);
  expect(replayed.checkpoint).toEqual(saved.checkpoint);
  expect(replayed.replayedEvents).toBe(0);
  expect(count(f)).toBe(1);
  expect(f.providerCalls()).toBe(calls);
  expect(await f.readApproval()).toEqual(f.approval);
});

it('never implicitly creates a missing wallet lease', async () => {
  const f = await fixture(false),
    before = f.statements.length,
    calls = f.providerCalls();
  await expect(save(f)).rejects.toThrow();
  expect(count(f)).toBe(0);
  expect(
    f.sqlite
      .prepare(
        'SELECT count(*) AS n FROM wallet_warmup_execution_wallet_leases',
      )
      .get()!.n,
  ).toBe(0);
  expect(f.statements.slice(before).some((s) => s.startsWith('INSERT'))).toBe(
    false,
  );
  expect(f.providerCalls()).toBe(calls);
});

it('keeps original owner and exact proposal identity independent of request-supplied hashes', async () => {
  const f = await fixture(),
    unknown = crypto.randomUUID();
  expect(
    await read(f.db, 'unrelated-owner', f.input.proposalId, signal()),
  ).toBeNull();
  expect(await read(f.db, f.owner, unknown, signal())).toBeNull();
  await expect(
    retain(f.db, 'unrelated-owner', f.input, signal()),
  ).rejects.toThrow();
  await expect(save(f, { ...f.input, proposalId: unknown })).rejects.toThrow();
  expect(count(f)).toBe(0);
});
it.each(['rootSha256', 'manifestSha256'] as const)(
  'refuses a different %s before genesis storage',
  async (key) => {
    const f = await fixture();
    await expect(
      save(f, { ...f.input, [key]: 'f'.repeat(64) }),
    ).rejects.toThrow();
    expect(count(f)).toBe(0);
  },
);
it.each(['createdAt', 'head', 'checkpoint', 'ownerId', 'version'] as const)(
  'refuses caller-supplied %s rather than promoting it to owned recovery state',
  async (key) => {
    const f = await fixture(),
      before = f.statements.length;
    await expect(
      save(f, { ...f.input, [key]: key === 'version' ? 0 : 'untrusted' }),
    ).rejects.toThrow();
    expect(count(f)).toBe(0);
    expect(f.statements.slice(before).some((s) => s.startsWith('INSERT'))).toBe(
      false,
    );
  },
);
it('repeated retain and saved-only read recover one original immutable row without another write', async () => {
  const f = await fixture(),
    saved = await save(f),
    before = f.statements.length,
    calls = f.providerCalls();
  expect(await save(f)).toEqual(saved);
  expect(await read(f.db, f.owner, f.input.proposalId, signal())).toEqual(
    saved,
  );
  expect(
    f.statements.slice(before).some((s) => /^(INSERT|UPDATE|DELETE)/.test(s)),
  ).toBe(false);
  expect(count(f)).toBe(1);
  expect(f.providerCalls()).toBe(calls);
});
it('recovers historical original genesis after expiry and wallet/plan archival without renewal', async () => {
  const f = await fixture(),
    saved = await save(f),
    calls = f.providerCalls();
  f.advance(86400000);
  f.sqlite
    .prepare(
      'UPDATE workspace_wallets SET archived=1,revision=revision+1 WHERE owner_id=?',
    )
    .run(f.owner);
  f.sqlite
    .prepare(
      'UPDATE wallet_warmup_plans SET archived=1,revision=revision+1 WHERE owner_id=?',
    )
    .run(f.owner);
  const before = f.statements.length;
  expect(await read(f.db, f.owner, f.input.proposalId, signal())).toEqual(
    saved,
  );
  expect(await save(f)).toEqual(saved);
  expect(
    f.statements.slice(before).some((s) => /^(INSERT|UPDATE|DELETE)/.test(s)),
  ).toBe(false);
  expect(count(f)).toBe(1);
  expect(f.providerCalls()).toBe(calls);
});
it('records only historical version-zero metadata if the original leased session has already expired and been archived', async () => {
  const f = await fixture(),
    calls = f.providerCalls();
  const leaseBefore = f.sqlite
    .prepare('SELECT * FROM wallet_warmup_execution_wallet_leases')
    .all();
  f.advance(86400000);
  f.sqlite
    .prepare(
      'UPDATE workspace_wallets SET archived=1,revision=revision+1 WHERE owner_id=?',
    )
    .run(f.owner);
  f.sqlite
    .prepare(
      'UPDATE wallet_warmup_plans SET archived=1,revision=revision+1 WHERE owner_id=?',
    )
    .run(f.owner);
  const saved = await save(f);
  expect(saved).toMatchObject({ ...f.input, ...flags });
  expect(saved.head.createdAt).toBe(f.lease!.createdAt);
  expect(saved.recordedAt).toBe(f.sqlClock());
  expect(saved.checkpoint.snapshot.expiresAt).toBe(
    f.approval.approval.sessionExpiresAt,
  );
  expect(Date.parse(saved.recordedAt)).toBeGreaterThan(
    Date.parse(saved.checkpoint.snapshot.expiresAt),
  );
  expect(
    f.sqlite
      .prepare('SELECT * FROM wallet_warmup_execution_wallet_leases')
      .all(),
  ).toEqual(leaseBefore);
  expect(f.providerCalls()).toBe(calls);
});

it('concurrent exact retains recover one owned head without replacing its original identity', async () => {
  const f = await fixture();
  const [one, two] = await Promise.all([save(f), save(f)]);
  expect(one).toEqual(two);
  expect(count(f)).toBe(1);
  expect(one).toMatchObject({ ...f.input, ...flags });
  await expect(
    save(f, { ...f.input, rootSha256: 'f'.repeat(64) }),
  ).rejects.toThrow();
  expect(await read(f.db, f.owner, f.input.proposalId, signal())).toEqual(one);
});

it.each(['event_sha256', 'checkpoint_sha256'] as const)(
  'rederives and refuses a structurally valid but cryptographically false stored %s',
  async (key) => {
    const f = await fixture(),
      row = await raw(f);
    insert(f, { ...row, [key]: 'f'.repeat(64) });
    // A raw SQL row with legal parents is not a cryptographically verified head.
    await expect(
      read(f.db, f.owner, f.input.proposalId, signal()),
    ).rejects.toThrow();
    await expect(save(f)).rejects.toThrow();
    expect(count(f)).toBe(1);
    expect(
      f.sqlite
        .prepare(`SELECT ${key} AS hash FROM wallet_warmup_execution_geneses`)
        .get()!.hash,
    ).toBe('f'.repeat(64));
  },
);
it('refuses UPDATE, DELETE and duplicate REPLACE without modifying the original head', async () => {
  const f = await fixture(),
    saved = await save(f),
    row = await raw(f);
  expect(() => insert(f, row, 'INSERT OR REPLACE')).toThrow();
  expect(() =>
    f.sqlite
      .prepare('UPDATE wallet_warmup_execution_geneses SET version=version')
      .run(),
  ).toThrow();
  expect(() =>
    f.sqlite.prepare('DELETE FROM wallet_warmup_execution_geneses').run(),
  ).toThrow();
  expect(await read(f.db, f.owner, f.input.proposalId, signal())).toEqual(
    saved,
  );
  expect(f.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
it.each(['version', 'recorded-clock', 'root', 'missing-parent'] as const)(
  'actual SQL admission rejects %s without an initial head',
  async (kind) => {
    const f = await fixture(),
      row = await raw(f);
    if (kind === 'version') row.version = 1;
    if (kind === 'recorded-clock')
      row.recorded_at = new Date(Date.parse(f.sqlClock()) + 1).toISOString();
    if (kind === 'root') row.root_sha256 = 'f'.repeat(64);
    if (kind === 'missing-parent') row.proposal_id = crypto.randomUUID();
    expect(() => insert(f, row)).toThrow();
    expect(count(f)).toBe(0);
    expect(f.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  },
);
it('retains the exact immutable lease foreign key and original schema dependencies', async () => {
  const f = await fixture();
  const foreign = f.sqlite
    .prepare('PRAGMA foreign_key_list(wallet_warmup_execution_geneses)')
    .all();
  expect(foreign).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        table: 'wallet_warmup_execution_wallet_leases',
        from: 'owner_id',
        to: 'owner_id',
      }),
      expect.objectContaining({
        table: 'wallet_warmup_execution_wallet_leases',
        from: 'proposal_id',
        to: 'proposal_id',
      }),
    ]),
  );
  expect(f.sqlite.prepare('PRAGMA foreign_keys').get()!.foreign_keys).toBe(1);
});
it('recovers the original committed ID after one lost INSERT response without retrying the write', async () => {
  const f = await fixture(),
    before = f.statements.length;
  let lost = false;
  f.setAfter((sql, op) => {
    if (
      op === 'run' &&
      sql.startsWith('INSERT INTO wallet_warmup_execution_geneses')
    ) {
      f.setAfter();
      lost = true;
      throw Error('Synthetic committed reply lost');
    }
  });
  const saved = await save(f);
  expect(lost).toBe(true);
  expect(saved.proposalId).toBe(f.input.proposalId);
  expect(count(f)).toBe(1);
  expect(
    f.statements
      .slice(before)
      .filter((s) =>
        s.startsWith('INSERT INTO wallet_warmup_execution_geneses'),
      ),
  ).toHaveLength(1);
  expect(await read(f.db, f.owner, f.input.proposalId, signal())).toEqual(
    saved,
  );
});
it('preserves a committed original ID on cancellation and permits saved-only recovery', async () => {
  const f = await fixture(),
    controller = new AbortController();
  f.setAfter((sql, op) => {
    if (
      op === 'run' &&
      sql.startsWith('INSERT INTO wallet_warmup_execution_geneses')
    ) {
      f.setAfter();
      controller.abort();
    }
  });
  await expect(save(f, f.input, controller.signal)).rejects.toThrow();
  expect(count(f)).toBe(1);
  const saved = await read(f.db, f.owner, f.input.proposalId, signal());
  expect(saved).toMatchObject({ ...f.input, ...flags });
  expect(await save(f)).toEqual(saved);
});
it.each(['foreign-keys-disabled', 'missing-genesis-guard'] as const)(
  'refuses %s before attempting a metadata write',
  async (kind) => {
    const f = await fixture();
    if (kind === 'foreign-keys-disabled')
      f.sqlite.exec('PRAGMA foreign_keys=OFF');
    else f.sqlite.exec('DROP TRIGGER warmup_execution_genesis_no_delete');
    // Deliberate disposable schema/connection corruption tests fail-closed
    // admission; no financial overlap or authority is manufactured this way.
    const before = f.statements.length,
      calls = f.providerCalls();
    await expect(save(f)).rejects.toThrow();
    expect(f.statements.slice(before).some((s) => s.startsWith('INSERT'))).toBe(
      false,
    );
    expect(count(f)).toBe(0);
    expect(f.providerCalls()).toBe(calls);
  },
);

it('an already aborted request performs no SQL or provider work', async () => {
  const f = await fixture(),
    controller = new AbortController(),
    before = f.statements.length,
    calls = f.providerCalls();
  controller.abort();
  await expect(save(f, f.input, controller.signal)).rejects.toThrow();
  expect(f.statements.length).toBe(before);
  expect(f.providerCalls()).toBe(calls);
  expect(count(f)).toBe(0);
});
