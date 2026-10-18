import {
  collectPumpProgramIdentities,
  type PumpProgramIdentity,
} from './pump-group-code-identity';
import { pumpGroupProgramDataLink } from './pump-launch-group-deployments';
import { pumpRpcAccount, pumpAccountBytes } from './pump-launch-simulation';
import {
  validateVolumePumpRoute,
  VOLUME_PUMP,
  VOLUME_PUMP_FEE,
  type VolumePumpRoute,
} from './volume-bundle-route';
import {
  simulateVolumePumpBundle,
  type VolumeSimulationRpc,
} from './volume-bundle-simulation';
import {
  requireVolumeBundleConstruction,
  volumeDigest,
  volumeBytesDigest,
  volumeKeys,
  volumeUint,
  volumeReject,
  VOLUME_SYSTEM,
  VOLUME_TOKEN,
  type VolumeBundleConstruction,
} from './volume-bundle-construction';

export type VolumeProgramPolicy = {
  format: 'volume-program-policy-v1';
  reviewReference: string;
  programs: PumpProgramIdentity[];
  sha256: string;
};
/** No Volume-specific Pump/Fee code pins have been reviewed. Capture cannot enroll itself. */
export const VOLUME_PROGRAM_POLICY: VolumeProgramPolicy | null = null;
const required = [VOLUME_PUMP, VOLUME_PUMP_FEE, VOLUME_TOKEN, VOLUME_SYSTEM];
export async function requireVolumeProgramPolicy(
  value: VolumeProgramPolicy | null,
) {
  if (!value)
    return volumeReject(
      'A separately reviewed Volume program policy is required. Execution remains disabled.',
    );
  volumeKeys(value, 'format,reviewReference,programs,sha256');
  const p = structuredClone(value),
    { sha256, ...terms } = p;
  if (
    p.format !== 'volume-program-policy-v1' ||
    typeof p.reviewReference !== 'string' ||
    !/^[\x20-\x7e]{1,512}$/.test(p.reviewReference) ||
    !Array.isArray(p.programs) ||
    p.programs.length !== 4 ||
    p.programs.some((v, i) => v.address !== required[i]) ||
    (await volumeDigest(terms)) !== sha256
  )
    volumeReject('Program policy binding differs.');
  for (const v of p.programs) {
    volumeKeys(
      v,
      'address,loader,programData,deploymentSlot,upgradeAuthority,codeSha256,codeBytes,identityKind',
    );
    if (
      !/^[a-f0-9]{64}$/.test(v.codeSha256) ||
      !Number.isSafeInteger(v.codeBytes) ||
      v.codeBytes < 4 ||
      v.codeBytes > 10 * 1024 * 1024
    )
      volumeReject('Complete reviewed code identity required.');
    if (v.address === VOLUME_SYSTEM) {
      if (
        v.identityKind !== 'native-system' ||
        v.loader !== 'NativeLoader1111111111111111111111111111111' ||
        v.programData !== null ||
        v.deploymentSlot !== null ||
        v.upgradeAuthority !== null
      )
        volumeReject('Native System policy differs.');
    } else {
      if (
        v.identityKind !== 'elf-code' ||
        ![
          'BPFLoaderUpgradeab1e11111111111111111111111',
          'BPFLoader2111111111111111111111111111111111',
        ].includes(v.loader)
      )
        volumeReject('Unsupported program loader policy.');
      if (v.loader === 'BPFLoaderUpgradeab1e11111111111111111111111') {
        if (!v.programData || !v.deploymentSlot)
          volumeReject('Reviewed deployment metadata required.');
        volumeUint(v.deploymentSlot);
      } else if (
        v.programData !== null ||
        v.deploymentSlot !== null ||
        v.upgradeAuthority !== null
      )
        volumeReject('Legacy program metadata differs.');
    }
  }
  return p;
}
/** Two complete full-byte observations bracket the original unsigned simulation. No configured RPC or authority. */
export async function validateVolumeProgramRuntime(
  reviewInput: VolumeBundleConstruction,
  routeInput: VolumePumpRoute,
  rpc: VolumeSimulationRpc,
  signal: AbortSignal,
  minimumSlot: number,
  policy: VolumeProgramPolicy | null = VOLUME_PROGRAM_POLICY,
  now: () => number = Date.now,
) {
  const approved = await requireVolumeProgramPolicy(policy),
    review = await requireVolumeBundleConstruction(reviewInput),
    route = await validateVolumePumpRoute(review, routeInput.identities);
  if (
    JSON.stringify(route) !== JSON.stringify(routeInput) ||
    !Number.isSafeInteger(minimumSlot) ||
    minimumSlot < 1
  )
    volumeReject('Runtime route or context differs.');
  const aborter = new AbortController(),
    scope = AbortSignal.any([
      signal,
      aborter.signal,
      AbortSignal.timeout(30000),
    ]),
    started = now();
  const current = () => {
    if (scope.aborted || now() < started || now() - started > 30000)
      volumeReject('Program validation cancelled or expired.');
  };
  let reads = 0;
  let expected: PumpProgramIdentity[] | null = null;
  const checked = async (method: string, params: unknown[], s: AbortSignal) => {
    current();
    if (
      ![
        'getGenesisHash',
        'getMultipleAccounts',
        'getFeeForMessage',
        'isBlockhashValid',
        'getBlockHeight',
        'simulateTransaction',
      ].includes(method) ||
      ++reads > 160
    )
      volumeReject('Runtime read budget or method differs.');
    const result = await rpc(
      method as Parameters<VolumeSimulationRpc>[0],
      params,
      AbortSignal.any([scope, s]),
    );
    if (
      expected &&
      method === 'getMultipleAccounts' &&
      !(params[1] as { dataSlice?: unknown })?.dataSlice
    ) {
      const keys = params[0] as string[],
        values = (result as { value?: unknown[] })?.value;
      if (!Array.isArray(values) || values.length !== keys.length)
        return volumeReject('Program snapshot mapping differs.');
      for (const p of expected) {
        const a =
          pumpRpcAccount(values[keys.indexOf(p.address)]) ??
          volumeReject('Program snapshot missing.');
        if (
          a.owner !== p.loader ||
          pumpGroupProgramDataLink(p.address, a) !== p.programData
        )
          volumeReject('Simulation program header differs from code scan.');
        if (
          p.programData === null &&
          (pumpAccountBytes(a).length !== p.codeBytes ||
            (await volumeBytesDigest(pumpAccountBytes(a))) !== p.codeSha256)
        )
          volumeReject('Simulation legacy/native code differs from code scan.');
      }
    }
    current();
    return result;
  };
  try {
    const first = await collectPumpProgramIdentities(
      required,
      minimumSlot,
      scope,
      checked,
    );
    if (JSON.stringify(first.programs) !== JSON.stringify(approved.programs))
      volumeReject(
        'Observed code, loader, deployment or authority differs from reviewed policy.',
      );
    expected = first.programs;
    const simulation = await simulateVolumePumpBundle(
      review,
      route,
      checked,
      scope,
      first.maximumSlot,
      now,
    );
    const second = await collectPumpProgramIdentities(
      required,
      simulation.slotMax,
      scope,
      checked,
    );
    if (
      JSON.stringify(second.programs) !== JSON.stringify(first.programs) ||
      second.maximumSlot - minimumSlot > 32 ||
      simulation.slotMin < first.maximumSlot
    )
      volumeReject(
        'Program identity changed or total runtime window exceeded 32 slots.',
      );
    current();
    const result = {
      format: 'volume-validated-runtime-v1' as const,
      construction: review,
      route,
      policy: approved,
      first,
      simulation,
      second,
      observedAt: new Date(now()).toISOString(),
      codePolicyVerified: true as const,
      semanticAuditEstablished: false as const,
      transportQualificationRequired: true as const,
      durableReservationRequired: true as const,
      signingAllowed: false as const,
      executionAllowed: false as const,
    };
    const sha256 = await volumeDigest(result);
    current();
    return { ...result, sha256 };
  } finally {
    aborter.abort();
  }
}
export type VolumeValidatedRuntime = Awaited<
  ReturnType<typeof validateVolumeProgramRuntime>
>;
