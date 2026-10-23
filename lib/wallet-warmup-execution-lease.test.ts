import { afterEach, expect, it, vi } from 'vitest';
import { warmupExecutionLeaseFixture } from '../test/warmup-execution-lease-fixture';
import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { Miniflare } from 'miniflare';
import { createTursoDatabase } from '../db/turso';
import { retainWarmupExecutionProposal } from './wallet-warmup-execution-proposal-storage';
import {
  retainWarmupExecutionApproval,
  readWarmupExecutionApproval,
} from './wallet-warmup-execution-approval';
import { loadWalletWarmupProgress } from './wallet-warmup-progress-server';
import { reviewWalletWarmupSession } from './wallet-warmup-session-review';
import { retainWalletWarmupSessionReview } from './wallet-warmup-session-storage';
import { walletWarmupSessionDigest } from './wallet-warmup-session-digest';
import {
  retainWarmupExecutionWalletLease as retain,
  readWarmupExecutionWalletLease as read,
} from './wallet-warmup-execution-lease';

type Fixture = Awaited<ReturnType<typeof warmupExecutionLeaseFixture>>;
const fixtures: Fixture[] = [];
const signal = () => new AbortController().signal;
async function fixture() {
  const f = await warmupExecutionLeaseFixture();
  fixtures.push(f);
  return f;
}
afterEach(() => {
  for (const f of fixtures.splice(0).reverse()) f.dispose();
  vi.restoreAllMocks();
});
const save = (f: Fixture, value: unknown = f.input, s = signal()) =>
  retain(f.db, f.owner, value, s);
