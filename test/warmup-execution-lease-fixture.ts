import { vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { env } from '../lib/server-env';
import { warmupReconstructionFixture } from './warmup-reconstruction-fixture';
import { advanceFamilyExclusionClock } from './solana-family-exclusion-fixture';
import {
  retainWarmupExecutionProposal,
  readWarmupExecutionProposal,
} from '../lib/wallet-warmup-execution-proposal-storage';
import {
  retainWarmupExecutionApproval,
  readWarmupExecutionApproval,
} from '../lib/wallet-warmup-execution-approval';
import { WARMUP_EXECUTION_ACKNOWLEDGEMENT } from '../lib/wallet-warmup-execution-terms';

const { controlled } = vi.hoisted(() => ({
  controlled: {
    fetcher: undefined as typeof fetch | undefined,
    now: undefined as (() => number) | undefined,
  },
}));
vi.mock('../lib/wallet-rpc-pacing', () => ({
  paceWalletRpc: vi.fn(async () => {}),
}));
vi.mock(
  '../lib/wallet-warmup-execution-budget-review',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../lib/wallet-warmup-execution-budget-review')
      >();
    return {
      ...actual,
      reviewWarmupExecutionBudget: vi.fn(
        (
          db: D1Database,
          owner: string,
          value: unknown,
          signal: AbortSignal,
          dependencies?: { fetcher?: typeof fetch; now?: () => number },
        ) =>
          actual.reviewWarmupExecutionBudget(
            db,
            owner,
            value,
            signal,
            dependencies ?? controlled,
          ),
      ),
    };
  },
);
type Hook = (sql: string, operation: string) => void | Promise<void>;
/** Genuine retained proposal/root on the unchanged full native schema, with a
 * wholly synthetic asset collector. This establishes no human or chain proof. */
export async function warmupExecutionLeaseFixture(maximum = false) {
  const prior = env.SOLANA_INDEXER_RPC_URL;
  const f = await warmupReconstructionFixture('none', maximum);
  env.SOLANA_INDEXER_RPC_URL = 'https://reconstruction.invalid/';
  controlled.fetcher = f.fetcher;
  controlled.now = f.clock;
  let before: Hook | undefined, after: Hook | undefined;
  const statements: string[] = [];
  const db = {
    prepare(sql: string) {
      statements.push(sql);
      const st = f.db.prepare(sql);
      const wrapped = {
        bind(...values: unknown[]) {
          st.bind(
            ...values.map((v) =>
              v instanceof ArrayBuffer ? new Uint8Array(v) : v,
            ),
          );
          return wrapped;
        },
        async first<T>() {
          await before?.(sql, 'first');
          const result = await st.first<T>();
          await after?.(sql, 'first');
          return result;
        },
        async all<T>() {
          await before?.(sql, 'all');
          const result = { ...(await st.all<T>()), success: true };
          await after?.(sql, 'all');
          return result;
        },
        async run<T>() {
          await before?.(sql, 'run');
          const result = { ...(await st.run<T>()), success: true };
          await after?.(sql, 'run');
          return result;
        },
      };
      return wrapped;
    },
  } as unknown as D1Database;
  try {
    const proposalRequest = {
      ...f.input,
      rootId: f.expected.id,
      consentId: f.expected.consentId,
      sessionExpiresAt: f.proposed.terms.intent.expiresAt,
      feeRentLimits: f.proposed.budget.feeRentLimits,
    };
    await retainWarmupExecutionProposal(
      db,
      f.owner,
      proposalRequest,
      new AbortController().signal,
    );
    const proposal = await readWarmupExecutionProposal(
      db,
      f.owner,
      f.expected.id,
      new AbortController().signal,
    );
    if (!proposal || proposal.status !== 'published')
      throw Error('Missing genuine retained proposal');
    const approvalRequest = {
      proposalId: proposal.id,
      headerSha256: proposal.headerSha256,
      termsSha256: proposal.proposal.termsSha256,
      approved: true as const,
      acknowledgement: WARMUP_EXECUTION_ACKNOWLEDGEMENT,
    };
    const approval = await retainWarmupExecutionApproval(
      db,
      f.owner,
      approvalRequest,
      new AbortController().signal,
    );
    if (
      !approval.rootSha256 ||
      !approval.manifestSha256 ||
      !approval.rootCreatedAt
    )
      throw Error('Missing genuine retained root');
    const native = () => {
      if (!f.actual)
        throw Error(
          'Maximum fixture exposes actual native SQL only through its D1 facade',
        );
      return f.actual.sqlite;
    };
    // The normal fixture applies the current journal. During parallel source
    // construction the new migration may not yet be registered there.
    if (
      !(await db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE name='wallet_warmup_execution_wallet_leases'",
        )
        .first())
    ) {
      const path = 'drizzle/0141_wallet_warmup_execution_wallet_leases.sql';
      for (const sql of readFileSync(path, 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean))
        await db.prepare(sql).run();
    }
    const input = {
      proposalId: proposal.id,
      rootSha256: approval.rootSha256,
      manifestSha256: approval.manifestSha256,
    };
    const sqlClock = () =>
      String(
        native()
          .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at")
          .get()!.at,
      );
    const rawLease = () => ({
      owner_id: f.owner,
      proposal_id: proposal.id,
      consent_id: approval.consentId,
      review_id: approval.reviewId,
      header_sha256: approval.headerSha256,
      terms_sha256: approval.termsSha256,
      consent_sha256: approval.consentSha256,
      root_sha256: approval.rootSha256!,
      manifest_sha256: approval.manifestSha256!,
      root_created_at: approval.rootCreatedAt!,
      created_at: sqlClock(),
    });
    const insertLease = () => {
      const row = rawLease();
      native()
        .prepare(
          `INSERT INTO wallet_warmup_execution_wallet_leases(${Object.keys(row).join(',')}) VALUES(${Object.keys(
            row,
          )
            .map(() => '?')
            .join(',')})`,
        )
        .run(...Object.values(row));
      return row;
    };
    return {
      ...f,
      db,
      get sqlite() {
        return native();
      },
      proposal,
      proposalRequest,
      approval,
      approvalRequest,
      input,
      statements,
      sqlClock,
      rawLease,
      insertLease,
      advance: (milliseconds: number) =>
        advanceFamilyExclusionClock(native(), milliseconds),
      setBefore: (hook?: Hook) => {
        before = hook;
      },
      setAfter: (hook?: Hook) => {
        after = hook;
      },
      readApproval: () =>
        readWarmupExecutionApproval(
          db,
          f.owner,
          proposal.id,
          new AbortController().signal,
        ),
      dispose: () => {
        controlled.fetcher = undefined;
        controlled.now = undefined;
        f.dispose();
        if (prior === undefined) delete env.SOLANA_INDEXER_RPC_URL;
        else env.SOLANA_INDEXER_RPC_URL = prior;
      },
    };
  } catch (error) {
    f.dispose();
    controlled.fetcher = undefined;
    controlled.now = undefined;
    if (prior === undefined) delete env.SOLANA_INDEXER_RPC_URL;
    else env.SOLANA_INDEXER_RPC_URL = prior;
    throw error;
  }
}
