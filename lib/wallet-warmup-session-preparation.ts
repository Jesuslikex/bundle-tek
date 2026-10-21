import { z } from 'zod';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import { readWalletWarmupSessionJournal } from './wallet-warmup-session-journal-storage';
import { readWalletWarmupSessionActionBinding } from './wallet-warmup-session-action-binding';
import { parseWalletWarmupSessionSettlement } from './wallet-warmup-session-sequence';
import {
  warmupPreparationHistoryDocument,
  type WarmupPreparationSummary,
} from './warmup-preparation-history';
import type { WarmupSessionAction } from './wallet-warmup-session-review';

const uuid = z.uuid().refine((v) => v === v.toLowerCase()),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const inputSchema = z
  .object({
    id: uuid,
    journalId: uuid,
    version: z.number().int().min(1).max(4095),
    headSha256: hash,
  })
  .strict();
const rowSchema = z
  .object({
    owner_id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
    preparation_id: uuid,
    journal_id: uuid,
    action_id: z.string().min(1).max(256),
    review_version: z.number().int().min(1).max(4095),
    review_sha256: hash,
    plan_id: z.string().max(64),
    plan_revision: z.number().int().positive(),
    cycle: z.number().int().min(1).max(20),
    wallet_address: z.string().max(64),
    wallet_revision: z.number().int().positive(),
    preparation_document: z.string().max(8192),
    plan_document: z.string().max(1048576),
    created_at: z.iso.datetime().refine((v) => new Date(v).toISOString() === v),
    binding_sha256: hash,
    record_sha256: hash,
  })
  .strict();
type Row = z.infer<typeof rowSchema>;
type Candidate = {
  action: WarmupSessionAction;
  sellSource: null | {
    buyReceiptId: string;
    remainingRaw: string;
    decimals: number;
  };
};
export class WalletWarmupSessionPreparationError extends Error {
  constructor(
    message = 'Recover the original session preparation. No signing is enabled.',
    readonly status = 409,
    readonly recoveryId?: string,
  ) {
    super(message);
  }
}
function fail(message?: string, status?: number, recoveryId?: string): never {
  throw new WalletWarmupSessionPreparationError(message, status, recoveryId);
}
function ownerId(owner: string) {
  if (typeof owner !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(owner))
    fail(undefined, 400);
}
async function installed(db: D1Database) {
  const row = await db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('wallet_warmup_session_preparations_insert','wallet_warmup_session_preparations_apply','wallet_warmup_session_preparations_no_update','wallet_warmup_session_preparations_no_delete','warmup_session_preparations_no_update','warmup_session_preparations_no_delete','warmup_session_preparations_no_replace','warmup_session_bound_intents_disabled')",
    )
    .first<{ n: number }>();
  if (row?.n !== 8) fail('Session preparation storage is unavailable.', 503);
}
async function parse(row: Row) {
  const value = rowSchema.parse(row),
    { record_sha256, ...facts } = value;
  if ((await digest(canonical(facts))) !== record_sha256) fail(undefined, 503);
  return value;
}
/** Server-internal recovery only. No private transaction, authorization or runtime grant. */
export async function readWalletWarmupSessionPreparation(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
) {
  ownerId(owner);
  uuid.parse(id);
  signal.throwIfAborted();
  await installed(db);
  const stored = await db
    .prepare(
      'SELECT * FROM wallet_warmup_session_preparations WHERE owner_id=? AND preparation_id=?',
    )
    .bind(owner, id)
    .first<Row>();
  signal.throwIfAborted();
  if (!stored) return null;
  const row = await parse(stored),
    binding = await readWalletWarmupSessionActionBinding(
      db,
      owner,
      row.journal_id,
      row.action_id,
      signal,
    );
  const prep = await db
    .prepare(
      'SELECT plan_id,plan_revision,cycle,wallet_address,wallet_revision,document,created_at FROM warmup_swap_preparations WHERE owner_id=? AND id=?',
    )
    .bind(owner, id)
    .first<{
      plan_id: string;
      plan_revision: number;
      cycle: number;
      wallet_address: string;
      wallet_revision: number;
      document: string;
      created_at: string;
    }>();
  signal.throwIfAborted();
  if (
    !binding ||
    !prep ||
    binding.preparation_id !== id ||
    binding.binding_sha256 !== row.binding_sha256 ||
    binding.preparation_document !== row.preparation_document ||
    binding.review_version !== row.review_version ||
    binding.review_sha256 !== row.review_sha256 ||
    binding.created_at !== row.created_at ||
    prep.plan_id !== row.plan_id ||
    prep.plan_revision !== row.plan_revision ||
    prep.cycle !== row.cycle ||
    prep.wallet_address !== row.wallet_address ||
    prep.wallet_revision !== row.wallet_revision ||
    prep.document !== row.preparation_document ||
    prep.created_at !== row.created_at
  )
    fail(undefined, 503);
  return {
    identity: row,
    preparation: {
      id,
      planId: row.plan_id,
      planRevision: row.plan_revision,
      cycle: row.cycle,
      walletRevision: row.wallet_revision,
      createdAt: row.created_at,
      document: JSON.parse(
        row.preparation_document,
      ) as WarmupPreparationSummary,
    },
    executionAllowed: false as const,
    signingAllowed: false as const,
    automaticExecutionAllowed: false as const,
  };
}
/**
 * A trusted server callback prepares the exact derived action without persisting
 * anything. One INSERT then creates its preparation AND immutable binding via
 * triggers. Never accept the callback/document from an HTTP request.
 */
