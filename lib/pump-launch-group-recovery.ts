import { PumpPreflightError } from './owned-pump-preflight';
import {
  pumpUnsignedInteger,
  pumpRpcAccount,
  type PumpLaunchRpc,
} from './pump-launch-simulation';
import { requireConsistentSolanaSlots } from './solana-rpc';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { canonicalPumpHolderJson } from './pump-holder-review';
import {
  requirePumpLaunchGroupReview,
  type PumpLaunchGroupReview,
} from './pump-launch-group-review';
import { verifyPumpLaunchGroupSignatures } from './pump-launch-group-signatures';

type SignedGroup = Awaited<ReturnType<typeof verifyPumpLaunchGroupSignatures>>;
type PacketObservation = {
  index: number;
  unsignedPacketSha256: string;
  signedPacketSha256: string | null;
  signature: string | null;
  finalized: boolean;
  succeeded: boolean | null;
  slot: string | null;
  networkFeeRaw: string | null;
};
type ExpiryObservation = {
  lastValidBlockHeight: string;
  finalizedBlockHeight: string;
  expiryBankSlot: string;
  pastExpiryMargin: boolean;
  marginBlocks: 32;
  mintObservedSlot: string | null;
  mintAbsent: boolean | null;
};
const fail = (message: string): never => {
  throw new PumpPreflightError(message, 409);
};
const safeSlot = (value: unknown, minimum: number) => {
  const slot = pumpUnsignedInteger(value);
  if (slot < BigInt(minimum) || slot > BigInt(Number.MAX_SAFE_INTEGER))
    return fail('Group recovery bank or receipt slot differs.');
  return Number(slot);
};

