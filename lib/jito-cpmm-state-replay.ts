import bs58 from 'bs58';
import { snapshotJitoEvidence } from './jito-evidence-json';
import { readJitoCpmmCurrentPoolEvidence } from './jito-cpmm-pool-evidence';
import {
  inspectJitoCpmmUnsignedPacket,
  inspectJitoCpmmPacketBalanceTransition,
} from './jito-cpmm-unsigned-packet';
import { PAIR_CLOCK } from './pair-stock-clock';
import { PAIR_RENT } from './pair-rent-evidence';
import type { PumpLaunchRpc } from './pump-launch-simulation';

type Raw = {
  address: string;
  owner: string;
  executable: boolean;
  lamports: string;
  dataBase64: string;
};
const fail = (): never => {
  throw Error('CPMM supplied state replay refused.');
};
const U64 = (1n << 64n) - 1n,
  U128 = (1n << 128n) - 1n;
type Bytes = ReturnType<typeof Buffer.from>;
const read128 = (b: Bytes, o: number) =>
  b.readBigUInt64LE(o) + (b.readBigUInt64LE(o + 8) << 64n);
function write128(b: Bytes, o: number, n: bigint) {
  b.writeBigUInt64LE(n & U64, o);
  b.writeBigUInt64LE(n >> 64n, o + 8);
}
function oracleAfter(
  before: Bytes,
  timestamp: bigint,
  price0: bigint,
  price1: bigint,
) {
  const b = Buffer.from(before),
    index = b.readUInt16LE(9),
    offset = 43 + index * 40;
  if (b[8] === 0) {
    b[8] = 1;
    b.writeBigUInt64LE(timestamp, offset);
    write128(b, offset + 8, 0n);
    write128(b, offset + 24, 0n);
    b.writeBigUInt64LE(timestamp, 4043);
    return b;
  }
  const last = b.readBigUInt64LE(offset);
  let updated = b.readBigUInt64LE(4043);
  if (updated === 0n) {
    updated = last;
    b.writeBigUInt64LE(last, 4043);
  }
  const sinceObservation = timestamp > last ? timestamp - last : 0n;
  const elapsed = timestamp > updated ? timestamp - updated : 0n;
  if (sinceObservation === 0n || elapsed === 0n) return b;
  const delta0 = price0 * elapsed,
    delta1 = price1 * elapsed;
  if (delta0 > U128 || delta1 > U128) return fail();
  const next = sinceObservation < 15n ? index : (index + 1) % 100,
    target = 43 + next * 40;
  if (next !== index) {
    b.writeUInt16LE(next, 9);
    b.writeBigUInt64LE(timestamp, target);
  }
  write128(b, target + 8, (read128(before, offset + 8) + delta0) & U128);
  write128(b, target + 24, (read128(before, offset + 24) + delta1) & U128);
  b.writeBigUInt64LE(timestamp, 4043);
  return b;
}

/** Replays supplied snapshots against matched source f4b9b263. Never a live RPC or bank attestation. */
export async function replayJitoCpmmSwapState(
  input: {
    packet: Parameters<typeof inspectJitoCpmmUnsignedPacket>[0];
    minimumSlot: number;
    slot: number;
    before: Raw[];
    after: Raw[];
  },
  signal: AbortSignal,
) {
  return replayState(input, signal, false);
}

/** Checks only actually returned writable post-images. Never supplies missing
 * readonly post-state or satisfies the complete-frame qualification contract. */
export async function inspectJitoCpmmSparseSwapState(
  input: Parameters<typeof replayJitoCpmmSwapState>[0],
  signal: AbortSignal,
) {
  const result = await replayState(input, signal, true);
  return {
    ...result,
    format: 'jito-cpmm-sparse-state-replay-v1' as const,
    readonlyPostCoverage: false as const,
    fullSwapQualified: false as const,
  };
}

