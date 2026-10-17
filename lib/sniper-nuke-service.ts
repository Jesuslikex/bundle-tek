import { PumpPreflightError } from './owned-pump-preflight';
import { env } from './server-env';
import { sniperGuardActions, sniperGuardDisplay } from './sniper-guard';
import {
  readLaunchTokenBalances,
  type SniperGuardRpc,
} from './sniper-guard-chain';
import { readSniperGuard } from './sniper-guard-service';
import {
  SNIPER_NUKE_MAX_WALLETS,
  verifySniperNukeSigned,
  type SniperNukeBatch,
  type SniperNukeConsent,
  type SniperNukeSellState,
} from './sniper-nuke';
import { prepareSolanaSwap } from './warmup-swap-quote';
import { simulateImportedSwap } from './imported-swap-simulation';
import {
  requireWarmupSigningReview,
  type WarmupSigningReview,
} from './warmup-signing';

/** Builds one reviewed full-balance sell for a wallet. Never signs. */
export type SniperNukeSellPreparer = (
  input: { mint: string; wallet: string; amountRaw: string; decimals: number },
  signal: AbortSignal,
) => Promise<WarmupSigningReview>;

const fail = (message: string, status = 409): never => {
  throw new PumpPreflightError(message, status);
};
const OPEN = "('review','signed','submitting','submitted')";

export const prepareJupiterNukeSell: SniperNukeSellPreparer = async (
  input,
  signal,
) => {
  const key = (env as unknown as { JUPITER_API_KEY?: string }).JUPITER_API_KEY;
  if (!key) return fail('Sell quote provider is unavailable.', 503);
  const order = await prepareSolanaSwap(
    {
      tokenMint: input.mint,
      side: 'Sell',
      amount: sniperGuardDisplay(input.amountRaw, input.decimals),
      decimals: input.decimals,
      wallet: input.wallet,
    },
    key,
    signal,
  );
  const simulation = await simulateImportedSwap(order, signal, fetch, true);
  const settlement = await requireWarmupSigningReview(order, simulation);
  return {
    id: crypto.randomUUID(),
    preparationId: crypto.randomUUID(),
    wallet: input.wallet,
    sha256: order.preparation.sha256,
    network: 'mainnet',
    expiresAt: order.expiresAt,
    maximumFeeLamports: simulation.networkFeeLamports,
    inputRaw: order.inAmount,
    minimumOutputRaw: order.minimumOutAmount,
    inputMint: order.inputMint,
    outputMint: order.outputMint,
    transaction: order.preparation.transaction,
    lastValidBlockHeight: order.preparation.lastValidBlockHeight,
    settlement,
    ...(order.platformFee ? { platformFee: order.platformFee } : {}),
  };
};

type Row = {
  id: string;
  guard_id: string;
  batch_id: string;
  wallet: string;
  review: string;
  state: SniperNukeSellState;
  signed: string | null;
  signature: string | null;
};

async function batchRows(db: D1Database, owner: string, batchId: string) {
  const { results } = await db
    .prepare(
      'SELECT id,guard_id,batch_id,wallet,review,state,signed,signature FROM sniper_nuke_sells WHERE owner_id=? AND batch_id=? ORDER BY created_at,id',
    )
    .bind(owner, batchId)
    .all<Row>();
  return results;
}
function publicBatch(
  reviewId: string,
  rows: Row[],
  skipped: SniperNukeBatch['skipped'] = [],
): SniperNukeBatch {
  return {
    batchId: rows[0].batch_id,
    reviewId,
    guardId: rows[0].guard_id,
    sells: rows.map((r) => ({
      id: r.id,
      wallet: r.wallet,
      state: r.state,
      signature: r.signature,
      review: JSON.parse(r.review) as WarmupSigningReview,
    })),
    skipped,
  };
}

/** Latest Nuke batch for a guarded launch, or null. */
export async function readSniperNuke(
  db: D1Database,
  owner: string,
  reviewId: string,
) {
  const guard = await readSniperGuard(db, owner, reviewId);
  if (!guard) return null;
  const latest = await db
    .prepare(
      'SELECT batch_id FROM sniper_nuke_sells WHERE owner_id=? AND guard_id=? ORDER BY created_at DESC,id DESC LIMIT 1',
    )
    .bind(owner, guard.id)
    .first<{ batch_id: string }>();
  return latest
    ? publicBatch(reviewId, await batchRows(db, owner, latest.batch_id))
    : null;
}

/**
 * Prepares one unsigned sell per Nuke wallet that still holds tokens. A
 * wallet whose sell cannot be prepared is reported, not silently dropped.
 */