function held(f: Fixture) {
  return f.sqlite
    .prepare(
      'SELECT * FROM wallet_warmup_execution_held_wallets WHERE owner_id=? ORDER BY wallet_address',
    )
    .all(f.owner);
}
function leaseCount(f: Fixture) {
  return Number(
    f.sqlite
      .prepare(
        'SELECT count(*) AS n FROM wallet_warmup_execution_wallet_leases',
      )
      .get()!.n,
  );
}
it('binds a genuine retained proposal and root to the whole original roster with actual SQL creation time and no authority', async () => {
  const f = await fixture(),
    calls = f.providerCalls();
  expect(await read(f.db, f.owner, f.input.proposalId, signal())).toBeNull();
  const saved = await save(f);
  expect(saved).toEqual({
    format: 'wallet-warmup-execution-wallet-lease-v1',
    ...f.input,
    rootCreatedAt: f.approval.rootCreatedAt,
    createdAt: f.sqlClock(),
    wallets: f.source.retainedReview.document.wallets.map((w) => ({
      wallet: w.wallet,
      walletRevision: w.walletRevision,
    })),
    scope: 'durable-wallet-exclusion-only',
    walletHoldRecorded: true,
    humanApprovalVerified: false,
    currentSourceVerified: false,
    signingAllowed: false,
    executionAllowed: false,
    automaticExecutionAllowed: false,
  });
  expect(held(f).length).toBe(saved.wallets.length);
  expect(leaseCount(f)).toBe(1);
  expect(f.providerCalls()).toBe(calls);
  expect(await f.readApproval()).toEqual(f.approval);
});
it('atomically derives all twenty original wallets from a genuine maximum retained root without a client roster', async () => {
  const f = await warmupExecutionLeaseFixture(true);
  fixtures.push(f);
  const calls = f.providerCalls();
  const blockedWallet = f.source.retainedReview.document.wallets[10].wallet;
  await f.db
    .prepare(`INSERT INTO native_withdrawals(id,owner_id,wallet_address,wallet_revision,document,state,created_at,updated_at)
    VALUES('synthetic-blocker',?,?,1,'{}','awaiting_signature',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
    .bind(f.owner, blockedWallet)
    .run();
  await expect(save(f)).rejects.toThrow();
  expect(
    await f.db
      .prepare(
        'SELECT count(*) AS n FROM wallet_warmup_execution_held_wallets WHERE owner_id=?',
      )
      .bind(f.owner)
      .first(),
  ).toMatchObject({ n: 0 });
  expect(
    await f.db
      .prepare(
        'SELECT count(*) AS n FROM wallet_warmup_execution_wallet_leases WHERE owner_id=?',
      )
      .bind(f.owner)
      .first(),
  ).toMatchObject({ n: 0 });
  // Cancel the actual unsigned synthetic withdrawal through its normal SQL transition.
  await f.db
    .prepare(
      "UPDATE native_withdrawals SET state='cancelled',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='synthetic-blocker'",
    )
    .run();
  const saved = await save(f);
  expect(saved.wallets.length).toBe(20);
  expect(saved.wallets).toEqual(
    f.source.retainedReview.document.wallets
      .map((w) => ({ wallet: w.wallet, walletRevision: w.walletRevision }))
      .sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0)),
  );
  const rows = await f.db
    .prepare(
      'SELECT wallet_address,wallet_revision FROM wallet_warmup_execution_held_wallets WHERE owner_id=? ORDER BY wallet_address',
    )
    .bind(f.owner)
    .all<{ wallet_address: string; wallet_revision: number }>();
  expect(
    rows.results.map((r) => ({
      wallet: r.wallet_address,
      walletRevision: r.wallet_revision,
    })),
  ).toEqual(saved.wallets);
  expect(f.providerCalls()).toBe(calls);
  expect(await f.readApproval()).toEqual(f.approval);
});
it.each(['rootSha256', 'manifestSha256'] as const)(
  'refuses a different %s and leaves no partial lease or held roster',
  async (key) => {
    const f = await fixture();
    await expect(
      save(f, { ...f.input, [key]: 'a'.repeat(64) }),
    ).rejects.toThrow();
    expect(leaseCount(f)).toBe(0);
    expect(held(f)).toEqual([]);
  },
);
it.each(['wallets', 'createdAt', 'ownerId', 'approved'] as const)(
  'rejects caller supplied %s before storage instead of trusting client metadata',
  async (key) => {
    const f = await fixture(),
      before = f.statements.length;
    await expect(
      save(f, { ...f.input, [key]: key === 'wallets' ? [] : 'untrusted' }),
    ).rejects.toThrow();
    expect(leaseCount(f)).toBe(0);
    expect(held(f)).toEqual([]);
    expect(f.statements.slice(before).some((s) => s.startsWith('INSERT'))).toBe(
      false,
    );
  },
);
it('keeps another owner from reading or activating the original root', async () => {
  const f = await fixture();
  expect(await read(f.db, 'other', f.input.proposalId, signal())).toBeNull();
  await expect(retain(f.db, 'other', f.input, signal())).rejects.toThrow();
  expect(leaseCount(f)).toBe(0);
});
it('recovers the exact original lease and approval after expiry and wallet/plan archival with no provider or renewal', async () => {
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
  expect(await save(f)).toEqual(saved);
  expect(await read(f.db, f.owner, f.input.proposalId, signal())).toEqual(
    saved,
  );
  expect(await f.readApproval()).toEqual(f.approval);
  expect(f.providerCalls()).toBe(calls);
  expect(
    f.statements
      .slice(before)
      .some((sql) => /^(INSERT|UPDATE|DELETE)/.test(sql)),
  ).toBe(false);
  expect(held(f).length).toBe(saved.wallets.length);
  expect(leaseCount(f)).toBe(1);
});
it('recovers one exact committed lease after its INSERT reply is lost', async () => {
  const f = await fixture();
  let lost = false;
  f.setAfter((sql, op) => {
    if (
      op === 'run' &&
      sql.startsWith('INSERT INTO wallet_warmup_execution_wallet_leases')
    ) {
      f.setAfter();
      lost = true;
      throw Error('Synthetic committed reply lost');
    }
  });
  const saved = await save(f);
  expect(lost).toBe(true);
  expect(leaseCount(f)).toBe(1);
  expect(await read(f.db, f.owner, f.input.proposalId, signal())).toEqual(
    saved,
  );
  expect(await save(f)).toEqual(saved);
});
it('preserves a committed original ID on cancellation without pretending the write was rolled back', async () => {
  const f = await fixture(),
    controller = new AbortController();
  f.setAfter((sql, op) => {
    if (
      op === 'run' &&
      sql.startsWith('INSERT INTO wallet_warmup_execution_wallet_leases')
    ) {
      f.setAfter();
      controller.abort();
    }
  });
  await expect(save(f, f.input, controller.signal)).rejects.toThrow();
  expect(leaseCount(f)).toBe(1);
  const saved = await read(f.db, f.owner, f.input.proposalId, signal());
  expect(saved?.proposalId).toBe(f.input.proposalId);
  expect(await save(f)).toEqual(saved);
});
it('coalesces concurrent exact requests while rejecting a conflicting digest without changing the original row', async () => {
  const f = await fixture(),
    [one, two] = await Promise.all([save(f), save(f)]);
  expect(one).toEqual(two);
  expect(leaseCount(f)).toBe(1);
  await expect(
    save(f, { ...f.input, rootSha256: 'b'.repeat(64) }),
  ).rejects.toThrow();
  expect(await read(f.db, f.owner, f.input.proposalId, signal())).toEqual(one);
});
it('refuses a second genuinely reconstructed overlapping root without relying on a same-ID constraint or leaving partial holds', async () => {
  const f = await fixture();
  // An exact document clone is intentionally not used: the original review
  // digest is owner-unique. Produce a fresh review through the real lifecycle.
  f.actual!.advance(1);
  f.advance(1);
  const at = f.clock(),
    loaded = await loadWalletWarmupProgress(
      f.actual!.db,
      f.owner,
      f.source.retainedReview.planId,
      1,
      false,
      true,
    );
  const reviewed = reviewWalletWarmupSession(
    loaded.plan,
    loaded.progress,
    loaded.performance,
    at,
  );
  const kept = await retainWalletWarmupSessionReview(
    f.actual!.db,
    f.owner,
    {
      id: crypto.randomUUID(),
      planId: f.source.retainedReview.planId,
      revision: 1,
      reviewedAt: new Date(at).toISOString(),
      reviewSha256: await walletWarmupSessionDigest(reviewed.contextKey),
    },
    true,
    signal(),
    () => at,
  );
  expect(kept.id).not.toBe(f.source.retainedReview.id);
  expect(kept.reviewSha256).not.toBe(f.source.retainedReview.reviewSha256);
  const proposed = await retainWarmupExecutionProposal(
    f.db,
    f.owner,
    {
      ...f.proposalRequest,
      reviewId: kept.id,
      reviewSha256: kept.reviewSha256,
      rootId: crypto.randomUUID(),
      consentId: crypto.randomUUID(),
      sessionExpiresAt: new Date(
        Date.parse(reviewed.actions.at(-1)!.scheduledAt) + 300000,
      ).toISOString(),
      feeRentLimits: reviewed.actions.map((action) => ({
        actionId: action.id,
        maximumLamports: '5000000',
      })),
    },
    signal(),
  );
  if (!proposed || proposed.status !== 'published')
    throw Error('Missing genuine second proposal');
  const approved = await retainWarmupExecutionApproval(
    f.db,
    f.owner,
    {
      ...f.approvalRequest,
      proposalId: proposed.id,
      headerSha256: proposed.headerSha256,
      termsSha256: proposed.proposal.termsSha256,
    },
    signal(),
  );
  if (!approved.rootSha256 || !approved.manifestSha256)
    throw Error('Missing genuine second root');
  expect(approved.proposalId).not.toBe(f.input.proposalId);
  expect(approved.rootSha256).not.toBe(f.input.rootSha256);
  const first = await save(f),
    before = held(f),
    calls = f.providerCalls();
  const second = {
    proposalId: approved.proposalId,
    rootSha256: approved.rootSha256,
    manifestSha256: approved.manifestSha256,
  };
  await expect(retain(f.db, f.owner, second, signal())).rejects.toThrow();
  expect(leaseCount(f)).toBe(1);
  expect(held(f)).toEqual(before);
  expect(await read(f.db, f.owner, second.proposalId, signal())).toBeNull();
  expect(await read(f.db, f.owner, first.proposalId, signal())).toEqual(first);
  expect(
    await readWarmupExecutionApproval(
      f.db,
      f.owner,
      approved.proposalId,
      signal(),
    ),
  ).toEqual(approved);
  expect(f.providerCalls()).toBe(calls);
});
it('repeats the current wallet/source guard in actual lease INSERT after a preflight race', async () => {
  const f = await fixture();
  let changed = false;
  f.setBefore((sql, op) => {
    if (
      op === 'run' &&
      sql.startsWith('INSERT INTO wallet_warmup_execution_wallet_leases')
    ) {
      f.setBefore();
      changed = true;
      f.sqlite
        .prepare(
          'UPDATE workspace_wallets SET revision=revision+1 WHERE owner_id=?',
        )
        .run(f.owner);
    }
  });
  await expect(save(f)).rejects.toThrow();
  expect(changed).toBe(true);
  expect(leaseCount(f)).toBe(0);
  expect(held(f)).toEqual([]);
  expect(await f.readApproval()).toEqual(f.approval);
});
it.each(['asset', 'pacing', 'session', 'review'] as const)(
  'refuses fresh activation at the original exclusive %s deadline without altering historical root',
  async (bound) => {
    const f = await fixture();
    const at =
      bound === 'asset'
        ? f.proposal.proposalExpiresAt
        : bound === 'pacing'
          ? f.approval.pacingBefore
          : bound === 'session'
            ? f.approval.approval.sessionExpiresAt
            : f.source.retainedReview.reviewExpiresAt;
    f.advance(Math.max(0, Date.parse(at) - Date.parse(f.sqlClock())));
    await expect(save(f)).rejects.toThrow();
    expect(leaseCount(f)).toBe(0);
    expect(held(f)).toEqual([]);
    expect(await f.readApproval()).toEqual(f.approval);
  },
);
it('refuses INSERT OR REPLACE, UPDATE and DELETE on the actual committed lease', async () => {
  const f = await fixture(),
    saved = await save(f),
    row = f.rawLease(),
    columns = Object.keys(row);
  expect(() =>
    f.sqlite
      .prepare(
        `INSERT OR REPLACE INTO wallet_warmup_execution_wallet_leases(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
      )
      .run(...Object.values(row)),
  ).toThrow();
  expect(() =>
    f.sqlite
      .prepare('UPDATE wallet_warmup_execution_wallet_leases SET created_at=?')
      .run(f.sqlClock()),
  ).toThrow();
  expect(() =>
    f.sqlite.exec('DELETE FROM wallet_warmup_execution_wallet_leases'),
  ).toThrow();
  expect(await read(f.db, f.owner, f.input.proposalId, signal())).toEqual(
    saved,
  );
});
it('fails closed on a missing derived held-wallet view before writing', async () => {
  const f = await fixture();
  f.sqlite.exec('DROP VIEW wallet_warmup_execution_held_wallets');
  await expect(save(f)).rejects.toThrow();
  expect(leaseCount(f)).toBe(0);
});
it('does not start SQL or provider work for an already cancelled activation', async () => {
  const f = await fixture(),
    controller = new AbortController(),
    before = f.statements.length,
    calls = f.providerCalls();
  controller.abort();
  await expect(save(f, f.input, controller.signal)).rejects.toThrow();
  expect(f.statements.length).toBe(before);
  expect(f.providerCalls()).toBe(calls);
  expect(leaseCount(f)).toBe(0);
});
it.each(['turso', 'd1'] as const)(
  'composes genuine retained proposal, approval and lease on disposable %s with its actual SQL clock',
  async (platform) => {
    const client =
      platform === 'turso' ? createClient({ url: 'file::memory:' }) : null;
    const mf =
      platform === 'd1'
        ? new Miniflare({
            telemetry: { enabled: false },
            workers: [
              {
                config: {
                  name: 'warmup-lease-local',
                  type: 'worker',
                  compatibilityDate: '2026-09-01',
                  manifest: {
                    mainModule: 'index.js',
                    modules: {
                      'index.js': {
                        type: 'esm',
                        contents:
                          'export default {fetch(){return new Response("disposable test only")}}',
                      },
                    },
                  },
                  env: { DB: { type: 'd1', id: 'warmup-lease-local' } },
                },
              },
            ],
          })
        : null;
    try {
      const db = client
        ? createTursoDatabase(client)
        : ((await mf!.getD1Database('DB')) as unknown as D1Database);
      const journal = JSON.parse(
        readFileSync('drizzle/meta/_journal.json', 'utf8'),
      ) as { entries: { tag: string }[] };
      for (const { tag } of journal.entries)
        await db.batch(
          readFileSync(`drizzle/${tag}.sql`, 'utf8')
            .split('--> statement-breakpoint')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => db.prepare(s)),
        );
      const f = await fixture();
      for (const table of [
        'workspace_wallets',
        'wallet_warmup_plans',
        'wallet_warmup_session_reviews',
      ])
        for (const row of f.sqlite
          .prepare(`SELECT * FROM ${table} WHERE owner_id=?`)
          .all(f.owner)) {
          const keys = Object.keys(row);
          await db
            .prepare(
              `INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`,
            )
            .bind(...keys.map((k) => row[k]))
            .run();
        }
      const proposal = await retainWarmupExecutionProposal(
        db,
        f.owner,
        f.proposalRequest,
        signal(),
      );
      if (!proposal || proposal.status !== 'published')
        throw Error('Missing real adapter proposal');
      const approval = await retainWarmupExecutionApproval(
        db,
        f.owner,
        {
          ...f.approvalRequest,
          headerSha256: proposal.headerSha256,
          termsSha256: proposal.proposal.termsSha256,
        },
        signal(),
      );
      if (!approval.rootSha256 || !approval.manifestSha256)
        throw Error('Missing real adapter root');
      const input = {
        proposalId: proposal.id,
        rootSha256: approval.rootSha256,
        manifestSha256: approval.manifestSha256,
      };
      const calls = f.providerCalls(),
        before = Date.now(),
        saved = await retain(db, f.owner, input, signal()),
        after = Date.now();
      expect(Date.parse(saved.createdAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(saved.createdAt)).toBeLessThanOrEqual(after);
      expect(await read(db, f.owner, proposal.id, signal())).toEqual(saved);
      expect(await retain(db, f.owner, input, signal())).toEqual(saved);
      expect(
        await readWarmupExecutionApproval(db, f.owner, proposal.id, signal()),
      ).toEqual(approval);
      expect(f.providerCalls()).toBe(calls);
      expect(saved.wallets.length).toBe(1);
      expect(saved.signingAllowed).toBe(false);
      expect(
        (await db.prepare('PRAGMA foreign_key_check').all()).results,
      ).toHaveLength(0);
    } finally {
      client?.close();
      await mf?.dispose();
    }
  },
);
