import { snapshotJitoEvidence } from './jito-evidence-json';
import {
  verifyJitoBundleSimulationFrames,
  type JitoSimulationAccount,
} from './jito-bundle-simulation-frames';
import { replayJitoCpmmBundleSettlement } from './jito-cpmm-bundle-replay';
import {
  inspectJitoCpmmAtaSetupPacket,
  inspectJitoCpmmAtaRentTransition,
} from './jito-cpmm-ata-setup';
import { inspectJitoCpmmUnsignedPacket } from './jito-cpmm-unsigned-packet';
const fail = (): never => {
  throw Error('CPMM setup bundle replay refused.');
};
type Bundle = Parameters<typeof replayJitoCpmmBundleSettlement>[0];
function uint(v: unknown) {
  if (
    typeof v !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(v) ||
    BigInt(v) > (1n << 64n) - 1n
  )
    return fail();
  return BigInt(v);
}
function wire(a: JitoSimulationAccount | null) {
  return a === null
    ? null
    : { ...a, data: [Buffer.from(a.data).toString('base64'), 'base64'] };
}

/** Complete supplied frames only. One explicit setup + 1..3 swaps + final tip.
 * No omitted readonly post-images are reconstructed or treated as observed. */
export async function replayJitoCpmmSetupBundle(
  input: {
    setup: Parameters<typeof inspectJitoCpmmAtaSetupPacket>[0];
    bundle: Bundle;
  },
  signal: AbortSignal,
) {
  signal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  const value = snapshotJitoEvidence(input, 4 * 1024 * 1024);
  if (
    !value ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'setup') ||
    !Object.hasOwn(value, 'bundle')
  )
    return fail();
  const { bundle } = value;
  if (
    !bundle ||
    typeof bundle !== 'object' ||
    Array.isArray(bundle) ||
    !value.setup ||
    typeof value.setup !== 'object' ||
    Array.isArray(value.setup)
  )
    return fail();
  if (
    !Array.isArray(bundle.swaps) ||
    bundle.swaps.length < 1 ||
    bundle.swaps.length > 3 ||
    !Array.isArray(bundle.packets) ||
    bundle.packets.length !== bundle.swaps.length + 2 ||
    bundle.packets.length > 5 ||
    bundle.packets[0].transaction !== value.setup.transaction ||
    bundle.packets[0].loadedAddresses !== null
  )
    return fail();
  signal.throwIfAborted();
  const setup = await inspectJitoCpmmAtaSetupPacket(value.setup);
  const firstSwap = await inspectJitoCpmmUnsignedPacket(bundle.swaps[0]);
  if (
    setup.payer !== firstSwap.payer ||
    setup.mint !== firstSwap.outputMint ||
    setup.destination !== firstSwap.destination ||
    setup.blockhash !== firstSwap.blockhash
  )
    return fail();
  const full = await verifyJitoBundleSimulationFrames({
    packets: bundle.packets,
    minimumSlot: bundle.minimumSlot,
    simulationBankSlot: bundle.simulationBankSlot,
    result: bundle.result,
  });
  signal.throwIfAborted();
  const prefix = full.frames[0];
  const rentRaw = bundle.bankAccounts?.before?.[1];
  if (
    !rentRaw ||
    !Array.isArray(bundle.walletReserves) ||
    bundle.walletReserves[0]?.wallet !== setup.payer
  )
    return fail();
  const reserve = bundle.walletReserves[0].reserveLamports;
  const transition = await inspectJitoCpmmAtaRentTransition({
    packet: value.setup,
    minimumSlot: bundle.minimumSlot,
    slot: full.slot,
    before: {
      payer: wire(prefix.preAccounts[0]),
      destination: wire(prefix.preAccounts[1]),
    },
    after: {
      payer: wire(prefix.postAccounts[0]),
      destination: wire(prefix.postAccounts[1]),
    },
    mintAccount: wire(prefix.preAccounts[prefix.keys.indexOf(setup.mint)]),
    rentAccount: { ...rentRaw, data: [rentRaw.dataBase64, 'base64'] },
    feeLamports: prefix.feeLamports,
    maximumFeeLamports: prefix.maximumFeeLamports,
    reserveLamports: reserve,
  });
  const result = bundle.result as {
    context: unknown;
    value: Record<string, unknown> & { transactionResults: unknown[] };
  };
  if (
    !Array.isArray(result.value.transactionResults) ||
    result.value.transactionResults.length !== full.frames.length
  )
    return fail();
  // Every complete original frame was checked above, including setup->swap
  // continuity. Preserve exact suffix rows and packets for the unchanged swap
  // verifier; do not manufacture account images from sparse archive output.
  const settlement = await replayJitoCpmmBundleSettlement(
    {
      ...bundle,
      packets: bundle.packets.slice(1),
      result: {
        ...result,
        value: {
          ...result.value,
          transactionResults: result.value.transactionResults.slice(1),
        },
      },
    },
    signal,
  );
  const payer = settlement.walletBalances[0];
  if (
    payer.wallet !== setup.payer ||
    uint(payer.initialLamports) !== uint(prefix.postAccounts[0]!.lamports)
  )
    return fail();
  const initial = uint(prefix.preAccounts[0]!.lamports),
    ending = uint(payer.finalLamports),
    rent = uint(transition.createdRentLamports),
    fee = uint(prefix.feeLamports) + uint(payer.networkFeeLamports),
    tip = uint(payer.tipLamports),
    declaredReserve = uint(reserve),
    systemReserve = uint(transition.requiredSystemRentLamports);
  const maximumFees = full.frames
    .filter((f) => f.keys[0] === setup.payer)
    .reduce((sum, f) => sum + uint(f.maximumFeeLamports), 0n);
  if (
    initial - ending !== rent + fee + tip ||
    initial <
      rent +
        maximumFees +
        tip +
        (declaredReserve > systemReserve ? declaredReserve : systemReserve)
  )
    return fail();
  signal.throwIfAborted();
  return {
    ...settlement,
    format: 'jito-cpmm-supplied-setup-bundle-replay-v1' as const,
    transactionSha256s: full.frames.map((f) => f.transactionSha256),
    setup: transition,
    walletBalances: settlement.walletBalances.map((w, i) =>
      i
        ? w
        : {
            ...w,
            initialLamports: initial.toString(),
            networkFeeLamports: fee.toString(),
            createdRentLamports: rent.toString(),
          },
    ),
    allSuppliedFramesChecked: true as const,
    setupFrameChecked: true as const,
    sourceAuthenticated: false as const,
    bankVerified: false as const,
    providerQualified: false as const,
    automaticExecutionAllowed: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
