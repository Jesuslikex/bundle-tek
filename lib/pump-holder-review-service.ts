import { PumpPreflightError } from './owned-pump-preflight';
import { preflightOwnedPumpHolderSimulation } from './pump-holder-preparation';
import { readOwnedPumpHolderWallets } from './pump-holder-selection';
import { encodePumpSigningInput } from './pump-launch-signing';
import {
  pumpLaunchRpc,
  requirePumpLaunchAuthorityPolicy,
} from './pump-launch-service';
import {
  canonicalPumpHolderJson,
  pumpHolderDigest,
  requirePumpHolderReview,
  type PumpHolderReview,
} from './pump-holder-review';
import type { PumpLaunchRpc } from './pump-launch-simulation';
import type { buildPumpCreateHolderMessage } from './pump-holder-message';

type Terms = Parameters<typeof preflightOwnedPumpHolderSimulation>[2];
type Checked = Awaited<ReturnType<typeof preflightOwnedPumpHolderSimulation>>;
type Row = {
  id: string;
  owner_id: string;
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
const FORMAT = 'pump-create-holders-review-v1';
const fail = (message: string, status = 409): never => {
  throw new PumpPreflightError(message, status);
};
async function requireReservationGuards(db: D1Database) {
  const row = await db
    .prepare(`SELECT count(*) AS installed FROM sqlite_master WHERE type='trigger' AND name IN
    ('pump_holder_review_insert','pump_holder_launch_reservation','pump_holder_shared_reservation','pump_holder_review_transition')`)
    .first<{ installed: number }>();
  if (row?.installed !== 4)
    return fail(
      'Holder reservation migration is not installed. Preparation remains disabled.',
      503,
    );
}
const publicReview = (row: Row) => ({
  format: FORMAT,
  review: JSON.parse(row.review) as PumpHolderReview,
  simulation: JSON.parse(row.simulation) as Checked,
  state: row.state,
  signature: row.signature,
  receipt: row.receipt ? JSON.parse(row.receipt) : null,
  signingAllowed: false as const,
  executionAllowed: false as const,
  completeLaunch: false as const,
  simulationLimits: [
    'program-deployment-metadata-only',
    'buyback-split-rounding-unattested',
    'holder-funded-proof-pending',
  ] as const,
});
async function read(db: D1Database, owner: string, id: string) {
  const row = await db
    .prepare(
      "SELECT * FROM pump_launch_reviews WHERE owner_id=? AND id=? AND json_extract(review,'$.format')=?",
    )
    .bind(owner, id, FORMAT)
    .first<Row>();
  if (!row) return fail('Owned holder launch review not found.', 404);
  return row;
}

/** Persist an immutable complete review. The authenticated owner must be supplied by the calling route. */
export async function preparePumpHolderReview(
  db: D1Database,
  owner: string,
  supplied: Terms,
  signal: AbortSignal,
  rpc: PumpLaunchRpc = pumpLaunchRpc(),
) {
  signal.throwIfAborted();
  await requireReservationGuards(db);
  const terms = structuredClone(supplied),
    selection = await readOwnedPumpHolderWallets(db, owner, terms),
    encodedTerms = canonicalPumpHolderJson(terms);
  const saved = await db
    .prepare(
      'SELECT document,updated_at,archived FROM workspace_projects WHERE owner_id=? AND id=?',
    )
    .bind(owner, terms.projectId)
    .first<{ document: string; updated_at: string; archived: number }>();
  if (!saved || saved.archived || saved.updated_at !== terms.updatedAt)
    return fail('Save the current holder launch first.');
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
    await requirePumpHolderReview(JSON.parse(existing.review), false);
    return publicReview(existing);
  }
  let input: Parameters<typeof buildPumpCreateHolderMessage>[0] | undefined;
  const checked = await preflightOwnedPumpHolderSimulation(
    db,
    owner,
    terms,
    signal,
    {
      rpc,
      captureInput: (value) => {
        input = value;
      },
    },
  );
  if (!input || signal.aborted)
    return fail('Holder review preparation interrupted.');
  await requirePumpLaunchAuthorityPolicy(
    checked.creationSimulation,
    terms.mint,
  );
  const context: Omit<PumpHolderReview, 'contextSha256'> = {
    format: FORMAT,
    id: crypto.randomUUID(),
    projectId: terms.projectId,
    projectUpdatedAt: terms.updatedAt,
    releaseId: terms.releaseId,
    expiresAt: checked.allWalletSimulation.expiresAt,
    transaction: checked.packet.transaction,
    sha256: checked.packet.packetSha256,
    input: { ...input, create: encodePumpSigningInput(input.create) },
    document: selection.document,
    allowances: checked.allowances,
    deployerBindingSha256: checked.deployerBindingSha256,
    holderBindingSha256: checked.holderBindingSha256,
    allowanceSha256: checked.allowanceSha256,
  };
  const review = { ...context, contextSha256: await pumpHolderDigest(context) };
  await requirePumpHolderReview(review);
  signal.throwIfAborted();
  try {
    await db
      .prepare(`INSERT INTO pump_launch_reviews(id,owner_id,project_id,payer,mint,project_document,terms,review,simulation,state,created_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,'review',?,?)`)
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
      'Holder ownership, project or wallet reservation changed. Reload before preparing again.',
    );
  }
  return publicReview(await read(db, owner, review.id));
}