async function replayState(
  input: Parameters<typeof replayJitoCpmmSwapState>[0],
  signal: AbortSignal,
  sparse: boolean,
) {
  signal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  const value = snapshotJitoEvidence(input, 65536);
  if (
    !value ||
    Object.keys(value).length !== 5 ||
    !['packet', 'minimumSlot', 'slot', 'before', 'after'].every((k) =>
      Object.hasOwn(value, k),
    ) ||
    !Number.isSafeInteger(value.minimumSlot) ||
    value.minimumSlot < 0 ||
    !Number.isSafeInteger(value.slot) ||
    value.slot < value.minimumSlot ||
    value.slot - value.minimumSlot > 32
  )
    return fail();
  signal.throwIfAborted();
  const bound = await inspectJitoCpmmUnsignedPacket(value.packet);
  const keys = [
    bound.pool,
    bound.source,
    bound.destination,
    bound.inputVault,
    bound.outputVault,
    bound.config,
    bound.observation,
    PAIR_CLOCK,
    bound.inputMint,
    bound.outputMint,
    PAIR_RENT,
  ];
  const writableKeys = [...keys.slice(0, 5), bound.observation];
  function accounts(raw: Raw[], expected: string[]) {
    if (!Array.isArray(raw) || raw.length !== expected.length) return fail();
    const out = new Map<string, Raw>();
    for (const a of raw) {
      if (
        !a ||
        Object.keys(a).length !== 5 ||
        !['address', 'owner', 'executable', 'lamports', 'dataBase64'].every(
          (k) => Object.hasOwn(a, k),
        ) ||
        !expected.includes(a.address) ||
        out.has(a.address) ||
        typeof a.owner !== 'string' ||
        typeof a.executable !== 'boolean' ||
        typeof a.lamports !== 'string' ||
        !/^(0|[1-9]\d{0,19})$/.test(a.lamports) ||
        BigInt(a.lamports) > U64 ||
        typeof a.dataBase64 !== 'string' ||
        a.dataBase64.length > 5500 ||
        Buffer.from(a.dataBase64, 'base64').toString('base64') !== a.dataBase64
      )
        return fail();
      out.set(a.address, a);
    }
    return out;
  }
  const pre = accounts(value.before, keys),
    post = accounts(value.after, sparse ? writableKeys : keys);
  for (const k of sparse ? writableKeys : keys) {
    const a = pre.get(k)!,
      b = post.get(k)!;
    if (a.owner !== b.owner || a.executable !== b.executable) return fail();
    if (
      !keys.slice(0, 5).includes(k) &&
      k !== bound.observation &&
      JSON.stringify(a) !== JSON.stringify(b)
    )
      return fail();
  }
  // Replay the existing strict pre-state/mint/Rent/PDA checker. This adapter
  // serves caller-supplied bytes only and must never be treated as a provider.
  const replayRpc: PumpLaunchRpc = async (method, params, s) => {
    s.throwIfAborted();
    const requested = params[0] as string[],
      options = params[1] as { minContextSlot: number };
    if (
      method !== 'getMultipleAccounts' ||
      options.minContextSlot > value.slot ||
      requested.some((k) => !pre.has(k))
    )
      return fail();
    return {
      context: { slot: String(value.slot) },
      value: requested.map((k) => {
        const a = pre.get(k)!;
        return {
          owner: a.owner,
          executable: a.executable,
          lamports: a.lamports,
          data: [a.dataBase64, 'base64'],
        };
      }),
    };
  };
  const pool = await readJitoCpmmCurrentPoolEvidence(
    value.packet,
    value.minimumSlot,
    replayRpc,
    signal,
  );
  if (!('creatorFeeOnInput' in pool.curve) || !('creatorFeeRaw' in pool.curve))
    return fail();
  const tokens = [
    bound.source,
    bound.destination,
    bound.inputVault,
    bound.outputVault,
  ];
  const balances = await inspectJitoCpmmPacketBalanceTransition({
    packet: value.packet,
    before: tokens.map((k) => pre.get(k)!),
    after: tokens.map((k) => post.get(k)!),
  });
  if (balances.outputRaw !== pool.curve.expectedOutputRaw) return fail();
  const poolBefore = pre.get(bound.pool)!,
    poolAfter = post.get(bound.pool)!;
  const p = Buffer.from(poolBefore.dataBase64, 'base64'),
    expectedPool = Buffer.from(p);
  const forward = bs58.encode(p.subarray(168, 200)) === bound.inputMint;
  const inputProtocol = forward ? 341 : 349,
    inputFund = inputProtocol + 16;
  const creatorOffset = pool.curve.creatorFeeOnInput
    ? forward
      ? 397
      : 405
    : forward
      ? 405
      : 397;
  for (const [offset, delta] of [
    [inputProtocol, pool.curve.protocolFeeRaw],
    [inputFund, pool.curve.fundFeeRaw],
    [creatorOffset, pool.curve.creatorFeeRaw],
  ] as const) {
    const n = expectedPool.readBigUInt64LE(offset) + BigInt(delta);
    if (n > U64) return fail();
    expectedPool.writeBigUInt64LE(n, offset);
  }
  const clock = Buffer.from(pre.get(PAIR_CLOCK)!.dataBase64, 'base64');
  expectedPool.writeBigUInt64LE(clock.readBigUInt64LE(16), 381);
  if (
    poolBefore.lamports !== poolAfter.lamports ||
    !expectedPool.equals(Buffer.from(poolAfter.dataBase64, 'base64'))
  )
    return fail();
  function reserve(vault: string, index: number) {
    const amount = Buffer.from(
      pre.get(vault)!.dataBase64,
      'base64',
    ).readBigUInt64LE(64);
    return (
      BigInt(amount) -
      BigInt(p.readBigUInt64LE(341 + 8 * index)) -
      BigInt(p.readBigUInt64LE(357 + 8 * index)) -
      BigInt(p.readBigUInt64LE(397 + 8 * index))
    );
  }
  const r0 = reserve(forward ? bound.inputVault : bound.outputVault, 0),
    r1 = reserve(forward ? bound.outputVault : bound.inputVault, 1);
  if (r0 <= 0n || r1 <= 0n) return fail();
  const oBefore = pre.get(bound.observation)!,
    oAfter = post.get(bound.observation)!;
  const expectedOracle = oracleAfter(
    Buffer.from(oBefore.dataBase64, 'base64'),
    clock.readBigUInt64LE(32),
    (r1 << 32n) / r0,
    (r0 << 32n) / r1,
  );
  if (
    oBefore.lamports !== oAfter.lamports ||
    !expectedOracle.equals(Buffer.from(oAfter.dataBase64, 'base64'))
  )
    return fail();
  signal.throwIfAborted();
  return {
    format: 'jito-cpmm-supplied-state-replay-v1' as const,
    transactionSha256: bound.transactionSha256,
    slot: value.slot,
    poolTransitionChecked: true as const,
    oracleTransitionChecked: true as const,
    tokenTransitionChecked: true as const,
    outputRaw: balances.outputRaw,
    rentCoverageChecked: true as const,
    sourceAuthenticated: false as const,
    packetVerified: false as const,
    economicOutputVerified: false as const,
    accountProvenanceVerified: false as const,
    bankVerified: false as const,
    providerQualified: false as const,
    programApproved: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
