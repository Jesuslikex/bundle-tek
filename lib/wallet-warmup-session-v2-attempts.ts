import { z } from 'zod';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import {
  readWalletWarmupV2Journal,
  publicWalletWarmupV2Journal,
} from './wallet-warmup-session-v2-journal';
import {
  warmupPreparationHistoryDocument,
  type WarmupPreparationSummary,
} from './warmup-preparation-history';
import {
  validateWalletWarmupSessionPacket,
  type WarmupSessionPacketMaterial,
} from './wallet-warmup-session-packet';
import type { WarmupSessionPreparationCandidate } from './wallet-warmup-session-preparation';
import { createWalletWarmupV2Provider } from './wallet-warmup-session-v2-provider';
import { createWalletWarmupV2RuntimeProvider } from './wallet-warmup-session-v2-runtime-provider';
import {
  WARMUP_RUNTIME_WALLET_BUSY_SQL,
  requireWarmupRuntimeWalletAvailability,
} from './wallet-warmup-runtime-wallet-busy';
import {
  warmupRuntimeInstalled,
  warmupPurposeInsert,
  readWarmupPurpose,
  warmupRuntimeDocument,
  warmupRuntimeInsert,
  readWarmupRuntimeObservation,
  WarmupRuntimeReadRace,
  readWarmupPurposePage,
  type WarmupAttemptMode,
  type WarmupRuntimeMaterial,
} from './wallet-warmup-session-v2-runtime-storage';
import { WalletWarmupSessionProviderError } from './wallet-warmup-session-provider';
import type { WarmupSessionProviderFeeEvidence } from './wallet-warmup-session-provider-core';
import { WalletRpcError } from './wallet-balances';
import { HoldingsReadError } from './wallet-holdings';
import { WarmupQuoteError } from './warmup-swap-quote';
import { SwapBlockhashExpiredError } from './imported-swap-simulation';
import {
  warmupAttemptUuid as uuid,
  warmupAttemptUnits as units,
  warmupV2AttemptInput as inputSchema,
  warmupV2AttemptRow as leaseSchema,
  warmupV2OutcomeRow as outcomeSchema,
  WalletWarmupV2AttemptError,
  warmupV2AttemptFlags as flags,
  warmupV2FeeEvidence as feeSchema,
  type WarmupV2AttemptRow,
  type WarmupV2OutcomeRow,
} from './wallet-warmup-session-v2-attempt-types';
export { WalletWarmupV2AttemptError } from './wallet-warmup-session-v2-attempt-types';

function fail(message?: string, status = 409, recoveryId?: string): never {
  throw new WalletWarmupV2AttemptError(message, status, recoveryId);
}
const ownerId = (owner: string) => {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(owner))
    fail('Verified owner required.', 400);
};
async function sqlNow(db: D1Database, signal: AbortSignal) {
  signal.throwIfAborted();
  const row = await db
    .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at")
    .first<{ at: string }>();
  signal.throwIfAborted();
  if (!row || new Date(row.at).toISOString() !== row.at)
    fail('Database time is unavailable. Recover the original request.', 503);
  return row.at;
}
function classifyRefusal(
  error: unknown,
): NonNullable<WarmupV2OutcomeRow['refusal_code']> {
  if (error instanceof WalletRpcError || error instanceof HoldingsReadError)
    return error.status === 429 ? 'provider-limited' : 'provider-unavailable';
  if (error instanceof WarmupQuoteError)
    return error.providerStatus === 429
      ? 'provider-limited'
      : error.code === 'PROVIDER_REJECTED'
        ? 'provider-refused'
        : error.code === 'QUOTE_UNAVAILABLE'
          ? 'provider-unavailable'
          : 'evidence-refused';
  if (
    error instanceof SwapBlockhashExpiredError ||
    (error instanceof Error &&
      ['AbortError', 'TimeoutError'].includes(error.name))
  )
    return 'provider-unavailable';
  if (error instanceof WalletWarmupSessionProviderError)
    return error.status === 429 ? 'provider-limited' : 'provider-refused';
  return 'evidence-refused';
}
const guardNames = [
  'wallet_warmup_session_v2_attempt_context',
  'wallet_warmup_session_v2_attempts',
  'wallet_warmup_session_v2_attempt_outcomes',
  'wallet_warmup_session_v2_attempts_insert',
  'wallet_warmup_session_v2_attempts_gate',
  'wallet_warmup_session_v2_attempts_no_update',
  'wallet_warmup_session_v2_attempts_no_delete',
  'wallet_warmup_session_v2_outcomes_insert',
  'wallet_warmup_session_v2_outcomes_no_update',
  'wallet_warmup_session_v2_outcomes_no_delete',
  'warmup_v2_attempt_preparation_isolation',
  'warmup_v2_attempt_legacy_preparation_isolation',
  'warmup_v2_attempt_signing_isolation',
  'warmup_v2_attempt_buy_receipt_isolation',
  'warmup_v2_attempt_sell_receipt_isolation',
];
async function installed(db: D1Database) {
  const row = await db
    .prepare(
      `SELECT count(*) AS n FROM sqlite_master WHERE name IN (${guardNames.map(() => '?').join(',')})`,
    )
    .bind(...guardNames)
    .first<{ n: number }>();
  if (row?.n !== guardNames.length)
    fail('Fresh unsigned attempt storage is unavailable.', 503);
}
type Journal = NonNullable<
  Awaited<ReturnType<typeof readWalletWarmupV2Journal>>
