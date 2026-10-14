import { preflightOwnedPumpLaunchGroup } from './pump-launch-group-preparation';
import {
  requirePumpLaunchGroupReview,
  type PumpLaunchGroupReview,
} from './pump-launch-group-review';
import {
  canonicalPumpHolderJson,
  pumpHolderDigest,
} from './pump-holder-review';
import {
  encodePumpSigningInput,
  decodePumpSigningInput,
} from './pump-launch-signing';
import { PumpPreflightError } from './owned-pump-preflight';
import {
  readPumpHistoryPage,
  type PumpHistoryPage,
} from './pump-launch-history-page';
import type { PumpLaunchRpc } from './pump-launch-simulation';
import type { PumpHolderMessageInput } from './pump-holder-message';

type Terms = Parameters<typeof preflightOwnedPumpLaunchGroup>[2];
type Checked = Awaited<ReturnType<typeof preflightOwnedPumpLaunchGroup>>;
type Row = {
  id: string;
  owner_id: string;
  project_id: string;
  project_document: string;
  terms: string;
  review: string;
  simulation: string;
  state: string;
  signed: string | null;
  signature: string | null;
  receipt: string | null;
  expires_at: string;
};
const FORMAT = 'pump-launch-group-review-v1';
const fail = (message: string, status = 409): never => {
  throw new PumpPreflightError(message, status);
};
async function requireGuards(db: D1Database) {
  const row = await db
    .prepare(
      "SELECT count(*) AS installed FROM sqlite_master WHERE type='trigger' AND name IN ('pump_group_review_insert','pump_group_launch_reservation','pump_group_shared_reservation','pump_group_stage_guard')",
    )
    .first<{ installed: number }>();
  if (row?.installed !== 4)
    fail(
      'Complete-group reservation migration is not installed. Preparation remains disabled.',
      503,
    );
}
function publicReview(row: Row) {
  return {
    format: FORMAT,
    review: JSON.parse(row.review) as PumpLaunchGroupReview,
    simulation: JSON.parse(row.simulation) as Checked,
    state: row.state,
    durableReview: true as const,
    approvalRequired: true as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
    completeLaunch: false as const,
  };
}
export async function readPumpLaunchGroupReview(
  db: D1Database,
  owner: string,
  id: string,
) {
  const row = await db
    .prepare(
      "SELECT * FROM pump_launch_reviews WHERE owner_id=? AND id=? AND json_extract(review,'$.format')=?",
    )
    .bind(owner, id, FORMAT)
    .first<Row>();
  if (!row) return fail('Owned complete-group review not found.', 404);
  await requirePumpLaunchGroupReview(JSON.parse(row.review), false);
  return publicReview(row);
}

