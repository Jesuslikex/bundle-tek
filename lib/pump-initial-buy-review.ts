import { buildPumpCreateAndBuyMessage } from './pump-initial-buy-message';
import {
  preflightOwnedPumpInitialBuy,
  PumpPreflightError,
  type OwnedPumpTerms,
} from './owned-pump-preflight';
import {
  encodePumpSigningInput,
  decodePumpSigningInput,
} from './pump-launch-signing';
import {
  requirePumpInitialBuySigningReview,
  requirePumpInitialBuyReviewForRecovery,
  verifyPumpInitialBuySignedPacket,
  type PumpInitialBuySigningReview,
} from './pump-initial-buy-signing';
import {
  pumpLaunchRpc,
  requirePumpLaunchAuthorityPolicy,
} from './pump-launch-service';
import type { PumpCreateInput } from './pump-launch-message';
import type { PumpLaunchRpc } from './pump-launch-simulation';
import { observePumpLaunchRecovery } from './pump-launch-recovery';
type Terms = OwnedPumpTerms & { maximumQuoteCostRaw: string };
type Row = {
  id: string;
  owner_id: string;
  project_document: string;
  terms: string;
  review: string;
  simulation: string;
  state: string;
  mint: string;
  signed: string | null;
  signature: string | null;
  receipt: string | null;
  expires_at: string;
};
export const publicPumpInitialBuyReview = (row: Row) => ({
  format: 'pump-create-buy-review-v1' as const,
  review: JSON.parse(row.review) as PumpInitialBuySigningReview,
  simulation: JSON.parse(row.simulation) as Awaited<
    ReturnType<typeof preflightOwnedPumpInitialBuy>
  >['simulation'],
  state: row.state,
  signingAllowed:
    row.state === 'approved' && Date.parse(row.expires_at) > Date.now(),
  signature: row.signature,
  receipt: row.receipt ? JSON.parse(row.receipt) : null,
  approvedScope: 'create-and-developer-buy' as const,
  simulationLimits: [
    'program-deployment-metadata-only',
    'buyback-split-rounding-unattested',
  ] as const,
  executionAllowed: false as const,
  completeLaunch: false as const,
  containsHolderBuys: false as const,
});
const fail = (message: string, status = 409): never => {
  throw new PumpPreflightError(message, status);
};

/** Server-internal immutable review preparation. Owner must come from an authenticated session. */
export async function preparePumpInitialBuyReview(
  db: D1Database,
  owner: string,
  supplied: Terms,
  signal: AbortSignal,
  rpc: PumpLaunchRpc = pumpLaunchRpc(),
) {
  const terms = structuredClone(supplied);
  const encodedTerms = JSON.stringify(terms, Object.keys(terms).sort());
  if (
    !/^[1-9]\d{0,9}$/.test(terms.feeAndRentLimitRaw) ||
    BigInt(terms.feeAndRentLimitRaw) > 1000000000n
  )
    fail('Review a positive fee/rent allowance of at most 1 SOL.', 400);
  const saved = await db
    .prepare(
      'SELECT document,updated_at,archived FROM workspace_projects WHERE owner_id=? AND id=?',
    )
    .bind(owner, terms.projectId)
    .first<{ document: string; updated_at: string; archived: number }>();
  if (!saved || saved.archived)
    return fail('Active owned launch project not found.', 404);
  if (saved.updated_at !== terms.updatedAt)
    fail('Save and review the current launch draft.');
  const existing = await db
    .prepare(
      "SELECT * FROM pump_launch_reviews WHERE owner_id=? AND project_id=? AND state NOT IN ('cancelled','failed')",
    )
    .bind(owner, terms.projectId)
    .first<Row>();
  if (existing) {
    if (
      existing.project_document !== saved.document ||
      existing.terms !== encodedTerms
    )
      fail(
        'Another launch review reserves this project. Recover or cancel it before preparing different terms.',
      );
    return publicPumpInitialBuyReview(existing);
  }
  const reserved = await db
    .prepare(`SELECT 1 AS reserved FROM solana_execution_reservations WHERE owner_id=? AND wallet_address=?
    UNION ALL SELECT 1 FROM pump_launch_reviews WHERE (owner_id=? AND payer=? AND state NOT IN ('cancelled','failed','finalized'))
    OR (mint=? AND state NOT IN ('cancelled','failed')) LIMIT 1`)
    .bind(owner, terms.payer, owner, terms.payer, terms.mint)
    .first();
  if (reserved)
    fail(
      'This payer or mint is already reserved. Recover its existing operation first.',
    );
  let input: PumpCreateInput | undefined;
  const checked = await preflightOwnedPumpInitialBuy(db, owner, terms, signal, {
    rpc,
    captureInput: (v) => {
      input = v;
    },
  });
  await requirePumpLaunchAuthorityPolicy(checked.simulation, terms.mint);
  if (!input || signal.aborted) fail('Atomic launch preparation interrupted.');
  const review: PumpInitialBuySigningReview = {
    id: crypto.randomUUID(),
    projectId: terms.projectId,
    projectUpdatedAt: terms.updatedAt,
    releaseId: terms.releaseId,
    expiresAt: checked.simulation.expiresAt,
    transaction: checked.packet.transaction,
    sha256: checked.packet.sha256,
    input: {
      create: encodePumpSigningInput(input!),
      tokenAmountRaw: checked.tokenAmountRaw,
      maximumQuoteCostRaw: terms.maximumQuoteCostRaw,
      transactionVersion: 1,
    },
    developerSupplyPercent: checked.developerSupplyPercent,
    feeAndRentLimitRaw: terms.feeAndRentLimitRaw,
  };
  await requirePumpInitialBuySigningReview(review);
  if (signal.aborted) fail('Atomic launch preparation interrupted.');
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
        JSON.stringify(checked.simulation),
        new Date().toISOString(),
        review.expiresAt,
      )
      .run();
  } catch {
    fail(
      'Launch context or reservation changed. Reload its saved review before retrying.',
    );
  }
  const row = await db
    .prepare('SELECT * FROM pump_launch_reviews WHERE owner_id=? AND id=?')
    .bind(owner, review.id)
    .first<Row>();
  if (!row)
    fail('Saved atomic launch review is unavailable. Reload its history.');
  return publicPumpInitialBuyReview(row!);
}