/** Read-only complete group observation. Owned durable transitions, settlement and reservation release are separate. Never signs, submits or retries a send. */
export async function observePumpLaunchGroupRecovery(
  suppliedReview: PumpLaunchGroupReview,
  suppliedSigned: SignedGroup | null,
  signal: AbortSignal,
  rpc: PumpLaunchRpc,
) {
  signal.throwIfAborted();
  const signed = structuredClone(suppliedSigned);
  const { review } = await requirePumpLaunchGroupReview(suppliedReview, false);
  if (signed !== null) {
    if (
      !Array.isArray(signed?.packets) ||
      signed.packets.length < 1 ||
      signed.packets.length > 5
    )
      return fail('Saved complete signed group is unavailable.');
    const verified = await verifyPumpLaunchGroupSignatures(
      review,
      signed.packets.map((p) => p.transaction),
      signal,
    );
    if (
      canonicalPumpHolderJson(verified) !== canonicalPumpHolderJson(signed) ||
      new Set(verified.packets.map((p) => p.signature)).size !==
        verified.packets.length
    )
      return fail(
        'Saved signed group evidence or transaction identities differ.',
      );
  }
  signal.throwIfAborted();
  let minimum = Math.max(
    review.simulation.maximumSlot,
    review.simulation.sourceRecheckSlot,
    review.simulation.bankSlot,
  );
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
  const allowed = new Set([
    'getGenesisHash',
    'getTransaction',
    'getEpochInfo',
    'getAccountInfo',
  ]);
  let reads = 0;
  const call = async (method: string, params: unknown[]) => {
    deadline.throwIfAborted();
    if (!allowed.has(method) || ++reads > review.packets.length + 4)
      return fail('Group recovery read budget exceeded.');
    return new Promise<unknown>((resolve, reject) => {
      const abort = () =>
        reject(new Error('Group recovery cancelled or timed out.'));
      deadline.addEventListener('abort', abort, { once: true });
      if (deadline.aborted) {
        abort();
        deadline.removeEventListener('abort', abort);
        return;
      }
      Promise.resolve()
        .then(() => rpc(method, params, deadline))
        .then((result) => {
          deadline.throwIfAborted();
          resolve(result);
        })
        .catch(() => reject(new Error('Group recovery read unavailable.')))
        .finally(() => deadline.removeEventListener('abort', abort));
    });
  };
  const mainnet = async () => {
    if ((await call('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
      return fail('Group recovery provider is not Solana mainnet.');
  };
  await mainnet();
  const packets: PacketObservation[] = [];
  for (const original of review.packets) {
    deadline.throwIfAborted();
    const packet = signed?.packets[original.index];
    const observation: PacketObservation = {
      index: original.index,
      unsignedPacketSha256: original.sha256,
      signedPacketSha256: packet?.signedPacketSha256 ?? null,
      signature: packet?.signature ?? null,
      finalized: false,
      succeeded: null,
      slot: null,
      networkFeeRaw: null,
    };
    if (packet) {
      const receipt = structuredClone(
        await call('getTransaction', [
          packet.signature,
          {
            encoding: 'base64',
            commitment: 'finalized',
            maxSupportedTransactionVersion: 1,
          },
        ]),
      ) as {
        slot?: unknown;
        transaction?: unknown;
        meta?: { err?: unknown; fee?: unknown };
      } | null;
      if (receipt !== null) {
        if (
          !receipt?.meta ||
          !Object.hasOwn(receipt.meta, 'err') ||
          receipt.meta.err === undefined ||
          !Array.isArray(receipt.transaction) ||
          receipt.transaction.length !== 2 ||
          receipt.transaction[1] !== 'base64' ||
          receipt.transaction[0] !== packet.transaction
        )
          return fail('Finalized group receipt packet or metadata differs.');
        const error = receipt.meta.err;
        if (
          error !== null &&
          !(
            typeof error === 'string' &&
            error.length > 0 &&
            error.length <= 128
          ) &&
          !(typeof error === 'object' && !Array.isArray(error))
        )
          return fail('Finalized group error metadata differs.');
        // Each exact packet was independently verified above. RPC bytes must match that signed packet.
        const slot = safeSlot(receipt.slot, minimum);
        observation.finalized = true;
        observation.succeeded = error === null;
        observation.slot = slot.toString();
        observation.networkFeeRaw =
          receipt.meta.fee === undefined
            ? null
            : pumpUnsignedInteger(receipt.meta.fee).toString();
      }
    }
    packets.push(observation);
  }
  // Do not demand one-slot finalization: different finalized slots are evidence against assuming an atomic bundle.
  minimum = Math.max(
    minimum,
    ...packets.filter((p) => p.slot !== null).map((p) => Number(p.slot)),
  );
  let expiry: ExpiryObservation | null = null;
  if (packets.some((p) => !p.finalized)) {
    const epoch = (await call('getEpochInfo', [
      { commitment: 'finalized', minContextSlot: minimum },
    ])) as { absoluteSlot?: unknown; blockHeight?: unknown };
    const bankSlot = safeSlot(epoch?.absoluteSlot, minimum),
      height = pumpUnsignedInteger(epoch?.blockHeight),
      last = pumpUnsignedInteger(review.input.create.lastValidBlockHeight);
    if (height > BigInt(bankSlot))
      return fail('Group expiry height and slot are not linked.');
    expiry = {
      lastValidBlockHeight: last.toString(),
      finalizedBlockHeight: height.toString(),
      expiryBankSlot: bankSlot.toString(),
      pastExpiryMargin: height > last + 32n,
      marginBlocks: 32,
      mintObservedSlot: null,
      mintAbsent: null,
    };
    if (expiry.pastExpiryMargin) {
      const mint = (await call('getAccountInfo', [
        review.input.create.mint,
        {
          encoding: 'base64',
          commitment: 'finalized',
          minContextSlot: bankSlot,
        },
      ])) as { context?: { slot?: unknown }; value?: unknown };
      if (!mint || !Object.hasOwn(mint, 'value'))
        return fail('Group expiry mint observation is missing.');
      const mintSlot = safeSlot(mint.context?.slot, bankSlot);
      requireConsistentSolanaSlots([bankSlot, mintSlot]);
      pumpRpcAccount(mint.value);
      expiry.mintObservedSlot = mintSlot.toString();
      expiry.mintAbsent = mint.value === null;
    }
  }
  await mainnet();
  deadline.throwIfAborted();
  const observed = packets.filter((p) => p.finalized).length,
    successes = packets.filter((p) => p.succeeded === true).length;
  const state =
    observed === packets.length
      ? successes === packets.length
        ? ('complete' as const)
        : successes === 0
          ? ('failed' as const)
          : ('partial' as const)
      : observed > 0
        ? ('partial' as const)
        : expiry?.pastExpiryMargin
          ? expiry.mintAbsent === true
            ? ('expired-unobserved' as const)
            : ('unknown' as const)
          : ('pending' as const);
  return {
    state,
    receipt: {
      format: 'pump-launch-group-recovery-observation-v1' as const,
      reviewId: review.id,
      contextSha256: review.contextSha256,
      manifestSha256: review.manifestSha256,
      signedGroupSha256: signed?.signedGroupSha256 ?? null,
      network: 'mainnet' as const,
      commitment: 'finalized' as const,
      mint: review.input.create.mint,
      packets,
      expiry,
      observedPacketCount: observed,
      successfulPacketCount: successes,
      allPacketsFinalized: observed === packets.length,
      allPacketsSucceeded: successes === packets.length,
      knownNetworkFeeRaw: packets
        .reduce((sum, p) => sum + BigInt(p.networkFeeRaw ?? '0'), 0n)
        .toString(),
      networkFeeUnresolved: packets.some((p) => p.networkFeeRaw === null),
      signatureKnown: signed !== null,
      atomicityProven: false as const,
      settlementVerificationRequired: true as const,
      durableTransitionRequired: true as const,
      reservationsMustRemainHeld: true as const,
      signingAllowed: false as const,
      executionAllowed: false as const,
      completeLaunch: false as const,
      observedAt: new Date().toISOString(),
      reads,
    },
  };
}