export async function prepareWalletWarmupSessionAction(
  db: D1Database,
  owner: string,
  value: unknown,
  signal: AbortSignal,
  prepare: (
    candidate: Candidate,
    signal: AbortSignal,
  ) => Promise<WarmupPreparationSummary>,
  clock: () => number = Date.now,
) {
  ownerId(owner);
  const input = inputSchema.parse(value);
  signal.throwIfAborted();
  await installed(db);
  const prior = await readWalletWarmupSessionPreparation(
    db,
    owner,
    input.id,
    signal,
  );
  if (prior) {
    if (
      prior.identity.journal_id !== input.journalId ||
      prior.identity.review_version !== input.version ||
      prior.identity.review_sha256 !== input.headSha256
    )
      fail();
    return prior;
  }
  const at = clock();
  if (!Number.isSafeInteger(at) || at < 0) fail();
  const journal = await readWalletWarmupSessionJournal(
      db,
      owner,
      input.journalId,
      signal,
      at,
    ),
    pending = journal?.snapshot.pending;
  if (
    !journal ||
    journal.version !== input.version ||
    journal.headSha256 !== input.headSha256 ||
    pending?.state !== 'reviewing' ||
    journal.snapshot.paused ||
    journal.snapshot.stopped ||
    !journal.snapshot.sourceReviewFresh
  )
    fail();
  const existing = await readWalletWarmupSessionActionBinding(
    db,
    owner,
    journal.id,
    pending.action.id,
    signal,
  );
  if (existing)
    fail(
      'This action already has a preparation. Recover its original ID.',
      409,
      existing.preparation_id,
    );
  const plan = await db
    .prepare(
      'SELECT document FROM wallet_warmup_plans WHERE owner_id=? AND id=? AND revision=? AND archived=0',
    )
    .bind(owner, journal.plan.id, journal.plan.revision)
    .first<{ document: string }>();
  if (
    !plan ||
    canonical(JSON.parse(plan.document)) !== canonical(journal.plan.document)
  )
    fail();
  const action = structuredClone(pending.action);
  let sellSource: Candidate['sellSource'] = null;
  if (action.side === 'Sell') {
    if (action.source.kind === 'saved-buy')
      sellSource = {
        buyReceiptId: action.source.buyReceiptId,
        remainingRaw: action.source.remainingRaw,
        decimals: action.source.decimals,
      };
    else {
      const sourceId = action.source.actionId;
      const event = journal.events
        .map((e) => JSON.parse(e.document))
        .find((e) => e.operation === 'finalized' && e.actionId === sourceId);
      if (!event) fail();
      const settled = parseWalletWarmupSessionSettlement(event.settlement);
      if (settled.side !== 'Buy') fail();
      sellSource = {
        buyReceiptId: settled.receiptId,
        remainingRaw: settled.acquiredRaw,
        decimals: settled.decimals,
      };
    }
  }
  signal.throwIfAborted();
  const document = await prepare(
    structuredClone({ action, sellSource }),
    signal,
  );
  signal.throwIfAborted();
  const text = warmupPreparationHistoryDocument(
    {
      planId: journal.plan.id,
      planRevision: journal.plan.revision,
      cycle: action.cycle,
      walletRevision: action.walletRevision,
    },
    document,
    plan.document,
  );
  const now = clock();
  if (
    !Number.isSafeInteger(now) ||
    now < at ||
    now >= Date.parse(JSON.parse(journal.sourceDocument).reviewExpiresAt)
  )
    fail();
  const createdAt = new Date(now).toISOString(),
    bindingFacts = {
      owner_id: owner,
      journal_id: journal.id,
      action_id: action.id,
      preparation_id: input.id,
      preparation_document: text,
      packet_sha256: hash.parse(document.transaction.sha256),
      review_version: input.version,
      review_sha256: input.headSha256,
      created_at: createdAt,
    };
  const facts = {
    owner_id: owner,
    preparation_id: input.id,
    journal_id: journal.id,
    action_id: action.id,
    review_version: input.version,
    review_sha256: input.headSha256,
    plan_id: journal.plan.id,
    plan_revision: journal.plan.revision,
    cycle: action.cycle,
    wallet_address: action.wallet,
    wallet_revision: action.walletRevision,
    preparation_document: text,
    plan_document: plan.document,
    created_at: createdAt,
    binding_sha256: await digest(canonical(bindingFacts)),
  };
  const row = await parse({
    ...facts,
    record_sha256: await digest(canonical(facts)),
  });
  signal.throwIfAborted();
  try {
    await db
      .prepare(
        'INSERT INTO wallet_warmup_session_preparations(owner_id,preparation_id,journal_id,action_id,review_version,review_sha256,plan_id,plan_revision,cycle,wallet_address,wallet_revision,preparation_document,plan_document,created_at,binding_sha256,record_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        row.owner_id,
        row.preparation_id,
        row.journal_id,
        row.action_id,
        row.review_version,
        row.review_sha256,
        row.plan_id,
        row.plan_revision,
        row.cycle,
        row.wallet_address,
        row.wallet_revision,
        row.preparation_document,
        row.plan_document,
        row.created_at,
        row.binding_sha256,
        row.record_sha256,
      )
      .run();
  } catch {
    /* Unknown outcome: one original-ID recovery, never another INSERT/callback. */
  }
  const saved = await readWalletWarmupSessionPreparation(
    db,
    owner,
    input.id,
    AbortSignal.timeout(15000),
  );
  signal.throwIfAborted();
  if (!saved) {
    const conflict = await readWalletWarmupSessionActionBinding(
      db,
      owner,
      journal.id,
      action.id,
      signal,
    );
    fail(undefined, 409, conflict?.preparation_id);
  }
  const {
    created_at: _savedAt,
    binding_sha256: _savedBinding,
    record_sha256: _savedHash,
    ...savedIdentity
  } = saved.identity;
  const {
    created_at: _attemptAt,
    binding_sha256: _attemptBinding,
    record_sha256: _attemptHash,
    ...attemptIdentity
  } = row;
  if (canonical(savedIdentity) !== canonical(attemptIdentity)) fail();
  return saved;
}