/** Refresh the exact saved packet and original lifetime before a future explicit approval step. */
export async function refreshPumpInitialBuyReview(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
  rpc: PumpLaunchRpc = pumpLaunchRpc(),
) {
  const row = await db
    .prepare('SELECT * FROM pump_launch_reviews WHERE owner_id=? AND id=?')
    .bind(owner, id)
    .first<Row>();
  if (!row) return fail('Owned atomic launch review not found.', 404);
  const review = JSON.parse(row.review) as PumpInitialBuySigningReview;
  const terms = JSON.parse(row.terms) as Terms;
  await requirePumpInitialBuySigningReview(review);
  const built = await buildPumpCreateAndBuyMessage({
    ...review.input,
    create: decodePumpSigningInput(review.input.create),
  });
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
    return fail('Saved atomic launch changed. Recover or cancel its review.');
  const checked = await preflightOwnedPumpInitialBuy(db, owner, terms, signal, {
    rpc,
    lifetime: {
      blockhash: review.input.create.blockhash,
      lastValidBlockHeight: review.input.create.lastValidBlockHeight,
    },
  });
  await requirePumpLaunchAuthorityPolicy(checked.simulation, terms.mint);
  const original = JSON.parse(row.simulation) as typeof checked.simulation;
  const stable = (s: typeof checked.simulation) => ({
    accounts: s.accountHashes.map((a) => ({
      address: a.address,
      beforeSha256:
        a.address === built.buybackAccount
          ? (a.sourceIdentitySha256 ?? a.beforeSha256)
          : a.beforeSha256,
      ...(a.address === built.volumeAccount
        ? {}
        : {
            simulatedSha256:
              a.address === built.buybackAccount
                ? (a.simulatedIdentitySha256 ?? a.simulatedSha256)
                : a.simulatedSha256,
          }),
    })),
    programs: s.programDeploymentHashes,
    price: s.price,
    quoteCostRaw: s.quoteCostRaw,
    feeAndRentDebitRaw: s.feeAndRentDebitRaw,
    payerDebitRaw: s.payerDebitRaw,
    networkFeeRaw: s.networkFeeRaw,
    buybackFeeRaw: s.buybackFeeRaw,
    retainedProtocolFeeRaw: s.retainedProtocolFeeRaw,
    creatorFeeUnclaimedRaw: s.creatorFeeUnclaimedRaw,
    rentAccounts: s.rentAccounts,
    volumeGainRaw: s.volumeGainRaw,
  });
  if (
    checked.packet.sha256 !== review.sha256 ||
    JSON.stringify(stable(checked.simulation)) !==
      JSON.stringify(stable(original)) ||
    signal.aborted
  )
    return fail(
      'Atomic launch packet, costs or observed state changed. Prepare a new review.',
    );
  return checked;
}