>;
const binding = (
  lease: WarmupV2AttemptRow,
  input: z.infer<typeof inputSchema>,
) =>
  lease.id === input.id &&
  lease.journal_id === input.journalId &&
  lease.review_version === input.version &&
  lease.review_sha256 === input.headSha256;
const evidenceHash = (
  lease: WarmupV2AttemptRow,
  outcome: Omit<WarmupV2OutcomeRow, 'record_sha256'>,
) =>
  digest(
    canonical({
      format: 'wallet-warmup-session-attempt-result-v2',
      lease,
      outcome,
    }),
  );

/** Private native packet admission is deliberately only unsigned envelope identity. */
async function admitMaterial(
  journal: Journal,
  material: WarmupSessionPacketMaterial & {
    feeEvidence: WarmupSessionProviderFeeEvidence;
  },
) {
  const source = await materialSummary(
    journal,
    material.summary,
    material.feeEvidence,
  );
  const packet = await validateWalletWarmupSessionPacket(
    material.transaction,
    source.summary,
  );
  return { ...source, packet };
}
async function materialSummary(
  journal: Journal,
  summary: WarmupPreparationSummary,
  feeValue: WarmupSessionProviderFeeEvidence,
) {
  const action = journal.manifest.actions[0];
  const wallet = journal.manifest.wallets.find(
    (w) => w.wallet === action.wallet,
  );
  if (!wallet) fail(undefined, 503);
  const source = JSON.parse(journal.consent.terms.reviewDocument);
  const expected = await journalSource(journal);
  const text = warmupPreparationHistoryDocument(
    {
      planId: journal.manifest.planId,
      planRevision: journal.manifest.planRevision,
      cycle: action.cycle,
      walletRevision: action.walletRevision,
    },
    summary,
    expected.planDocument,
  );
  if (
    new TextEncoder().encode(text).byteLength > 8192 ||
    source.actions[0].id !== action.id ||
    summary.wallet !== action.wallet ||
    summary.side !== action.side ||
    summary.simulation.succeeded !== true ||
    summary.simulation.tokensComplete !== true ||
    (action.side === 'Buy'
      ? summary.inAmountRaw !== action.inputLamports ||
        summary.simulation.minimumOutputCovered !== true
      : action.source.kind !== 'saved-buy' ||
        summary.inAmountRaw !== action.source.remainingRaw ||
        summary.buyReceipt?.receiptId !== action.source.buyReceiptId ||
        summary.simulation.inputAmountMatches !== true)
  )
    fail();
  const input = units.parse(summary.inAmountRaw),
    minimum = units.parse(summary.minimumOutRaw),
    quoted = units.parse(summary.quotedOutRaw);
  const feeEvidence = feeSchema.parse(feeValue);
  const estimate = BigInt(
      units.parse(summary.transaction.estimatedFeesLamports),
    ),
    fee = BigInt(units.parse(summary.simulation.networkFeeLamports));
  const quotedNetwork =
      BigInt(feeEvidence.signatureFeeLamports) +
      BigInt(feeEvidence.prioritizationFeeLamports),
    rent = BigInt(feeEvidence.rentFeeLamports);
  const feeCap = (quotedNetwork > fee ? quotedNetwork : fee) + rent;
  if (
    !BigInt(input) ||
    !BigInt(minimum) ||
    BigInt(minimum) > BigInt(quoted) ||
    estimate !== quotedNetwork + rent ||
    feeEvidence.observedNetworkFeeLamports !== fee.toString() ||
    feeCap !== BigInt(feeEvidence.boundLamports) ||
    feeCap > BigInt(wallet.remainingFeeReserveLamports)
  )
    fail('Unsigned fees, input or output exceed the original review.');
  for (const at of [
    summary.quotedAt,
    summary.expiresAt,
    summary.simulation.observedAt,
  ])
    if (!Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at)
      fail();
  return { summary, text, feeCap: feeCap.toString(), fee: feeEvidence };
}
async function journalSource(journal: Journal) {
  // Filled by the owner-scoped immutable source query, never by an HTTP selector.
  return (
    journalPrivateSource.get(journal) ??
    fail('Original plan source is unavailable.', 503)
  );
}
const journalPrivateSource = new WeakMap<
  Journal,
  { planDocument: string; planUpdatedAt: string }
