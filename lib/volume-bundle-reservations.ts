import { address } from '@solana/kit';
import {
  requireVolumeBundlePlan,
  type VolumeBundlePlan,
} from './volume-bundle-plan';
import {
  volumeDigest,
  volumeKeys,
  volumeReject,
  type VolumeBundleConstruction,
} from './volume-bundle-construction';
import type { VolumePumpRoute } from './volume-bundle-route';
import {
  validateVolumeProgramRuntime,
  VOLUME_PROGRAM_POLICY,
  type VolumeProgramPolicy,
  type VolumeValidatedRuntime,
} from './volume-bundle-programs';
import type { VolumeSimulationRpc } from './volume-bundle-simulation';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const identity = (v: string) => {
  if (typeof v !== 'string' || !uuid.test(v))
    volumeReject('Volume identity differs.');
};
const revision = (v: number) => {
  if (!Number.isSafeInteger(v) || v < 1 || v > 1e9)
    volumeReject('Volume revision differs.');
};
const owned = (v: string) => {
  if (typeof v !== 'string' || !v || v.length > 128)
    volumeReject('Owned Volume scope required.');
};
export type VolumeBundleSessionRequest = {
  id: string;
  projectId: string;
  projectRevision: number;
  mint: string;
  plan: VolumeBundlePlan;
  wallets: { address: string; revision: number }[];
};
type SessionRow = {
  id: string;
  owner_id: string;
  project_id: string;
  project_revision: number;
  revision: number;
  mint: string;
  plan: string;
  plan_sha256: string;
  wallets: string;
  tip_budget: number;
  created_at: string;
};
async function session(db: D1Database, owner: string, id: string) {
  owned(owner);
  identity(id);
  const row = await db
    .prepare('SELECT * FROM volume_bundle_sessions WHERE owner_id=? AND id=?')
    .bind(owner, id)
    .first<SessionRow>();
  if (!row) return volumeReject('Owned Volume session unavailable.');
  const plan = requireVolumeBundlePlan(
    JSON.parse(row.plan) as VolumeBundlePlan,
  );
  if (
    (await volumeDigest(plan)) !== row.plan_sha256 ||
    row.tip_budget !== Number(plan.terms.tipBudgetLamports) ||
    row.revision !== 1
  )
    volumeReject('Stored Volume session differs.');
  return { row, plan };
}
/** Saves reviewed planning terms only. No wallets or money are held until an individual round is reserved. */
export async function createVolumeBundleSession(
  db: D1Database,
  owner: string,
  supplied: VolumeBundleSessionRequest,
) {
  owned(owner);
  volumeKeys(supplied, 'id,projectId,projectRevision,mint,plan,wallets');
  const input = structuredClone(supplied),
    plan = requireVolumeBundlePlan(input.plan);
  identity(input.id);
  identity(input.projectId);
  revision(input.projectRevision);
  address(input.mint);
  if (
    !Array.isArray(input.wallets) ||
    input.wallets.length !== plan.terms.wallets.length
  )
    volumeReject('Exact wallet revision roster required.');
  for (const [i, w] of input.wallets.entries()) {
    volumeKeys(w, 'address,revision');
    revision(w.revision);
    if (w.address !== plan.terms.wallets[i])
      volumeReject('Wallet roster changed.');
  }
  const planText = JSON.stringify(plan),
    walletText = JSON.stringify(input.wallets),
    sha = await volumeDigest(plan);
  const old = await db
    .prepare('SELECT id FROM volume_bundle_sessions WHERE owner_id=? AND id=?')
    .bind(owner, input.id)
    .first();
  if (!old)
    await db
      .prepare(`INSERT INTO volume_bundle_sessions(id,owner_id,project_id,project_revision,revision,mint,plan,plan_sha256,wallets,tip_budget,created_at)
    VALUES(?,?,?,?,1,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(id) DO NOTHING`)
      .bind(
        input.id,
        owner,
        input.projectId,
        input.projectRevision,
        input.mint,
        planText,
        sha,
        walletText,
        Number(plan.terms.tipBudgetLamports),
      )
      .run();
  const saved = await session(db, owner, input.id);
  if (
    saved.row.project_id !== input.projectId ||
    saved.row.project_revision !== input.projectRevision ||
    saved.row.mint !== input.mint ||
    saved.row.plan !== planText ||
    saved.row.wallets !== walletText
  )
    volumeReject('Session identity already binds different terms.');
  return {
    id: saved.row.id,
    revision: 1,
    plan: saved.plan,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
type ReservationRow = {
  id: string;
  owner_id: string;
  session_id: string;
  session_revision: number;
  round: number;
  wallet: string;
  wallet_revision: number;
  construction_sha256: string;
  runtime_sha256: string;
  document: string;
  tip_cap: number;
  state: 'held' | 'attempted' | 'cancelled' | 'settled';
  attempt_id: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
};
/** Historical reads retain expired/attempted holds. They are never a new execution authorization. */
export async function readVolumeBundleReservation(
  db: D1Database,
  owner: string,
  id: string,
) {
  owned(owner);
  identity(id);
  const row = await db
    .prepare(
      'SELECT * FROM volume_bundle_reservations WHERE owner_id=? AND id=?',
    )
    .bind(owner, id)
    .first<ReservationRow>();
  if (!row) return null;
  const runtime = JSON.parse(row.document) as VolumeValidatedRuntime,
    { sha256, ...terms } = runtime;
  if (
    (await volumeDigest(terms)) !== sha256 ||
    sha256 !== row.runtime_sha256 ||
    runtime.executionAllowed !== false ||
    runtime.signingAllowed !== false ||
    runtime.construction.sha256 !== row.construction_sha256 ||
    runtime.construction.wallet !== row.wallet ||
    runtime.construction.input.sessionId !== row.session_id ||
    runtime.construction.input.sessionRevision !== row.session_revision ||
    runtime.construction.input.round !== row.round ||
    !['held', 'attempted', 'cancelled', 'settled'].includes(row.state)
  )
    volumeReject('Stored reservation identity differs.');
  return {
    id: row.id,
    sessionId: row.session_id,
    sessionRevision: row.session_revision,
    round: row.round,
    wallet: row.wallet,
    walletRevision: row.wallet_revision,
    constructionSha256: row.construction_sha256,
    runtimeSha256: row.runtime_sha256,
    routeSha256: runtime.route.sha256,
    tipCapLamports: String(row.tip_cap),
    state: row.state,
    attemptId: row.attempt_id,
    expiresAt: row.expires_at,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
export type VolumeReservationRequest = {
  id: string;
  sessionId: string;
  sessionRevision: number;
  walletRevision: number;
  construction: VolumeBundleConstruction;
  route: VolumePumpRoute;
};
export type VolumeReservationDependencies = {
  rpc: VolumeSimulationRpc;
  policy?: VolumeProgramPolicy | null;
  minimumSlot: number;
  now?: () => number;
};
/** Server-internal composition: collect fresh runtime here, never accept a client-supplied simulation/proof. */
export async function reserveVolumeBundleRound(
  db: D1Database,
  owner: string,
  supplied: VolumeReservationRequest,
  deps: VolumeReservationDependencies,
  signal: AbortSignal,
) {
  volumeKeys(
    supplied,
    'id,sessionId,sessionRevision,walletRevision,construction,route',
  );
  const input = structuredClone(supplied);
  owned(owner);
  identity(input.id);
  identity(input.sessionId);
  revision(input.sessionRevision);
  revision(input.walletRevision);
  const saved = await session(db, owner, input.sessionId),
    candidate = input.construction;
  if (
    candidate.input.sessionId !== saved.row.id ||
    candidate.input.sessionRevision !== saved.row.revision ||
    input.sessionRevision !== saved.row.revision ||
    candidate.input.projectId !== saved.row.project_id ||
    candidate.input.projectRevision !== saved.row.project_revision ||
    candidate.input.mint !== saved.row.mint ||
    JSON.stringify(candidate.input.plan) !== saved.row.plan
  )
    volumeReject('Construction differs from the saved session.');
  const roster = JSON.parse(saved.row.wallets) as {
    address: string;
    revision: number;
  }[];
  if (
    !roster.some(
      (w) =>
        w.address === candidate.wallet && w.revision === input.walletRevision,
    )
  )
    volumeReject('Wallet revision differs from session.');
  const existing = await readVolumeBundleReservation(db, owner, input.id);
  if (existing) {
    if (
      existing.sessionId !== input.sessionId ||
      existing.sessionRevision !== input.sessionRevision ||
      existing.walletRevision !== input.walletRevision ||
      existing.constructionSha256 !== candidate.sha256 ||
      existing.routeSha256 !== input.route.sha256
    )
      volumeReject('Reservation identity already binds different terms.');
    return existing;
  }
  signal.throwIfAborted();
  const current = await db
    .prepare(`SELECT 1 AS ok FROM imported_token_projects p JOIN workspace_wallets w ON w.owner_id=p.owner_id AND w.chain='Solana' AND w.address=?
   JOIN wallet_ownership_proofs o ON o.owner_id=w.owner_id AND o.chain=w.chain AND o.address=w.address
   WHERE p.owner_id=? AND p.id=? AND p.revision=? AND p.archived=0 AND p.chain='Solana' AND json_extract(p.document,'$.token.address')=? AND w.revision=? AND w.archived=0`)
    .bind(
      candidate.wallet,
      owner,
      saved.row.project_id,
      saved.row.project_revision,
      saved.row.mint,
      input.walletRevision,
    )
    .first();
  if (!current) volumeReject('Current project or proven wallet changed.');
  const runtime = await validateVolumeProgramRuntime(
    candidate,
    input.route,
    deps.rpc,
    signal,
    deps.minimumSlot,
    deps.policy ?? VOLUME_PROGRAM_POLICY,
    deps.now,
  );
  signal.throwIfAborted();
  const expiresAt = new Date(
    Date.parse(runtime.observedAt) + 30000,
  ).toISOString();
  try {
    await db
      .prepare(`INSERT INTO volume_bundle_reservations(id,owner_id,session_id,session_revision,round,wallet,wallet_revision,construction_sha256,runtime_sha256,document,tip_cap,state,attempt_id,expires_at,created_at,updated_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,'held',NULL,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .bind(
        input.id,
        owner,
        input.sessionId,
        input.sessionRevision,
        candidate.input.round,
        candidate.wallet,
        input.walletRevision,
        candidate.sha256,
        runtime.sha256,
        JSON.stringify(runtime),
        Number(
          candidate.input.plan.rounds[candidate.input.round].tipCapLamports,
        ),
        expiresAt,
      )
      .run();
  } catch (error) {
    const raced = await readVolumeBundleReservation(db, owner, input.id);
    if (
      raced &&
      raced.sessionId === input.sessionId &&
      raced.sessionRevision === input.sessionRevision &&
      raced.walletRevision === input.walletRevision &&
      raced.constructionSha256 === candidate.sha256 &&
      raced.routeSha256 === input.route.sha256
    )
      return raced;
    throw error;
  }
  return readVolumeBundleReservation(db, owner, input.id);
}
/** Conservative pre-attempt marker only: no approval, signature or send. Only verified recovery can settle an attempt. */
export async function markVolumeBundleAttempted(
  db: D1Database,
  owner: string,
  id: string,
  attemptId: string,
) {
  owned(owner);
  identity(id);
  identity(attemptId);
  const old = await readVolumeBundleReservation(db, owner, id);
  if (old?.state === 'attempted' && old.attemptId === attemptId) return old;
  const r = await db
    .prepare(
      `UPDATE volume_bundle_reservations SET state='attempted',attempt_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=? AND id=? AND state='held' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
    .bind(attemptId, owner, id)
    .run();
  if (r.meta.changes !== 1)
    volumeReject('Reservation cannot be marked attempted.');
  return readVolumeBundleReservation(db, owner, id);
}
/** Only an explicitly cancelled, never-attempted hold returns its cap. No automatic expiry release. */
export async function cancelVolumeBundleReservation(
  db: D1Database,
  owner: string,
  id: string,
) {
  owned(owner);
  identity(id);
  const old = await readVolumeBundleReservation(db, owner, id);
  if (old?.state === 'cancelled') return old;
  const r = await db
    .prepare(
      `UPDATE volume_bundle_reservations SET state='cancelled',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=? AND id=? AND state='held' AND attempt_id IS NULL`,
    )
    .bind(owner, id)
    .run();
  if (r.meta.changes !== 1)
    volumeReject('Unresolved attempted reservations cannot be released.');
  return readVolumeBundleReservation(db, owner, id);
}
export async function readVolumeBundleTipBudget(
  db: D1Database,
  owner: string,
  sessionId: string,
) {
  const saved = await session(db, owner, sessionId);
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN r.state IN ('held','attempted') THEN r.tip_cap ELSE 0 END),0) AS held,
       COALESCE(SUM(CASE WHEN r.state='settled' THEN s.tip_spent ELSE 0 END),0) AS spent
       FROM volume_bundle_reservations r LEFT JOIN volume_bundle_settlements s ON s.reservation_id=r.id AND s.owner_id=r.owner_id WHERE r.owner_id=? AND r.session_id=?`,
    )
    .bind(owner, sessionId)
    .first<{ held: number; spent: number }>();
  const held = row?.held ?? 0;
  const spent = row?.spent ?? 0;
  if (
    !Number.isSafeInteger(held) ||
    !Number.isSafeInteger(spent) ||
    held < 0 ||
    spent < 0 ||
    held + spent > saved.row.tip_budget
  )
    volumeReject('Stored tip budget differs.');
  return {
    totalLamports: String(saved.row.tip_budget),
    heldLamports: String(held),
    spentLamports: String(spent),
    availableLamports: String(saved.row.tip_budget - held - spent),
    executionAllowed: false as const,
  };
}
