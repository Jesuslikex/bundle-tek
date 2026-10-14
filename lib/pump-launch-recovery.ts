import { PumpPreflightError } from './owned-pump-preflight';
import {
  pumpUnsignedInteger,
  type PumpLaunchRpc,
} from './pump-launch-simulation';
import { requireConsistentSolanaSlots } from './solana-rpc';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';

const fail = (message: string): never => {
  throw new PumpPreflightError(message, 409);
};

/** Read-only common recovery evidence. Callers bind the result to their immutable review with a guarded write. */
export async function observePumpLaunchRecovery(
  supplied: {
    minimumSlot: number;
    mint: string;
    lastValidBlockHeight: string;
    signed: string | null;
    signature: string | null;
    verifySigned: (packet: string) => Promise<string>;
  },
  signal: AbortSignal,
  rpc: PumpLaunchRpc,
) {
  const {
    minimumSlot: minimum,
    mint,
    lastValidBlockHeight,
    signed,
    signature,
    verifySigned,
  } = supplied;
  signal.throwIfAborted();
  if (!Number.isSafeInteger(minimum) || minimum < 0)
    return fail('Saved launch recovery slot is unavailable.');
  pumpUnsignedInteger(lastValidBlockHeight);
  if ((signed === null) !== (signature === null))
    return fail('Saved launch recovery signatures are missing.');
  if (signed !== null && (await verifySigned(signed)) !== signature)
    return fail('Saved launch recovery signature differs.');
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
      return fail('Launch recovery read budget exceeded.');
    return new Promise<unknown>((resolve, reject) => {
      const abort = () =>
        reject(new Error('Launch recovery cancelled or timed out.'));
      if (deadline.aborted) {
        abort();
        return;
      }
      deadline.addEventListener('abort', abort, { once: true });
      Promise.resolve()
        .then(() => rpc(method, params, deadline))
        .then((result) => {
          deadline.throwIfAborted();
          resolve(result);
        })
        .catch(() => reject(new Error('Launch recovery read unavailable.')))
        .finally(() => deadline.removeEventListener('abort', abort));
    });
  };
  const mainnet = async () => {
    if ((await call('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
      return fail('Launch recovery provider is not Solana mainnet.');
  };
  await mainnet();
  if (signature) {
    const result = (await call('getTransaction', [
      signature,
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
        result.transaction[0] !== signed
      )
        return fail('Finalized launch receipt packet or metadata differs.');
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
        return fail('Finalized launch receipt error metadata differs.');
      const slot = pumpUnsignedInteger(result.slot);
      if (slot < BigInt(minimum) || slot > BigInt(Number.MAX_SAFE_INTEGER))
        return fail('Finalized launch receipt slot differs.');
      if ((await verifySigned(result.transaction[0])) !== signature)
        return fail('Finalized launch receipt signatures differ.');
      await mainnet();
      const receipt = {
        kind: 'finalized' as const,
        network: 'mainnet',
        commitment: 'finalized',
        signature,
        slot: slot.toString(),
        mint,
        succeeded: result.meta.err === null,
        networkFeeUnresolved: result.meta.fee === undefined,
        ...(result.meta.fee === undefined
          ? {}
          : { networkFeeRaw: pumpUnsignedInteger(result.meta.fee).toString() }),
        observedAt: new Date().toISOString(),
      };
      return {
        state:
          result.meta.err === null
            ? ('finalized' as const)
            : ('failed' as const),
        receipt,
      };
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
    return fail('Launch expiry bank slot differs.');
  if (height <= BigInt(lastValidBlockHeight) + 32n) {
    await mainnet();
    return { state: 'pending' as const, receipt: null };
  }
  const mintObservation = (await call('getAccountInfo', [
    mint,
    {
      encoding: 'base64',
      commitment: 'finalized',
      minContextSlot: Number(epochSlot),
    },
  ])) as {
    context?: { slot?: unknown };
    value?: unknown;
  };
  const mintSlot = pumpUnsignedInteger(mintObservation?.context?.slot);
  if (
    mintSlot < epochSlot ||
    mintSlot > BigInt(Number.MAX_SAFE_INTEGER) ||
    !mintObservation ||
    !Object.hasOwn(mintObservation, 'value')
  )
    return fail('Launch expiry mint observation differs.');
  requireConsistentSolanaSlots([Number(epochSlot), Number(mintSlot)]);
  await mainnet();
  if (mintObservation.value !== null)
    return { state: 'pending' as const, receipt: null };
  const receipt = {
    kind: 'expired-unobserved' as const,
    network: 'mainnet',
    commitment: 'finalized',
    signature,
    mint,
    lastValidBlockHeight,
    finalizedBlockHeight: height.toString(),
    expiryBankSlot: epochSlot.toString(),
    mintObservedSlot: mintSlot.toString(),
    mintAbsent: true,
    signatureKnown: signature !== null,
    networkFeeUnresolved: true,
    observedAt: new Date().toISOString(),
  };
  return { state: 'cancelled' as const, receipt };
}
