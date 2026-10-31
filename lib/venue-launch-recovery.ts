import { z } from 'zod';
import {
  prepareMeteoraDbcLaunch,
  submitMeteoraDbcLaunch,
  type MeteoraDbcReview,
  type MeteoraDbcTerms,
} from './meteora-dbc-launch-service';
import {
  prepareStonkLaunch,
  submitStonkLaunch,
  type StonkLaunchReview,
  type StonkLaunchTerms,
} from './stonkfun-launch-service';
import { observePumpLaunchRecovery } from './pump-launch-recovery';
import { verifyVenueLaunchSignedPacket } from './venue-launch-signed-packet';
import { getSolanaRpcEndpoint, rpcCall } from './solana-rpc';
import { PumpPreflightError } from './owned-pump-preflight';
import {
  isStonkBundleReview,
  prepareStonkBundle,
  verifyStonkBundleReview,
  type StonkBundleReview,
  type StonkBundleTerms,
} from './stonkfun-bundle-service';
import { verifyStonkBundleSigned } from './stonkfun-bundle';
import { jitoRpc } from './jito-provider';
import {
  prepareLaunchLabLaunch,
  submitLaunchLabLaunch,
  type LaunchLabReview,
  type LaunchLabTerms,
} from './launchlab-launch-service';

export type LaunchRecoveryVenue = 'meteora-dbc' | 'stonkfun' | 'launchlab';
type Review =
  | MeteoraDbcReview
  | StonkLaunchReview
  | StonkBundleReview
  | LaunchLabReview;
type Terms =
  | MeteoraDbcTerms
  | StonkLaunchTerms
  | StonkBundleTerms
  | LaunchLabTerms;
type Rpc = (
  method: string,
  params: unknown[],
  signal: AbortSignal,
) => Promise<unknown>;
type Row = {
  id: string;
  owner_id: string;
  venue: LaunchRecoveryVenue;
  project_id: string;
  payer: string;
  mint: string;
  project_document: string;
  terms: string;
  review: string;
  sha256: string;
  minimum_slot: number;
  state:
    | 'review'
    | 'approved'
    | 'signed'
    | 'submitting'
    | 'submitted'
    | 'finalized'
    | 'failed'
    | 'cancelled';
  signed: string | null;
  signature: string | null;
  receipt: string | null;
  created_at: string;
  expires_at: string;
};
export class VenueLaunchRecoveryError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
/** Only for checks before the first recovery INSERT is attempted. */
export class VenueLaunchPreparationNotSavedError extends VenueLaunchRecoveryError {}
const fail = (message: string, status = 409): never => {
  throw new VenueLaunchRecoveryError(message, status);
};
function tableForVenue(venue: LaunchRecoveryVenue) {
  if (venue === 'launchlab') return 'launchlab_launch_recoveries';
  if (venue === 'meteora-dbc' || venue === 'stonkfun')
    return 'venue_launch_recoveries';
  return fail('Unsupported saved launch venue.', 400);
}
async function verifyPacket(review: Review, packet: string, status = 409) {
  try {
    return await verifyVenueLaunchSignedPacket(
      review as Exclude<Review, StonkBundleReview>,
      packet,
    );
  } catch {
    return fail(
      'Signed launch does not match the exact saved review and signatures.',
      status,
    );
  }
}
const terminal = (row: Row) =>
  ['finalized', 'failed', 'cancelled'].includes(row.state);
