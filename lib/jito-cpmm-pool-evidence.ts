import bs58 from 'bs58';
import { address, getProgramDerivedAddress } from '@solana/kit';
import { PAIR_CLOCK, pairClockUnixTimestamp } from './pair-stock-clock';
import { inspectJitoCpmmUnsignedPacket } from './jito-cpmm-unsigned-packet';
import { readJitoCpmmAssetEvidence } from './jito-cpmm-asset-evidence';
import { pairRentMinimumRaw } from './pair-rent-evidence';
import { snapshotJitoEvidence, awaitJitoEvidence } from './jito-evidence-json';
import type { PumpLaunchRpc } from './pump-launch-simulation';
const CPMM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const WSOL = 'So11111111111111111111111111111111111111112';
const fail = (): never => {
  throw Error('CPMM pool or rent evidence refused.');
};
/** Research profile for the referenced 637-byte PoolState. Unknown layouts refuse. */
export async function readJitoCpmmPoolEvidence(
  packet: Parameters<typeof inspectJitoCpmmUnsignedPacket>[0],
  minimumSlot: number,
  rpc: PumpLaunchRpc,
  signal: AbortSignal,
) {
  signal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  const original = snapshotJitoEvidence(packet, 16384);
  const bound = await inspectJitoCpmmUnsignedPacket(original);
  const assets = await readJitoCpmmAssetEvidence(
    original,
    minimumSlot,
    rpc,
    signal,
  );
  const keys = [
    bound.pool,
    bound.source,
    bound.destination,
    bound.inputVault,
    bound.outputVault,
    bound.config,
    bound.observation,
    PAIR_CLOCK,
  ];
  signal.throwIfAborted();
  const result = snapshotJitoEvidence(
    await awaitJitoEvidence(
      signal,
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return rpc(
          'getMultipleAccounts',
          [
            keys,
            {
              encoding: 'base64',
              commitment: 'confirmed',
              minContextSlot: assets.after.slot,
            },
          ],
          signal,
        );
      }),
    ),
    16384,
  ) as { context?: { slot?: unknown }; value?: unknown[] };
  const slot = result.context?.slot;
  if (
    typeof slot !== 'string' ||
    !/^(0|[1-9]\d{0,15})$/.test(slot) ||
    !Number.isSafeInteger(Number(slot)) ||
    Number(slot) < assets.after.slot ||
    Number(slot) - minimumSlot > 32 ||
    !Array.isArray(result.value) ||
    result.value.length !== 8
  )
    return fail();
  function decode(raw: unknown, owner: string, size: number) {
    const a = raw as {
      owner?: unknown;
      executable?: unknown;
      lamports?: unknown;
      data?: unknown;
    };
    if (
      !a ||
      a.owner !== owner ||
      a.executable !== false ||
      typeof a.lamports !== 'string' ||
      !/^(0|[1-9]\d{0,19})$/.test(a.lamports) ||
      BigInt(a.lamports) > (1n << 64n) - 1n ||
      !Array.isArray(a.data) ||
      a.data.length !== 2 ||
      a.data[1] !== 'base64' ||
      typeof a.data[0] !== 'string' ||
      a.data[0].length > 5500
    )
      return fail();
    const b = Buffer.from(a.data[0], 'base64'),
      lamports = BigInt(a.lamports),
      rent = BigInt(pairRentMinimumRaw(assets.after.rent, size));
    if (
      b.length !== size ||
      b.toString('base64') !== a.data[0] ||
      lamports < rent
    )
      return fail();
    return { b, lamports, rent };
  }
  const pool = decode(result.value[0], CPMM, 637),
    b = pool.b;
  const key = (offset: number) => bs58.encode(b.subarray(offset, offset + 32));
  const forward = key(168) === bound.inputMint && key(200) === bound.outputMint;
  const reverse = key(200) === bound.inputMint && key(168) === bound.outputMint;
  if (
    b.subarray(0, 8).toString('hex') !== 'f7ede3f5d7c3de46' ||
    (!forward && !reverse) ||
    key(8) !== bound.config ||
    key(296) !== bound.observation ||
    key(232) !== TOKEN ||
    key(264) !== TOKEN ||
    b[328] !== bound.authorityBump ||
    b[329] > 7 ||
    (b[329] & 4) !== 0 ||
    key(forward ? 72 : 104) !== bound.inputVault ||
    key(forward ? 104 : 72) !== bound.outputVault ||
    b[forward ? 331 : 332] !== assets.after.mints[0].decimals ||
    b[forward ? 332 : 331] !== assets.after.mints[1].decimals
  )
    return fail();
  const config = decode(result.value[5], CPMM, 236);
  const oracle = decode(result.value[6], CPMM, 4075);
  const c = config.b,
    o = oracle.b;
  const unixTimestamp = pairClockUnixTimestamp(result.value[7], Number(slot));
  if (
    b.readBigUInt64LE(373) > BigInt(unixTimestamp) ||
    (o[8] === 1 &&
      o.readUInt16LE(9) < 100 &&
      o.readBigUInt64LE(43 + o.readUInt16LE(9) * 40) > BigInt(unixTimestamp))
  )
    return fail();
  const tradeFee = c.readBigUInt64LE(12),
    protocolFee = c.readBigUInt64LE(20),
    fundFee = c.readBigUInt64LE(28);
  if (
    c.subarray(0, 8).toString('hex') !== 'daf42168cbcb2b6f' ||
    c[9] > 1 ||
    tradeFee >= 1000000n ||
    protocolFee > 1000000n ||
    fundFee > 1000000n ||
    protocolFee + fundFee > 1000000n ||
    o.subarray(0, 8).toString('hex') !== '7aaec5358109a584' ||
    o[8] > 1 ||
    o.readUInt16LE(9) >= 100 ||
    bs58.encode(o.subarray(11, 43)) !== bound.pool
  )
    return fail();
  const configIndex = Buffer.alloc(2);
  configIndex.writeUInt16BE(c.readUInt16LE(10));
  const seeds = [
    [new TextEncoder().encode('amm_config'), configIndex],
    [new TextEncoder().encode('observation'), bs58.decode(bound.pool)],
    [
      new TextEncoder().encode('pool_vault'),
      bs58.decode(bound.pool),
      bs58.decode(bound.inputMint),
    ],
    [
      new TextEncoder().encode('pool_vault'),
      bs58.decode(bound.pool),
      bs58.decode(bound.outputMint),
    ],
  ];
  const derived = await Promise.all(
    seeds.map((seeds) =>
      getProgramDerivedAddress({ programAddress: address(CPMM), seeds }),
    ),
  );
  signal.throwIfAborted();
  if (
    derived[0][0] !== bound.config ||
    derived[0][1] !== c[8] ||
    derived[1][0] !== bound.observation ||
    derived[2][0] !== bound.inputVault ||
    derived[3][0] !== bound.outputVault
  )
    return fail();
  const coverage = keys.slice(0, 5).map((address, i) => {
    const decoded = i === 0 ? pool : decode(result.value![i], TOKEN, 165);
    if (i) {
      const t = decoded.b,
        mint = i === 1 || i === 3 ? bound.inputMint : bound.outputMint,
        authority = i < 3 ? bound.payer : bound.authority;
      if (
        bs58.encode(t.subarray(0, 32)) !== mint ||
        bs58.encode(t.subarray(32, 64)) !== authority ||
        t[108] !== 1 ||
        t.readUInt32LE(72) !== 0 ||
        t.readBigUInt64LE(121) !== 0n ||
        t.readUInt32LE(129) !== 0
      )
        return fail();
      const native = t.readUInt32LE(109);
      if (mint === WSOL) {
        if (
          native !== 1 ||
          t.readBigUInt64LE(113) !== decoded.rent ||
          t.readBigUInt64LE(64) + decoded.rent !== decoded.lamports
        )
          return fail();
      } else if (native !== 0) return fail();
    }
    return {
      address,
      lamports: decoded.lamports.toString(),
      requiredRent: decoded.rent.toString(),
    };
  });
  coverage.push(
    ...[config, oracle].map((v, i) => ({
      address: keys[i + 5],
      lamports: v.lamports.toString(),
      requiredRent: v.rent.toString(),
    })),
  );
  signal.throwIfAborted();
  return {
    format: 'jito-cpmm-pool-observation-v1' as const,
    transactionSha256: bound.transactionSha256,
    slot: Number(slot),
    assets,
    coverage,
    poolRelationshipsChecked: true as const,
    rentCoverageChecked: true as const,
    configLayoutChecked: true as const,
    oraclePoolBindingChecked: true as const,
    configOracleVaultPdasChecked: true as const,
    poolOpenAtObservedClock: true as const,
    unixTimestamp,
    tradeFeeMillionths: tradeFee.toString(),
    poolVerified: false as const,
    priceVerified: false as const,
    bankVerified: false as const,
    providerQualified: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
