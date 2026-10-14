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
import {
  pumpUnsignedInteger,
  type PumpLaunchRpc,
} from './pump-launch-simulation';
import { requireConsistentSolanaSlots } from './solana-rpc';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';

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
  if (
    row.signed &&
    (await verifyPumpHolderSignedPacket(review, row.signed)) !== row.signature
  )
    return fail('Saved holder recovery signature differs.');
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    allowed = new Set([
      'getGenesisHash',
      'getTransaction',
      'getEpochInfo',
      'getAccountInfo',
    ]);
  let reads = 0;
  const call = async (method: string, params: unknown[]) => {
    deadline.throwIfAborted();
    if (!allowed.has(method) || ++reads > 6)
      return fail('Holder recovery read budget exceeded.');
    const result = await rpc(method, params, deadline);
    deadline.throwIfAborted();
    return result;
  };
  const mainnet = async () => {
    if ((await call('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
      return fail('Holder recovery provider is not Solana mainnet.');
  };
  await mainnet();
  if (row.signature) {
    const result = (await call('getTransaction', [
      row.signature,
      {
        encoding: 'base64',
        commitment: 'finalized',
        maxSupportedTransactionVersion: 1,
      },
    ])) as {
      slot?: unknown;
      transaction?: unknown;
      meta?: { err?: unknown; fee?: unknown };
    } | null;
    if (result !== null) {
      if (
        !result ||
        !result.meta ||
        !Object.hasOwn(result.meta, 'err') ||
        result.meta.err === undefined ||
        !Array.isArray(result.transaction) ||
        result.transaction.length !== 2 ||
        result.transaction[1] !== 'base64' ||
        result.transaction[0] !== row.signed
      )
        return fail('Finalized holder receipt packet or metadata differs.');
      if (
        result.meta.err !== null &&
        !(
          typeof result.meta.err === 'string' &&
          result.meta.err.length > 0 &&
          result.meta.err.length <= 128
        ) &&
        !(
          typeof result.meta.err === 'object' && !Array.isArray(result.meta.err)
        )
      )
        return fail('Finalized holder receipt error metadata differs.');
      const slot = pumpUnsignedInteger(result.slot);
      if (slot < BigInt(minimum) || slot > BigInt(Number.MAX_SAFE_INTEGER))
        return fail('Finalized holder receipt slot differs.');
      if (
        (await verifyPumpHolderSignedPacket(review, result.transaction[0])) !==
        row.signature
      )
        return fail('Finalized holder receipt signatures differ.');
      await mainnet();
      const receipt = {
        kind: 'finalized',
        network: 'mainnet',
        commitment: 'finalized',
        signature: row.signature,
        slot: slot.toString(),
        packetSha256: review.sha256,
        contextSha256: review.contextSha256,
        mint: review.input.create.mint,
        containsHolderBuys: true,
        activeHolderCount: review.input.holders.filter((h) => h.kind !== 'none')
          .length,
        containsDeveloperBuy: !!review.input.developer,
        succeeded: result.meta.err === null,
        networkFeeUnresolved: result.meta.fee === undefined,
        ...(result.meta.fee === undefined
          ? {}
          : { networkFeeRaw: pumpUnsignedInteger(result.meta.fee).toString() }),
        observedAt: new Date().toISOString(),
      };
      return publicPumpHolderReview(
        await change(
          db,
          owner,
          row,
          result.meta.err === null ? 'finalized' : 'failed',
          deadline,
          receipt,
        ),
      );
    }
  }
  // getEpochInfo links finalized block height and slot in one bank observation.
  const epoch = (await call('getEpochInfo', [
    { commitment: 'finalized', minContextSlot: minimum },
  ])) as { absoluteSlot?: unknown; blockHeight?: unknown };
  const height = pumpUnsignedInteger(epoch?.blockHeight),
    epochSlot = pumpUnsignedInteger(epoch?.absoluteSlot);
  if (
    epochSlot < BigInt(minimum) ||
    epochSlot > BigInt(Number.MAX_SAFE_INTEGER) ||
    height > epochSlot
  )
    return fail('Holder expiry bank slot differs.');
  if (height <= BigInt(review.input.create.lastValidBlockHeight) + 32n) {
    await mainnet();
    return publicPumpHolderReview(row);
  }
  const mint = (await call('getAccountInfo', [
    review.input.create.mint,
    {
      encoding: 'base64',
      commitment: 'finalized',
      minContextSlot: Number(epochSlot),
    },
  ])) as {
    context?: { slot?: unknown };
    value?: unknown;
  };
  const mintSlot = pumpUnsignedInteger(mint?.context?.slot);
  if (
    mintSlot < epochSlot ||
    mintSlot > BigInt(Number.MAX_SAFE_INTEGER) ||
    !mint ||
    !Object.hasOwn(mint, 'value')
  )
    return fail('Holder expiry mint observation differs.');
  requireConsistentSolanaSlots([Number(epochSlot), Number(mintSlot)]);
  await mainnet();
  if (mint.value !== null) return publicPumpHolderReview(row);
  const receipt = {
    kind: 'expired-unobserved',
    network: 'mainnet',
    commitment: 'finalized',
    signature: row.signature,
    packetSha256: review.sha256,
    contextSha256: review.contextSha256,
    mint: review.input.create.mint,
    lastValidBlockHeight: review.input.create.lastValidBlockHeight,
    finalizedBlockHeight: height.toString(),
    expiryBankSlot: epochSlot.toString(),
    mintObservedSlot: mintSlot.toString(),
    mintAbsent: true,
    signatureKnown: row.signature !== null,
    networkFeeUnresolved: true,
    observedAt: new Date().toISOString(),
  };
  return publicPumpHolderReview(
    await change(db, owner, row, 'cancelled', deadline, receipt),
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
