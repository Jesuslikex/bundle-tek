import { UUID } from './wallet-operation';
import { walletAddress } from './wallet-workspace';
import { decodeCounterPlan, readCounterPlan } from './counter-trade-store';
import type { CounterBuyPreparation } from './counter-buy-preparation';
import type { reviewCounterBuySettlement } from './counter-buy-settlement';
export type CounterReservationRequest = {
  id: string;
  projectId: string;
  projectRevision: number;
  planId: string;
  planRevision: number;
  decisionIdentity: string;
  wallet: string;
  walletRevision: number;
  sha256: string;
  expiresAt: string;
  maximumInputRaw: string;
  minimumOutputRaw: string;
  maximumFeeAndRentRaw: string;
};
type CounterReservationDocument = CounterReservationRequest & {
  format: 'counter-reservation-v1';
  executionAllowed: false;
  side: 'Buy' | 'Sell';
  mint: string;
  decimals: number;
  proposalTokenRaw: string;
};
export type CounterReservation = {
  document: CounterReservationDocument;
  approvalId: string | null;
  createdAt: string;
  updatedAt: string;
  executionAllowed: false;
};
const uint = (v: string, positive = false) => {
  if (
    typeof v !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(v) ||
    BigInt(v) > (1n << 64n) - 1n ||
    (positive && v === '0')
  )
    throw new Error('Counter reservation requires exact bounded amounts.');
  return v;
};
function validate(request: CounterReservationRequest) {
  const v = structuredClone(request);
  if (
    Object.keys(v).sort().join(',') !==
    'decisionIdentity,expiresAt,id,maximumFeeAndRentRaw,maximumInputRaw,minimumOutputRaw,planId,planRevision,projectId,projectRevision,sha256,wallet,walletRevision'
  )
    throw new Error('Review exact Counter reservation terms.');
  for (const id of [v.id, v.projectId, v.planId])
    if (typeof id !== 'string' || !UUID.test(id))
      throw new Error('Choose current Counter reservation identities.');
  for (const revision of [v.projectRevision, v.planRevision, v.walletRevision])
    if (!Number.isSafeInteger(revision) || revision < 1 || revision > 1e9)
      throw new Error('Choose current Counter reservation revisions.');
  walletAddress(v.wallet, 'Solana');
  if (
    typeof v.decisionIdentity !== 'string' ||
    !v.decisionIdentity ||
    v.decisionIdentity.length > 512 ||
    typeof v.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.sha256) ||
    !Number.isFinite(Date.parse(v.expiresAt)) ||
    new Date(v.expiresAt).toISOString() !== v.expiresAt ||
    Date.parse(v.expiresAt) <= Date.now() ||
    Date.parse(v.expiresAt) > Date.now() + 30000
  )
    throw new Error('Counter reservation packet or expiry differs.');
  uint(v.maximumInputRaw, true);
  uint(v.minimumOutputRaw, true);
  uint(v.maximumFeeAndRentRaw);
  return {
    id: v.id,
    projectId: v.projectId,
    projectRevision: v.projectRevision,
    planId: v.planId,
    planRevision: v.planRevision,
    decisionIdentity: v.decisionIdentity,
    wallet: v.wallet,
    walletRevision: v.walletRevision,
    sha256: v.sha256,
    expiresAt: v.expiresAt,
    maximumInputRaw: v.maximumInputRaw,
    minimumOutputRaw: v.minimumOutputRaw,
    maximumFeeAndRentRaw: v.maximumFeeAndRentRaw,
  };
}
type Row = {
  id: string;
  project_revision: number;
  plan_revision: number;
  wallet_address: string;
  wallet_revision: number;
  packet_sha256: string;
  expires_at: string;
  document: string;
  approval_id: string | null;
  created_at: string;
  updated_at: string;
};
function decode(
  row: Row,
  projectId: string,
  planId: string,
  identity: string,
): CounterReservation {
  const document = JSON.parse(row.document) as CounterReservationDocument;
  if (
    !document ||
    document.format !== 'counter-reservation-v1' ||
    document.executionAllowed !== false ||
    document.projectId !== projectId ||
    document.planId !== planId ||
    document.decisionIdentity !== identity ||
    document.id !== row.id ||
    document.projectRevision !== row.project_revision ||
    document.planRevision !== row.plan_revision ||
    document.wallet !== row.wallet_address ||
    document.walletRevision !== row.wallet_revision ||
    document.sha256 !== row.packet_sha256 ||
    document.expiresAt !== row.expires_at ||
    !['Buy', 'Sell'].includes(document.side) ||
    !UUID.test(document.id) ||
    !/^[a-f0-9]{64}$/.test(document.sha256)
  )
    throw new Error('Stored Counter reservation context differs.');
  walletAddress(document.wallet, 'Solana');
  walletAddress(document.mint, 'Solana');
  for (const key of [
    'proposalTokenRaw',
    'maximumInputRaw',
    'minimumOutputRaw',
  ] as const)
    uint(document[key], true);
  uint(document.maximumFeeAndRentRaw);
  if (row.approval_id !== null && !UUID.test(row.approval_id))
    throw new Error('Stored Counter approval identity differs.');
  return {
    document,
    approvalId: row.approval_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    executionAllowed: false,
  };
}
export async function readCounterReservation(
  db: D1Database,
  owner: string,
  projectId: string,
  planId: string,
  identity: string,
) {
  const row = await db
    .prepare(
      'SELECT * FROM counter_proposal_reservations WHERE owner_id=? AND project_id=? AND plan_id=? AND decision_identity=?',
    )
    .bind(owner, projectId, planId, identity)
    .first<Row>();
  return row ? decode(row, projectId, planId, identity) : null;
}
/** Inputs must be derived from server-reviewed preparation, never a client proof. */
export async function reserveCounterProposal(
  db: D1Database,
  owner: string,
  value: CounterReservationRequest,
) {
  const v = validate(value);
  const row = await db
    .prepare(
      "SELECT c.revision,c.state,c.document,p.document AS projectDocument,p.address,p.revision AS projectRevision,p.archived FROM counter_trade_plans c JOIN imported_token_projects p ON p.owner_id=c.owner_id AND p.id=c.project_id JOIN workspace_wallets w ON w.owner_id=c.owner_id AND w.chain='Solana' AND w.address=? AND w.revision=? WHERE c.owner_id=? AND c.project_id=? AND c.id=? AND p.chain='Solana' AND w.archived=0 AND EXISTS(SELECT 1 FROM wallet_ownership_proofs o WHERE o.owner_id=c.owner_id AND o.chain='Solana' AND o.address=w.address) AND NOT EXISTS(SELECT 1 FROM wallet_ownership_proofs o WHERE o.owner_id=c.owner_id AND o.chain='Solana' AND NOT EXISTS(SELECT 1 FROM json_each(c.document,'$.rules.ignoredWallets') x WHERE x.value=o.address))",
    )
    .bind(v.wallet, v.walletRevision, owner, v.projectId, v.planId)
    .first<{
      revision: number;
      state: string;
      document: string;
      projectDocument: string;
      address: string;
      projectRevision: number;
      archived: number;
    }>();
  if (!row) throw new Error('Owned Counter proposal unavailable.');
  const plan = decodeCounterPlan(JSON.parse(row.document)),
    decision = plan.ledger.decisions.find(
      (d) => d.identity === v.decisionIdentity,
    );
  if (
    plan.id !== v.planId ||
    plan.projectId !== v.projectId ||
    plan.revision !== row.revision ||
    plan.state !== row.state ||
    plan.revision !== v.planRevision ||
    plan.state !== 'active' ||
    row.archived ||
    row.projectRevision !== v.projectRevision ||
    plan.ledger.scope.revision !== v.projectRevision ||
    plan.ledger.scope.mint !== row.address ||
    plan.projectDocument !== row.projectDocument ||
    decision?.outcome !== 'proposal' ||
    decision.proposalTokenRaw === null
  )
    throw new Error('Counter proposal or project changed before reservation.');
  if (
    plan.rules.responseSide === 'Buy'
      ? v.minimumOutputRaw !== decision.proposalTokenRaw
      : v.maximumInputRaw !== decision.proposalTokenRaw
  )
    throw new Error(
      'Counter reservation target differs from the retained proposal.',
    );
  const document: CounterReservationDocument = {
    ...v,
    format: 'counter-reservation-v1',
    executionAllowed: false,
    side: plan.rules.responseSide,
    mint: plan.ledger.scope.mint,
    decimals: plan.ledger.scope.decimals,
    proposalTokenRaw: decision.proposalTokenRaw,
  };
  const now = new Date().toISOString();
  const existing = await readCounterReservation(
    db,
    owner,
    v.projectId,
    v.planId,
    v.decisionIdentity,
  );
  if (
    existing &&
    (existing.approvalId !== null ||
      Date.parse(existing.document.expiresAt) > Date.now())
  ) {
    if (JSON.stringify(existing.document) === JSON.stringify(document))
      return {
        reservation: existing,
        replayed: true,
        executionAllowed: false as const,
      };
    throw new Error(
      'Counter proposal already has a retained reservation or approval.',
    );
  }
  const written = await db
    .prepare(
      "INSERT INTO counter_proposal_reservations(owner_id,project_id,plan_id,decision_identity,id,project_revision,plan_revision,wallet_address,wallet_revision,packet_sha256,document,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,project_id,plan_id,decision_identity) DO UPDATE SET id=excluded.id,project_revision=excluded.project_revision,plan_revision=excluded.plan_revision,wallet_address=excluded.wallet_address,wallet_revision=excluded.wallet_revision,packet_sha256=excluded.packet_sha256,document=excluded.document,expires_at=excluded.expires_at,updated_at=excluded.updated_at WHERE counter_proposal_reservations.approval_id IS NULL AND counter_proposal_reservations.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    )
    .bind(
      owner,
      v.projectId,
      v.planId,
      v.decisionIdentity,
      v.id,
      v.projectRevision,
      v.planRevision,
      v.wallet,
      v.walletRevision,
      v.sha256,
      JSON.stringify(document),
      v.expiresAt,
      existing?.createdAt ?? now,
      now,
    )
    .run();
  const reservation = await readCounterReservation(
    db,
    owner,
    v.projectId,
    v.planId,
    v.decisionIdentity,
  );
  if (
    !reservation ||
    JSON.stringify(reservation.document) !== JSON.stringify(document)
  )
    throw new Error(
      'Counter reservation changed concurrently. Reload its retained approval.',
    );
  return {
    reservation,
    replayed: written.meta.changes === 0,
    executionAllowed: false as const,
  };
}

/** Connect the server-derived native proof to its proposal reservation. */
export async function reserveReviewedCounterBuy(
  db: D1Database,
  owner: string,
  id: string,
  walletRevision: number,
  preparation: CounterBuyPreparation,
  proof: Awaited<ReturnType<typeof reviewCounterBuySettlement>>,
) {
  const q = preparation.quote;
  const current = await readCounterPlan(db, owner, q.projectId, q.planId);
  if (
    !current ||
    current.rules.responseSide !== 'Buy' ||
    current.ledger.scope.mint !== q.outputMint ||
    current.ledger.scope.decimals !== preparation.tokenDecimals
  )
    throw new Error(
      'Counter native proof mint or precision differs from its owned plan.',
    );
  if (
    proof.executionAllowed !== false ||
    proof.instructionsVerified !== false ||
    proof.swapMode !== 'ExactOut' ||
    proof.sha256 !== preparation.preparation.sha256 ||
    proof.wallet !== preparation.preparation.wallet ||
    proof.expiresAt !== preparation.expiresAt ||
    proof.projectId !== q.projectId ||
    proof.projectRevision !== q.projectRevision ||
    proof.planId !== q.planId ||
    proof.planRevision !== q.planRevision ||
    proof.decisionIdentity !== q.decisionIdentity ||
    BigInt(uint(proof.actualInputRaw, true)) >
      BigInt(uint(q.maximumSolInputRaw, true)) ||
    BigInt(uint(proof.settlement.maximumNativeDebitLamports, true)) >
      BigInt(uint(q.maximumSolInputRaw, true)) +
        BigInt(uint(proof.reviewedFeeAndRentLimitRaw))
  )
    throw new Error(
      'Counter reservation requires its server-reviewed native proof.',
    );
  return reserveCounterProposal(db, owner, {
    id,
    projectId: q.projectId,
    projectRevision: q.projectRevision,
    planId: q.planId,
    planRevision: q.planRevision,
    decisionIdentity: q.decisionIdentity,
    wallet: proof.wallet,
    walletRevision,
    sha256: proof.sha256,
    expiresAt: proof.expiresAt,
    maximumInputRaw: q.maximumSolInputRaw,
    minimumOutputRaw: q.outputTargetRaw,
    maximumFeeAndRentRaw: proof.reviewedFeeAndRentLimitRaw,
  });
}
