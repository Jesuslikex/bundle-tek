import { snapshotJitoEvidence } from './jito-evidence-json';
import { replayJitoCpmmBundleSettlement } from './jito-cpmm-bundle-replay';
import { verifyJitoBundleSimulationFrames } from './jito-bundle-simulation-frames';
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
  const finalLifetime = await recheckJitoCpmmLifetime(
    value.swaps[0],
    lifetime,
    finalFloor,
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
    ),
    runtime,
    settlement,
    lifetime: finalLifetime,
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
