import {
  captureSelection,
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
    captureSelection(c),
    review,
  );
  if (
    Object.keys(guard.capture).length !== Object.keys(c).length ||
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
  if (!guard) return { sql: '', bindings: [] };
  const c = guard.capture;
  // A later proxy leg starts only after the previous leg of the same recipient finalized.
  const previous =
    c.leg !== undefined && c.leg > 1
      ? {
          sql: " AND EXISTS(SELECT 1 FROM native_withdrawals p WHERE p.owner_id=? AND p.state='finalized' AND json_extract(p.document,'$.funding.planId')=? AND json_extract(p.document,'$.funding.revision')=? AND json_extract(p.document,'$.funding.item')=? AND json_extract(p.document,'$.funding.leg')=?)",
          bindings: [owner, c.planId, c.revision, c.item, c.leg - 1],
        }
      : { sql: '', bindings: [] };
  return {
    sql:
      " AND EXISTS(SELECT 1 FROM funding_plans f WHERE f.owner_id=? AND f.id=? AND f.revision=? AND f.archived=0 AND f.document=?) AND julianday(?)<=julianday('now')" +
      previous.sql,
    bindings: [
      owner,
      c.planId,
      c.revision,
      guard.document,
      c.scheduledAt,
      ...previous.bindings,
    ],
  };
}
export function fundingHistoryScope(selection?: FundingSelection) {
  if (!selection) return { sql: '', bindings: [] };
  const base = {
    sql: " AND json_extract(document,'$.funding.planId')=? AND json_extract(document,'$.funding.revision')=? AND json_extract(document,'$.funding.item')=?",
    bindings: [selection.planId, selection.revision, selection.item] as (
      | string
      | number
    )[],
  };
  return selection.leg === undefined
    ? base
    : {
        sql: base.sql + " AND json_extract(document,'$.funding.leg')=?",
        bindings: [...base.bindings, selection.leg],
      };
}
