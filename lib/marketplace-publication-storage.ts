import { configuredMarketplaceOperators } from './marketplace-operator-policy';
import {
  readOperatorDraft,
  OperatorDraftStorageError,
} from './marketplace-operator-draft-storage';
import {
  admitOperatorDraft,
  operatorDraftId,
  operatorDraftCanonical as canonical,
} from './marketplace-operator-draft-view';
import { readMarketplaceOwnedInventory } from './marketplace-owned-inventory-server';
import {
  reviewPublication,
  admitPublicationRecord,
  publicationRequest,
  withdrawalRequest,
  WITHDRAWAL_ACK,
  admitBundleCatalog,
  type PublicationRecord,
  type PublicationRequest,
} from './marketplace-publication';
const fail = (message: string, status = 409): never => {
  throw new OperatorDraftStorageError(message, status);
};
const select =
  'SELECT p.*,d.document AS draft_document,d.review_sha256 AS parent_sha256,x.withdrawn_at,x.context_sha256 AS withdrawal_sha256,x.acknowledgement AS withdrawal_ack FROM marketplace_publications p JOIN marketplace_operator_drafts d ON d.owner_id=p.owner_id AND d.id=p.draft_id LEFT JOIN marketplace_withdrawals x ON x.owner_id=p.owner_id AND x.publication_id=p.id';
