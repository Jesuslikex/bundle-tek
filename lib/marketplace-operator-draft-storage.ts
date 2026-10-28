import { readMarketplaceOwnedInventory } from './marketplace-owned-inventory-server';
import {
  reviewOperatorListing,
  OPERATOR_REVIEW_WINDOW_MS,
} from './marketplace-operator-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import {
  admitOperatorDraft,
  operatorDraftCanonical as canonical,
  operatorDraftSave,
  operatorDraftId,
  type OperatorDraftSave,
  type OperatorDraftRecord,
} from './marketplace-operator-draft-view';

export class OperatorDraftStorageError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
const fail = (message: string, status = 409): never => {
  throw new OperatorDraftStorageError(message, status);
};
type Row = {
  owner_id: string;
  id: string;
  wallet_address: string;
  wallet_revision: number;
  review_sha256: string;
  document: string;
  created_at: string;
};
async function installed(db: D1Database) {
  const row = await db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('marketplace_operator_drafts_insert','marketplace_operator_drafts_no_update','marketplace_operator_drafts_no_delete')",
    )
    .first<{ n: number }>();
  if (row?.n !== 3)
    fail(
      'Listing draft storage is not installed. No draft was published.',
      503,
    );
}
function ownerId(owner: string) {
  if (typeof owner !== 'string' || owner.length < 1 || owner.length > 256)
    fail('Sign in to use listing drafts.', 401);
}
async function read(
  db: D1Database,
  owner: string,
  id: string,
  now = Date.now(),
) {
  const row = await db
    .prepare(
      'SELECT * FROM marketplace_operator_drafts WHERE owner_id=? AND id=?',
    )
    .bind(owner, id)
    .first<Row>();
  if (!row) return null;
  try {
    if (
      row.owner_id !== owner ||
      row.id !== id ||
      new TextEncoder().encode(row.document).byteLength > 16384
    )
      throw Error('Invalid row');
    const record = await admitOperatorDraft(
      JSON.parse(row.document),
      undefined,
      now,
    );
    if (
      record.id !== row.id ||
      record.createdAt !== row.created_at ||
      record.reviewSha256 !== row.review_sha256 ||
      record.review.selection.address !== row.wallet_address ||
      record.review.selection.walletRevision !== row.wallet_revision
    )
      throw Error('Invalid row');
    return record;
  } catch {
    return fail('Saved listing draft is unavailable or inconsistent.', 503);
  }
}
export async function readOperatorDraft(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
  now = Date.now(),
) {
  ownerId(owner);
  operatorDraftId.parse(id);
  signal.throwIfAborted();
  await installed(db);
  signal.throwIfAborted();
  const result = await read(db, owner, id, now);
  signal.throwIfAborted();
  return result;
}
/** Historical draft retention only. Operator authorization belongs to every calling route. */
export async function saveOperatorDraft(
  db: D1Database,
  owner: string,
  input: OperatorDraftSave,
  signal: AbortSignal,
  clock: () => number = Date.now,
): Promise<OperatorDraftRecord> {
  ownerId(owner);
  const selection = operatorDraftSave.parse(input);
  signal.throwIfAborted();
  await installed(db);
  signal.throwIfAborted();
  const prior = await read(db, owner, selection.id, clock());
  signal.throwIfAborted();
  if (prior) {
    try {
      return await admitOperatorDraft(prior, selection, clock());
    } catch {
      return fail(
        'This draft ID already belongs to different contents. Recover the original ID.',
      );
    }
  }
  const at = Date.parse(selection.reviewedAt),
    now = clock();
  if (at > now || now - at >= OPERATOR_REVIEW_WINDOW_MS)
    fail('Listing review expired. Request a fresh review.');
  const inventory = await readMarketplaceOwnedInventory(db, owner, signal);
  signal.throwIfAborted();
  let review;
  try {
    review = await reviewOperatorListing(
      inventory,
      selection.selection,
      clock(),
      at,
    );
  } catch {
    return fail(
      'Wallet evidence changed or the review expired. Reload inventory and review again.',
    );
  }
  if (
    review.requestSha256 !== selection.requestSha256 ||
    review.evidenceSha256 !== selection.evidenceSha256
  )
    fail(
      'Wallet evidence or asking price changed. Reload inventory and review again.',
    );
  const record: OperatorDraftRecord = {
    format: 'bundle-operator-draft-v1',
    id: selection.id,
    createdAt: new Date(clock()).toISOString(),
    sourceObservedAt: inventory.observedAt,
    acknowledgement: selection.acknowledgement,
    review,
    reviewSha256: await digest(canonical(review)),
    publicationAllowed: false,
    paymentAllowed: false,
    deliveryAllowed: false,
    signingAllowed: false,
  };
  await admitOperatorDraft(record, selection, clock());
  const document = canonical(record);
  if (new TextEncoder().encode(document).byteLength > 16384)
    fail('Listing draft exceeds storage capacity.');
  signal.throwIfAborted();
  if (clock() >= at + OPERATOR_REVIEW_WINDOW_MS)
    fail('Listing review expired. Request a fresh review.');
  try {
    await db
      .prepare(
        'INSERT INTO marketplace_operator_drafts(owner_id,id,wallet_address,wallet_revision,review_sha256,document,created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .bind(
        owner,
        record.id,
        review.selection.address,
        review.selection.walletRevision,
        record.reviewSha256,
        document,
        record.createdAt,
      )
      .run();
  } catch (error) {
    // No retry or replacement ID after an ambiguous write.
    const prior = await read(db, owner, selection.id, clock());
    if (prior) {
      try {
        return await admitOperatorDraft(prior, selection, clock());
      } catch {
        return fail('This draft ID belongs to different saved contents.');
      }
    }
    const conflict =
      error instanceof Error &&
      /constraint|Invalid unpublished|Marketplace draft|UNIQUE/i.test(
        error.message,
      );
    return fail(
      conflict
        ? 'Draft was already retained or the wallet changed. Recover the original ID or request a fresh review.'
        : 'Draft save outcome is unknown. Recover the same draft ID before saving again.',
      conflict ? 409 : 503,
    );
  }
  signal.throwIfAborted();
  const retained = await read(db, owner, selection.id, clock());
  if (!retained)
    return fail(
      'Draft save outcome is unknown. Recover the same draft ID before saving again.',
      503,
    );
  return admitOperatorDraft(retained, selection, clock());
}
