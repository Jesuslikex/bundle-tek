import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createClient } from '@libsql/client';
import { Miniflare } from 'miniflare';
import { createTursoDatabase } from '../db/turso';
import { warmupExecutionLeaseFixture } from './warmup-execution-lease-fixture';
import { retainWarmupExecutionProposal } from '../lib/wallet-warmup-execution-proposal-storage';
import { retainWarmupExecutionApproval } from '../lib/wallet-warmup-execution-approval';
import {
  retainWarmupExecutionWalletLease,
  readWarmupExecutionWalletLease,
} from '../lib/wallet-warmup-execution-lease';
import { retainWarmupExecutionGenesis } from '../lib/wallet-warmup-execution-genesis';
import {
  retainWarmupExecutionControl,
  readWarmupExecutionControls,
  readWarmupExecutionControlRequest,
} from '../lib/wallet-warmup-execution-control-storage';
import { canonicalPumpHolderJson as canonical } from '../lib/pump-holder-review';

const signal = () => new AbortController().signal;
async function count(db: D1Database, table: string) {
  return (await db
    .prepare(`SELECT count(*) AS n FROM ${table}`)
    .first<{ n: number }>())!.n;
}
async function sqlNow(db: D1Database) {
  return Date.parse(
    (await db
      .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now")
      .first<{ now: string }>())!.now,
  );
}
async function exercise(
  db: D1Database,
  owner: string,
  input: { proposalId: string; rootSha256: string; manifestSha256: string },
) {
  expect(
    await readWarmupExecutionControls(db, owner, input.proposalId, signal()),
  ).toBeNull();
  await expect(
    retainWarmupExecutionControl(
      db,
      owner,
      {
        id: randomUUID(),
        ...input,
        expectedVersion: 0,
        expectedEventSha256: 'a'.repeat(64),
        expectedCheckpointSha256: 'b'.repeat(64),
        operation: 'pause',
      },
      signal(),
    ),
  ).rejects.toThrow();
  expect(await count(db, 'wallet_warmup_execution_geneses')).toBe(0);
  await retainWarmupExecutionGenesis(db, owner, input, signal());
  let history = await readWarmupExecutionControls(
    db,
    owner,
    input.proposalId,
    signal(),
  );
  if (!history) throw Error('Missing actual genesis control history');
  expect(history.head.version).toBe(0);
  await db
    .prepare(
      "CREATE TRIGGER synthetic_control_head_refusal BEFORE UPDATE ON wallet_warmup_execution_control_heads BEGIN SELECT RAISE(ABORT,'synthetic head rejection'); END",
    )
    .run();
  try {
    const refused = await retainWarmupExecutionControl(
      db,
      owner,
      {
        id: randomUUID(),
        ...input,
        expectedVersion: history.head.version,
        expectedEventSha256: history.head.eventSha256,
        expectedCheckpointSha256: history.head.checkpointSha256,
        operation: 'pause',
      },
      signal(),
    );
    expect(refused.request.status).toBe('intent-recorded');
    expect(refused.history.head).toEqual(history.head);
    expect(refused.history.headRecorded).toBe(true);
    expect(await count(db, 'wallet_warmup_execution_control_events')).toBe(0);
    expect(
      (await db
        .prepare('SELECT version FROM wallet_warmup_execution_control_heads')
        .first<{ version: number }>())!.version,
    ).toBe(0);
    expect(
      (await readWarmupExecutionControls(
        db,
        owner,
        input.proposalId,
        signal(),
      ))!.head,
    ).toEqual(history.head);
  } finally {
    await db.prepare('DROP TRIGGER synthetic_control_head_refusal').run();
  }
  const lease = await readWarmupExecutionWalletLease(
    db,
    owner,
    input.proposalId,
    signal(),
  );
  for (const operation of ['pause', 'resume', 'stop'] as const) {
    const value = {
      id: randomUUID(),
      ...input,
      expectedVersion: history.head.version,
      expectedEventSha256: history.head.eventSha256,
      expectedCheckpointSha256: history.head.checkpointSha256,
      operation,
    };
    const before = await sqlNow(db);
    const saved = await retainWarmupExecutionControl(
      db,
      owner,
      value,
      signal(),
    );
    const after = await sqlNow(db);
    history = saved.history;
    expect(history).toMatchObject({
      scope: 'durable-control-history-only',
      headRecorded: true,
      workerControlApplied: false,
      leaseReleased: false,
      runStarted: false,
      currentHeadVerified: false,
      currentSourceVerified: false,
      receiptEvidenceVerified: false,
      financialReservationVerified: false,
      signingAllowed: false,
      executionAllowed: false,
      automaticExecutionAllowed: false,
    });
    expect(history.head.version).toBe(value.expectedVersion + 1);
    const row = await db
      .prepare(
        'SELECT * FROM wallet_warmup_execution_control_events WHERE owner_id=? AND id=?',
      )
      .bind(owner, value.id)
      .first<{
        wire: string;
        model_at: string;
        recorded_at: string;
        sequence: number;
        event_sha256: string;
        checkpoint_sha256: string;
      }>();
    expect(row).not.toBeNull();
    expect(canonical(JSON.parse(row!.wire))).toBe(row!.wire);
    expect(JSON.parse(row!.wire).event).toMatchObject({
      operation,
      now: Date.parse(row!.model_at),
      expectedVersion: value.expectedVersion,
    });
    expect(Date.parse(row!.model_at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(row!.model_at)).toBeLessThanOrEqual(after);
    expect(Date.parse(row!.recorded_at)).toBeGreaterThanOrEqual(
      Date.parse(row!.model_at),
    );
    expect(Date.parse(row!.recorded_at)).toBeLessThanOrEqual(after);
    const intent = await db
      .prepare(
        'SELECT model_at FROM wallet_warmup_execution_control_intents WHERE owner_id=? AND id=?',
      )
      .bind(owner, value.id)
      .first<{ model_at: string }>();
    expect(intent!.model_at).toBe(row!.model_at);
    expect(history.head).toMatchObject({
      version: row!.sequence,
      eventSha256: row!.event_sha256,
      checkpointSha256: row!.checkpoint_sha256,
    });
    expect(
      await readWarmupExecutionControls(db, owner, input.proposalId, signal()),
    ).toEqual(history);
    const eventCount = await count(
      db,
      'wallet_warmup_execution_control_events',
    );
    const intentCount = await count(
      db,
      'wallet_warmup_execution_control_intents',
    );
    expect(
      await retainWarmupExecutionControl(db, owner, value, signal()),
    ).toEqual(saved);
    expect(
      await readWarmupExecutionControlRequest(db, owner, value.id, signal()),
    ).toEqual(saved.request);
    expect(await count(db, 'wallet_warmup_execution_control_events')).toBe(
      eventCount,
    );
    expect(await count(db, 'wallet_warmup_execution_control_intents')).toBe(
      intentCount,
    );
    expect(
      await readWarmupExecutionControlRequest(db, 'other', value.id, signal()),
    ).toBeNull();
  }
  expect(await count(db, 'wallet_warmup_execution_control_events')).toBe(3);
  expect(await count(db, 'wallet_warmup_execution_control_heads')).toBe(1);
  expect(
    await readWarmupExecutionControls(db, 'other', input.proposalId, signal()),
  ).toBeNull();
  expect(
    await readWarmupExecutionWalletLease(db, owner, input.proposalId, signal()),
  ).toEqual(lease);
  await expect(
    db
      .prepare('UPDATE wallet_warmup_execution_control_events SET wire=wire')
      .run(),
  ).rejects.toThrow();
  await expect(
    db.prepare('DELETE FROM wallet_warmup_execution_control_events').run(),
  ).rejects.toThrow();
  await expect(
    db.prepare('DELETE FROM wallet_warmup_execution_control_heads').run(),
  ).rejects.toThrow();
  expect(
    (await db.prepare('PRAGMA foreign_key_check').all()).results,
  ).toHaveLength(0);
}

/** Real local adapters and synthetic owned source. These controls neither run
 * workers nor release the original immutable whole-wallet exclusion. */
it.each(['turso', 'd1'] as const)(
  'retains and recovers real source-bound controls on disposable %s',
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
                  name: 'warmup-controls-local',
                  type: 'worker',
                  compatibilityDate: '2026-09-01',
                  manifest: {
                    mainModule: 'index.js',
                    modules: {
                      'index.js': {
                        type: 'esm',
                        contents:
                          'export default {fetch(){return new Response("local controls only")}}',
                      },
                    },
                  },
                  env: { DB: { type: 'd1', id: 'warmup-controls-local' } },
                },
              },
            ],
          })
        : null;
    let f: Awaited<ReturnType<typeof warmupExecutionLeaseFixture>> | undefined;
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
      f = await warmupExecutionLeaseFixture();
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
        throw Error('Missing actual proposal');
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
        throw Error('Missing actual root');
      const input = {
        proposalId: proposal.id,
        rootSha256: approval.rootSha256,
        manifestSha256: approval.manifestSha256,
      };
      await retainWarmupExecutionWalletLease(db, f.owner, input, signal());
      const calls = f.providerCalls();
      await exercise(db, f.owner, input);
      expect(f.providerCalls()).toBe(calls);
    } finally {
      f?.dispose();
      client?.close();
      await mf?.dispose();
    }
  },
  // Full immutable source replay on local workerd is intentionally exercised.
  // This extends the test harness deadline only, never the approved session.
  600_000,
);

it('retains controls for the complete native twenty-wallet lease without releasing any wallet', async () => {
  const f = await warmupExecutionLeaseFixture(true);
  try {
    const lease = await retainWarmupExecutionWalletLease(
      f.db,
      f.owner,
      f.input,
      signal(),
    );
    expect(lease.wallets).toHaveLength(20);
    const calls = f.providerCalls();
    await exercise(f.db, f.owner, f.input);
    expect(
      (await readWarmupExecutionWalletLease(
        f.db,
        f.owner,
        f.input.proposalId,
        signal(),
      ))!.wallets,
    ).toHaveLength(20);
    expect(f.providerCalls()).toBe(calls);
  } finally {
    f.dispose();
  }
}, 600_000);