/** Authenticated owner is supplied by the future route. Collects server evidence; never accepts a client-authored simulation. */
export async function preparePumpLaunchGroupReview(
  db: D1Database,
  owner: string,
  supplied: Terms,
  signal: AbortSignal,
  rpc: PumpLaunchRpc,
) {
  signal.throwIfAborted();
  await requireGuards(db);
  const terms = structuredClone(supplied),
    encodedTerms = canonicalPumpHolderJson(terms);
  const saved = await db
    .prepare(
      'SELECT document,updated_at,archived FROM workspace_projects WHERE owner_id=? AND id=?',
    )
    .bind(owner, terms.projectId)
    .first<{ document: string; updated_at: string; archived: number }>();
  if (!saved || saved.archived || saved.updated_at !== terms.updatedAt)
    return fail('Save the current complete-group launch first.');
  const existing = await db
    .prepare(
      "SELECT * FROM pump_launch_reviews WHERE owner_id=? AND project_id=? AND state NOT IN ('cancelled','failed')",
    )
    .bind(owner, terms.projectId)
    .first<Row>();
  if (existing) {
    if (
      existing.terms !== encodedTerms ||
      existing.project_document !== saved.document ||
      JSON.parse(existing.review).format !== FORMAT
    )
      return fail(
        'Another launch review reserves this project. Recover or cancel it first.',
      );
    await requirePumpLaunchGroupReview(JSON.parse(existing.review), false);
    return publicReview(existing);
  }
  let captured: PumpHolderMessageInput | undefined;
  const checked = await preflightOwnedPumpLaunchGroup(
    db,
    owner,
    terms,
    signal,
    {
      rpc,
      captureInput: (value) => {
        captured = value;
      },
    },
  );
  if (!captured || signal.aborted)
    return fail('Complete-group review preparation interrupted.');
  const context: Omit<PumpLaunchGroupReview, 'contextSha256'> = {
    format: FORMAT,
    id: crypto.randomUUID(),
    projectId: terms.projectId,
    projectUpdatedAt: terms.updatedAt,
    releaseId: terms.releaseId,
    expiresAt: checked.simulation.expiresAt,
    manifestSha256: checked.group.manifestSha256,
    packets: checked.group.packets.map((packet, index) => ({
      index,
      transaction: packet.transaction,
      sha256: packet.packetSha256,
      requiredSigners: [...packet.requiredSigners],
      holderIndices: [...packet.holderIndices],
    })),
    input: { ...captured, create: encodePumpSigningInput(captured.create) },
    document: JSON.parse(saved.document),
    allowances: checked.allowances,
    deployerBindingSha256: checked.deployerBindingSha256,
    holderBindingSha256: checked.holderBindingSha256,
    allowanceSha256: checked.allowanceSha256,
    simulation: checked.simulation,
    simulationSha256: await pumpHolderDigest(checked.simulation),
  };
  const review = { ...context, contextSha256: await pumpHolderDigest(context) };
  await requirePumpLaunchGroupReview(review);
  signal.throwIfAborted();
  try {
    await db
      .prepare(
        "INSERT INTO pump_launch_reviews(id,owner_id,project_id,payer,mint,project_document,terms,review,simulation,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,'review',?,?)",
      )
      .bind(
        review.id,
        owner,
        terms.projectId,
        terms.payer,
        terms.mint,
        saved.document,
        encodedTerms,
        JSON.stringify(review),
        JSON.stringify(checked),
        new Date().toISOString(),
        review.expiresAt,
      )
      .run();
  } catch {
    return fail(
      'Group ownership, project or wallet reservation changed. Reload before preparing again.',
    );
  }
  return readPumpLaunchGroupReview(db, owner, review.id);
}

/** Only never-approved, unsigned groups may release their reservation without on-chain recovery. */
export async function cancelUnsignedPumpLaunchGroupReview(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  await requireGuards(db);
  const row = await db
    .prepare(
      "SELECT * FROM pump_launch_reviews WHERE owner_id=? AND id=? AND json_extract(review,'$.format')=?",
    )
    .bind(owner, id, FORMAT)
    .first<Row>();
  if (!row) return fail('Owned complete-group review not found.', 404);
  await requirePumpLaunchGroupReview(JSON.parse(row.review), false);
  if (
    row.state !== 'review' ||
    row.signed !== null ||
    row.signature !== null ||
    row.receipt !== null
  )
    return fail(
      'Only an unsigned, never-approved complete-group review can be cancelled.',
    );
  signal.throwIfAborted();
  const changed = await db
    .prepare(
      "UPDATE pump_launch_reviews SET state='cancelled' WHERE owner_id=? AND id=? AND state='review' AND review=? AND signed IS NULL AND signature IS NULL AND receipt IS NULL",
    )
    .bind(owner, id, row.review)
    .run();
  if (!changed.meta.changes)
    return fail('Group review state changed. Reload its history.');
  return readPumpLaunchGroupReview(db, owner, id);
}
export function listPumpLaunchGroupPage(
  db: D1Database,
  owner: string,
  projectId: string,
  page: PumpHistoryPage,
) {
  return readPumpHistoryPage(
    db,
    owner,
    projectId,
    'groups',
    page,
    publicReview,
  );
}

