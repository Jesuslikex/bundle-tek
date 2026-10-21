import { readWalletWarmupSessionPreparation } from './wallet-warmup-session-preparation';
import { readWalletWarmupSessionJournal } from './wallet-warmup-session-journal-storage';
import { replayWalletWarmupSessionJournal } from './wallet-warmup-session-replay';
import { publicWalletWarmupSessionJournal } from './wallet-warmup-session-journal-public';
import { publicWalletWarmupSessionPreparation } from './wallet-warmup-session-preparation-public';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';

function fail(): never {
  throw Error(
    'Saved unsigned preparation context is unavailable or differs. Nothing was renewed or sent.',
  );
}
/** Owner-scoped SELECT/replay only. Verify the COMPLETE stored journal before deriving
 * the exact historical prefix named by the immutable preparation binding. */
export async function readWalletWarmupSessionPreparationRecovery(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
  now = Date.now(),
) {
  const retained = await readWalletWarmupSessionPreparation(
    db,
    owner,
    id,
    signal,
  );
  signal.throwIfAborted();
  if (!retained) return null;
  const facts = retained.identity;
  const current = await readWalletWarmupSessionJournal(
    db,
    owner,
    facts.journal_id,
    signal,
    now,
  );
  if (!current) fail();
  const events = current.events.slice(0, facts.review_version),
    last = events.at(-1);
  const created = Date.parse(retained.preparation.createdAt);
  if (
    events.length !== facts.review_version ||
    !last ||
    last.version !== facts.review_version ||
    last.event_sha256 !== facts.review_sha256 ||
    Date.parse(last.created_at) > created ||
    created > now ||
    created < Date.parse(current.createdAt) ||
    created >= Date.parse(current.effectiveReviewExpiresAt) ||
    current.plan.id !== facts.plan_id ||
    current.plan.revision !== facts.plan_revision ||
    canonical(JSON.parse(facts.plan_document)) !==
      canonical(current.plan.document)
  )
    fail();
  const anchor = {
    ...current.anchor,
    version: facts.review_version,
    headSha256: facts.review_sha256,
  };
  const state = await replayWalletWarmupSessionJournal(
    current.sourceDocument,
    current.plan,
    anchor,
    events.map((e) => e.document),
    now,
  );
  signal.throwIfAborted();
  const a = state.snapshot.pending?.action,
    p = retained.preparation,
    d = p.document;
  if (
    state.snapshot.pending?.state !== 'reviewing' ||
    state.snapshot.paused ||
    state.snapshot.stopped ||
    !a ||
    a.id !== facts.action_id ||
    a.wallet !== facts.wallet_address ||
    a.walletRevision !== facts.wallet_revision ||
    a.cycle !== facts.cycle ||
    a.side !== d.side ||
    a.wallet !== d.wallet ||
    a.mint !== (d.side === 'Buy' ? d.outputMint : d.inputMint)
  )
    fail();
  const original = {
    ...current,
    ...state,
    anchor,
    events,
    snapshot: {
      ...state.snapshot,
      sourceReviewFresh:
        state.snapshot.sourceReviewFresh &&
        now < Date.parse(current.effectiveReviewExpiresAt),
    },
  };
  // No packet bytes, source documents, event/proof rows or mutable sequence escape.
  return {
    readOnly: true as const,
    preparation: publicWalletWarmupSessionPreparation(retained),
    originalJournal: publicWalletWarmupSessionJournal(original),
    currentJournal: publicWalletWarmupSessionJournal(current),
  };
}

/** Find only the authenticated journal's current pending action, never an action
 * chosen by the client. A concurrent move to another action fails closed. */
export async function findWalletWarmupSessionPreparationRecovery(
  db: D1Database,
  owner: string,
  journalId: string,
  signal: AbortSignal,
  now = Date.now(),
) {
  const journal = await readWalletWarmupSessionJournal(
    db,
    owner,
    journalId,
    signal,
    now,
  );
  signal.throwIfAborted();
  const action = journal?.snapshot.pending?.action;
  if (!journal || !action) return null;
  const row = await db
    .prepare(
      'SELECT preparation_id FROM wallet_warmup_session_preparations WHERE owner_id=? AND journal_id=? AND action_id=?',
    )
    .bind(owner, journalId, action.id)
    .first<{ preparation_id: string }>();
  signal.throwIfAborted();
  if (!row) return null;
  const recovery = await readWalletWarmupSessionPreparationRecovery(
    db,
    owner,
    row.preparation_id,
    signal,
    now,
  );
  if (
    !recovery ||
    recovery.currentJournal.id !== journalId ||
    recovery.currentJournal.snapshot.pending?.action.id !== action.id ||
    recovery.originalJournal.snapshot.pending?.action.id !== action.id
  )
    fail();
  return recovery;
}