/** Refreshes the original packet/lifetime, never replacing an approved message or writing over its observations. */
export async function refreshPumpHolderReview(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
  rpc: PumpLaunchRpc = pumpLaunchRpc(),
) {
  signal.throwIfAborted();
  await requireReservationGuards(db);
  const row = await read(db, owner, id),
    { review, built } = await requirePumpHolderReview(JSON.parse(row.review)),
    terms = JSON.parse(row.terms) as Terms;
  if (!['review', 'approved', 'signed'].includes(row.state))
    return fail('This holder review cannot be refreshed in its current state.');
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
    return fail('Saved holder launch changed; recover or cancel its review.');
  const checked = await preflightOwnedPumpHolderSimulation(
    db,
    owner,
    terms,
    signal,
    {
      rpc,
      lifetime: {
        blockhash: review.input.create.blockhash,
        lastValidBlockHeight: review.input.create.lastValidBlockHeight,
      },
    },
  );
  await requirePumpLaunchAuthorityPolicy(
    checked.creationSimulation,
    terms.mint,
  );
  const original = JSON.parse(row.simulation) as Checked,
    volumeAccounts = new Set<string>(
      built.buyerAccounts.map((b) => b.volumeAccount),
    );
  const stable = (value: Checked) => ({
    deployerBindingSha256: value.deployerBindingSha256,
    holderBindingSha256: value.holderBindingSha256,
    allowanceSha256: value.allowanceSha256,
    packetSha256: value.packet.packetSha256,
    accounting: value.allWalletSimulation.accounting,
    networkFeeRaw: value.allWalletSimulation.networkFeeRaw,
    programs: value.allWalletSimulation.programDeploymentHashes,
    source: value.allWalletSimulation.accountHashes.map((a) => ({
      address: a.address,
      beforeSha256: a.beforeSha256,
      ...(!volumeAccounts.has(a.address)
        ? { simulatedSha256: a.simulatedSha256 }
        : {}),
    })),
  });
  if (
    checked.packet.packetSha256 !== review.sha256 ||
    canonicalPumpHolderJson(stable(checked)) !==
      canonicalPumpHolderJson(stable(original))
  )
    return fail(
      'Holder packet, funding, settlement or observed source changed. Prepare a new review.',
    );
  // Only validated simulated volume timestamps may differ. Source bytes, rewards and per-wallet accounting are rechecked.
  const current = await read(db, owner, id);
  if (
    current.state !== row.state ||
    current.review !== row.review ||
    current.simulation !== row.simulation ||
    signal.aborted
  )
    return fail('Holder review changed during refresh.');
  return checked;
}

export async function cancelUnsignedPumpHolderReview(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
) {
  const row = await read(db, owner, id);
  if (row.state === 'cancelled') return publicReview(row);
  if (row.state !== 'review' || row.signed !== null || row.signature !== null)
    return fail(
      'Approved or signed holder packets require lifetime/receipt recovery before releasing reservations.',
    );
  signal.throwIfAborted();
  const result = await db
    .prepare(
      "UPDATE pump_launch_reviews SET state='cancelled' WHERE owner_id=? AND id=? AND state=? AND signed IS NULL AND signature IS NULL",
    )
    .bind(owner, id, row.state)
    .run();
  if (!result.meta.changes)
    return fail('Holder review state changed. Reload its history.');
  return publicReview(await read(db, owner, id));
}

export async function listPumpHolderReviews(
  db: D1Database,
  owner: string,
  projectId: string,
) {
  const { results } = await db
    .prepare(
      "SELECT * FROM pump_launch_reviews WHERE owner_id=? AND project_id=? AND json_extract(review,'$.format')=? ORDER BY created_at DESC LIMIT 20",
    )
    .bind(owner, projectId, FORMAT)
    .all<Row>();
  return results.map(publicReview);
}