export async function actPumpInitialBuyReview(
  db: D1Database,
  owner: string,
  id: string,
  action: 'approve' | 'register' | 'submit' | 'recover' | 'cancel',
  payload: {
    approved?: boolean;
    sha256?: string;
    transaction?: string;
    approvedScope?: string;
    acknowledgeSimulationLimits?: boolean;
  },
  signal: AbortSignal,
  rpc: PumpLaunchRpc = pumpLaunchRpc(),
) {
  const read = () =>
    db
      .prepare(
        "SELECT * FROM pump_launch_reviews WHERE owner_id=? AND id=? AND json_type(terms,'$.maximumQuoteCostRaw') IS NOT NULL",
      )
      .bind(owner, id)
      .first<Row>();
  let found = await read();
  if (!found) return fail('Owned atomic launch review not found.', 404);
  let row: Row = found;
  const review = JSON.parse(row.review) as PumpInitialBuySigningReview;
  const change = async (
    state: string,
    extraSql = '',
    extra: unknown[] = [],
  ) => {
    if (signal.aborted) fail('Atomic launch action interrupted.');
    const result = await db
      .prepare(
        `UPDATE pump_launch_reviews SET state=?${extraSql} WHERE owner_id=? AND id=? AND state=? AND review=? AND signed IS ? AND signature IS ?`,
      )
      .bind(
        state,
        ...extra,
        owner,
        id,
        row.state,
        row.review,
        row.signed,
        row.signature,
      )
      .run();
    if (!result.meta.changes)
      fail('Atomic launch state changed. Reload its saved history.');
    found = await read();
    if (!found) fail('Saved atomic review unavailable.');
    row = found!;
  };
  const consent = () => {
    if (
      payload.approved !== true ||
      payload.sha256 !== review.sha256 ||
      payload.approvedScope !== 'create-and-developer-buy' ||
      payload.acknowledgeSimulationLimits !== true
    )
      fail(
        'Approve this exact create/developer-buy packet and acknowledge its simulation limits. Holder buys are not included.',
        400,
      );
  };
  if (action === 'approve') {
    consent();
    if (row.state === 'approved') return publicPumpInitialBuyReview(row);
    if (row.state !== 'review')
      fail('This atomic launch cannot be approved again.');
    await refreshPumpInitialBuyReview(db, owner, id, signal, rpc);
    await change('approved');
  } else if (action === 'register') {
    if (typeof payload.transaction !== 'string')
      fail('Both signed atomic launch signatures are required.', 400);
    if (row.signed === payload.transaction)
      return publicPumpInitialBuyReview(row);
    if (row.state !== 'approved')
      fail('Approve this atomic launch before registering signatures.');
    // Retain signatures for recovery even if their lifetime has elapsed. Never sends.
    const signature = await verifyPumpInitialBuySignedPacket(
      review,
      payload.transaction!,
    );
    await change('signed', ',signed=?,signature=?', [
      payload.transaction,
      signature,
    ]);
  } else if (action === 'submit') {
    consent();
    if (row.state !== 'signed') return publicPumpInitialBuyReview(row);
    if (
      !row.signed ||
      (await verifyPumpInitialBuySignedPacket(review, row.signed)) !==
        row.signature
    )
      fail('Saved atomic signatures differ.');
    const checked = await refreshPumpInitialBuyReview(
      db,
      owner,
      id,
      signal,
      rpc,
    );
    await change('submitting');
    try {
      const signature = await rpc(
        'sendTransaction',
        [
          row.signed,
          {
            encoding: 'base64',
            skipPreflight: false,
            preflightCommitment: 'confirmed',
            maxRetries: 0,
            minContextSlot: checked.simulation.maximumSlot,
          },
        ],
        signal,
      );
      if (signature !== row.signature)
        fail('Provider returned a different signature. Recover status.');
      await change('submitted');
    } catch {
      const latest = await read();
      return publicPumpInitialBuyReview(latest ?? row);
    }
  } else if (action === 'recover' || action === 'cancel') {
    if (
      !['review', 'approved', 'signed', 'submitting', 'submitted'].includes(
        row.state,
      )
    )
      return publicPumpInitialBuyReview(row);
    if (action === 'cancel' && row.state === 'review') {
      await change('cancelled');
      return publicPumpInitialBuyReview(row);
    }
    if (row.state === 'review') return publicPumpInitialBuyReview(row);
    await requirePumpInitialBuyReviewForRecovery(review);
    if (
      row.mint !== review.input.create.mint ||
      (row.state !== 'approved' && (!row.signed || !row.signature))
    )
      return fail('Saved atomic recovery context or signatures differ.');
    const original = JSON.parse(row.simulation) as { minimumSlot: number };
    const observed = await observePumpLaunchRecovery(
      {
        minimumSlot: original.minimumSlot,
        mint: review.input.create.mint,
        lastValidBlockHeight: review.input.create.lastValidBlockHeight,
        signed: row.signed,
        signature: row.signature,
        verifySigned: (packet) =>
          verifyPumpInitialBuySignedPacket(review, packet),
      },
      signal,
      rpc,
    );
    if (observed.state === 'pending') return publicPumpInitialBuyReview(row);
    await change(observed.state, ',receipt=?', [
      JSON.stringify({
        ...observed.receipt,
        packetSha256: review.sha256,
        containsInitialBuy: true,
        containsHolderBuys: false,
      }),
    ]);
  }
  return publicPumpInitialBuyReview(row);
}

export async function listPumpInitialBuyReviews(
  db: D1Database,
  owner: string,
  projectId: string,
) {
  const { results } = await db
    .prepare(
      "SELECT * FROM pump_launch_reviews WHERE owner_id=? AND project_id=? AND json_type(terms,'$.maximumQuoteCostRaw') IS NOT NULL ORDER BY created_at DESC LIMIT 20",
    )
    .bind(owner, projectId)
    .all<Row>();
  return results.map(publicPumpInitialBuyReview);
}
