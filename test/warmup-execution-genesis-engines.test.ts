import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { Miniflare } from 'miniflare';
import { createTursoDatabase } from '../db/turso';
import { warmupExecutionLeaseFixture } from './warmup-execution-lease-fixture';
import { retainWarmupExecutionProposal } from '../lib/wallet-warmup-execution-proposal-storage';
import {
  retainWarmupExecutionApproval,
  readWarmupExecutionApproval,
} from '../lib/wallet-warmup-execution-approval';
import {
  retainWarmupExecutionWalletLease,
  readWarmupExecutionWalletLease,
} from '../lib/wallet-warmup-execution-lease';
import {
  retainWarmupExecutionGenesis,
  readWarmupExecutionGenesis,
} from '../lib/wallet-warmup-execution-genesis';

const signal = () => new AbortController().signal;
type GenesisRow = {
  owner_id: string;
  proposal_id: string;
  root_sha256: string;
  manifest_sha256: string;
  lease_created_at: string;
  version: number;
  event_sha256: string;
  checkpoint_sha256: string;
  recorded_at: string;
};
async function genesisRow(db: D1Database, owner: string, id: string) {
  return db
    .prepare(
      'SELECT owner_id,proposal_id,root_sha256,manifest_sha256,lease_created_at,version,event_sha256,checkpoint_sha256,recorded_at FROM wallet_warmup_execution_geneses WHERE owner_id=? AND proposal_id=?',
    )
    .bind(owner, id)
    .first<GenesisRow>();
}

/** Local adapters and synthetic owned evidence only. A recorded version zero
 * is not a dispatched action, a resumable runtime head or signing authority. */
it.each(['turso', 'd1'] as const)(
  'retains a genuine root-bound version-zero genesis on disposable %s using its real SQL timestamp',
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
                  name: 'warmup-genesis-local',
                  type: 'worker',
                  compatibilityDate: '2026-09-01',
                  manifest: {
                    mainModule: 'index.js',
                    modules: {
                      'index.js': {
                        type: 'esm',
                        contents:
                          'export default {fetch(){return new Response("local genesis fixture only")}}',
                      },
                    },
                  },
                  env: { DB: { type: 'd1', id: 'warmup-genesis-local' } },
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
      const lease = await retainWarmupExecutionWalletLease(
          db,
          f.owner,
          input,
          signal(),
        ),
        calls = f.providerCalls();
      expect(
        await readWarmupExecutionGenesis(db, f.owner, proposal.id, signal()),
      ).toBeNull();
      const before = Date.now(),
        saved = await retainWarmupExecutionGenesis(
          db,
          f.owner,
          input,
          signal(),
        ),
        after = Date.now();
      const row = await genesisRow(db, f.owner, proposal.id);
      expect(saved).toMatchObject({
        scope: 'durable-initial-audit-only',
        recordedEvents: 0,
        runStarted: false,
        currentHeadVerified: false,
        receiptEvidenceVerified: false,
        currentSourceVerified: false,
        financialReservationVerified: false,
        signingAllowed: false,
        executionAllowed: false,
        automaticExecutionAllowed: false,
      });
      expect(row).toMatchObject({
        owner_id: f.owner,
        proposal_id: proposal.id,
        root_sha256: approval.rootSha256,
        manifest_sha256: approval.manifestSha256,
        lease_created_at: lease.createdAt,
        version: 0,
      });
      expect(row!.event_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(row!.checkpoint_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(saved.head).toMatchObject({
        version: 0,
        eventSha256: row!.event_sha256,
        checkpointSha256: row!.checkpoint_sha256,
        createdAt: lease.createdAt,
      });
      expect(Date.parse(row!.recorded_at)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(row!.recorded_at)).toBeLessThanOrEqual(after);
      expect(
        await readWarmupExecutionGenesis(db, f.owner, proposal.id, signal()),
      ).toEqual(saved);
      expect(
        await retainWarmupExecutionGenesis(db, f.owner, input, signal()),
      ).toEqual(saved);
      expect(
        await readWarmupExecutionGenesis(db, 'other', proposal.id, signal()),
      ).toBeNull();
      expect(
        await readWarmupExecutionWalletLease(
          db,
          f.owner,
          proposal.id,
          signal(),
        ),
      ).toEqual(lease);
      expect(
        await readWarmupExecutionApproval(db, f.owner, proposal.id, signal()),
      ).toEqual(approval);
      expect(await genesisRow(db, f.owner, proposal.id)).toEqual(row);
      expect(f.providerCalls()).toBe(calls);
      expect(
        (await db
          .prepare('SELECT count(*) AS n FROM wallet_warmup_execution_geneses')
          .first<{ n: number }>())!.n,
      ).toBe(1);
      await expect(
        db
          .prepare(
            'UPDATE wallet_warmup_execution_geneses SET recorded_at=recorded_at',
          )
          .run(),
      ).rejects.toThrow();
      await expect(
        db.prepare('DELETE FROM wallet_warmup_execution_geneses').run(),
      ).rejects.toThrow();
      expect(
        (await db.prepare('PRAGMA foreign_key_check').all()).results,
      ).toHaveLength(0);
    } finally {
      f?.dispose();
      client?.close();
      await mf?.dispose();
    }
  },
);

it('retains version zero for the complete genuine twenty-wallet native lease without creating action or signing authority', async () => {
  const f = await warmupExecutionLeaseFixture(true);
  try {
    const lease = await retainWarmupExecutionWalletLease(
        f.db,
        f.owner,
        f.input,
        signal(),
      ),
      calls = f.providerCalls();
    expect(lease.wallets).toHaveLength(20);
    const saved = await retainWarmupExecutionGenesis(
      f.db,
      f.owner,
      f.input,
      signal(),
    );
    expect(saved).toMatchObject({
      recordedEvents: 0,
      runStarted: false,
      currentHeadVerified: false,
      financialReservationVerified: false,
      signingAllowed: false,
      executionAllowed: false,
      automaticExecutionAllowed: false,
    });
    const row = await genesisRow(f.db, f.owner, f.input.proposalId);
    expect(row).toMatchObject({
      version: 0,
      lease_created_at: lease.createdAt,
      root_sha256: f.input.rootSha256,
      manifest_sha256: f.input.manifestSha256,
    });
    expect(
      await readWarmupExecutionGenesis(
        f.db,
        f.owner,
        f.input.proposalId,
        signal(),
      ),
    ).toEqual(saved);
    expect(
      await readWarmupExecutionWalletLease(
        f.db,
        f.owner,
        f.input.proposalId,
        signal(),
      ),
    ).toEqual(lease);
    expect(f.providerCalls()).toBe(calls);
  } finally {
    f.dispose();
  }
});
