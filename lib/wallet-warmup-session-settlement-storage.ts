import { z } from 'zod';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import { readWalletWarmupSessionJournal } from './wallet-warmup-session-journal-storage';
import { replayWalletWarmupSessionJournal } from './wallet-warmup-session-replay';
import { replayWarmupSessionSettlement } from './wallet-warmup-session-settlement';
import {
  parseWalletWarmupSessionSettlement,
  WARMUP_SESSION_REVIEW_GAP_MS,
} from './wallet-warmup-session-sequence';
import { parseWalletWarmupSessionSettlementRecord } from './wallet-warmup-session-settlement-record';
import { warmupSessionSettlementSourceGuard } from './wallet-warmup-session-settlement-source';
import { warmupSessionSettlementSourceSql } from './wallet-warmup-session-settlement-source';
import { readWalletWarmupSessionActionBinding } from './wallet-warmup-session-action-binding';

const uuid = z.uuid().refine((v) => v === v.toLowerCase());
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const selection = z
  .object({
    id: uuid,
    journalId: uuid,
    version: z.number().int().min(0).max(4095),
    headSha256: hash,
    receiptId: uuid,
  })
  .strict();
type Journal = NonNullable<
  Awaited<ReturnType<typeof readWalletWarmupSessionJournal>>
>;
type Row = {
  id: string;
  journal_id: string;
  action_id: string;
  side: 'Buy' | 'Sell';
  receipt_id: string;
  signature: string;
  mode: 'applied' | 'held';
  document: string;
  record_sha256: string;
  source: string;
  event_document: string;
  event_sha256: string;
  created_at: string;
};
export class WalletWarmupSettlementStorageError extends Error {
  constructor(
    message: string,
    readonly status = 409,
    readonly recoveryId?: string,
  ) {
    super(message);
  }
}
function fail(
  message = 'Verified settlement needs recovery by its original record ID.',
  status = 409,
  recoveryId?: string,
): never {
  throw new WalletWarmupSettlementStorageError(message, status, recoveryId);
}
function ownerId(owner: string) {
  if (typeof owner !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(owner))
    fail('Verified session owner required.', 400);
}
function time(value: number) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 8640000000000000 - WARMUP_SESSION_REVIEW_GAP_MS
  )
    fail();
  return new Date(value).toISOString();
}
async function installed(db: D1Database) {
  const row = await db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('wallet_warmup_session_settlements_insert','wallet_warmup_session_settlements_no_update','wallet_warmup_session_settlements_no_delete','wallet_warmup_session_settlements_apply')",
    )
    .first<{ n: number }>();
  if (row?.n !== 4) fail('Verified settlement storage is not installed.', 503);
}
function candidate(journal: Journal) {
  const pending = journal.snapshot.pending;
  if (!pending || !['submitted', 'unknown'].includes(pending.state))
    fail('Recover the original submitted action before recording its outcome.');
  const action = structuredClone(pending.action);
  let sellSource: null | {
    buyReceiptId: string;
    remainingRaw: string;
    decimals: number;
  } = null;
  if (action.side === 'Sell') {
    if (action.source.kind === 'saved-buy')
      sellSource = {
        buyReceiptId: action.source.buyReceiptId,
        remainingRaw: action.source.remainingRaw,
        decimals: action.source.decimals,
      };
    else {
      const previous = journal.events
        .map((e) => JSON.parse(e.document))
        .find(
          (e) =>
            e.operation === 'finalized' &&
            e.actionId ===
              (action.source.kind === 'session-buy'
                ? action.source.actionId
                : ''),
        );
      if (!previous) fail();
      const settled = parseWalletWarmupSessionSettlement(previous.settlement);
      if (settled.side !== 'Buy') fail();
      sellSource = {
        buyReceiptId: settled.receiptId,
        remainingRaw: settled.acquiredRaw,
        decimals: settled.decimals,
      };
    }
  }
  return {
    action,
    sellSource,
    executionAllowed: false as const,
    signingAllowed: false as const,
  };
}
function event(
  record: Awaited<ReturnType<typeof parseWalletWarmupSessionSettlementRecord>>,
  recordSha256: string,
) {
  return canonical({
    eventId: record.id,
    version: record.version + 1,
    previousSha256: record.headSha256,
    at: record.createdAt,
    operation: record.mode === 'applied' ? 'finalized' : 'unknown',
    actionId: record.actionId,
    proofSha256: recordSha256,
    ...(record.mode === 'applied' ? { settlement: record.settlement } : {}),
  });
}
/** Historical proof recovery only. It does not requalify source counters or authorize new work. */
export async function readWalletWarmupSessionSettlement(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
  now = Date.now(),
) {
  ownerId(owner);
  uuid.parse(id);
  time(now);
  signal.throwIfAborted();
  await installed(db);
  const row = await db
    .prepare(
      'SELECT * FROM wallet_warmup_session_settlements WHERE owner_id=? AND id=?',
    )
    .bind(owner, id)
    .first<Row>();
  signal.throwIfAborted();
  if (!row) return null;
  try {
    const record = await parseWalletWarmupSessionSettlementRecord(
      row.document,
      row.record_sha256,
      { owner, document: row.source },
    );
    const journal = await readWalletWarmupSessionJournal(
      db,
      owner,
      row.journal_id,
      signal,
      now,
    );
    const expectedEvent = event(record, row.record_sha256);
    const [source] = JSON.parse(row.source);
    if (
      !journal ||
      row.id !== record.id ||
      row.journal_id !== record.journalId ||
      row.action_id !== record.actionId ||
      row.side !== record.settlement.side ||
      row.receipt_id !== record.receiptId ||
      row.signature !== source.receiptSignature ||
      row.mode !== record.mode ||
      row.created_at !== record.createdAt ||
      Date.parse(record.createdAt) > now ||
      row.event_document !== expectedEvent ||
      row.event_sha256 !== (await digest(expectedEvent)) ||
      !journal.events.some(
        (e) =>
          e.id === record.id &&
          e.document === expectedEvent &&
          e.event_sha256 === row.event_sha256,
      )
    )
      fail();
    signal.throwIfAborted();
    // Neither raw stored packets nor the source blob leave this internal reader.
    return { record, recordSha256: row.record_sha256, journal };
  } catch {
    signal.throwIfAborted();
    return fail('Retained verified settlement is unavailable or differs.', 503);
  }
}
/**
 * Internal capture of an EXISTING finalized receipt. Verified owner only; never
 * accepts a client settlement/source/approval. No signing or transaction send.
 * One guarded INSERT retains the record and trigger-appends exactly one event/head.
 */
