import { z } from 'zod';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import { readWalletWarmupSessionJournal } from './wallet-warmup-session-journal-storage';

const uuid = z.uuid().refine((v) => v === v.toLowerCase());
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const selection = z
  .object({
    journalId: uuid,
    version: z.number().int().min(1).max(4095),
    headSha256: hash,
    preparationId: uuid,
  })
  .strict();
const schema = z
  .object({
    owner_id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
    journal_id: uuid,
    action_id: z.string().min(1).max(256),
    preparation_id: uuid,
    preparation_document: z.string().max(8192),
    packet_sha256: hash,
    review_version: z.number().int().min(1).max(4095),
    review_sha256: hash,
    created_at: z.iso.datetime().refine((v) => new Date(v).toISOString() === v),
    binding_sha256: hash,
  })
  .strict();
type Binding = z.infer<typeof schema>;
function fail(): never {
  throw Error(
    'Recover the exact action preparation binding. No signing is authorized.',
  );
}
function ownerId(owner: string) {
  if (typeof owner !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(owner))
    fail();
}
async function installed(db: D1Database) {
  const row = await db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('wallet_warmup_session_action_bindings_insert','wallet_warmup_session_action_bindings_no_update','wallet_warmup_session_action_bindings_no_delete','wallet_warmup_session_settlements_action_binding')",
    )
    .first<{ n: number }>();
  if (row?.n !== 4) fail();
}
async function parse(row: Binding) {
  const value = schema.parse(row);
  const { binding_sha256, ...facts } = value;
  if (
    (await digest(canonical(facts))) !== binding_sha256 ||
    JSON.parse(value.preparation_document).transaction?.sha256 !==
      value.packet_sha256
  )
    fail();
  return value;
}
/** Internal historical identity only. Never an approval, runtime proof or API DTO. */
export async function readWalletWarmupSessionActionBinding(
  db: D1Database,
  owner: string,
  journalId: string,
  actionId: string,
  signal: AbortSignal,
) {
  ownerId(owner);
  uuid.parse(journalId);
  signal.throwIfAborted();
  await installed(db);
  const row = await db
    .prepare(
      'SELECT * FROM wallet_warmup_session_action_bindings WHERE owner_id=? AND journal_id=? AND action_id=?',
    )
    .bind(owner, journalId, actionId)
    .first<Binding>();
  signal.throwIfAborted();
  const saved = row ? await parse(row) : null;
  signal.throwIfAborted();
  return saved;
}
/**
 * Reserve an unsigned preparation identity while this exact action is reviewing,
 * BEFORE any intent/signature/receipt exists. One immutable preparation per action
 * and one action per preparation. This creates no signing/execution authority.
 */
export async function retainWalletWarmupSessionActionBinding(
  db: D1Database,
  owner: string,
  value: unknown,
  signal: AbortSignal,
  clock: () => number = Date.now,
) {
  ownerId(owner);
  const input = selection.parse(value);
  signal.throwIfAborted();
  await installed(db);
  const prior = await db
    .prepare(
      'SELECT * FROM wallet_warmup_session_action_bindings WHERE owner_id=? AND journal_id=? AND review_version=?',
    )
    .bind(owner, input.journalId, input.version)
    .first<Binding>();
  signal.throwIfAborted();
  if (prior) {
    const saved = await parse(prior);
    if (
      saved.preparation_id !== input.preparationId ||
      saved.review_sha256 !== input.headSha256
    )
      fail();
    return saved;
  }
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) fail();
  const createdAt = new Date(now).toISOString();
  const journal = await readWalletWarmupSessionJournal(
    db,
    owner,
    input.journalId,
    signal,
    now,
  );
  const pending = journal?.snapshot.pending;
  if (
    !journal ||
    journal.version !== input.version ||
    journal.headSha256 !== input.headSha256 ||
    pending?.state !== 'reviewing' ||
    journal.snapshot.stopped ||
    journal.snapshot.paused ||
    !journal.snapshot.sourceReviewFresh
  )
    fail();
  const prep = await db
    .prepare(
      'SELECT document FROM warmup_swap_preparations WHERE owner_id=? AND id=?',
    )
    .bind(owner, input.preparationId)
    .first<{ document: string }>();
  signal.throwIfAborted();
  if (!prep || new TextEncoder().encode(prep.document).byteLength > 8192)
    fail();
  const facts = {
    owner_id: owner,
    journal_id: input.journalId,
    action_id: pending.action.id,
    preparation_id: input.preparationId,
    preparation_document: prep.document,
    packet_sha256: hash.parse(JSON.parse(prep.document).transaction?.sha256),
    review_version: input.version,
    review_sha256: input.headSha256,
    created_at: createdAt,
  };
  const row = await parse({
    ...facts,
    binding_sha256: await digest(canonical(facts)),
  });
  signal.throwIfAborted();
  const beforeWrite = clock();
  if (
    !Number.isSafeInteger(beforeWrite) ||
    beforeWrite < now ||
    beforeWrite >=
      Date.parse(JSON.parse(journal.sourceDocument).reviewExpiresAt)
  )
    fail();
  try {
    await db
      .prepare(
        'INSERT INTO wallet_warmup_session_action_bindings(owner_id,journal_id,action_id,preparation_id,preparation_document,packet_sha256,review_version,review_sha256,created_at,binding_sha256) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        row.owner_id,
        row.journal_id,
        row.action_id,
        row.preparation_id,
        row.preparation_document,
        row.packet_sha256,
        row.review_version,
        row.review_sha256,
        row.created_at,
        row.binding_sha256,
      )
      .run();
  } catch {
    /* Unknown write: same identity recovery only, never another INSERT. */
  }
  const recovered = await readWalletWarmupSessionActionBinding(
    db,
    owner,
    input.journalId,
    pending.action.id,
    AbortSignal.timeout(15000),
  );
  signal.throwIfAborted();
  if (!recovered || recovered.binding_sha256 !== row.binding_sha256) fail();
  return recovered;
}
