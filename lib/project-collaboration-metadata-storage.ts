import { z } from 'zod';
import {
  readMetadataEditRequest,
  readMetadataEditSource,
  readMetadataText,
  metadataEditReviewHash,
  verifyMetadataEditReceipt,
  type MetadataEditRequest,
  type MetadataEditReceipt,
  type MetadataEditSource,
} from './project-collaboration-metadata';
import { validateProjectDocument } from './workspace-project';
import { validateVenuePlan } from './venue-limits';
import { validateSequencedSupply } from './launch-supply';
import { validateHoldersQuoteAmount } from './launch-buy';
import { validateQuoteSelection } from './quote-catalog';
import { validateLaunchMethod } from './launch-methods';
import { validateLaunchTiming } from './launch-timing';
import { validateLaunchWalletSelection } from './launch-wallets';

export class ProjectMetadataEditError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
const fail = (message: string, status = 409): never => {
  throw new ProjectMetadataEditError(message, status);
};
const uuid = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    !z.uuid().safeParse(value).success ||
    value.toLowerCase() !== value
  )
    return fail('A complete metadata edit or share ID is required.', 400);
  return value;
};
type SourceRow = {
  owner_id: string;
  share_id: string;
  project_id: string;
  document: string;
  updated_at: string;
  expires_at: string | null;
};
type EditRow = {
  id: string;
  owner_id: string;
  editor_id: string;
  share_id: string;
  project_id: string;
  source_document: string;
  before_revision: string;
  after_revision: string;
  values_before: string;
  values_after: string;
  review_hash: string;
  created_at: string;
};
async function sourceRow(db: D1Database, actor: string, shareId: string) {
  const row = await db
    .prepare(`SELECT s.owner_id,s.id AS share_id,s.project_id,p.document,p.updated_at,s.expires_at
   FROM project_shares s JOIN workspace_projects p ON p.owner_id=s.owner_id AND p.id=s.project_id
   WHERE s.id=? AND s.member_id=? AND s.accepted_at IS NOT NULL AND s.metadata_edit=1
    AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND p.archived=0`)
    .bind(uuid(shareId), actor)
    .first<SourceRow>();
  if (!row)
    return fail('Saved-text editing is unavailable for this invite.', 403);
  return row;
}
function rawSource(row: SourceRow) {
  try {
    const raw = JSON.parse(row.document) as Record<string, unknown> & {
      plan: Record<string, unknown>;
    };
    const values = readMetadataText({
      tokenName: raw.plan.tokenName,
      ticker: raw.plan.ticker,
      description: raw.plan.description,
    });
    return { raw, values };
  } catch {
    return fail(
      'The owner must refresh and save canonical project name, symbol and description before text editing.',
    );
  }
}
function ownerSizedCandidate(
  row: SourceRow,
  values: MetadataEditRequest['values'],
  mutationId: string,
) {
  const { raw } = rawSource(row);
  const candidate = { ...raw, plan: { ...raw.plan, ...values } };
  // Match the owner's UTF-16 request bound, preserving every raw saved field.
  const envelope = {
    ...candidate,
    id: row.project_id,
    archived: false,
    expectedUpdatedAt: row.updated_at,
    mutationId,
  };
  if (JSON.stringify(envelope).length > 24_000)
    return fail(
      'The owner must reduce and save this project before text editing: its complete owner-save request exceeds 24,000 characters.',
    );
  return candidate;
}
function source(row: SourceRow): MetadataEditSource {
  const original = rawSource(row);
  ownerSizedCandidate(
    row,
    original.values,
    '00000000-0000-4000-8000-000000000000',
  );
  try {
    validateProjectDocument(original.raw);
    return readMetadataEditSource({
      format: 'shared-project-metadata-source-v1',
      shareId: row.share_id,
      projectId: row.project_id,
      projectUpdatedAt: row.updated_at,
      expiresAt: row.expires_at,
      values: original.values,
      editingAllowed: true,
      walletActionsAllowed: false,
      signingAllowed: false,
      publishingAllowed: false,
    });
  } catch {
    return fail(
      'The owner must refresh this saved project before text editing.',
    );
  }
}
export async function getMetadataEditSource(
  db: D1Database,
  actor: string,
  shareId: string,
): Promise<MetadataEditSource> {
  return source(await sourceRow(db, actor, shareId));
}
async function receipt(row: EditRow): Promise<MetadataEditReceipt> {
  try {
    const original = validateProjectDocument(JSON.parse(row.source_document));
    const before = readMetadataText(JSON.parse(row.values_before));
    if (
      JSON.stringify(before) !==
      JSON.stringify({
        tokenName: original.plan.tokenName,
        ticker: original.plan.ticker,
        description: original.plan.description,
      })
    )
      return fail('The retained metadata edit source could not be verified.');
    return await verifyMetadataEditReceipt({
      format: 'shared-project-metadata-edit-receipt-v1',
      mutationId: row.id,
      shareId: row.share_id,
      projectId: row.project_id,
      beforeUpdatedAt: row.before_revision,
      updatedAt: row.after_revision,
      createdAt: row.created_at,
      reviewHash: row.review_hash,
      before,
      after: readMetadataText(JSON.parse(row.values_after)),
      metadataSaved: true,
      walletActionsAllowed: false,
      signingAllowed: false,
      publishingAllowed: false,
    });
  } catch {
    return fail('The retained metadata edit receipt could not be verified.');
  }
}
async function retainedRow(db: D1Database, actor: string, mutationId: string) {
  return db
    .prepare(
      'SELECT * FROM project_collaboration_metadata_edits WHERE id=? AND (editor_id=? OR owner_id=?)',
    )
    .bind(uuid(mutationId), actor, actor)
    .first<EditRow>();
}
/** Past-action facts remain readable after a grant expires or is revoked. No current project data is returned. */
export async function readMetadataEditReceipt(
  db: D1Database,
  actor: string,
  mutationId: string,
): Promise<MetadataEditReceipt | null> {
  const row = await retainedRow(db, actor, mutationId);
  return row ? receipt(row) : null;
}
async function exactReplay(
  row: EditRow,
  actor: string,
  request: MetadataEditRequest,
) {
  const result = await receipt(row);
  if (
    row.editor_id !== actor ||
    result.shareId !== request.shareId ||
    result.projectId !== request.projectId ||
    result.beforeUpdatedAt !== request.expectedUpdatedAt ||
    result.reviewHash !== request.reviewHash ||
    JSON.stringify(result.after) !== JSON.stringify(request.values)
  )
    return fail('This metadata edit ID is already used by another request.');
  return result;
}
function validateChangedProject(row: SourceRow, request: MetadataEditRequest) {
  const rawCandidate = ownerSizedCandidate(
    row,
    request.values,
    request.mutationId,
  );
  try {
    const candidate = validateProjectDocument(rawCandidate);
    validateVenuePlan(candidate.plan);
    validateSequencedSupply(candidate.plan);
    validateHoldersQuoteAmount(candidate.plan);
    validateQuoteSelection(candidate.plan);
    validateLaunchMethod(candidate.plan);
    validateLaunchTiming(candidate.plan);
    validateLaunchWalletSelection(
      candidate.options.wallets,
      candidate.plan.chain,
      candidate.plan.holderCount,
    );
  } catch {
    return fail(
      'The owner must refresh launch settings and wallet selections before this text edit.',
    );
  }
}
/** One atomic SQL insert applies only three text fields and records the owner event and immutable receipt. */
export async function saveMetadataEdit(
  db: D1Database,
  actor: string,
  value: unknown,
  signal: AbortSignal,
): Promise<MetadataEditReceipt> {
  let request: MetadataEditRequest;
  try {
    request = readMetadataEditRequest(value);
  } catch {
    return fail('Review and approve the exact saved text edit.', 400);
  }
  signal.throwIfAborted();
  const previous = await retainedRow(db, actor, request.mutationId);
  if (previous) return exactReplay(previous, actor, request);
  const row = await sourceRow(db, actor, request.shareId),
    original = source(row);
  if (
    original.projectId !== request.projectId ||
    original.projectUpdatedAt !== request.expectedUpdatedAt
  )
    return fail(
      'The shared project changed. Load its current saved text again.',
    );
  if (JSON.stringify(original.values) === JSON.stringify(request.values))
    return fail('No saved text changes were selected.', 400);
  if (
    (await metadataEditReviewHash(original, request.values)) !==
    request.reviewHash
  )
    return fail(
      'The reviewed text changed. Load and review the current saved text again.',
    );
  validateChangedProject(row, request);
  signal.throwIfAborted();
  const now = new Date().toISOString();
  const afterRevision = new Date(
    Math.max(Date.now(), Date.parse(request.expectedUpdatedAt) + 1),
  ).toISOString();
  try {
    await db
      .prepare(`INSERT INTO project_collaboration_metadata_edits
     (id,owner_id,editor_id,share_id,project_id,source_document,before_revision,after_revision,values_before,values_after,review_hash,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(
        request.mutationId,
        row.owner_id,
        actor,
        request.shareId,
        request.projectId,
        row.document,
        request.expectedUpdatedAt,
        afterRevision,
        JSON.stringify(original.values),
        JSON.stringify(request.values),
        request.reviewHash,
        now,
      )
      .run();
  } catch (error) {
    // A concurrent exact request may have committed while this request lost its CAS race.
    const committed = await retainedRow(db, actor, request.mutationId);
    if (committed) return exactReplay(committed, actor, request);
    const text = error instanceof Error ? error.message : '';
    if (text.includes('Metadata edit owner document limit'))
      return fail(
        'The owner must reduce and save this project before text editing: its complete owner-save request exceeds the saved-text budget.',
      );
    if (text.includes('Metadata edit'))
      return fail(
        text.includes('capacity')
          ? 'Saved text edit history is full. Ask the owner for assistance.'
          : 'Edit permission, project or selected wallets changed. Load current text before another review.',
      );
    return fail(
      'The metadata save response is unavailable. Keep the mutation ID and check its saved receipt.',
      503,
    );
  }
  const saved = await retainedRow(db, actor, request.mutationId);
  if (!saved)
    return fail(
      'The metadata save response is unavailable. Keep the mutation ID and check its saved receipt.',
      503,
    );
  return exactReplay(saved, actor, request);
}