/** Rechecks exact frozen group semantics using fresh owned server evidence. Never modifies, approves or signs. */
export async function refreshPumpLaunchGroupReview(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
  rpc: PumpLaunchRpc,
) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
  deadline.throwIfAborted();
  await requireGuards(db);
  const read = () =>
    db
      .prepare(
        "SELECT * FROM pump_launch_reviews WHERE owner_id=? AND id=? AND json_extract(review,'$.format')=?",
      )
      .bind(owner, id, FORMAT)
      .first<Row>();
  const row = await read();
  if (!row) return fail('Owned complete-group review not found.', 404);
  if (
    row.state !== 'review' ||
    row.signed !== null ||
    row.signature !== null ||
    row.receipt !== null
  )
    return fail(
      'Only an unsigned group review can be revalidated at this stage.',
    );
  const { review } = await requirePumpLaunchGroupReview(JSON.parse(row.review));
  const terms = JSON.parse(row.terms) as Terms;
  const saved = await db
    .prepare(
      'SELECT document,updated_at,archived FROM workspace_projects WHERE owner_id=? AND id=?',
    )
    .bind(owner, review.projectId)
    .first<{ document: string; updated_at: string; archived: number }>();
  if (
    !saved ||
    saved.archived ||
    saved.document !== row.project_document ||
    saved.updated_at !== terms.updatedAt
  )
    return fail(
      'Saved group project changed. Cancel its unsigned review before preparing again.',
    );
  const originalInput = {
    ...review.input,
    create: decodePumpSigningInput(review.input.create),
  };
  const checked = await preflightOwnedPumpLaunchGroup(
    db,
    owner,
    terms,
    deadline,
    {
      rpc,
      originalInput,
      lifetime: {
        blockhash: review.input.create.blockhash,
        lastValidBlockHeight: review.input.create.lastValidBlockHeight,
      },
    },
  );
  const original = JSON.parse(row.simulation) as Checked;
  const stable = (value: Checked) => {
    const { bankSlot: _slot, ...accounting } = value.simulation.accounting;
    return {
      projectId: value.projectId,
      projectUpdatedAt: value.projectUpdatedAt,
      releaseId: value.metadataReleaseId,
      uri: value.metadataUri,
      deployerBinding: value.deployerBindingSha256,
      holderBinding: value.holderBindingSha256,
      allowanceSha256: value.allowanceSha256,
      manifestSha256: value.group.manifestSha256,
      targets: value.targets,
      allowances: value.allowances,
      packetFees: value.funding.packetFees,
      networkFeeRaw: value.simulation.networkFeeRaw,
      source: value.funding.accountHashes.map((account) => ({
        address: account.address,
        sha256: account.sourceIdentitySha256,
      })),
      programs: value.simulation.programDeploymentHashes,
      accounting,
    };
  };
  if (
    checked.group.manifestSha256 !== review.manifestSha256 ||
    canonicalPumpHolderJson(stable(checked)) !==
      canonicalPumpHolderJson(stable(original))
  )
    return fail(
      'Group ownership, source, fees, deployment or economic results changed. Prepare a new review.',
    );
  const current = await read();
  if (
    !current ||
    current.state !== row.state ||
    current.review !== row.review ||
    current.simulation !== row.simulation ||
    current.signed !== row.signed ||
    current.signature !== row.signature ||
    current.receipt !== row.receipt
  )
    return fail('Group review changed during revalidation.');
  deadline.throwIfAborted();
  if (Date.parse(review.expiresAt) <= Date.now())
    return fail('Group review expired during revalidation.');
  const result = {
    checked,
    reviewContextSha256: review.contextSha256,
    simulationSha256: await pumpHolderDigest(checked.simulation),
    originalReviewExpiresAt: review.expiresAt,
    sourceRevalidated: true as const,
    approvalRequired: true as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
  deadline.throwIfAborted();
  if (Date.parse(review.expiresAt) <= Date.now())
    return fail('Group review expired during revalidation.');
  return result;
}
