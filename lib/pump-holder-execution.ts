import { PumpPreflightError } from './owned-pump-preflight';
import {
  readPumpHolderReview,
  publicPumpHolderReview,
  requirePumpHolderReservationGuards,
  refreshPumpHolderReview,
  cancelUnsignedPumpHolderReview,
  type PumpHolderReviewRow,
} from './pump-holder-review-service';
import {
  requirePumpHolderReview,
  type PumpHolderReview,
} from './pump-holder-review';
import {
  requirePumpHolderConsent,
  verifyPumpHolderSignedPacket,
  type PumpHolderConsent,
} from './pump-holder-signing';
import { pumpLaunchRpc } from './pump-launch-service';
import type { PumpLaunchRpc } from './pump-launch-simulation';
import { observePumpLaunchRecovery } from './pump-launch-recovery';

const fail = (message: string, status = 409): never => {
  throw new PumpPreflightError(message, status);
};
async function change(
  db: D1Database,
  owner: string,
  row: PumpHolderReviewRow,
  state: string,
  signal: AbortSignal,
  receipt?: unknown,
) {
  signal.throwIfAborted();
  const result = await db
    .prepare(`UPDATE pump_launch_reviews SET state=?${receipt === undefined ? '' : ',receipt=?'}
    WHERE owner_id=? AND id=? AND state=? AND review=? AND signed IS ? AND signature IS ?`)
    .bind(
      state,
      ...(receipt === undefined ? [] : [JSON.stringify(receipt)]),
      owner,
      row.id,
      row.state,
      row.review,
      row.signed,
      row.signature,
    )
    .run();
  if (!result.meta.changes)
    return fail('Holder launch state changed. Reload its saved history.');
  return readPumpHolderReview(db, owner, row.id);
}

/** Separate broadcast consent, complete original-packet refresh and durable one-attempt send. Never signs. */
export async function submitPumpHolderReview(
  db: D1Database,
  owner: string,
  id: string,
  supplied: { consent: PumpHolderConsent; submitApproved: true },
  signal: AbortSignal,
  rpc: PumpLaunchRpc = pumpLaunchRpc(),
) {
  signal.throwIfAborted();
  let row = await readPumpHolderReview(db, owner, id);
  const review = JSON.parse(row.review) as PumpHolderReview,
    payload = structuredClone(supplied);
  try {
    requirePumpHolderConsent(review, payload.consent);
    if (payload.submitApproved !== true) throw new Error();
  } catch {
    return fail(
      'Separately approve broadcasting this exact signed holder packet and context.',
      400,
    );
  }
  if (
    ['submitting', 'submitted', 'finalized', 'failed', 'cancelled'].includes(
      row.state,
    )
  )
    return publicPumpHolderReview(row);
  if (row.state !== 'signed' || !row.signed || !row.signature)
    return fail('Register every holder signature before submission.');
  if (Date.parse(row.expires_at) <= Date.now())
    return fail(
      'Signed holder packet expired. Recover its lifetime before preparing again.',
    );
  await requirePumpHolderReservationGuards(db);
  if (
    (await verifyPumpHolderSignedPacket(review, row.signed)) !== row.signature
  )
    return fail('Saved holder signatures differ.');
  const checked = await refreshPumpHolderReview(db, owner, id, signal, rpc);
  const minimum = checked.allWalletSimulation.maximumSlot;
  if (!Number.isSafeInteger(minimum) || minimum < 0)
    return fail('Holder submission context slot is unavailable.');
  // Persist before the only send call. A dropped response leaves an observable, non-retryable submitting state.
  row = await change(db, owner, row, 'submitting', signal);
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
          minContextSlot: minimum,
        },
      ],
      signal,
    );
    if (signature !== row.signature)
      throw new Error('Different provider signature');
    row = await change(db, owner, row, 'submitted', signal);
  } catch {
    return publicPumpHolderReview(await readPumpHolderReview(db, owner, id));
  }
  return publicPumpHolderReview(row);
}

/** Read-only recovery. Only exact finalized receipts or linked finalized expiry/mint-absence evidence releases reservations. */
export async function recoverPumpHolderReview(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
  rpc: PumpLaunchRpc = pumpLaunchRpc(),
) {
  const row = await readPumpHolderReview(db, owner, id);
  if (!['approved', 'signed', 'submitting', 'submitted'].includes(row.state))
    return publicPumpHolderReview(row);
  const { review } = await requirePumpHolderReview(
      JSON.parse(row.review),
      false,
    ),
    original = JSON.parse(row.simulation) as {
      allWalletSimulation: { minimumSlot: number };
    };
  const minimum = original.allWalletSimulation.minimumSlot;
  if (!Number.isSafeInteger(minimum) || minimum < 0)
    return fail('Saved holder recovery slot is unavailable.');
  if (row.state !== 'approved' && (!row.signed || !row.signature))
    return fail('Saved holder recovery signatures are missing.');
  const observed = await observePumpLaunchRecovery(
    {
      minimumSlot: minimum,
      mint: review.input.create.mint,
      lastValidBlockHeight: review.input.create.lastValidBlockHeight,
      signed: row.signed,
      signature: row.signature,
      verifySigned: (packet) => verifyPumpHolderSignedPacket(review, packet),
    },
    signal,
    rpc,
  );
  if (observed.state === 'pending') return publicPumpHolderReview(row);
  const receipt = {
    ...observed.receipt,
    packetSha256: review.sha256,
    contextSha256: review.contextSha256,
    ...(observed.state === 'cancelled'
      ? {}
      : {
          containsHolderBuys: true,
          activeHolderCount: review.input.holders.filter(
            (h) => h.kind !== 'none',
          ).length,
          containsDeveloperBuy: !!review.input.developer,
        }),
  };
  return publicPumpHolderReview(
    await change(db, owner, row, observed.state, signal, receipt),
  );
}

export async function cancelPumpHolderReview(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
  rpc: PumpLaunchRpc = pumpLaunchRpc(),
) {
  const row = await readPumpHolderReview(db, owner, id);
  return row.state === 'review'
    ? cancelUnsignedPumpHolderReview(db, owner, id, signal)
    : recoverPumpHolderReview(db, owner, id, signal, rpc);
}