type Row = {
  id: string;
  owner_id: string;
  draft_id: string;
  draft_sha256: string;
  wallet_address: string;
  context_sha256: string;
  document: string;
  published_at: string;
  draft_document: string;
  parent_sha256: string;
  withdrawn_at: string | null;
  withdrawal_sha256: string | null;
  withdrawal_ack: string | null;
};
async function installed(db: D1Database) {
  const found = await db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('marketplace_publications_insert','marketplace_publications_no_update','marketplace_publications_no_delete','marketplace_withdrawals_insert','marketplace_withdrawals_no_update','marketplace_withdrawals_no_delete')",
    )
    .first<{ n: number }>();
  if (found?.n !== 6)
    fail('Marketplace publication storage is not installed.', 503);
}
async function decode(row: Row, now: number) {
  try {
    if (
      new TextEncoder().encode(row.document).byteLength > 16384 ||
      new TextEncoder().encode(row.draft_document).byteLength > 16384
    )
      throw Error('Capacity');
    const draft = await admitOperatorDraft(
        JSON.parse(row.draft_document),
        undefined,
        now,
      ),
      document = JSON.parse(row.document) as PublicationRecord;
    if (
      document.withdrawnAt !== null ||
      draft.id !== row.draft_id ||
      draft.reviewSha256 !== row.parent_sha256 ||
      row.draft_sha256 !== row.parent_sha256 ||
      document.id !== row.id ||
      document.publishedAt !== row.published_at ||
      document.preview.contextSha256 !== row.context_sha256 ||
      document.preview.listing.address !== row.wallet_address ||
      (row.withdrawn_at !== null &&
        (row.withdrawal_sha256 !== row.context_sha256 ||
          row.withdrawal_ack !== WITHDRAWAL_ACK))
    )
      throw Error('Binding');
    return await admitPublicationRecord(
      { ...document, withdrawnAt: row.withdrawn_at },
      draft,
      undefined,
      now,
    );
  } catch {
    return fail(
      'Stored marketplace publication is unavailable or inconsistent.',
      503,
    );
  }
}
async function read(
  db: D1Database,
  owner: string,
  id: string,
  now = Date.now(),
) {
  const row = await db
    .prepare(select + ' WHERE p.owner_id=? AND p.id=?')
    .bind(owner, id)
    .first<Row>();
  return row ? decode(row, now) : null;
}
export async function readPublication(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
) {
  operatorDraftId.parse(id);
  signal.throwIfAborted();
  await installed(db);
  const value = await read(db, owner, id);
  signal.throwIfAborted();
  return value;
}
export async function readPublicationForDraft(
  db: D1Database,
  owner: string,
  draftId: string,
  signal: AbortSignal,
) {
  operatorDraftId.parse(draftId);
  signal.throwIfAborted();
  await installed(db);
  const row = await db
    .prepare(select + ' WHERE p.owner_id=? AND p.draft_id=?')
    .bind(owner, draftId)
    .first<Row>();
  const value = row ? await decode(row, Date.now()) : null;
  signal.throwIfAborted();
  return value;
}
export async function previewPublication(
  db: D1Database,
  owner: string,
  draftId: string,
  signal: AbortSignal,
  at?: number,
) {
  signal.throwIfAborted();
  await installed(db);
  const draft = await readOperatorDraft(db, owner, draftId, signal);
  if (!draft) return fail('Saved draft not found for this operator.', 404);
  if (draft.review.evidence.ownershipProofAt === null)
    return fail(
      'Verify control of this wallet, then save a fresh listing draft before publication.',
      422,
    );
  const inventory = await readMarketplaceOwnedInventory(db, owner, signal),
    now = Date.now();
  try {
    return {
      draft,
      preview: await reviewPublication(draft, inventory, now, at ?? now),
    };
  } catch {
    return fail(
      'Wallet evidence changed or publication review expired. Save a fresh draft before publishing.',
    );
  }
}
export async function publishListing(
  db: D1Database,
  owner: string,
  value: PublicationRequest,
  signal: AbortSignal,
) {
  const input = publicationRequest.parse(value);
  signal.throwIfAborted();
  await installed(db);
  const prior = await read(db, owner, input.id);
  signal.throwIfAborted();
  if (prior) {
    if (
      prior.preview.draftId !== input.draftId ||
      prior.preview.contextSha256 !== input.contextSha256 ||
      prior.preview.reviewedAt !== input.reviewedAt
    )
      fail('This publication ID belongs to different contents.');
    return prior;
  }
  const { draft, preview } = await previewPublication(
    db,
    owner,
    input.draftId,
    signal,
    Date.parse(input.reviewedAt),
  );
  if (preview.contextSha256 !== input.contextSha256)
    fail('Publication review changed. Request a fresh review.');
  const record: PublicationRecord = {
    format: 'bundle-publication-v1',
    id: input.id,
    publishedAt: new Date().toISOString(),
    preview,
    acknowledgement: input.acknowledgement,
    withdrawnAt: null,
  };
  await admitPublicationRecord(record, draft, input);
  signal.throwIfAborted();
  if (Date.now() >= Date.parse(preview.expiresAt))
    fail('Publication review expired. Request a fresh review.');
  try {
    await db
      .prepare(
        'INSERT INTO marketplace_publications(id,owner_id,draft_id,draft_sha256,wallet_address,context_sha256,document,published_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .bind(
        input.id,
        owner,
        input.draftId,
        draft.reviewSha256,
        preview.listing.address,
        preview.contextSha256,
        canonical(record),
        record.publishedAt,
      )
      .run();
  } catch (error) {
    const found = await read(db, owner, input.id);
    if (
      found &&
      found.preview.contextSha256 === input.contextSha256 &&
      found.preview.draftId === input.draftId
    )
      return found;
    const conflict =
      error instanceof Error &&
      /constraint|marketplace publication|Marketplace publication|UNIQUE/i.test(
        error.message,
      );
    return fail(
      conflict
        ? 'The draft, wallet or active listing changed. Recover the same publication ID before another review.'
        : 'Publication outcome is unknown. Recover the same publication ID; do not publish again.',
      conflict ? 409 : 503,
    );
  }
  signal.throwIfAborted();
  const saved = await read(db, owner, input.id);
  if (!saved)
    return fail(
      'Publication outcome is unknown. Recover the same publication ID.',
      503,
    );
  return saved;
}
export async function withdrawListing(
  db: D1Database,
  owner: string,
  value: unknown,
  signal: AbortSignal,
) {
  const input = withdrawalRequest.parse(value);
  signal.throwIfAborted();
  await installed(db);
  const publication = await read(db, owner, input.id);
  if (!publication)
    return fail('Publication not found for this operator.', 404);
  if (publication.preview.contextSha256 !== input.contextSha256)
    fail('Withdraw the exact current publication.');
  if (publication.withdrawnAt) return publication;
  signal.throwIfAborted();
  try {
    await db
      .prepare(
        'INSERT INTO marketplace_withdrawals(owner_id,publication_id,context_sha256,withdrawn_at,acknowledgement) VALUES(?,?,?,?,?)',
      )
      .bind(
        owner,
        input.id,
        input.contextSha256,
        new Date().toISOString(),
        input.acknowledgement,
      )
      .run();
  } catch {
    const found = await read(db, owner, input.id);
    if (found?.withdrawnAt) return found;
    return fail(
      'Withdrawal outcome is unknown. Recover the same publication ID.',
      503,
    );
  }
  signal.throwIfAborted();
  const saved = await read(db, owner, input.id);
  if (!saved?.withdrawnAt)
    return fail(
      'Withdrawal outcome is unknown. Recover the same publication ID.',
      503,
    );
  return saved;
}
export async function readBundleCatalog(db: D1Database, signal: AbortSignal) {
  signal.throwIfAborted();
  await installed(db);
  const operators = configuredMarketplaceOperators();
  const rows = (
    await db
      .prepare(
        select +
          " JOIN workspace_wallets w ON w.owner_id=p.owner_id AND w.chain='Solana' AND w.address=p.wallet_address WHERE p.owner_id IN (SELECT value FROM json_each(?)) AND w.archived=0 AND w.revision=json_extract(d.document,'$.review.selection.walletRevision') AND x.publication_id IS NULL ORDER BY p.published_at DESC,p.id LIMIT 501",
      )
      .bind(JSON.stringify(operators))
      .all<Row>()
  ).results;
  if (rows.length > 500)
    fail('Bundle inventory exceeds this catalog snapshot capacity.', 503);
  const now = Date.now(),
    listings = [];
  for (const row of rows) {
    signal.throwIfAborted();
    const record = await decode(row, now);
    if (record.withdrawnAt) throw Error('Catalog changed');
    listings.push({
      id: record.id,
      publishedAt: record.publishedAt,
      listing: record.preview.listing,
    });
  }
  signal.throwIfAborted();
  return admitBundleCatalog({
    format: 'bundle-catalog-v1',
    seller: 'Bundle',
    observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
    purchaseEnabled: false,
    deliveryEnabled: false,
    signingAllowed: false,
    listings,
  });
}