const termsKey = (terms: object, omitOrigin = false) =>
  JSON.stringify(
    Object.entries(terms)
      .filter(([key]) => !omitOrigin || key !== 'origin')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
const rpcDefault: Rpc = async (method, params, signal) => {
  signal.throwIfAborted();
  // The original RPC helper has its own transport timeout. A stopped caller
  // never receives authority to proceed to the guarded send marker below.
  const result = await rpcCall(getSolanaRpcEndpoint('mainnet'), method, params);
  signal.throwIfAborted();
  return result;
};
export function publicVenueLaunchRecovery(row: Row) {
  return {
    format: 'venue-launch-recovery-v1' as const,
    id: row.id,
    venue: row.venue,
    projectId: row.project_id,
    review: JSON.parse(row.review) as Review,
    state: row.state,
    signature: row.signature,
    receipt: row.receipt
      ? (JSON.parse(row.receipt) as Record<string, unknown>)
      : null,
    createdAt: row.created_at,
  };
}
async function getRow(
  db: D1Database,
  owner: string,
  venue: LaunchRecoveryVenue,
  id: string,
) {
  if (!z.uuid().safeParse(id).success)
    return fail('Saved launch ID required.', 400);
  const row = await db
    .prepare(
      `SELECT * FROM ${tableForVenue(venue)} WHERE owner_id=? AND venue=? AND id=?`,
    )
    .bind(owner, venue, id)
    .first<Row>();
  if (!row) return fail('Saved launch not found.', 404);
  const review = JSON.parse(row.review) as Review;
  if (termsKey(review.terms) !== termsKey(JSON.parse(row.terms) as Terms, true))
    return fail('Saved launch terms differ.');
  if (
    review.sha256 !== row.sha256 ||
    review.expiresAt !== row.expires_at ||
    review.terms.projectId !== row.project_id ||
    review.terms.mint !== row.mint ||
    review.terms.payer !== row.payer ||
    review.minimumSlot !== row.minimum_slot ||
    review.format !==
      (venue === 'meteora-dbc'
        ? 'meteora-dbc-launch-review-v1'
        : venue === 'stonkfun'
          ? 'stonkfun-launch-review-v1'
          : 'launchlab-launch-review-v1')
  )
    return fail('Saved launch binding differs.');
  return row;
}
export async function readVenueLaunchRecovery(
  db: D1Database,
  owner: string,
  venue: LaunchRecoveryVenue,
  id: string,
) {
  return publicVenueLaunchRecovery(await getRow(db, owner, venue, id));
}
export async function listVenueLaunchRecoveries(
  db: D1Database,
  owner: string,
  venue: LaunchRecoveryVenue,
  projectId: string,
) {
  if (!projectId || projectId.length > 128)
    return fail('Project ID required.', 400);
  const rows = await db
    .prepare(
      `SELECT * FROM ${tableForVenue(venue)} WHERE owner_id=? AND venue=? AND project_id=? ORDER BY created_at DESC,id DESC LIMIT 20`,
    )
    .bind(owner, venue, projectId)
    .all<Row>();
  return {
    launches: await Promise.all(
      (rows.results ?? []).map(async (row) =>
        publicVenueLaunchRecovery(await getRow(db, owner, venue, row.id)),
      ),
    ),
  };
}
type Deps = {
  rpc?: Rpc;
  prepareDbc?: typeof prepareMeteoraDbcLaunch;
  prepareStonk?: typeof prepareStonkLaunch;
  submitDbc?: typeof submitMeteoraDbcLaunch;
  submitStonk?: typeof submitStonkLaunch;
  prepareLaunchLab?: typeof prepareLaunchLabLaunch;
  submitLaunchLab?: typeof submitLaunchLabLaunch;
  prepareStonkBundle?: typeof prepareStonkBundle;
  /** Jito block engine handoff for a StonkFun holder bundle; one attempt only. */
  sendBundle?: (
    transactions: string[],
    signal: AbortSignal,
  ) => Promise<unknown>;
};
export async function prepareVenueLaunchRecovery(
  db: D1Database,
  owner: string,
  venue: LaunchRecoveryVenue,
  terms: Terms,
  signal: AbortSignal,
  deps: Deps = {},
) {
  signal.throwIfAborted();
  const existing = await db
    .prepare(
      `SELECT * FROM ${tableForVenue(venue)} WHERE owner_id=? AND project_id=? AND state NOT IN ('finalized','failed','cancelled')`,
    )
    .bind(owner, terms.projectId)
    .first<Row>();
  if (existing) {
    if (
      existing.venue !== venue ||
      termsKey(JSON.parse(existing.terms) as Terms) !== termsKey(terms)
    )
      return fail(
        'Recover or cancel the saved launch before preparing another.',
      );
    const stored = await getRow(db, owner, venue, existing.id);
    return { ...(JSON.parse(stored.review) as Review), recoveryId: stored.id };
  }
  const projectBefore = await db
    .prepare(
      'SELECT document,updated_at,archived FROM workspace_projects WHERE owner_id=? AND id=?',
    )
    .bind(owner, terms.projectId)
    .first<{ document: string; updated_at: string; archived: number }>();
  const review: Review =
    venue === 'meteora-dbc'
      ? await (deps.prepareDbc ?? prepareMeteoraDbcLaunch)(
          db,
          owner,
          terms as MeteoraDbcTerms,
          signal,
          { rpc: deps.rpc },
        )
      : venue === 'stonkfun' && 'holders' in terms
        ? await (deps.prepareStonkBundle ?? prepareStonkBundle)(
            db,
            owner,
            terms as StonkBundleTerms,
            signal,
            { rpc: deps.rpc },
          )
        : venue === 'stonkfun'
          ? await (deps.prepareStonk ?? prepareStonkLaunch)(
              db,
              owner,
              terms as StonkLaunchTerms,
              signal,
              { rpc: deps.rpc },
            )
          : await (deps.prepareLaunchLab ?? prepareLaunchLabLaunch)(
              db,
              owner,
              terms as LaunchLabTerms,
              signal,
              { rpc: deps.rpc },
            );
  signal.throwIfAborted();
  if (!Number.isSafeInteger(review.minimumSlot) || review.minimumSlot! < 0)
    throw new VenueLaunchPreparationNotSavedError(
      'Original launch observation slot is unavailable.',
    );
  const project = await db
    .prepare(
      'SELECT document,updated_at,archived FROM workspace_projects WHERE owner_id=? AND id=?',
    )
    .bind(owner, terms.projectId)
    .first<{ document: string; updated_at: string; archived: number }>();
  if (
    !project ||
    !projectBefore ||
    projectBefore.archived ||
    project.document !== projectBefore.document ||
    project.updated_at !== projectBefore.updated_at ||
    project.archived ||
    project.updated_at !== terms.updatedAt ||
    review.terms.mint !== terms.mint ||
    review.terms.payer !== terms.payer ||
    review.terms.projectId !== terms.projectId ||
    termsKey(review.terms) !== termsKey(terms, true)
  )
    throw new VenueLaunchPreparationNotSavedError('Launch source changed.');
  const id = crypto.randomUUID();
  try {
    await db
      .prepare(
        `INSERT INTO ${tableForVenue(venue)}(id,owner_id,venue,project_id,payer,mint,project_document,terms,review,sha256,minimum_slot,state,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'review',?)`,
      )
      .bind(
        id,
        owner,
        venue,
        terms.projectId,
        terms.payer,
        terms.mint,
        project.document,
        JSON.stringify(terms),
        JSON.stringify(review),
        review.sha256,
        review.minimumSlot!,
        review.expiresAt,
      )
      .run();
  } catch {
    return fail(
      'Launch save outcome is uncertain or conflicts. Reload saved launch history before preparing again.',
    );
  }
  signal.throwIfAborted();
  return { ...review, recoveryId: id };
}
const hash = z.string().regex(/^[0-9a-f]{64}$/),
  id = z.uuid();
const actionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('approve'),
      id,
      sha256: hash,
      bundleSha256: hash.optional(),
      approved: z.literal(true),
    })
    .strict(),
  z
    .object({
      action: z.literal('register'),
      id,
      transaction: z.string().min(1).max(1800),
    })
    .strict(),
  z
    .object({
      action: z.literal('submit'),
      id,
      sha256: hash,
      bundleSha256: hash.optional(),
      bundleTransactions: z
        .array(z.string().min(1).max(1800))
        .min(1)
        .max(4)
        .optional(),
      approved: z.literal(true),
    })
    .strict(),
  z.object({ action: z.enum(['recover', 'cancel']), id }).strict(),
]);
export async function actVenueLaunchRecovery(
  db: D1Database,
  owner: string,
  venue: LaunchRecoveryVenue,
  body: unknown,
  signal: AbortSignal,
  deps: Deps = {},
) {
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success)
    return fail(
      'Use the exact saved launch action and separate approval.',
      400,
    );
  const action = parsed.data;
  let row = await getRow(db, owner, venue, action.id);
  const review = JSON.parse(row.review) as Review;
  const bundle = venue === 'stonkfun' && isStonkBundleReview(review);
  if (action.action === 'approve' || action.action === 'submit') {
    if (bundle) {
      if (action.bundleSha256 !== review.bundle.sha256)
        return fail('Approve the exact saved holder bundle.');
      try {
        await verifyStonkBundleReview(review);
      } catch {
        return fail('Saved holder bundle differs from its review.');
      }
    } else if (
      action.bundleSha256 !== undefined ||
      (action.action === 'submit' && action.bundleTransactions !== undefined)
    )
      return fail('This saved launch has no holder bundle.', 400);
  }
  const rpc = deps.rpc ?? rpcDefault;
  const change = async (
    state: Row['state'],
    extra = '',
    values: unknown[] = [],
  ) => {
    signal.throwIfAborted();
    const result = await db
      .prepare(
        `UPDATE ${tableForVenue(venue)} SET state=?${extra} WHERE owner_id=? AND venue=? AND id=? AND state=? AND review=? AND signed IS ? AND signature IS ?`,
      )
      .bind(
        state,
        ...values,
        owner,
        venue,
        row.id,
        row.state,
        row.review,
        row.signed,
        row.signature,
      )
      .run();
    if ((result.success as boolean) === false || result.meta.changes !== 1)
      return fail('Saved launch changed. Recover the original ID.');
    row = await getRow(db, owner, venue, row.id);
  };
  if (action.action === 'approve') {
    if (action.sha256 !== row.sha256)
      return fail('Approve the exact saved launch.');
    if (row.state === 'approved') return publicVenueLaunchRecovery(row);
    if (row.state !== 'review')
      return fail('This saved launch cannot be approved.');
    await change('approved');
  } else if (action.action === 'register') {
    const signature = await verifyPacket(review, action.transaction, 400);
    if (row.signed === action.transaction && row.signature === signature)
      return publicVenueLaunchRecovery(row);
    if (row.state !== 'approved')
      return fail(
        'Approve the saved launch before registering its signatures.',
      );
    await change('signed', ',signed=?,signature=?', [
      action.transaction,
      signature,
    ]);
  } else if (action.action === 'submit') {
    if (action.sha256 !== row.sha256)
      return fail('Approve broadcasting this exact saved launch.');
    if (row.state !== 'signed') return publicVenueLaunchRecovery(row);
    if (
      !row.signed ||
      (await verifyPacket(review, row.signed)) !== row.signature
    )
      return fail('Saved signed launch differs.');
    if (Date.parse(row.expires_at) <= Date.now())
      return fail(
        'Launch review expired. Recover the saved launch; do not resend.',
      );
    let bundleSigned: string[] = [];
    if (bundle) {
      try {
        verifyStonkBundleSigned(
          (review as StonkBundleReview).bundle.packets,
          action.bundleTransactions,
        );
      } catch {
        return fail(
          'Sign every holder and tip packet of the exact saved bundle.',
          400,
        );
      }
      bundleSigned = action.bundleTransactions!;
    }
    let claimed = false;
    const guardedRpc: Rpc = async (method, params, readSignal) => {
      readSignal.throwIfAborted();
      if (
        ![
          'getMultipleAccounts',
          'getBalance',
          'getLatestBlockhash',
          'simulateTransaction',
          'sendTransaction',
        ].includes(method)
      )
        return fail(
          'Unsupported launch submission transport. Recover the original ID.',
        );
      if (method === 'sendTransaction') {
        if (claimed || params[0] !== row.signed)
          return fail('Saved launch send differs.');
        await change('submitting'); // Acknowledged durable marker before any network handoff.
        claimed = true;
        readSignal.throwIfAborted();
        if (bundle) {
          // One atomic Jito bundle: create first, then holders, then the tip.
          const transactions = [row.signed!, ...bundleSigned];
          const bundleId = await (
            deps.sendBundle ??
            ((txs: string[], s: AbortSignal) =>
              jitoRpc('sendBundle', [txs, { encoding: 'base64' }], s))
          )(transactions, readSignal);
          if (typeof bundleId !== 'string' || !bundleId)
            throw new Error('Jito bundle outcome is unknown.');
          return row.signature;
        }
      }
      return rpc(method, params, readSignal);
    };
    const terms = JSON.parse(row.terms) as Terms;
    const outcome =
      venue === 'meteora-dbc'
        ? await (deps.submitDbc ?? submitMeteoraDbcLaunch)(
            db,
            owner,
            terms as MeteoraDbcTerms,
            review.input as MeteoraDbcReview['input'],
            row.signed,
            signal,
            { rpc: guardedRpc },
          )
        : venue === 'stonkfun'
          ? await (deps.submitStonk ?? submitStonkLaunch)(
              db,
              owner,
              terms as StonkLaunchTerms,
              review.input as StonkLaunchReview['input'],
              row.signed,
              signal,
              { rpc: guardedRpc },
            )
          : await (deps.submitLaunchLab ?? submitLaunchLabLaunch)(
              db,
              owner,
              terms as LaunchLabTerms,
              review.input as LaunchLabReview['input'],
              row.signed,
              signal,
              { rpc: guardedRpc },
            );
    if (!claimed)
      return fail('Submission did not reach the saved send marker.');
    if (outcome.state === 'sent' && outcome.signature === row.signature) {
      try {
        await change('submitted');
      } catch {
        return readVenueLaunchRecovery(db, owner, venue, row.id);
      }
    }
  } else if (action.action === 'recover' || action.action === 'cancel') {
    if (terminal(row)) return publicVenueLaunchRecovery(row);
    if (action.action === 'cancel' && row.state === 'review') {
      await change('cancelled');
    } else {
      let observed;
      try {
        observed = await observePumpLaunchRecovery(
          {
            minimumSlot: row.minimum_slot,
            mint: row.mint,
            lastValidBlockHeight: review.input.lastValidBlockHeight,
            signed: row.signed,
            signature: row.signature,
            verifySigned: (packet) => verifyPacket(review, packet),
          },
          signal,
          rpc,
        );
      } catch (error) {
        if (error instanceof PumpPreflightError)
          return fail(error.message, error.status);
        throw error;
      }
      if (observed.state !== 'pending')
        await change(observed.state, ',receipt=?', [
          JSON.stringify(observed.receipt),
        ]);
    }
  }
  return publicVenueLaunchRecovery(row);
}
