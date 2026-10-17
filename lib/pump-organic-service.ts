import bs58 from 'bs58';
import { PumpPreflightError } from './owned-pump-preflight';
import {
  requirePumpOrganicBatchConsent,
  requirePumpOrganicBatchReview,
  verifyPumpOrganicBatchSigned,
  type PumpOrganicBatchConsent,
  type PumpOrganicBatchReview,
} from './pump-organic-batch';
import {
  pumpUnsignedInteger,
  type PumpLaunchRpc,
} from './pump-launch-simulation';
import type { planPumpOrganicSequence } from './pump-organic-sequence';

type Plan = ReturnType<typeof planPumpOrganicSequence>;
const fail = (message: string, status = 409): never => {
  throw new PumpPreflightError(message, status);
};
const sha = async (value: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
type BuyRow = {
  batch_id: string;
  buy_index: number;
  holder: string;
  signed: string;
  signature: string;
  state: string;
  receipt: string | null;
};
type BatchRow = {
  id: string;
  sequence_id: string;
  batch: number;
  review: string;
  review_sha256: string;
  state: string;
  expires_at: string;
};
const EXPIRY_MARGIN_BLOCKS = 32n;

/** Saves the reviewed plan for one created token. The plan grants nothing on its own. */
export async function savePumpOrganicSequence(
  db: D1Database,
  owner: string,
  supplied: {
    projectId: string;
    launchReviewId: string;
    mint: string;
    rentAllowanceRaw: string;
    plan: Plan;
  },
) {
  const { projectId, launchReviewId, mint, rentAllowanceRaw, plan } =
    structuredClone(supplied);
  if (!/^(0|[1-9]\d{0,9})$/.test(rentAllowanceRaw))
    return fail('Review an exact per-buy rent allowance.', 400);
  if (
    plan?.format !== 'pump-organic-sequence-plan-v1' ||
    plan.signingAllowed !== false ||
    plan.executionAllowed !== false
  )
    return fail('Save a reviewed organic sequence plan.', 400);
  bs58.decode(mint);
  const project = await db
    .prepare(
      'SELECT 1 AS ok FROM workspace_projects WHERE owner_id=? AND id=? AND archived=0',
    )
    .bind(owner, projectId)
    .first<{ ok: number }>();
  if (!project) return fail('Saved project not found.', 404);
  const id = crypto.randomUUID(),
    text = JSON.stringify(plan);
  await db
    .prepare(
      "INSERT INTO pump_organic_sequences(id,owner_id,project_id,launch_review_id,mint,rent_allowance_raw,plan,plan_sha256,state) VALUES(?,?,?,?,?,?,?,?,'active')",
    )
    .bind(
      id,
      owner,
      projectId,
      launchReviewId,
      mint,
      rentAllowanceRaw,
      text,
      await sha(text),
    )
    .run();
  return { id, state: 'active' as const, plan };
}

export async function readPumpOrganicSequence(
  db: D1Database,
  owner: string,
  id: string,
) {
  const row = await db
    .prepare(
      'SELECT id,launch_review_id,mint,rent_allowance_raw,plan,state FROM pump_organic_sequences WHERE owner_id=? AND id=?',
    )
    .bind(owner, id)
    .first<{
      id: string;
      launch_review_id: string;
      mint: string;
      rent_allowance_raw: string;
      plan: string;
      state: string;
    }>();
  return row ?? fail('Organic sequence not found.', 404);
}
async function readBatch(db: D1Database, owner: string, id: string) {
  const row = await db
    .prepare(
      'SELECT id,sequence_id,batch,review,review_sha256,state,expires_at FROM pump_organic_batches WHERE owner_id=? AND id=?',
    )
    .bind(owner, id)
    .first<BatchRow>();
  return row ?? fail('Organic batch not found.', 404);
}
async function readBuys(db: D1Database, owner: string, batchId: string) {
  const { results } = await db
    .prepare(
      'SELECT batch_id,buy_index,holder,signed,signature,state,receipt FROM pump_organic_buys WHERE owner_id=? AND batch_id=? ORDER BY buy_index',
    )
    .bind(owner, batchId)
    .all<BuyRow>();
  return results;
}

/** Stores one batch review after checking it matches the saved plan's rows exactly. */
export async function savePumpOrganicBatch(
  db: D1Database,
  owner: string,
  supplied: PumpOrganicBatchReview,
) {
  const { review } = await requirePumpOrganicBatchReview(supplied);
  const sequence = await readPumpOrganicSequence(db, owner, review.sequenceId);
  if (sequence.state !== 'active')
    return fail('This organic sequence was stopped.');
  const plan = JSON.parse(sequence.plan) as Plan;
  const rows = plan.rows.filter((r) => r.batch === review.batch);
  if (
    review.mint !== sequence.mint ||
    rows.length !== review.buys.length ||
    rows.some(
      (r, n) =>
        review.buys[n].index !== r.index ||
        review.buys[n].holder !== r.address ||
        review.buys[n].batchOffsetMs !== r.batchOffsetMs ||
        review.buys[n].tokenAmountRaw !== r.tokenAmountRaw ||
        review.buys[n].maximumQuoteCostRaw !== r.maximumQuoteCostRaw,
    )
  )
    return fail('Organic batch differs from its saved plan.', 400);
  await db
    .prepare(
      "INSERT INTO pump_organic_batches(id,owner_id,sequence_id,batch,review,review_sha256,state,expires_at) VALUES(?,?,?,?,?,?,'review',?)",
    )
    .bind(
      review.id,
      owner,
      review.sequenceId,
      review.batch,
      JSON.stringify(review),
      review.sha256,
      review.expiresAt,
    )
    .run();
  return { id: review.id, state: 'review' as const };
}

/** Records exact consent and every verified holder signature at once. Never signs. */
export async function registerPumpOrganicBatch(
  db: D1Database,
  owner: string,
  batchId: string,
  supplied: { consent: PumpOrganicBatchConsent; transactions: string[] },
) {
  const row = await readBatch(db, owner, batchId);
  const review = JSON.parse(row.review) as PumpOrganicBatchReview;
  try {
    requirePumpOrganicBatchConsent(review, supplied.consent);
  } catch {
    return fail('Approve this exact organic batch before registering it.', 400);
  }
  if (row.state === 'signed') return publicBatch(db, owner, batchId);
  if (row.state !== 'review') return fail('Organic batch is no longer open.');
  if (Date.parse(row.expires_at) <= Date.now())
    return fail('Organic batch expired. Prepare the next batch again.');
  const signatures = await verifyPumpOrganicBatchSigned(
    review,
    supplied.transactions,
  );
  const statements = [
    db
      .prepare(
        "UPDATE pump_organic_batches SET state='signed',consent=? WHERE owner_id=? AND id=? AND state='review' AND review_sha256=?",
      )
      .bind(JSON.stringify(supplied.consent), owner, batchId, review.sha256),
    ...review.buys.map((buy, n) =>
      db
        .prepare(
          "INSERT INTO pump_organic_buys(owner_id,batch_id,buy_index,holder,signed,signature,state) VALUES(?,?,?,?,?,?,'signed')",
        )
        .bind(
          owner,
          batchId,
          buy.index,
          buy.holder,
          supplied.transactions[n],
          signatures[n],
        ),
    ),
  ];
  const results = await db.batch(statements);
  if (!results[0].meta.changes)
    return fail('Organic batch changed while registering.');
  return publicBatch(db, owner, batchId);
}

/**
 * One-attempt send of one signed buy. State moves to submitting before the
 * only provider call, so a lost response can never be resent.
 */
export async function sendPumpOrganicBuy(
  db: D1Database,
  owner: string,
  batchId: string,
  index: number,
  signal: AbortSignal,
  rpc: PumpLaunchRpc,
) {
  const buy = (await readBuys(db, owner, batchId)).find(
    (b) => b.buy_index === index,
  );
  if (!buy) return fail('Organic buy not found.', 404);
  if (buy.state !== 'signed') return publicBatch(db, owner, batchId);
  const claimed = await db
    .prepare(
      "UPDATE pump_organic_buys SET state='submitting',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=? AND batch_id=? AND buy_index=? AND state='signed'",
    )
    .bind(owner, batchId, index)
    .run()
    .catch(() => fail('Organic batch is stopped, expired or not signed.'));
  if (!claimed.meta.changes) return publicBatch(db, owner, batchId);
  try {
    signal.throwIfAborted();
    const signature = await rpc(
      'sendTransaction',
      [
        buy.signed,
        {
          encoding: 'base64',
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 0,
        },
      ],
      signal,
    );
    if (signature === buy.signature)
      await db
        .prepare(
          "UPDATE pump_organic_buys SET state='submitted',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=? AND batch_id=? AND buy_index=? AND state='submitting'",
        )
        .bind(owner, batchId, index)
        .run();
  } catch {
    // Unknown outcome stays submitting; only observation can settle it.
  }
  return publicBatch(db, owner, batchId);
}

/** Stops further sends. Signed-but-unsent buys are cancelled and simply expire on chain. */
export async function stopPumpOrganicSequence(
  db: D1Database,
  owner: string,
  sequenceId: string,
) {
  await readPumpOrganicSequence(db, owner, sequenceId);
  await db.batch([
    db
      .prepare(
        "UPDATE pump_organic_sequences SET state='stopped' WHERE owner_id=? AND id=? AND state='active'",
      )
      .bind(owner, sequenceId),
    db
      .prepare(
        "UPDATE pump_organic_batches SET state='stopped' WHERE owner_id=? AND sequence_id=? AND state IN ('review','signed')",
      )
      .bind(owner, sequenceId),
    db
      .prepare(
        "UPDATE pump_organic_buys SET state='cancelled',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=? AND state='signed' AND batch_id IN (SELECT id FROM pump_organic_batches WHERE owner_id=? AND sequence_id=?)",
      )
      .bind(owner, owner, sequenceId),
  ]);
  return { id: sequenceId, state: 'stopped' as const };
}

/**
 * Read-only settlement: finalized statuses settle submitted buys; anything
 * unseen after the lifetime plus a 32-block margin is recorded as expired.
 */
export async function observePumpOrganicBatch(
  db: D1Database,
  owner: string,
  batchId: string,
  signal: AbortSignal,
  rpc: PumpLaunchRpc,
) {
  const batch = await readBatch(db, owner, batchId);
  const review = JSON.parse(batch.review) as PumpOrganicBatchReview;
  const open = (await readBuys(db, owner, batchId)).filter((b) =>
    ['signed', 'submitting', 'submitted'].includes(b.state),
  );
  if (!open.length) return publicBatch(db, owner, batchId);
  const statuses = (await rpc(
    'getSignatureStatuses',
    [open.map((b) => b.signature), { searchTransactionHistory: true }],
    signal,
  )) as { value?: unknown[] };
  if (!Array.isArray(statuses?.value) || statuses.value.length !== open.length)
    return fail('Organic buy status mapping differs.');
  const height = pumpUnsignedInteger(
    await rpc('getBlockHeight', [{ commitment: 'finalized' }], signal),
  );
  const expired =
    height > BigInt(review.lastValidBlockHeight) + EXPIRY_MARGIN_BLOCKS;
  for (const [n, buy] of open.entries()) {
    const status = statuses.value[n] as {
      slot?: number;
      err?: unknown;
      confirmationStatus?: string;
    } | null;
    let next: string | undefined, receipt: unknown;
    if (status && status.confirmationStatus === 'finalized') {
      next = status.err === null ? 'finalized' : 'failed';
      receipt = { slot: status.slot, err: status.err ?? null };
    } else if (!status && expired) {
      next = 'expired';
      receipt = { finalizedBlockHeight: height.toString(), marginBlocks: 32 };
    }
    if (next)
      await db
        .prepare(
          "UPDATE pump_organic_buys SET state=?,receipt=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=? AND batch_id=? AND buy_index=? AND state=?",
        )
        .bind(
          next,
          JSON.stringify(receipt),
          owner,
          batchId,
          buy.buy_index,
          buy.state,
        )
        .run();
  }
  const remaining = (await readBuys(db, owner, batchId)).some((b) =>
    ['signed', 'submitting', 'submitted'].includes(b.state),
  );
  if (!remaining)
    await db
      .prepare(
        "UPDATE pump_organic_batches SET state='closed' WHERE owner_id=? AND id=? AND state IN ('signed','stopped')",
      )
      .bind(owner, batchId)
      .run();
  // Every planned batch closed: the sequence is complete and its wallet hold ends.
  await db
    .prepare(
      "UPDATE pump_organic_sequences SET state='complete' WHERE owner_id=? AND state='active' AND id=(SELECT sequence_id FROM pump_organic_batches WHERE id=?) AND json_array_length(plan,'$.batches')=(SELECT count(*) FROM pump_organic_batches b WHERE b.sequence_id=pump_organic_sequences.id AND b.state='closed')",
    )
    .bind(owner, batchId)
    .run();
  return publicBatch(db, owner, batchId);
}

export async function publicBatch(db: D1Database, owner: string, id: string) {
  const row = await readBatch(db, owner, id);
  const review = JSON.parse(row.review) as PumpOrganicBatchReview;
  const buys = await readBuys(db, owner, id);
  return {
    id: row.id,
    sequenceId: row.sequence_id,
    batch: row.batch,
    state: row.state,
    expiresAt: row.expires_at,
    review,
    buys: buys.map((b) => ({
      index: b.buy_index,
      holder: b.holder,
      signature: b.signature,
      state: b.state,
      receipt: b.receipt ? JSON.parse(b.receipt) : null,
      batchOffsetMs:
        review.buys.find((r) => r.index === b.buy_index)?.batchOffsetMs ?? 0,
    })),
    signingAllowed: false as const,
  };
}

/** Owned sequences of one project with every batch and buy state, newest first. */
export async function listPumpOrganicSequences(
  db: D1Database,
  owner: string,
  projectId: string,
) {
  const { results } = await db
    .prepare(
      'SELECT id,launch_review_id,mint,plan,state,created_at FROM pump_organic_sequences WHERE owner_id=? AND project_id=? ORDER BY created_at DESC LIMIT 20',
    )
    .bind(owner, projectId)
    .all<{
      id: string;
      launch_review_id: string;
      mint: string;
      plan: string;
      state: string;
      created_at: string;
    }>();
  const sequences = [];
  for (const row of results) {
    const { results: batches } = await db
      .prepare(
        'SELECT id FROM pump_organic_batches WHERE owner_id=? AND sequence_id=? ORDER BY batch',
      )
      .bind(owner, row.id)
      .all<{ id: string }>();
    sequences.push({
      id: row.id,
      launchReviewId: row.launch_review_id,
      mint: row.mint,
      state: row.state,
      createdAt: row.created_at,
      plan: JSON.parse(row.plan) as Plan,
      batches: await Promise.all(
        batches.map((b) => publicBatch(db, owner, b.id)),
      ),
    });
  }
  return sequences;
}
