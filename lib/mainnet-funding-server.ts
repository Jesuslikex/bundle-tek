import {
  fundingSelection,
  selectedFundingCapture,
  validatedFundingCapture,
  type FundingSelection,
  type FundingTransferContext,
} from './mainnet-funding';
import type { NativeWithdrawalReview } from './native-withdrawal';
import type { FundingDocument, SavedFunding } from './funding-plan';

export async function captureOwnedFunding(
  db: D1Database,
  owner: string,
  selection: FundingSelection,
  review: FundingTransferContext,
) {
  fundingSelection(selection);
  const row = await db
    .prepare(
      'SELECT id,document,revision,archived,updated_at AS updatedAt FROM funding_plans WHERE owner_id=? AND id=?',
    )
    .bind(owner, selection.planId)
    .first<{
      id: string;
      document: string;
      revision: number;
      archived: number;
      updatedAt: string;
    }>();
  if (!row) throw new Error('Owned saved funding draft unavailable.');
  const plan: SavedFunding = {
    ...row,
    archived: Boolean(row.archived),
    document: JSON.parse(row.document) as FundingDocument,
  };
  const capture = await selectedFundingCapture(
    plan,
    selection,
    review,
    Date.now(),
  );
  return { capture, document: row.document };
}
export async function currentFundingGuard(
  db: D1Database,
  owner: string,
  review: NativeWithdrawalReview,
) {
  if (!review.funding) return undefined;
  const c = validatedFundingCapture(review.funding);
  const guard = await captureOwnedFunding(
    db,
    owner,
    { planId: c.planId, revision: c.revision, item: c.item },
    review,
  );
  if (
    Object.keys(guard.capture).some(
      (key) =>
        guard.capture[key as keyof typeof guard.capture] !==
        c[key as keyof typeof c],
    )
  )
    throw new Error(
      'Saved funding terms changed. Recover the retained signature.',
    );
  return guard;
}
export function fundingWriteGuard(
  owner: string,
  guard?: Awaited<ReturnType<typeof captureOwnedFunding>>,
) {
  return guard
    ? {
        sql: " AND EXISTS(SELECT 1 FROM funding_plans f WHERE f.owner_id=? AND f.id=? AND f.revision=? AND f.archived=0 AND f.document=?) AND julianday(?)<=julianday('now')",
        bindings: [
          owner,
          guard.capture.planId,
          guard.capture.revision,
          guard.document,
          guard.capture.scheduledAt,
        ],
      }
    : { sql: '', bindings: [] };
}
export function fundingHistoryScope(selection?: FundingSelection) {
  return selection
    ? {
        sql: " AND json_extract(document,'$.funding.planId')=? AND json_extract(document,'$.funding.revision')=? AND json_extract(document,'$.funding.item')=?",
        bindings: [selection.planId, selection.revision, selection.item],
      }
    : { sql: '', bindings: [] };
}