export async function retainWalletWarmupSessionSettlement(
  db: D1Database,
  owner: string,
  value: unknown,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
) {
  ownerId(owner);
  const input = selection.parse(value);
  signal.throwIfAborted();
  await installed(db);
  const prior = await readWalletWarmupSessionSettlement(
    db,
    owner,
    input.id,
    signal,
    clock(),
  );
  if (prior) {
    if (
      prior.record.journalId !== input.journalId ||
      prior.record.receiptId !== input.receiptId ||
      prior.record.version !== input.version ||
      prior.record.headSha256 !== input.headSha256
    )
      fail();
    return prior;
  }
  const observedAt = clock();
  time(observedAt);
  const current = await readWalletWarmupSessionJournal(
    db,
    owner,
    input.journalId,
    signal,
    observedAt,
  );
  if (
    !current ||
    current.version !== input.version ||
    current.headSha256 !== input.headSha256
  )
    fail('The journal changed. Recover its current original action.');
  const selectedCandidate = candidate(current);
  const binding = await readWalletWarmupSessionActionBinding(
    db,
    owner,
    current.id,
    selectedCandidate.action.id,
    signal,
  );
  const selectedSource = await db
    .prepare(warmupSessionSettlementSourceSql(selectedCandidate.action.side))
    .bind(owner, input.receiptId, current.plan.id)
    .first<{ preparationId: string; preparationDocument: string }>();
  signal.throwIfAborted();
  if (
    !binding ||
    !selectedSource ||
    binding.preparation_id !== selectedSource.preparationId ||
    binding.preparation_document !== selectedSource.preparationDocument ||
    binding.packet_sha256 !==
      JSON.parse(selectedSource.preparationDocument).transaction?.sha256
  )
    fail(
      'This receipt does not belong to the exact preparation bound to this action.',
    );
  let verified: Awaited<ReturnType<typeof replayWarmupSessionSettlement>>;
  try {
    verified = await replayWarmupSessionSettlement(
      db,
      owner,
      {
        planId: current.plan.id,
        planRevision: current.plan.revision,
        receiptId: input.receiptId,
        candidate: selectedCandidate,
      },
      signal,
      fetcher,
    );
  } catch {
    signal.throwIfAborted();
    return fail(
      'Finalized receipt verification is unavailable or refused. No transaction was retried.',
      503,
    );
  }
  signal.throwIfAborted();
  const guard = await warmupSessionSettlementSourceGuard(
    owner,
    verified.settlement.side,
    verified,
  );
  const at = clock(),
    createdAt = time(at);
  if (at < observedAt) fail();
  const common = {
    format: 'wallet-warmup-session-settlement-v1' as const,
    id: input.id,
    journalId: input.journalId,
    actionId: selectedCandidate.action.id,
    receiptId: input.receiptId,
    version: input.version,
    headSha256: input.headSha256,
    candidate: selectedCandidate,
    settlement: verified.settlement,
    sourceSha256: verified.sourceSha256,
    scope: verified.replayScope,
    createdAt,
    executionAllowed: false as const,
    signingAllowed: false as const,
    automaticExecutionAllowed: false as const,
  };
  async function prepare(mode: 'applied' | 'held') {
    const document = canonical({
      ...common,
      mode,
      reason: mode === 'applied' ? null : 'sequence-refused',
    });
    const sha256 = await digest(document);
    const record = await parseWalletWarmupSessionSettlementRecord(
      document,
      sha256,
      { owner, document: verified.sourceDocument },
    );
    const eventDocument = event(record, sha256),
      eventSha256 = await digest(eventDocument);
    return { document, sha256, record, eventDocument, eventSha256 };
  }
  let prepared = await prepare('applied');
  async function preview(value: typeof prepared) {
    return replayWalletWarmupSessionJournal(
      current!.sourceDocument,
      current!.plan,
      {
        ...current!.anchor,
        version: current!.version + 1,
        headSha256: value.eventSha256,
      },
      [...current!.events.map((e) => e.document), value.eventDocument],
      at,
    );
  }
  try {
    await preview(prepared);
  } catch (error) {
    const wallet = current.snapshot.wallets.find(
      (w) => w.wallet === verified.settlement.wallet,
    );
    const rent = BigInt(verified.settlement.rentChangeLamports);
    const cost =
      BigInt(verified.settlement.networkFeeLamports) + (rent > 0n ? rent : 0n);
    // Only a known fee/rent overrun may become a held outcome. Any other
    // replay refusal must remain an error, including future replay invariants.
    if (!wallet || cost <= BigInt(wallet.remainingReserveLamports)) throw error;
    prepared = await prepare('held');
    await preview(prepared);
  }
  signal.throwIfAborted();
  const beforeWrite = clock();
  time(beforeWrite);
  if (beforeWrite < at) fail();
  const [rootSource] = JSON.parse(verified.sourceDocument);
  try {
    await db
      .prepare(`INSERT INTO wallet_warmup_session_settlements(owner_id,id,journal_id,action_id,side,receipt_id,signature,mode,document,record_sha256,source,event_document,event_sha256,created_at)
   SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard.sql}`)
      .bind(
        owner,
        input.id,
        input.journalId,
        prepared.record.actionId,
        verified.settlement.side,
        input.receiptId,
        rootSource.receiptSignature,
        prepared.record.mode,
        prepared.document,
        prepared.sha256,
        verified.sourceDocument,
        prepared.eventDocument,
        prepared.eventSha256,
        createdAt,
        ...guard.bindings,
      )
      .run();
  } catch {
    /* Unknown write outcome: original-ID reads only; never another INSERT. */
  }
  const recoverySignal = AbortSignal.timeout(15000);
  const saved = await readWalletWarmupSessionSettlement(
    db,
    owner,
    input.id,
    recoverySignal,
    clock(),
  );
  signal.throwIfAborted();
  if (!saved) {
    const conflict = await db
      .prepare(
        'SELECT id FROM wallet_warmup_session_settlements WHERE owner_id=? AND ((journal_id=? AND action_id=?) OR (side=? AND receipt_id=?) OR signature=?) ORDER BY created_at,id LIMIT 1',
      )
      .bind(
        owner,
        input.journalId,
        selectedCandidate.action.id,
        verified.settlement.side,
        input.receiptId,
        rootSource.receiptSignature,
      )
      .first<{ id: string }>();
    if (conflict && uuid.safeParse(conflict.id).success)
      fail(
        'This action or receipt already has a verified outcome record. Recover its original ID.',
        409,
        conflict.id,
      );
    return fail();
  }
  if (
    saved.record.journalId !== input.journalId ||
    saved.record.receiptId !== input.receiptId ||
    saved.record.version !== input.version ||
    saved.record.headSha256 !== input.headSha256
  )
    fail();
  signal.throwIfAborted();
  return saved;
}