export async function prepareSniperNuke(
  db: D1Database,
  owner: string,
  reviewId: string,
  rpc: SniperGuardRpc,
  signal: AbortSignal,
  prepareSell: SniperNukeSellPreparer = prepareJupiterNukeSell,
  now = new Date(),
) {
  const guard = await readSniperGuard(db, owner, reviewId);
  if (!guard || guard.state !== 'triggered' || !guard.launch)
    return fail('Nuke sells are only prepared after Sniper Guard triggers.');
  const open = await db
    .prepare(
      `SELECT batch_id FROM sniper_nuke_sells WHERE owner_id=? AND guard_id=? AND state IN ${OPEN} LIMIT 1`,
    )
    .bind(owner, guard.id)
    .first<{ batch_id: string }>();
  if (open)
    return publicBatch(reviewId, await batchRows(db, owner, open.batch_id));
  const wallets = sniperGuardActions(guard.settings, guard.launch).sellWallets;
  if (!wallets.length) return fail('This guard response sells nothing.');
  if (wallets.length > SNIPER_NUKE_MAX_WALLETS)
    return fail(
      `A Nuke batch covers up to ${SNIPER_NUKE_MAX_WALLETS} wallets.`,
    );
  const balances = await readLaunchTokenBalances(
    rpc,
    guard.launch.mint,
    wallets,
    signal,
  );
  const skipped: SniperNukeBatch['skipped'] = [];
  const reviews: WarmupSigningReview[] = [];
  const settled = await Promise.allSettled(
    balances.map(async (balance) => {
      if (balance.amountRaw === '0') {
        skipped.push({ wallet: balance.wallet, reason: 'No tokens to sell.' });
        return;
      }
      if (balance.decimals === undefined) {
        skipped.push({
          wallet: balance.wallet,
          reason: 'Token precision unavailable.',
        });
        return;
      }
      const review = await prepareSell(
        {
          mint: guard.launch!.mint,
          wallet: balance.wallet,
          amountRaw: balance.amountRaw,
          decimals: balance.decimals,
        },
        signal,
      );
      if (
        review.wallet !== balance.wallet ||
        review.inputMint !== guard.launch!.mint ||
        review.inputRaw !== balance.amountRaw
      )
        throw new Error('Prepared sell differs from the wallet balance.');
      reviews.push(review);
    }),
  );
  settled.forEach((result, index) => {
    if (result.status === 'rejected')
      skipped.push({
        wallet: balances[index].wallet,
        reason:
          result.reason instanceof Error
            ? result.reason.message
            : 'Sell could not be prepared.',
      });
  });
  if (!reviews.length)
    return fail(
      'No Nuke sell could be prepared: ' +
        skipped.map((s) => `${s.wallet}: ${s.reason}`).join('; '),
    );
  const batchId = crypto.randomUUID(),
    at = now.toISOString();
  await db.batch(
    reviews.map((review) =>
      db
        .prepare(
          "INSERT INTO sniper_nuke_sells(id,owner_id,guard_id,batch_id,wallet,review,review_sha256,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'review',?,?)",
        )
        .bind(
          review.id,
          owner,
          guard.id,
          batchId,
          review.wallet,
          JSON.stringify(review),
          review.sha256,
          at,
          at,
        ),
    ),
  );
  return publicBatch(reviewId, await batchRows(db, owner, batchId), skipped);
}

/** Registers every locally signed sell of the batch at once, or none. */
export async function registerSniperNuke(
  db: D1Database,
  owner: string,
  reviewId: string,
  consent: SniperNukeConsent,
  signed: { id: string; transaction: string }[],
  now = new Date(),
) {
  if (
    !consent ||
    typeof consent !== 'object' ||
    typeof consent.batchId !== 'string'
  )
    return fail('Approve this exact Nuke batch first.', 400);
  const rows = await batchRows(db, owner, consent.batchId);
  if (!rows.length) return fail('Nuke batch not found.', 404);
  const open = rows.filter((r) => r.state === 'review');
  const expected = open
    .map(
      (r) => `${r.id}:${(JSON.parse(r.review) as WarmupSigningReview).sha256}`,
    )
    .sort()
    .join(',');
  if (
    consent.approved !== true ||
    consent.scope !== 'sniper-guard-nuke-batch' ||
    consent.acknowledgeFullBalanceSells !== true ||
    !Array.isArray(consent.sells) ||
    consent.sells
      .map((s) => `${s.id}:${s.sha256}`)
      .sort()
      .join(',') !== expected ||
    !Array.isArray(signed) ||
    signed.length !== open.length ||
    signed
      .map((s) => s.id)
      .sort()
      .join(',') !==
      open
        .map((r) => r.id)
        .sort()
        .join(',')
  )
    return fail('Approve and sign every sell in this exact Nuke batch.');
  const updates = [];
  for (const row of open) {
    const review = JSON.parse(row.review) as WarmupSigningReview;
    if (Date.parse(review.expiresAt) <= now.getTime())
      return fail('This Nuke batch expired. Prepare fresh sells.');
    const transaction = signed.find((s) => s.id === row.id)!.transaction;
    const signature = await verifySniperNukeSigned(review, transaction);
    updates.push(
      db
        .prepare(
          "UPDATE sniper_nuke_sells SET state='signed',signed=?,signature=?,updated_at=? WHERE owner_id=? AND id=? AND state='review'",
        )
        .bind(transaction, signature, now.toISOString(), owner, row.id),
    );
  }
  await db.batch(updates);
  return publicBatch(reviewId, await batchRows(db, owner, consent.batchId));
}

