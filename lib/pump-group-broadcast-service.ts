import bs58 from 'bs58';
import { PumpPreflightError } from './owned-pump-preflight';
import { readPumpLaunchGroupReview } from './pump-launch-group-review-service';
import {
  canonicalPumpHolderJson,
  pumpHolderDigest,
} from './pump-holder-review';
import {
  pumpGroupRuntimeProgramScope,
  requirePumpRuntimePreview,
  type PumpGroupRuntimePreview,
} from './pump-group-runtime-authorization';
import { collectPumpProgramIdentities } from './pump-group-code-identity';
import { jitoRpc } from './jito-provider';
import { simulateOwnedPumpGroupBroadcast } from './pump-group-broadcast-simulation';
import {
  buildPumpGroupTip,
  broadcastBudgets,
  PUMP_GROUP_JITO_ENDPOINT,
  PUMP_GROUP_JITO_TIP_ACCOUNTS,
  requirePumpGroupBroadcastReview,
  requirePumpGroupBroadcastConsent,
  verifyPumpGroupTip,
  type PumpGroupBroadcastReview,
  type PumpGroupBroadcastState,
  type PumpGroupBroadcastConsent,
} from './pump-group-broadcast';
import type { PumpLaunchRpc } from './pump-launch-simulation';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
export type PumpGroupJitoRpc = (
  method: 'getTipAccounts' | 'sendBundle' | 'getBundleStatuses',
  params: unknown[],
  signal: AbortSignal,
) => Promise<unknown>;
export const pumpGroupBroadcastFail = (
  message: string,
  status = 409,
): never => {
  throw new PumpPreflightError(message, status);
};
const fail = pumpGroupBroadcastFail;
export async function requirePumpGroupBroadcastGuards(db: D1Database) {
  const result = await db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('pump_group_broadcast_review_insert','pump_group_broadcast_tip_insert','pump_group_broadcast_attempt_insert','pump_group_broadcast_result_insert','pump_group_broadcast_observation_insert','pump_group_broadcast_closure_insert','pump_group_broadcast_closure_apply','pump_group_terminal_broadcast_guard','pump_group_broadcast_reviews_no_update','pump_group_broadcast_reviews_no_delete','pump_group_broadcast_tips_no_update','pump_group_broadcast_tips_no_delete','pump_group_broadcast_attempts_no_update','pump_group_broadcast_attempts_no_delete','pump_group_broadcast_results_no_update','pump_group_broadcast_results_no_delete','pump_group_broadcast_observations_no_update','pump_group_broadcast_observations_no_delete','pump_group_broadcast_closures_no_update','pump_group_broadcast_closures_no_delete','pump_group_shared_reservation_update')",
    )
    .first<{ n: number }>();
  if (result?.n !== 21)
    fail('Group broadcast migration is not installed.', 503);
}
export async function readOwnedPumpGroupBroadcast(
  db: D1Database,
  owner: string,
  id: string,
): Promise<PumpGroupBroadcastState | null> {
  await requirePumpGroupBroadcastGuards(db);
  const group = await readPumpLaunchGroupReview(db, owner, id);
  const row = await db
    .prepare(
      'SELECT review,code,id FROM pump_group_broadcast_reviews WHERE owner_id=? AND review_id=?',
    )
    .bind(owner, id)
    .first<{ review: string; code: string; id: string }>();
  if (!row) return null;
  const review = await requirePumpGroupBroadcastReview(
    JSON.parse(row.review),
    group.review,
    false,
  );
  if (review.signedGroupSha256 !== group.signedEvidence?.signedGroupSha256)
    return fail('Retained broadcast group differs.');
  const code = await requirePumpRuntimePreview(
    JSON.parse(row.code),
    group.review,
    false,
  );
  if (code.identitySha256 !== review.codeIdentitySha256)
    return fail('Retained broadcast code consent differs.');
  const tipRow = await db
    .prepare(
      'SELECT transaction_bytes,signature,sha256 FROM pump_group_broadcast_tips WHERE owner_id=? AND review_id=? AND broadcast_id=?',
    )
    .bind(owner, id, row.id)
    .first<{ transaction_bytes: string; signature: string; sha256: string }>();
  const tip = tipRow
    ? await verifyPumpGroupTip(review, tipRow.transaction_bytes)
    : null;
  if (
    tip &&
    (tip.signature !== tipRow!.signature || tip.sha256 !== tipRow!.sha256)
  )
    return fail('Retained tip evidence differs.');
  const attempt = await db
    .prepare(
      'SELECT review_id FROM pump_group_broadcast_attempts WHERE owner_id=? AND review_id=? AND broadcast_id=?',
    )
    .bind(owner, id, row.id)
    .first();
  const outcome = await db
    .prepare(
      'SELECT bundle_id,outcome FROM pump_group_broadcast_results WHERE owner_id=? AND review_id=?',
    )
    .bind(owner, id)
    .first<{ bundle_id: string | null; outcome: 'accepted' | 'unknown' }>();
  const observation = await db
    .prepare(
      'SELECT observation,sha256 FROM pump_group_broadcast_observations o WHERE o.owner_id=? AND o.review_id=? AND o.broadcast_id=? AND (NOT EXISTS(SELECT 1 FROM pump_group_broadcast_closures c WHERE c.review_id=o.review_id AND c.owner_id=o.owner_id) OR o.id=(SELECT observation_id FROM pump_group_broadcast_closures c WHERE c.review_id=o.review_id AND c.owner_id=o.owner_id)) ORDER BY created_at DESC,id DESC LIMIT 1',
    )
    .bind(owner, id, row.id)
    .first<{ observation: string; sha256: string }>();
  const recovery = observation
    ? (JSON.parse(
        observation.observation,
      ) as PumpGroupBroadcastState['recovery'])
    : null;
  if (recovery) {
    const { sha256, ...body } = recovery;
    if (
      sha256 !== observation!.sha256 ||
      sha256 !== (await pumpHolderDigest(body)) ||
      recovery.broadcastSha256 !== review.sha256
    )
      return fail('Retained broadcast recovery differs.');
  }
  const closure = await db
    .prepare(
      'SELECT receipt FROM pump_group_broadcast_closures WHERE owner_id=? AND review_id=?',
    )
    .bind(owner, id)
    .first<{ receipt: string }>();
  if (
    closure &&
    (!group.receipt ||
      canonicalPumpHolderJson(group.receipt) !== closure.receipt)
  )
    return fail('Broadcast reservation closure differs.');
  return {
    review,
    code,
    tip,
    attempted: !!attempt,
    result: outcome
      ? { bundleId: outcome.bundle_id, outcome: outcome.outcome }
      : null,
    recovery,
    reservationsReleased: !!closure,
  };
}
async function approvedCode(db: D1Database, owner: string, id: string) {
  const group = await readPumpLaunchGroupReview(db, owner, id);
  const row = await db
    .prepare(
      'SELECT v.preview FROM pump_group_signing_authorizations a JOIN pump_group_runtime_reviews v ON v.id=a.preview_id AND v.owner_id=a.owner_id AND v.review_id=a.review_id WHERE a.owner_id=? AND a.review_id=? ORDER BY a.created_at DESC,a.id DESC LIMIT 1',
    )
    .bind(owner, id)
    .first<{ preview: string }>();
  if (!row)
    return fail(
      'This group needs its recorded explicit deployed-code approval before broadcast.',
    );
  return requirePumpRuntimePreview(
    JSON.parse(row.preview),
    group.review,
    false,
  );
}
async function checkCurrentCode(
  group: Awaited<ReturnType<typeof readPumpLaunchGroupReview>>,
  code: PumpGroupRuntimePreview,
  slot: number,
  signal: AbortSignal,
  rpc: PumpLaunchRpc,
) {
  const scope = await pumpGroupRuntimeProgramScope(group.review);
  const current = await collectPumpProgramIdentities(scope, slot, signal, rpc);
  if (
    canonicalPumpHolderJson(current.programs) !==
    canonicalPumpHolderJson(code.programs)
  )
    fail(
      'Deployed program bytes or authority changed after explicit approval. This group cannot broadcast.',
    );
}
export async function prepareOwnedPumpGroupBroadcast(
  db: D1Database,
  owner: string,
  id: string,
  tipRaw: string,
  tipFeeLimitRaw: string,
  signal: AbortSignal,
  rpc: PumpLaunchRpc,
  jito: PumpGroupJitoRpc = jitoRpc,
) {
  broadcastBudgets(tipRaw, tipFeeLimitRaw);
  signal.throwIfAborted();
  const existing = await readOwnedPumpGroupBroadcast(db, owner, id);
  if (existing) {
    if (
      existing.review.tipRaw !== tipRaw ||
      existing.review.tipFeeLimitRaw !== tipFeeLimitRaw
    )
      return fail(
        'Recover the original broadcast review; its tip and fee cap are immutable.',
      );
    return existing;
  }
  const group = await readPumpLaunchGroupReview(db, owner, id);
  if (
    group.state !== 'signed' ||
    !group.signedEvidence ||
    group.review.packets.length > 4
  )
    return fail(
      'Jito broadcast requires the exact signed launch group with at most four launch packets, plus its separate tip.',
    );
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(55000)]);
  const code = await approvedCode(db, owner, id);
  const tips = await jito('getTipAccounts', [], deadline);
  if (
    !Array.isArray(tips) ||
    !tips.length ||
    tips.length > 32 ||
    new Set(tips).size !== tips.length ||
    tips.some(
      (v) =>
        typeof v !== 'string' ||
        bs58.decode(v).length !== 32 ||
        !(PUMP_GROUP_JITO_TIP_ACCOUNTS as readonly string[]).includes(v),
    )
  )
    return fail('Reviewed Jito tip accounts are unavailable.');
  const input: Omit<PumpGroupBroadcastReview, 'sha256'> = {
    format: 'pump-group-jito-broadcast-v1' as const,
    id: crypto.randomUUID(),
    reviewId: id,
    contextSha256: group.review.contextSha256,
    signedGroupSha256: group.signedEvidence.signedGroupSha256,
    codeIdentitySha256: code.identitySha256,
    endpoint: PUMP_GROUP_JITO_ENDPOINT,
    payer: group.review.input.create.payer,
    recipient: tips[
      crypto.getRandomValues(new Uint32Array(1))[0] % tips.length
    ] as string,
    tipRaw,
    tipFeeLimitRaw,
    tipTransaction: '',
    blockhash: group.review.input.create.blockhash,
    lastValidBlockHeight: group.review.input.create.lastValidBlockHeight,
    transactions: group.signedEvidence.packets.map((p) => p.transaction),
    createdAt: new Date().toISOString(),
    expiresAt: group.review.expiresAt,
    atomicity: 'jito-transport-requested-not-proven' as const,
    executionAllowed: false as const,
    completeLaunch: false as const,
  };
  input.tipTransaction = buildPumpGroupTip(input).transaction;
  let review = { ...input, sha256: await pumpHolderDigest(input) };
  await requirePumpGroupBroadcastReview(review, group.review);
  const simulation = await simulateOwnedPumpGroupBroadcast(
    db,
    owner,
    review,
    null,
    deadline,
    rpc,
  );
  await checkCurrentCode(group, code, simulation.bankSlot, deadline, rpc);
  input.createdAt = new Date().toISOString();
  review = { ...input, sha256: await pumpHolderDigest(input) };
  await requirePumpGroupBroadcastReview(review, group.review);
  deadline.throwIfAborted();
  try {
    await db
      .prepare(
        'INSERT INTO pump_group_broadcast_reviews(id,review_id,owner_id,context_sha256,signed_group_sha256,sha256,review,code,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        review.id,
        id,
        owner,
        review.contextSha256,
        review.signedGroupSha256,
        review.sha256,
        canonicalPumpHolderJson(review),
        canonicalPumpHolderJson(code),
        review.createdAt,
        review.expiresAt,
      )
      .run();
  } catch {
    return fail(
      'Group ownership or broadcast review changed before preparation was saved.',
    );
  }
  return readOwnedPumpGroupBroadcast(db, owner, id);
}
export async function registerOwnedPumpGroupTip(
  db: D1Database,
  owner: string,
  id: string,
  broadcastId: string,
  sha256: string,
  transaction: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const saved = await readOwnedPumpGroupBroadcast(db, owner, id);
  if (
    !saved ||
    saved.review.id !== broadcastId ||
    saved.review.sha256 !== sha256
  )
    return fail('Exact owned broadcast review is required.');
  const tip = await verifyPumpGroupTip(saved.review, transaction);
  signal.throwIfAborted();
  if (saved.tip) {
    if (canonicalPumpHolderJson(saved.tip) !== canonicalPumpHolderJson(tip))
      return fail('Retained tip bytes differ.');
    return saved;
  }
  if (saved.attempted)
    return fail(
      'This broadcast was already attempted. Recover it without signing again.',
    );
  try {
    await db
      .prepare(
        'INSERT INTO pump_group_broadcast_tips(review_id,broadcast_id,owner_id,transaction_bytes,signature,sha256,created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .bind(
        id,
        broadcastId,
        owner,
        tip.transaction,
        tip.signature,
        tip.sha256,
        new Date().toISOString(),
      )
      .run();
  } catch {
    return fail(
      'Group or tip registration changed. Reload its retained history.',
    );
  }
  return readOwnedPumpGroupBroadcast(db, owner, id);
}
/** Single use is persisted before contacting Jito. Every network failure, abort or malformed acknowledgement becomes uncertain; never a resend. */
export async function submitOwnedPumpGroupBroadcast(
  db: D1Database,
  owner: string,
  id: string,
  consent: PumpGroupBroadcastConsent,
  signal: AbortSignal,
  rpc: PumpLaunchRpc,
  jito: PumpGroupJitoRpc = jitoRpc,
) {
  signal.throwIfAborted();
  const saved = await readOwnedPumpGroupBroadcast(db, owner, id);
  if (!saved) return fail('Prepare the exact broadcast and tip first.');
  requirePumpGroupBroadcastConsent(saved.review, consent);
  if (saved.attempted) return saved;
  if (!saved.tip)
    return fail('Retain the explicitly approved signed tip before broadcast.');
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(55000)]);
  const group = await readPumpLaunchGroupReview(db, owner, id);
  await requirePumpGroupBroadcastReview(saved.review, group.review);
  const tip = await verifyPumpGroupTip(saved.review, saved.tip.transaction);
  const simulation = await simulateOwnedPumpGroupBroadcast(
    db,
    owner,
    saved.review,
    tip.transaction,
    deadline,
    rpc,
  );
  await checkCurrentCode(group, saved.code, simulation.bankSlot, deadline, rpc);
  await requirePumpGroupBroadcastReview(saved.review, group.review);
  deadline.throwIfAborted();
  const height = await rpc(
    'getBlockHeight',
    [{ commitment: 'confirmed' }],
    deadline,
  );
  if (
    (typeof height !== 'string' && typeof height !== 'number') ||
    BigInt(String(height)) + 10n >= BigInt(saved.review.lastValidBlockHeight)
  )
    return fail('Original broadcast lifetime is too close to expiry.');
  const vector = [...saved.review.transactions, tip.transaction];
  if ((await rpc('getGenesisHash', [], deadline)) !== SOLANA_MAINNET_GENESIS)
    return fail('Broadcast provider network changed before the send attempt.');
  const evidence = {
    broadcastSha256: saved.review.sha256,
    tipSha256: tip.sha256,
    wireSha256: await pumpHolderDigest(vector),
    simulation,
    fullCodeRechecked: true,
    codeIdentitySha256: saved.code.identitySha256,
  };
  deadline.throwIfAborted();
  try {
    await db
      .prepare(
        'INSERT INTO pump_group_broadcast_attempts(review_id,broadcast_id,owner_id,consent,evidence,created_at) VALUES(?,?,?,?,?,?)',
      )
      .bind(
        id,
        saved.review.id,
        owner,
        canonicalPumpHolderJson(consent),
        canonicalPumpHolderJson(evidence),
        new Date().toISOString(),
      )
      .run();
  } catch {
    const raced = await readOwnedPumpGroupBroadcast(db, owner, id);
    if (raced?.attempted) return raced;
    return fail(
      'Ownership or broadcast approval changed before the send attempt.',
    );
  }
  let bundleId: string | null = null;
  try {
    deadline.throwIfAborted();
    const result = await new Promise<unknown>((resolve, reject) => {
      const abort = () => reject(new Error('Broadcast result is uncertain.'));
      deadline.addEventListener('abort', abort, { once: true });
      if (deadline.aborted) {
        abort();
        deadline.removeEventListener('abort', abort);
        return;
      }
      Promise.resolve()
        .then(() => {
          deadline.throwIfAborted();
          return jito('sendBundle', [vector, { encoding: 'base64' }], deadline);
        })
        .then(resolve, reject)
        .finally(() => deadline.removeEventListener('abort', abort));
    });
    if (typeof result === 'string' && /^[a-f0-9]{64}$/.test(result))
      bundleId = result;
  } catch {
    /* A consumed attempt is always recovered through reads, never resent. */
  }
  try {
    await db
      .prepare(
        'INSERT INTO pump_group_broadcast_results(review_id,owner_id,bundle_id,outcome,created_at) VALUES(?,?,?,?,?)',
      )
      .bind(
        id,
        owner,
        bundleId,
        bundleId ? 'accepted' : 'unknown',
        new Date().toISOString(),
      )
      .run();
  } catch {
    /* Missing result still reads as an uncertain consumed attempt. */
  }
  return readOwnedPumpGroupBroadcast(db, owner, id);
}