>();
async function ownedJournal(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
) {
  const journal = await readWalletWarmupV2Journal(db, owner, id, signal);
  if (!journal) fail('Saved warmup history is unavailable.', 404);
  const row = await db
    .prepare(
      'SELECT source FROM wallet_warmup_session_reviews WHERE owner_id=? AND id=?',
    )
    .bind(owner, journal.consent.terms.reviewId)
    .first<{ source: string }>();
  signal.throwIfAborted();
  if (!row) fail(undefined, 503);
  const source = JSON.parse(row.source) as {
    planDocument: string;
    planUpdatedAt: string;
  };
  journalPrivateSource.set(journal, {
    planDocument: source.planDocument,
    planUpdatedAt: source.planUpdatedAt,
  });
  return journal;
}
function admitLease(lease: WarmupV2AttemptRow, journal: Journal) {
  const event = journal.events[lease.review_version - 1],
    action = journal.manifest.actions[0];
  if (
    lease.journal_id !== journal.id ||
    lease.terms_sha256 !== journal.termsSha256 ||
    lease.action_id !== action.id ||
    !event ||
    event.event_sha256 !== lease.review_sha256 ||
    lease.created_at < event.created_at ||
    lease.expires_at !==
      new Date(
        Math.min(
          Date.parse(lease.created_at) + 60000,
          Date.parse(journal.consent.terms.sessionExpiresAt),
        ),
      ).toISOString() ||
    lease.created_at < action.scheduledAt ||
    lease.created_at >= lease.expires_at
  )
    fail('Saved unsigned attempt differs from its original head.', 503);
  if (originalReviewSnapshot(lease, journal).phase !== 'reviewing')
    fail('The retained attempt head was not an active review.', 503);
}
function originalReviewSnapshot(lease: WarmupV2AttemptRow, journal: Journal) {
  let paused = false,
    stopped = false,
    pending = false;
  for (const record of journal.events.slice(0, lease.review_version)) {
    const event = JSON.parse(record.document) as {
      operation: string;
      actionId?: string;
    };
    if (
      event.operation === 'begin-review' &&
      event.actionId === lease.action_id
    )
      pending = true;
    if (event.operation === 'pause') paused = true;
    if (event.operation === 'resume') paused = false;
    if (event.operation === 'stop') stopped = true;
  }
  const expired =
    Date.parse(lease.created_at) >=
    Date.parse(journal.consent.terms.sessionExpiresAt);
  return {
    ...journal.snapshot,
    paused,
    stopped,
    expired,
    pendingReview: pending ? journal.manifest.actions[0] : null,
    phase: stopped
      ? ('stopped' as const)
      : expired
        ? ('expired' as const)
        : paused
          ? ('paused' as const)
          : pending
            ? ('reviewing' as const)
            : ('review-required' as const),
  };
}
/** Saved-only, owner-scoped recovery. Never renews timestamps or calls a provider. */
export async function readWalletWarmupV2Attempt(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
) {
  ownerId(owner);
  uuid.parse(id);
  signal.throwIfAborted();
  await installed(db);
  const raw = await db
    .prepare(
      'SELECT * FROM wallet_warmup_session_v2_attempts WHERE owner_id=? AND id=?',
    )
    .bind(owner, id)
    .first<WarmupV2AttemptRow>();
  signal.throwIfAborted();
  if (!raw) return null;
  try {
    const lease = leaseSchema.parse(raw),
      journal = await ownedJournal(db, owner, lease.journal_id, signal);
    if (lease.owner_id !== owner || lease.id !== id) fail(undefined, 503);
    admitLease(lease, journal);
    // Bounded metadata pages, not a SQL aggregate or a packet/history vector.
    let previous: string | null = null,
      sequence = 0;
    const counts = new Map<string, number>();
    for (let lower = 1; lower <= lease.sequence; lower += 256) {
      signal.throwIfAborted();
      const page = await db
        .prepare(
          'SELECT * FROM wallet_warmup_session_v2_attempts WHERE owner_id=? AND journal_id=? AND sequence>=? AND sequence<=? ORDER BY sequence',
        )
        .bind(
          owner,
          lease.journal_id,
          lower,
          Math.min(lower + 255, lease.sequence),
        )
        .all<WarmupV2AttemptRow>();
      if (page.results.length !== Math.min(256, lease.sequence - lower + 1))
        fail(undefined, 503);
      for (const rawItem of page.results) {
        const item = leaseSchema.parse(rawItem);
        admitLease(item, journal);
        const count = (counts.get(item.action_id) ?? 0) + 1;
        if (
          item.owner_id !== owner ||
          item.journal_id !== lease.journal_id ||
          item.sequence !== ++sequence ||
          item.previous_id !== previous ||
          item.attempt_no !== count ||
          count > 3
        )
          fail(undefined, 503);
        counts.set(item.action_id, count);
        previous = item.id;
      }
    }
    if (
      previous !== lease.id ||
      sequence !== lease.sequence ||
      sequence > journal.consent.terms.policy.maxQualifications
    )
      fail(undefined, 503);
    const rawOutcome = await db
      .prepare(
        'SELECT * FROM wallet_warmup_session_v2_attempt_outcomes WHERE owner_id=? AND attempt_id=?',
      )
      .bind(owner, id)
      .first<WarmupV2OutcomeRow>();
    signal.throwIfAborted();
    let outcome: WarmupV2OutcomeRow | null = null,
      summary: WarmupPreparationSummary | null = null,
      feeCap: string | null = null,
      fee: WarmupSessionProviderFeeEvidence | null = null;
    if (rawOutcome) {
      outcome = outcomeSchema.parse(rawOutcome);
      const { record_sha256, ...facts } = outcome;
      if (
        outcome.owner_id !== owner ||
        outcome.attempt_id !== id ||
        outcome.created_at < lease.created_at ||
        outcome.created_at >= lease.expires_at ||
        (await evidenceHash(lease, facts)) !== record_sha256
      )
        fail(undefined, 503);
      if (outcome.kind === 'prepared') {
        if (
          !outcome.summary_document ||
          !outcome.unsigned_transaction ||
          !outcome.packet_sha256 ||
          !outcome.fee_document ||
          outcome.refusal_code !== null
        )
          fail(undefined, 503);
        const admitted = await admitMaterial(journal, {
          summary: JSON.parse(outcome.summary_document),
          transaction: outcome.unsigned_transaction,
          feeEvidence: JSON.parse(outcome.fee_document),
        });
        if (
          admitted.text !== outcome.summary_document ||
          admitted.packet.sha256 !== outcome.packet_sha256 ||
          canonical(admitted.fee) !== outcome.fee_document ||
          outcome.expires_at !==
            new Date(
              Math.min(
                Date.parse(lease.expires_at),
                Date.parse(admitted.summary.expiresAt),
              ),
            ).toISOString() ||
          outcome.created_at >= outcome.expires_at
        )
          fail(undefined, 503);
        summary = admitted.summary;
        feeCap = admitted.feeCap;
        fee = admitted.fee;
      } else if (
        outcome.summary_document !== null ||
        outcome.unsigned_transaction !== null ||
        outcome.packet_sha256 !== null ||
        outcome.fee_document !== null ||
        !outcome.refusal_code ||
        outcome.expires_at !== outcome.created_at
      )
        fail(undefined, 503);
    }
    signal.throwIfAborted();
    return { lease, journal, outcome, summary, feeCap, fee, ...flags };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof WalletWarmupV2AttemptError && error.status === 404)
      throw error;
    fail(
      'Saved unsigned attempt integrity is unavailable. Keep its original ID.',
      503,
    );
  }
}
type Saved = NonNullable<Awaited<ReturnType<typeof readWalletWarmupV2Attempt>>>;
/** Explicit saved-only discovery for another tab/browser; bounded immutable cursor. */
async function listAttemptPage(
  db: D1Database,
  owner: string,
  journalId: string,
  before: number | null,
  signal: AbortSignal,
) {
  ownerId(owner);
  uuid.parse(journalId);
  if (
    before !== null &&
    (!Number.isSafeInteger(before) || before < 1 || before > 14400)
  )
    fail('Choose a valid saved request page.', 400);
  signal.throwIfAborted();
  await installed(db);
  const journal = await ownedJournal(db, owner, journalId, signal);
  if (
    before !== null &&
    !(await db
      .prepare(
        'SELECT 1 FROM wallet_warmup_session_v2_attempts WHERE owner_id=? AND journal_id=? AND sequence=?',
      )
      .bind(owner, journalId, before)
      .first())
  )
    fail('Saved request cursor is unavailable.', 400);
  const rows = await db
    .prepare(
      'SELECT * FROM wallet_warmup_session_v2_attempts WHERE owner_id=? AND journal_id=? AND (? IS NULL OR sequence<?) ORDER BY sequence DESC LIMIT 26',
    )
    .bind(owner, journalId, before, before)
    .all<WarmupV2AttemptRow>();
  signal.throwIfAborted();
  let last = before ?? 14401;
  let leases: WarmupV2AttemptRow[];
  try {
    leases = rows.results.map((raw) => {
      const lease = leaseSchema.parse(raw);
      admitLease(lease, journal);
      if (
        lease.owner_id !== owner ||
        lease.journal_id !== journalId ||
        lease.sequence >= last
      )
        fail(undefined, 503);
      last = lease.sequence;
      return lease;
    });
  } catch (error) {
    if (error instanceof WalletWarmupV2AttemptError) throw error;
    fail('Saved request integrity could not be verified.', 503);
  }
  const selected = leases.slice(0, 25),
    tail = selected.at(-1);
  const page = {
    format: 'wallet-warmup-attempt-page-v2' as const,
    journalId,
    termsSha256: journal.termsSha256,
    requests: selected.map((a) => ({
      id: a.id,
      actionId: a.action_id,
      sequence: a.sequence,
      attempt: a.attempt_no,
      createdAt: a.created_at,
      expiresAt: a.expires_at,
    })),
    nextBefore: leases.length > 25 && tail ? tail.sequence : null,
    ...flags,
  };
  return { page, selected };
}
export async function listWalletWarmupV2Attempts(
  db: D1Database,
  owner: string,
  journalId: string,
  before: number | null,
  signal: AbortSignal,
) {
  const { page, selected } = await listAttemptPage(
    db,
    owner,
    journalId,
    before,
    signal,
  );
  const purposes = await readWarmupPurposePage(db, selected, signal);
  if (purposes.some((p) => p?.mode === 'runtime'))
    fail(
      'This history contains runtime checks. Recover it through the current saved-check history.',
      409,
    );
  return page;
}
export async function listWalletWarmupV2ReadAttempts(
  db: D1Database,
  owner: string,
  journalId: string,
  before: number | null,
  signal: AbortSignal,
) {
  const { page, selected } = await listAttemptPage(
    db,
    owner,
    journalId,
    before,
    signal,
  );
  const purposes = await readWarmupPurposePage(db, selected, signal);
  return {
    ...page,
    format: 'wallet-warmup-read-page-v1' as const,
    requests: page.requests.map((row, index) => ({
      ...row,
      mode: purposes[index]?.mode ?? ('preview' as WarmupAttemptMode),
    })),
  };
}
export async function readWalletWarmupV2ReadAttempt(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
) {
  const attempt = await readWalletWarmupV2Attempt(db, owner, id, signal);
  if (!attempt) return null;
  const purpose = await readWarmupPurpose(db, attempt.lease);
  signal.throwIfAborted();
  if (purpose?.mode !== 'runtime')
    return {
      mode: 'preview' as const,
      attempt: publicWalletWarmupV2Attempt(attempt),
    };
  let runtime;
  try {
    runtime = await runtimeFromSavedAttempt(db, attempt, signal);
  } catch (error) {
    if (!(error instanceof WarmupRuntimeReadRace)) throw error;
    signal.throwIfAborted();
    runtime = await readRuntimeAttemptSnapshot(db, owner, id, signal);
  }
  if (!runtime) return fail(undefined, 503);
  return {
    mode: 'runtime' as const,
    ...publicWalletWarmupV2RuntimeAttempt(runtime),
  };
}
export function publicWalletWarmupV2Attempt(saved: Saved) {
  const { lease, outcome, summary } = saved;
  const event = saved.journal.events[lease.review_version - 1];
  if (!event) fail(undefined, 503);
  // Historical exact head, never the current control state or a renewed grant.
  const originalJournal = publicWalletWarmupV2Journal(
    {
      ...saved.journal,
      version: lease.review_version,
      headSha256: lease.review_sha256,
      updatedAt: event.created_at,
      events: saved.journal.events.slice(0, lease.review_version),
      snapshot: originalReviewSnapshot(lease, saved.journal),
    },
    event.id,
  );
  return {
    format: 'wallet-warmup-session-attempt-v2' as const,
    id: lease.id,
    originalHead: {
      format: 'wallet-warmup-attempt-head-v2' as const,
      historical: true as const,
      journal: originalJournal,
    },
    journalId: lease.journal_id,
    actionId: lease.action_id,
    sequence: lease.sequence,
    attempt: lease.attempt_no,
    reviewVersion: lease.review_version,
    reviewHeadSha256: lease.review_sha256,
    termsSha256: lease.terms_sha256,
    createdAt: lease.created_at,
    leaseExpiresAt: lease.expires_at,
    nextAttemptAt: new Date(Date.parse(lease.created_at) + 30000).toISOString(),
    maxAttempts: 3 as const,
    outcome: outcome
      ? {
          kind: outcome.kind,
          createdAt: outcome.created_at,
          expiresAt: outcome.expires_at,
          refusalCode: outcome.refusal_code,
          recordSha256: outcome.record_sha256,
        }
      : null,
    preview: summary
      ? {
          side: summary.side,
          wallet: summary.wallet,
          inputMint: summary.inputMint,
          outputMint: summary.outputMint,
          inAmountRaw: summary.inAmountRaw,
          quotedOutRaw: summary.quotedOutRaw,
          minimumOutRaw: summary.minimumOutRaw,
          quoteExpiresAt: summary.expiresAt,
          packetSha256: summary.transaction.sha256,
          estimatedFeesLamports: summary.transaction.estimatedFeesLamports,
          feeUpperBoundLamports: saved.feeCap,
          networkFeeLamports: summary.simulation.networkFeeLamports,
          fees: saved.fee,
          simulationSucceeded: true as const,
          tokensComplete: true as const,
        }
      : null,
    ...flags,
    limitations:
      'Unsigned quote and simulation preview only. No instruction, custody or signing qualification, funds reservation or trade execution.',
  };
}
async function readSame(
  db: D1Database,
  owner: string,
  input: z.infer<typeof inputSchema>,
  mode: WarmupAttemptMode,
) {
  const saved = await readWalletWarmupV2Attempt(
    db,
    owner,
    input.id,
    AbortSignal.timeout(20000),
  );
  if (saved && !binding(saved.lease, input))
    fail('This request ID belongs to a different saved head.');
  if (saved) await readWarmupPurpose(db, saved.lease, mode);
  return saved;
}
export async function prepareWalletWarmupV2Attempt(
  db: D1Database,
  owner: string,
  value: unknown,
  approved: boolean,
  signal: AbortSignal,
  apiKey: string | undefined,
  providerFactory: typeof createWalletWarmupV2Provider = createWalletWarmupV2Provider,
) {
  return prepareAttempt(
    db,
    owner,
    value,
    approved,
    signal,
    apiKey,
    'preview',
    providerFactory,
  );
}
type Material = Awaited<
  ReturnType<ReturnType<typeof createWalletWarmupV2Provider>>
