import { inspectJitoCpmmUnsignedPacket } from './jito-cpmm-unsigned-packet';
import {
  inspectSwapMintAccount,
  SWAP_TOKEN,
  assertSameSwapMintEvidence,
} from './swap-token-program-evidence';
import {
  PAIR_RENT,
  inspectPairRentAccount,
  pairRentMinimumRaw,
} from './pair-rent-evidence';
import { snapshotJitoEvidence, awaitJitoEvidence } from './jito-evidence-json';
import type { PumpLaunchRpc } from './pump-launch-simulation';

/** Read-only mint/Rent bracket. No pool, price, same-bank or execution approval. */
export async function readJitoCpmmAssetEvidence(
  packet: Parameters<typeof inspectJitoCpmmUnsignedPacket>[0],
  minimumSlot: number,
  rpc: PumpLaunchRpc,
  signal: AbortSignal,
) {
  signal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  if (!Number.isSafeInteger(minimumSlot) || minimumSlot < 0)
    throw Error('CPMM asset floor refused.');
  signal.throwIfAborted();
  const bound = await inspectJitoCpmmUnsignedPacket(packet);
  const keys = [bound.inputMint, bound.outputMint, PAIR_RENT];
  async function read(floor: number) {
    signal.throwIfAborted();
    const result = snapshotJitoEvidence(
      await awaitJitoEvidence(
        signal,
        Promise.resolve().then(() => {
          signal.throwIfAborted();
          return rpc(
            'getMultipleAccounts',
            [
              keys.slice(),
              {
                encoding: 'base64',
                commitment: 'confirmed',
                minContextSlot: floor,
              },
            ],
            signal,
          );
        }),
      ),
      16384,
    ) as { context?: { slot?: unknown }; value?: unknown[] };
    const raw = result.context?.slot;
    if (
      typeof raw !== 'string' ||
      !/^(0|[1-9]\d{0,15})$/.test(raw) ||
      !Number.isSafeInteger(Number(raw)) ||
      Number(raw) < floor ||
      Number(raw) - minimumSlot > 32 ||
      !Array.isArray(result.value) ||
      result.value.length !== 3
    )
      throw Error('CPMM asset response refused.');
    const mints = await Promise.all(
      result.value
        .slice(0, 2)
        .map((v, i) => inspectSwapMintAccount(v, keys[i])),
    );
    if (mints.some((m) => m.program !== SWAP_TOKEN))
      throw Error('CPMM token program refused.');
    const rent = inspectPairRentAccount(result.value[2]);
    const requiredMintRent = BigInt(pairRentMinimumRaw(rent, 82));
    const mintRentCoverage = result.value.slice(0, 2).map((raw, i) => {
      const a = raw as { lamports?: unknown; data?: unknown };
      if (
        typeof a.lamports !== 'string' ||
        !/^(0|[1-9]\d{0,19})$/.test(a.lamports) ||
        BigInt(a.lamports) > (1n << 64n) - 1n ||
        BigInt(a.lamports) < requiredMintRent ||
        !Array.isArray(a.data) ||
        Buffer.from(a.data[0], 'base64').length !== 82
      )
        throw Error('CPMM mint rent coverage refused.');
      return {
        address: keys[i],
        lamports: a.lamports,
        requiredRent: requiredMintRent.toString(),
      };
    });
    signal.throwIfAborted();
    return { slot: Number(raw), mints, rent, mintRentCoverage };
  }
  const before = await read(minimumSlot),
    after = await read(before.slot);
  assertSameSwapMintEvidence(before, after);
  if (JSON.stringify(before.rent) !== JSON.stringify(after.rent))
    throw Error('CPMM Rent changed during reads.');
  signal.throwIfAborted();
  return {
    format: 'jito-cpmm-asset-evidence-v1' as const,
    transactionSha256: bound.transactionSha256,
    minimumSlot,
    before,
    after,
    tokenAccountRentLamports: pairRentMinimumRaw(after.rent, 165),
    sourceAuthenticated: false as const,
    bankVerified: false as const,
    priceVerified: false as const,
    poolVerified: false as const,
    providerQualified: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