/** Settles sent sells from signature status and expires stale ones. */
export async function observeSniperNuke(
  db: D1Database,
  owner: string,
  reviewId: string,
  batchId: string,
  rpc: SniperGuardRpc,
  signal: AbortSignal,
) {
  const rows = await batchRows(db, owner, batchId);
  if (!rows.length) return fail('Nuke batch not found.', 404);
  const pending = rows.filter((r) =>
    ['review', 'signed', 'submitting', 'submitted'].includes(r.state),
  );
  if (pending.length) {
    const height = BigInt(
      String(
        await rpc('getBlockHeight', [{ commitment: 'finalized' }], signal),
      ),
    );
    const sent = pending.filter((r) => r.signature);
    const statuses = sent.length
      ? ((await rpc(
          'getSignatureStatuses',
          [sent.map((r) => r.signature), { searchTransactionHistory: true }],
          signal,
        )) as {
          value?: ({ confirmationStatus?: string; err?: unknown } | null)[];
        })
      : { value: [] };
    if (
      !Array.isArray(statuses?.value) ||
      statuses.value.length !== sent.length
    )
      return fail('Nuke sell status read differs.', 502);
    for (const row of pending) {
      const review = JSON.parse(row.review) as WarmupSigningReview;
      const status = row.signature ? statuses.value[sent.indexOf(row)] : null;
      let next: SniperNukeSellState | null = null;
      if (status?.confirmationStatus === 'finalized')
        next = status.err ? 'failed' : 'finalized';
      else if (!status && height > BigInt(review.lastValidBlockHeight))
        next = 'expired';
      if (!next || next === row.state) continue;
      await db
        .prepare(
          `UPDATE sniper_nuke_sells SET state=?,receipt=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=? AND id=? AND state=?`,
        )
        .bind(
          next,
          next === 'expired'
            ? null
            : JSON.stringify({
                err: status?.err ?? null,
                height: String(height),
              }),
          owner,
          row.id,
          row.state,
        )
        .run();
    }
  }
  return publicBatch(reviewId, await batchRows(db, owner, batchId));
}

/**
 * One-attempt send of one signed Nuke sell, only on the user's click. State
 * moves to submitting before the only provider call, so a lost response is
 * never resent; observation settles it.
 */
export async function sendSniperNukeSell(
  db: D1Database,
  owner: string,
  reviewId: string,
  batchId: string,
  sellId: string,
  rpc: SniperGuardRpc,
  signal: AbortSignal,
  now = new Date(),
) {
  const row = (await batchRows(db, owner, batchId)).find(
    (r) => r.id === sellId,
  );
  if (!row) return fail('Nuke sell not found.', 404);
  if (row.state !== 'signed' || !row.signed)
    return publicBatch(reviewId, await batchRows(db, owner, batchId));
  const review = JSON.parse(row.review) as WarmupSigningReview;
  if (Date.parse(review.expiresAt) <= now.getTime())
    return fail('This Nuke sell expired. Prepare a fresh batch.', 409);
  const claimed = await db
    .prepare(
      "UPDATE sniper_nuke_sells SET state='submitting',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=? AND id=? AND state='signed'",
    )
    .bind(owner, sellId)
    .run();
  if (claimed.meta.changes)
    try {
      signal.throwIfAborted();
      const signature = await rpc(
        'sendTransaction',
        [
          row.signed,
          {
            encoding: 'base64',
            skipPreflight: false,
            preflightCommitment: 'confirmed',
            maxRetries: 0,
          },
        ],
        signal,
      );
      if (signature === row.signature)
        await db
          .prepare(
            "UPDATE sniper_nuke_sells SET state='submitted',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=? AND id=? AND state='submitting'",
          )
          .bind(owner, sellId)
          .run();
    } catch {
      // Unknown outcome stays submitting; only observation can settle it.
    }
  return publicBatch(reviewId, await batchRows(db, owner, batchId));
}

/** Discards an unsigned batch so a fresh one can be prepared. */
export async function cancelSniperNuke(
  db: D1Database,
  owner: string,
  reviewId: string,
  batchId: string,
) {
  await db
    .prepare(
      "UPDATE sniper_nuke_sells SET state='cancelled',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=? AND batch_id=? AND state='review'",
    )
    .bind(owner, batchId)
    .run();
  const rows = await batchRows(db, owner, batchId);
  if (!rows.length) return fail('Nuke batch not found.', 404);
  return publicBatch(reviewId, rows);
}
