import bs58 from 'bs58';
import {
  snapshotJitoEvidence,
  awaitJitoEvidence,
  jitoEvidenceSha256,
} from './jito-evidence-json';
import { replayJitoCpmmBundleSettlement } from './jito-cpmm-bundle-replay';
import {
  verifyJitoBundleSimulationFrames,
  type JitoBundleSimulationFrames,
  type JitoSimulationAccount,
} from './jito-bundle-simulation-frames';
import { inspectJitoCpmmUnsignedPacket } from './jito-cpmm-unsigned-packet';
import { PAIR_CLOCK, pairClockUnixTimestamp } from './pair-stock-clock';
import {
  PAIR_RENT,
  inspectPairRentAccount,
  pairRentMinimumRaw,
} from './pair-rent-evidence';
import {
  inspectSwapMintAccount,
  assertSameSwapMintEvidence,
} from './swap-token-program-evidence';
import {
  pairReviewDiagnostic,
  pairDiagnosticComparisons,
} from './pair-review-diagnostic';
import {
  verifyJitoCpmmResearchRuntimeBracket,
  requireJitoRuntimeRpcScope,
  type JitoRuntimeCapture,
} from './jito-runtime-evidence';
import {
  requireJitoCpmmLifetimeScope,
  recheckJitoCpmmLifetime,
} from './jito-cpmm-lifetime';
import type { PumpLaunchRpc } from './pump-launch-simulation';
const fail = (): never => {
  throw Error('CPMM owned research bracket refused.');
};
type Role = 'wallet' | 'token' | 'mint' | 'tip' | 'rent';
const wire = (a: JitoSimulationAccount) => ({
  owner: a.owner,
  executable: a.executable,
  lamports: a.lamports,
  data: [Buffer.from(a.data).toString('base64'), 'base64'],
});
function rawAccount(v: unknown): JitoSimulationAccount {
  const a = v as {
    owner?: unknown;
    executable?: unknown;
    lamports?: unknown;
    data?: unknown;
    space?: unknown;
    rentEpoch?: unknown;
  };
  if (
    !a ||
    typeof a.owner !== 'string' ||
    a.owner.length < 32 ||
    a.owner.length > 44 ||
    typeof a.executable !== 'boolean' ||
    typeof a.lamports !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(a.lamports) ||
    BigInt(a.lamports) > (1n << 64n) - 1n ||
    !Array.isArray(a.data) ||
    a.data.length !== 2 ||
    a.data[1] !== 'base64' ||
    typeof a.data[0] !== 'string' ||
    a.data[0].length > 1024
  )
    return fail();
  const data = Buffer.from(a.data[0], 'base64');
  try {
    const key = bs58.decode(a.owner);
    if (key.length !== 32 || bs58.encode(key) !== a.owner) return fail();
  } catch {
    return fail();
  }
  if (
    data.toString('base64') !== a.data[0] ||
    (a.space !== undefined && a.space !== String(data.length)) ||
    (a.rentEpoch !== undefined &&
      (typeof a.rentEpoch !== 'string' ||
        !/^(0|[1-9]\d{0,19})$/.test(a.rentEpoch) ||
        BigInt(a.rentEpoch) > (1n << 64n) - 1n))
  )
    return fail();
  return {
    owner: a.owner,
    executable: a.executable,
    lamports: a.lamports,
    data,
  };
}
async function finalCustody(
  value: Parameters<typeof replayJitoCpmmBundleSettlement>[0],
  frames: JitoBundleSimulationFrames,
  minimumReadSlot: number,
  rpc: PumpLaunchRpc,
  signal: AbortSignal,
) {
  const expected = new Map<
    string,
    { role: Role; state: JitoSimulationAccount }
  >();
  const add = (
    address: string,
    role: Role,
    state: JitoSimulationAccount | null | undefined,
  ) => {
    if (
      !state ||
      (expected.has(address) && expected.get(address)!.role !== role)
    )
      return fail();
    if (!expected.has(address)) expected.set(address, { role, state });
  };
  for (let i = 0; i < value.swaps.length; i++) {
    const b = await inspectJitoCpmmUnsignedPacket(value.swaps[i]),
      f = frames.frames[i];
    const state = (key: string) => f.preAccounts[f.keys.indexOf(key)];
    add(b.payer, 'wallet', state(b.payer));
    for (const key of [b.source, b.destination]) add(key, 'token', state(key));
    for (const key of [b.inputMint, b.outputMint]) add(key, 'mint', state(key));
  }
  const tip = frames.frames.at(-1)!;
  add(value.tip.recipient, 'tip', tip.preAccounts[1]);
  const rentBefore = value.bankAccounts.before.find(
    (a) => a.address === PAIR_RENT,
  )!;
  add(PAIR_RENT, 'rent', {
    ...rentBefore,
    data: Buffer.from(rentBefore.dataBase64, 'base64'),
  });
  const keys = [...expected.keys(), PAIR_CLOCK];
  if (keys.length > 100 || new Set(keys).size !== keys.length) return fail();
  signal.throwIfAborted();
  const response = snapshotJitoEvidence(
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
              minContextSlot: minimumReadSlot,
            },
          ],
          signal,
        );
      }),
    ),
    65536,
  ) as { context?: { slot?: unknown }; value?: unknown[] };
  const rawSlot = response?.context?.slot;
  if (
    typeof rawSlot !== 'string' ||
    !/^[1-9]\d{0,15}$/.test(rawSlot) ||
    !Number.isSafeInteger(Number(rawSlot)) ||
    Number(rawSlot) < minimumReadSlot ||
    Number(rawSlot) - value.minimumSlot > 32 ||
    !Array.isArray(response.value) ||
    response.value.length !== keys.length
  )
    return fail();
  const slot = Number(rawSlot),
    accounts = response.value.map(rawAccount);
  const unixTimestamp = pairClockUnixTimestamp(wire(accounts.at(-1)!), slot);
  const rent = inspectPairRentAccount(wire(accounts[keys.indexOf(PAIR_RENT)]));
  if (
    JSON.stringify(rent) !==
    JSON.stringify(inspectPairRentAccount(wire(expected.get(PAIR_RENT)!.state)))
  )
    return fail();
  const beforeMints = [],
    afterMints = [];
  for (const [i, key] of keys.slice(0, -1).entries()) {
    const { role, state: before } = expected.get(key)!,
      after = accounts[i];
    let matches =
      before.owner === after.owner && before.executable === after.executable;
    if (role === 'mint') {
      beforeMints.push(await inspectSwapMintAccount(wire(before), key));
      afterMints.push(await inspectSwapMintAccount(wire(after), key));
      matches =
        matches &&
        BigInt(after.lamports) >= BigInt(pairRentMinimumRaw(rent, 82));
    } else if (role === 'tip') {
      matches =
        matches &&
        Buffer.from(before.data).equals(Buffer.from(after.data)) &&
        BigInt(after.lamports) >= BigInt(pairRentMinimumRaw(rent, 0));
    } else if (role !== 'rent') {
      matches =
        matches &&
        before.lamports === after.lamports &&
        Buffer.from(before.data).equals(Buffer.from(after.data));
    }
    if (!matches)
      throw pairReviewDiagnostic(
        Error('CPMM final custody changed.'),
        'cpmm-final-custody',
        {
          address: key,
          role,
          comparisons: pairDiagnosticComparisons(
            {
              owner: before.owner,
              executable: before.executable,
              lamports: before.lamports,
              dataSha256: await jitoEvidenceSha256(before.data),
            },
            {
              owner: after.owner,
              executable: after.executable,
              lamports: after.lamports,
              dataSha256: await jitoEvidenceSha256(after.data),
            },
          ),
        },
      );
  }
  assertSameSwapMintEvidence(
    { slot: frames.slot, mints: beforeMints },
    { slot, mints: afterMints },
  );
  signal.throwIfAborted();
  return {
    format: 'jito-cpmm-final-custody-observation-v1' as const,
    slot,
    minimumReadSlot,
    unixTimestamp,
    walletAccountsChecked: [...expected.values()].filter(
      (v) => v.role === 'wallet',
    ).length,
    tokenAccountsChecked: [...expected.values()].filter(
      (v) => v.role === 'token',
    ).length,
    mintPoliciesChecked: afterMints.length,
    rentPolicyUnchanged: true as const,
    tipRecipientStillOrdinary: true as const,
    bankVerified: false as const,
    providerQualified: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
/** Composes owned read captures and supplied simulation data. Does not upgrade
 * the latter into a transport-bound response or authenticated same-bank proof. */
export async function verifyJitoCpmmOwnedResearchBracket(
  input: Parameters<typeof replayJitoCpmmBundleSettlement>[0],
  lifetime: Parameters<typeof recheckJitoCpmmLifetime>[1],
  beforeCode: JitoRuntimeCapture,
  afterCode: JitoRuntimeCapture,
  rpc: PumpLaunchRpc,
  signal: AbortSignal,
) {
  signal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  const value = snapshotJitoEvidence(input, 4 * 1024 * 1024);
  signal.throwIfAborted();
  const scope = requireJitoCpmmLifetimeScope(lifetime, rpc, value.minimumSlot);
  const beforeScope = requireJitoRuntimeRpcScope(beforeCode, rpc);
  const afterScope = requireJitoRuntimeRpcScope(afterCode, rpc);
  if (
    beforeScope.minimumSlot !== value.minimumSlot ||
    afterScope.minimumSlot !== value.minimumSlot ||
    beforeScope.minimumReadSlot < scope.slot
  )
    return fail();
  const frames = await verifyJitoBundleSimulationFrames({
    packets: value.packets,
    minimumSlot: value.minimumSlot,
    simulationBankSlot: value.simulationBankSlot,
    result: value.result,
  });
  const runtime = await verifyJitoCpmmResearchRuntimeBracket(
    beforeCode,
    afterCode,
    frames,
    signal,
  );
  const settlement = await replayJitoCpmmBundleSettlement(value, signal);
  const finalFloor = Math.max(afterScope.maximumSlot, frames.slot);
  const custody = await finalCustody(value, frames, finalFloor, rpc, signal);
  const finalLifetime = await recheckJitoCpmmLifetime(
    value.swaps[0],
    lifetime,
    custody.slot,
    signal,
  );
  // Reject mutations of owned capture objects while the final RPCs were pending.
  requireJitoCpmmLifetimeScope(lifetime, rpc, value.minimumSlot);
  requireJitoRuntimeRpcScope(beforeCode, rpc);
  requireJitoRuntimeRpcScope(afterCode, rpc);
  signal.throwIfAborted();
  return {
    format: 'jito-cpmm-owned-research-bracket-v1' as const,
    originalMinimumSlot: value.minimumSlot,
    maximumObservedContextSlot: Math.max(
      beforeScope.maximumSlot,
      afterScope.maximumSlot,
      finalLifetime.validitySlot,
      custody.slot,
    ),
    runtime,
    settlement,
    lifetime: finalLifetime,
    custody,
    sameRpcDependencyChecked: true as const,
    ownedCapturesChecked: true as const,
    transportRequestBound: false as const,
    liveSimulationVerified: false as const,
    wholeOperationSlotBoundVerified: false as const,
    feeBankVerified: false as const,
    bankVerified: false as const,
    providerQualified: false as const,
    programApproved: false as const,
    sourceAuthenticated: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