> & { runtimeEvidence?: WarmupRuntimeMaterial };
type ProviderFactory = (
  db: D1Database,
  owner: string,
  key: string | undefined,
  lease: WarmupV2AttemptRow,
) => (
  candidate: WarmupSessionPreparationCandidate,
  signal: AbortSignal,
) => Promise<Material>;
export async function prepareWalletWarmupV2RuntimeAttempt(
  db: D1Database,
  owner: string,
  value: unknown,
  approved: boolean,
  signal: AbortSignal,
  apiKey: string | undefined,
  providerFactory: ProviderFactory = createWalletWarmupV2RuntimeProvider,
) {
  const saved = await prepareAttempt(
    db,
    owner,
    value,
    approved,
    signal,
    apiKey,
    'runtime',
    providerFactory,
  );
  const recovered = await readWalletWarmupV2RuntimeAttempt(
    db,
    owner,
    saved.lease.id,
    signal,
  );
  return recovered?.attempt ?? fail(undefined, 503);
}
async function prepareAttempt(
  db: D1Database,
  owner: string,
  value: unknown,
  approved: boolean,
  signal: AbortSignal,
  apiKey: string | undefined,
  mode: WarmupAttemptMode,
  providerFactory: ProviderFactory,
) {
  ownerId(owner);
  const input = inputSchema.parse(value);
  if (approved !== true)
    fail('Request this exact unsigned preview separately.', 400);
  signal.throwIfAborted();
  await installed(db);
  const purposesInstalled = await warmupRuntimeInstalled(
    db,
    mode === 'runtime',
  );
  const prior = await readSame(db, owner, input, mode);
  if (prior) return prior;
  if (!apiKey || apiKey.length > 1000 || /\s/.test(apiKey))
    fail('Unsigned provider is not configured.', 503);
  const journal = await ownedJournal(db, owner, input.journalId, signal);
  if (
    journal.version !== input.version ||
    journal.headSha256 !== input.headSha256 ||
    journal.snapshot.phase !== 'reviewing' ||
    !journal.snapshot.pendingReview
  )
    fail('Recover the current owned review before requesting a preview.');
  const pending = await db
    .prepare(`SELECT a.id FROM wallet_warmup_session_v2_attempts a LEFT JOIN wallet_warmup_session_v2_attempt_outcomes o ON o.owner_id=a.owner_id AND o.attempt_id=a.id
 WHERE a.owner_id=? AND a.journal_id=? AND COALESCE(o.kind,'pending')!='refused' AND strftime('%Y-%m-%dT%H:%M:%fZ','now')<COALESCE(o.expires_at,a.expires_at) ORDER BY a.sequence DESC LIMIT 1`)
    .bind(owner, journal.id)
    .first<{ id: string }>();
  signal.throwIfAborted();
  if (pending?.id === input.id) {
    const raced = await readSame(db, owner, input, mode);
    if (raced) return raced;
    fail(
      'The original request is still being recovered. Keep its ID.',
      409,
      input.id,
    );
  }
  if (pending)
    fail(
      'An original unsigned request is still pending. Recover it first.',
      409,
      pending.id,
    );
  if (mode === 'runtime')
    await requireWarmupRuntimeWalletAvailability(db, owner, input, signal);
  let claimed = false;
  try {
    signal.throwIfAborted();
    const claimStatement = db
      .prepare(`INSERT INTO wallet_warmup_session_v2_attempts
 (owner_id,id,journal_id,action_id,sequence,attempt_no,previous_id,review_version,review_sha256,terms_sha256,created_at,expires_at)
 SELECT c.owner_id,?,c.journal_id,c.action_id,(SELECT count(*)+1 FROM wallet_warmup_session_v2_attempts a WHERE a.owner_id=c.owner_id AND a.journal_id=c.journal_id),
 (SELECT count(*)+1 FROM wallet_warmup_session_v2_attempts a WHERE a.owner_id=c.owner_id AND a.journal_id=c.journal_id AND a.action_id=c.action_id),
 (SELECT id FROM wallet_warmup_session_v2_attempts a WHERE a.owner_id=c.owner_id AND a.journal_id=c.journal_id ORDER BY sequence DESC LIMIT 1),c.version,c.head_sha256,c.terms_sha256,
 strftime('%Y-%m-%dT%H:%M:%fZ','now'),min(strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds'),c.finish_at)
 FROM wallet_warmup_session_v2_attempt_context c WHERE c.owner_id=? AND c.journal_id=? AND c.version=? AND c.head_sha256=?${mode === 'runtime' ? ` AND (${WARMUP_RUNTIME_WALLET_BUSY_SQL})=0` : ''}`)
      .bind(input.id, owner, input.journalId, input.version, input.headSha256);
    const result = purposesInstalled
      ? (
          await db.batch([
            await warmupPurposeInsert(
              db,
              owner,
              input,
              journal.termsSha256,
              mode,
            ),
            claimStatement,
          ])
        )[1]
      : await claimStatement.run();
    claimed = result.meta.changes > 0;
  } catch {
    /* An uncertain write never authorizes another provider call. */
  }
  const retained = await readSame(db, owner, input, mode);
  if (!retained) {
    const other = await db
      .prepare(
        "SELECT a.id FROM wallet_warmup_session_v2_attempts a LEFT JOIN wallet_warmup_session_v2_attempt_outcomes o ON o.owner_id=a.owner_id AND o.attempt_id=a.id WHERE a.owner_id=? AND a.journal_id=? AND COALESCE(o.kind,'pending')!='refused' AND strftime('%Y-%m-%dT%H:%M:%fZ','now')<COALESCE(o.expires_at,a.expires_at) ORDER BY a.sequence DESC LIMIT 1",
      )
      .bind(owner, input.journalId)
      .first<{ id: string }>();
    fail(
      'No new attempt was confirmed. Recover saved history and respect the original attempt/cooldown limits.',
      409,
      other?.id,
    );
  }
  if (!claimed || retained.outcome || signal.aborted) return retained;
  const lease = retained.lease,
    action = retained.journal.manifest.actions[0],
    wallet = retained.journal.manifest.wallets.find(
      (w) => w.wallet === action.wallet,
    );
  if (!wallet) fail(undefined, 503);
  const source = await journalSource(retained.journal);
  const candidate: WarmupSessionPreparationCandidate = {
    action,
    plan: {
      id: journal.manifest.planId,
      revision: journal.manifest.planRevision,
      archived: false,
      updatedAt: source.planUpdatedAt,
      document: JSON.parse(source.planDocument),
    },
    planDocument: source.planDocument,
    journalId: lease.journal_id,
    version: lease.review_version,
    headSha256: lease.review_sha256,
    deadline: Date.parse(lease.expires_at),
    budget: {
      buySpendLamports: wallet.buySpendLamports,
      recordedFurtherBuySpendLamports: '0',
      remainingReserveLamports: wallet.remainingFeeReserveLamports,
    },
    sellSource:
      action.side === 'Sell' && action.source.kind === 'saved-buy'
        ? {
            buyReceiptId: action.source.buyReceiptId,
            remainingRaw: action.source.remainingRaw,
            decimals: action.source.decimals,
          }
        : null,
  };
  let facts: Omit<WarmupV2OutcomeRow, 'record_sha256'>;
  let runtimeDocument: string | null = null;
  const purpose = await readWarmupPurpose(db, lease, mode);
  try {
    signal.throwIfAborted();
    const material = await providerFactory(
      db,
      owner,
      apiKey,
      lease,
    )(candidate, signal);
    signal.throwIfAborted();
    const admitted = await admitMaterial(retained.journal, material);
    if (mode === 'runtime') {
      if (!purpose || !material.runtimeEvidence)
        fail('Complete original runtime observations are required.');
      if (
        material.runtimeEvidence.result.order.preparation.transaction !==
        material.transaction
      )
        fail('Runtime packet differs from the original outcome.');
      runtimeDocument = await warmupRuntimeDocument(
        material.runtimeEvidence,
        lease,
        purpose,
        admitted.summary,
        wallet.remainingFeeReserveLamports,
      );
    } else if (material.runtimeEvidence)
      fail('Runtime reads require their separate original purpose.');
    signal.throwIfAborted();
    facts = {
      owner_id: owner,
      attempt_id: lease.id,
      kind: 'prepared',
      summary_document: admitted.text,
      unsigned_transaction: admitted.packet.transaction,
      packet_sha256: admitted.packet.sha256,
      fee_document: canonical(admitted.fee),
      refusal_code: null,
      created_at: await sqlNow(db, signal),
      expires_at: new Date(
        Math.min(
          Date.parse(lease.expires_at),
          Date.parse(admitted.summary.expiresAt),
        ),
      ).toISOString(),
    };
  } catch (error) {
    if (signal.aborted) return retained;
    const at = await sqlNow(db, signal);
    facts = {
      owner_id: owner,
      attempt_id: lease.id,
      kind: 'refused',
      summary_document: null,
      unsigned_transaction: null,
      packet_sha256: null,
      fee_document: null,
      refusal_code: classifyRefusal(error),
      created_at: at,
      expires_at: at,
    };
  }
  try {
    signal.throwIfAborted();
    const row = outcomeSchema.parse({
      ...facts,
      record_sha256: await evidenceHash(lease, facts),
    });
    signal.throwIfAborted();
    const outcomeStatement = db
      .prepare(
        'INSERT INTO wallet_warmup_session_v2_attempt_outcomes VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        row.owner_id,
        row.attempt_id,
        row.kind,
        row.summary_document,
        row.unsigned_transaction,
        row.packet_sha256,
        row.fee_document,
        row.refusal_code,
        row.created_at,
        row.expires_at,
        row.record_sha256,
      );
    if (mode === 'runtime' && row.kind === 'prepared') {
      if (!purpose || !runtimeDocument) fail();
      await db.batch([
        await warmupRuntimeInsert(db, lease, purpose, row, runtimeDocument),
        outcomeStatement,
      ]);
    } else await outcomeStatement.run();
  } catch {
    /* Outcome and exact packet are one immutable row; recover, never rerun. */
  }
  const saved = await readSame(db, owner, input, mode);
  if (!saved)
    fail(
      'Keep the original request ID. Its retained result is unavailable.',
      503,
    );
  return saved;
}
export async function readWalletWarmupV2RuntimeAttempt(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
) {
  for (let pass = 0; pass < 2; pass++) {
    try {
      return await readRuntimeAttemptSnapshot(db, owner, id, signal);
    } catch (error) {
      if (!(error instanceof WarmupRuntimeReadRace) || pass !== 0) throw error;
      signal.throwIfAborted();
    }
  }
  return fail(undefined, 503);
}
async function readRuntimeAttemptSnapshot(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
) {
  const attempt = await readWalletWarmupV2Attempt(db, owner, id, signal);
  if (!attempt) return null;
  return runtimeFromSavedAttempt(db, attempt, signal);
}
async function runtimeFromSavedAttempt(
  db: D1Database,
  attempt: Saved,
  signal: AbortSignal,
) {
  const runtime = await readWarmupRuntimeObservation(
    db,
    attempt.lease,
    attempt.outcome,
    attempt.summary,
    attempt.journal.manifest.wallets.find(
      (w) => w.wallet === attempt.journal.manifest.actions[0].wallet,
    )?.remainingFeeReserveLamports ?? fail(),
  );
  signal.throwIfAborted();
  return { attempt, runtime };
}
export function publicWalletWarmupV2RuntimeAttempt(
  saved: NonNullable<
    Awaited<ReturnType<typeof readWalletWarmupV2RuntimeAttempt>>
  >,
) {
  const { purpose, observation } = saved.runtime;
  return {
    attempt: publicWalletWarmupV2Attempt(saved.attempt),
    runtime: {
      mode: 'runtime-observation-v1' as const,
      purposeSha256: purpose.request_sha256,
      effectiveExpiresAt: observation
        ? new Date(
            Math.min(
              Date.parse(observation.runtimeExpiresAt),
              Date.parse(saved.attempt.outcome!.expires_at),
            ),
          ).toISOString()
        : null,
      observation: observation
        ? {
            packetSha256: observation.packetSha256,
            observedAt: observation.observedAt,
            expiresAt: observation.runtimeExpiresAt,
            minimumSlot: observation.minimumSlot,
            maximumSlot: observation.maximumSlot,
            programCount: observation.codeScans[0].length,
            codeScans: 2 as const,
            referenceMinimum: observation.referenceMinimum,
            codeClockPolicy: observation.codeClockPolicy,
          }
        : null,
      programCodeAttested: false,
      independentPriceProtectionEstablished: false,
      trustedProgramPolicyEstablished: false,
      ...flags,
      limitations:
        'Saved raw-account and code identity observations only. The minimum is the order’s own bound, with no independent price check. Code chunks use context-slot floors, not per-chunk Clock reads. No trusted code policy, funds reservation, signing or execution permission.',
    },
  };
}
