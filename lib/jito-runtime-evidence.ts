import bs58 from 'bs58';
import { collectPumpProgramIdentities } from './pump-group-code-identity';
import { pumpGroupProgramDataLink } from './pump-launch-group-deployments';
import {
  requirePairTrustedPrograms,
  PAIR_TRUSTED_PROGRAMS,
} from './pair-trusted-programs';
import { assertPairRuntimeWritableAccount } from './pair-runtime-exposure';
import {
  snapshotJitoEvidence,
  jitoEvidenceSha256,
  awaitJitoEvidence,
} from './jito-evidence-json';
import type { PumpLaunchRpc, PumpRpcAccount } from './pump-launch-simulation';
import type { JitoBundleSimulationFrames } from './jito-bundle-simulation-frames';
import {
  requireJitoCpmmResearchIdentities,
  requireJitoCpmmSetupResearchIdentities,
} from './jito-cpmm-source-identity';
type RuntimeProfile = 'reviewed' | 'cpmm-research' | 'cpmm-ata-research';
function requireRuntimePrograms(
  profile: RuntimeProfile,
  first: Identity[],
  last: Identity[],
) {
  if (profile === 'cpmm-research')
    requireJitoCpmmResearchIdentities(first, last);
  else if (profile === 'cpmm-ata-research')
    requireJitoCpmmSetupResearchIdentities(first, last);
  else requirePairTrustedPrograms(first, last);
}
const SYSTEM = '11111111111111111111111111111111',
  COMPUTE = 'ComputeBudget111111111111111111111111111111',
  NATIVE = 'NativeLoader1111111111111111111111111111111';
/** Complete all-active superset from pinned Jito reserved-account-keys/src/lib.rs,
 * a3f2fe92c1166c7ec9f21a3655b37877fe1279a3. Conservative exclusion, not a node attestation.
 * Program invocation/executable keys must also be requested readonly. */
export const JITO_RESERVED_WRITE_KEYS = Object.freeze([
  'AddressLookupTab1e1111111111111111111111111',
  'BPFLoader2111111111111111111111111111111111',
  'BPFLoader1111111111111111111111111111111111',
  'BPFLoaderUpgradeab1e11111111111111111111111',
  COMPUTE,
  'Config1111111111111111111111111111111111111',
  'Ed25519SigVerify111111111111111111111111111',
  'Feature111111111111111111111111111111111111',
  'LoaderV411111111111111111111111111111111111',
  'KeccakSecp256k11111111111111111111111111111',
  'Secp256r1SigVerify1111111111111111111111111',
  'StakeConfig11111111111111111111111111111111',
  'Stake11111111111111111111111111111111111111',
  SYSTEM,
  'Vote111111111111111111111111111111111111111',
  'ZkE1Gama1Proof11111111111111111111111111111',
  'ZkTokenProof1111111111111111111111111111111',
  'SysvarC1ock11111111111111111111111111111111',
  'SysvarEpochRewards1111111111111111111111111',
  'SysvarEpochSchedu1e111111111111111111111111',
  'SysvarFees111111111111111111111111111111111',
  'Sysvar1nstructions1111111111111111111111111',
  'SysvarLastRestartS1ot1111111111111111111111',
  'SysvarRecentB1ockHashes11111111111111111111',
  'SysvarRent111111111111111111111111111111111',
  'SysvarRewards111111111111111111111111111111',
  'SysvarS1otHashes111111111111111111111111111',
  'SysvarS1otHistory11111111111111111111111111',
  'SysvarStakeHistory1111111111111111111111111',
  NATIVE,
  'Sysvar1111111111111111111111111111111111111',
]);
type Identity =
  | Awaited<ReturnType<typeof collectPumpProgramIdentities>>['programs'][number]
  | {
      address: string;
      loader: string;
      programData: null;
      deploymentSlot: null;
      upgradeAuthority: null;
      codeSha256: string;
      codeBytes: number;
      identityKind: 'native-marker';
    };
type PolicyRefusal = {
  reason: 'program-policy-refused';
  observedPrograms: Identity[];
  differences: {
    address: string;
    observed: Identity;
    expected: (typeof PAIR_TRUSTED_PROGRAMS)[number] | null;
  }[];
  signingAllowed: false;
  executionAllowed: false;
};
const policyRefusals = new WeakMap<object, PolicyRefusal>();
export function jitoRuntimePolicyRefusal(error: unknown): PolicyRefusal | null {
  return error && typeof error === 'object' && policyRefusals.has(error)
    ? snapshotJitoEvidence(policyRefusals.get(error)!)
    : null;
}
export type JitoRuntimeCapture = {
  format: 'jito-runtime-capture-v1';
  minimumSlot: number;
  minimumReadSlot: number;
  maximumSlot: number;
  keys: string[];
  programs: Identity[];
  sha256: string;
  reads: number;
  signingAllowed: false;
  executionAllowed: false;
  diagnosticProfile?:
    | 'cpmm-matched-source-research'
    | 'cpmm-ata-matched-source-research';
};
const issued = new WeakMap<
  object,
  {
    value: JitoRuntimeCapture;
    inventory: PumpRpcAccount[];
    profile: RuntimeProfile;
    rpc: PumpLaunchRpc;
  }
>();
const fail = (): never => {
  throw Error('Jito runtime evidence differs or is incomplete.');
};
/** Only binds an issued immutable capture to its original reader dependency. */
export function requireJitoRuntimeRpcScope(
  capture: JitoRuntimeCapture,
  rpc: PumpLaunchRpc,
) {
  const owned = issued.get(capture);
  if (
    !owned ||
    owned.rpc !== rpc ||
    JSON.stringify(snapshotJitoEvidence(capture)) !==
      JSON.stringify(owned.value)
  )
    return fail();
  return snapshotJitoEvidence(owned.value);
}
const address = (v: string) => {
  const b = bs58.decode(v);
  if (b.length !== 32 || bs58.encode(b) !== v) fail();
  return v;
};
const checksum = async (v: unknown) =>
  jitoEvidenceSha256(new TextEncoder().encode(JSON.stringify(v)));
const account = (v: unknown): PumpRpcAccount => {
  if (v === null) return null;
  const a = v as {
    owner?: unknown;
    executable?: unknown;
    lamports?: unknown;
    data?: unknown;
  };
  if (
    typeof a.owner !== 'string' ||
    typeof a.executable !== 'boolean' ||
    typeof a.lamports !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(a.lamports) ||
    BigInt(a.lamports) > (1n << 64n) - 1n ||
    !Array.isArray(a.data) ||
    a.data.length !== 2 ||
    typeof a.data[0] !== 'string' ||
    a.data[1] !== 'base64'
  )
    return fail();
  address(a.owner);
  const bytes = Buffer.from(a.data[0], 'base64');
  if (bytes.toString('base64') !== a.data[0]) return fail();
  return {
    owner: a.owner,
    executable: a.executable,
    lamports: a.lamports,
    data: [a.data[0], 'base64'],
  };
};

/** Separate read-only runtime stage. Reuses the unchanged serial group code scanner.
 * 300 scanner calls remain its existing bound; this stage adds at most three
 * inventory calls. The caller must include ALL stage slots in original F..F+32.
 * RPC values are caller transport observations, not authenticated node binaries. */
export async function collectJitoRuntimeEvidence(
  keysInput: string[],
  minimumSlot: number,
  minimumReadSlot: number,
  signal: AbortSignal,
  rpc: PumpLaunchRpc,
): Promise<JitoRuntimeCapture> {
  return collectRuntime(
    keysInput,
    minimumSlot,
    minimumReadSlot,
    signal,
    rpc,
    'reviewed',
  );
}
/** Isolated unsigned research entry; cannot be consumed by the reviewed-policy verifier. */
export async function collectJitoCpmmResearchRuntimeEvidence(
  keysInput: string[],
  minimumSlot: number,
  minimumReadSlot: number,
  signal: AbortSignal,
  rpc: PumpLaunchRpc,
): Promise<JitoRuntimeCapture> {
  return collectRuntime(
    keysInput,
    minimumSlot,
    minimumReadSlot,
    signal,
    rpc,
    'cpmm-research',
  );
}
/** Explicit setup profile; cannot be consumed by either original verifier. */
export async function collectJitoCpmmSetupResearchRuntimeEvidence(
  keysInput: string[],
  minimumSlot: number,
  minimumReadSlot: number,
  signal: AbortSignal,
  rpc: PumpLaunchRpc,
): Promise<JitoRuntimeCapture> {
  return collectRuntime(
    keysInput,
    minimumSlot,
    minimumReadSlot,
    signal,
    rpc,
    'cpmm-ata-research',
  );
}

async function collectRuntime(
  keysInput: string[],
  minimumSlot: number,
  minimumReadSlot: number,
  signal: AbortSignal,
  rpc: PumpLaunchRpc,
  profile: RuntimeProfile,
): Promise<JitoRuntimeCapture> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  const keys = snapshotJitoEvidence(keysInput);
  if (
    keys.length < 1 ||
    !keys.includes(SYSTEM) ||
    keys.length > 256 ||
    new Set(keys).size !== keys.length ||
    !Number.isSafeInteger(minimumSlot) ||
    minimumSlot < 0 ||
    !Number.isSafeInteger(minimumReadSlot) ||
    minimumReadSlot < minimumSlot ||
    minimumReadSlot - minimumSlot > 32
  )
    return fail();
  keys.forEach(address);
  let maximumSlot = minimumReadSlot,
    reads = 0;
  const inventory: PumpRpcAccount[] = [];
  const call: PumpLaunchRpc = async (method, params, readSignal) => {
    signal.throwIfAborted();
    readSignal.throwIfAborted();
    if (
      !['getGenesisHash', 'getMultipleAccounts'].includes(method) ||
      ++reads > 303
    )
      return fail();
    const result = snapshotJitoEvidence(
      await awaitJitoEvidence(
        signal,
        Promise.resolve().then(() => rpc(method, params, readSignal)),
      ),
    );
    signal.throwIfAborted();
    readSignal.throwIfAborted();
    if (method === 'getMultipleAccounts') {
      const r = result as { context?: { slot?: unknown }; value?: unknown },
        raw = r?.context?.slot;
      const floor = (params[1] as { minContextSlot?: unknown })?.minContextSlot;
      if (
        typeof raw !== 'string' ||
        !/^(0|[1-9]\d{0,15})$/.test(raw) ||
        !Number.isSafeInteger(Number(raw)) ||
        typeof floor !== 'number' ||
        Number(raw) < floor ||
        Number(raw) < minimumReadSlot ||
        Number(raw) - minimumSlot > 32 ||
        !Array.isArray(r.value) ||
        r.value.length !== (params[0] as unknown[]).length
      )
        return fail();
      maximumSlot = Math.max(maximumSlot, Number(raw));
    }
    return result;
  };
  for (let i = 0; i < keys.length; i += 100) {
    const response = (await call(
      'getMultipleAccounts',
      [
        keys.slice(i, i + 100),
        {
          encoding: 'base64',
          commitment: 'confirmed',
          minContextSlot: maximumSlot,
          dataSlice: { offset: 0, length: 128 },
        },
      ],
      signal,
    )) as { value: unknown[] };
    inventory.push(...response.value.map(account));
  }
  const programs = keys.filter((_, i) => inventory[i]?.executable);
  if (!programs.length || programs.length > 16) return fail();
  const beforeCode = maximumSlot;
  const scanned = programs.filter((p) => p !== COMPUTE);
  const identities: Identity[] = scanned.length
    ? (
        await collectPumpProgramIdentities(
          scanned,
          beforeCode,
          signal,
          call,
          1,
          100,
          profile === 'cpmm-ata-research' ? 'serial-cpmm-research' : 'default',
        )
      ).programs
    : [];
  if (programs.includes(COMPUTE)) {
    const a = inventory[keys.indexOf(COMPUTE)]!;
    const bytes = Buffer.from(a.data[0], 'base64');
    if (
      a.owner !== NATIVE ||
      a.executable !== true ||
      bytes.length < 1 ||
      bytes.length > 45
    )
      return fail();
    identities.push({
      address: COMPUTE,
      loader: NATIVE,
      programData: null,
      deploymentSlot: null,
      upgradeAuthority: null,
      codeSha256: await jitoEvidenceSha256(bytes),
      codeBytes: bytes.length,
      identityKind: 'native-marker',
    });
  }
  identities.sort((a, b) => (a.address < b.address ? -1 : 1));
  // The first scan alone can refuse an unreviewed program immediately; it can
  // never create policy by copying today's observed hash into an allowlist.
  try {
    requireRuntimePrograms(profile, identities, identities);
  } catch {
    if (profile !== 'reviewed')
      throw Error('Jito CPMM research source identity refused.');
    const differences = identities.flatMap((observed) => {
      const expected = PAIR_TRUSTED_PROGRAMS.find(
        (p) => p.address === observed.address,
      );
      return !expected ||
        expected.loader !== observed.loader ||
        expected.identityKind !== observed.identityKind ||
        expected.upgradeAuthority !== observed.upgradeAuthority ||
        !expected.codeSha256.includes(observed.codeSha256)
        ? [{ address: observed.address, observed, expected: expected ?? null }]
        : [];
    });
    const error = Error('Jito runtime reviewed program policy refused.');
    policyRefusals.set(
      error,
      snapshotJitoEvidence({
        reason: 'program-policy-refused',
        observedPrograms: identities,
        differences,
        signingAllowed: false,
        executionAllowed: false,
      }),
    );
    throw error;
  }
  const base = {
    format: 'jito-runtime-capture-v1' as const,
    minimumSlot,
    minimumReadSlot,
    maximumSlot,
    keys,
    programs: identities,
    reads,
    signingAllowed: false as const,
    executionAllowed: false as const,
    ...(profile !== 'reviewed'
      ? {
          diagnosticProfile:
            profile === 'cpmm-research'
              ? ('cpmm-matched-source-research' as const)
              : ('cpmm-ata-matched-source-research' as const),
        }
      : {}),
  };
  const value = { ...base, sha256: await checksum(base) };
  issued.set(value, {
    value: snapshotJitoEvidence(value),
    inventory: snapshotJitoEvidence(inventory),
    profile,
    rpc,
  });
  signal.throwIfAborted();
  return value;
}

/** Conservative pinned-profile checks; never asserts provider runtime attestation. */
export async function verifyJitoRuntimeBracket(
  first: JitoRuntimeCapture,
  last: JitoRuntimeCapture,
  frames: JitoBundleSimulationFrames,
  signal: AbortSignal,
) {
  const value = await verifyRuntime(first, last, frames, signal, 'reviewed');
  return { ...value, reviewedCodePolicyMatched: true as const };
}
/** Same serial scanner and conservative writable checks, with matched-source research scope only. */
export async function verifyJitoCpmmResearchRuntimeBracket(
  first: JitoRuntimeCapture,
  last: JitoRuntimeCapture,
  frames: JitoBundleSimulationFrames,
  signal: AbortSignal,
) {
  const value = await verifyRuntime(
    first,
    last,
    frames,
    signal,
    'cpmm-research',
  );
  return {
    ...value,
    format: 'jito-cpmm-research-runtime-bracket-v1' as const,
    matchedSourceIdentityChecked: true as const,
    reviewedCodePolicyMatched: false as const,
    programApproved: false as const,
    sourceAuthenticated: false as const,
  };
}
export async function verifyJitoCpmmSetupResearchRuntimeBracket(
  first: JitoRuntimeCapture,
  last: JitoRuntimeCapture,
  frames: JitoBundleSimulationFrames,
  signal: AbortSignal,
) {
  const value = await verifyRuntime(
    first,
    last,
    frames,
    signal,
    'cpmm-ata-research',
  );
  return {
    ...value,
    format: 'jito-cpmm-setup-research-runtime-bracket-v1' as const,
    matchedSourceIdentityChecked: true as const,
    ataSetupProgramChecked: true as const,
    reviewedCodePolicyMatched: false as const,
    programApproved: false as const,
    sourceAuthenticated: false as const,
  };
}

async function verifyRuntime(
  first: JitoRuntimeCapture,
  last: JitoRuntimeCapture,
  frames: JitoBundleSimulationFrames,
  signal: AbortSignal,
  profile: RuntimeProfile,
) {
  const copiedFrames = structuredClone(frames);
  const a = issued.get(first),
    b = issued.get(last);
  if (!a || !b || a.profile !== profile || b.profile !== profile) return fail();
  if (
    JSON.stringify(snapshotJitoEvidence(first)) !== JSON.stringify(a.value) ||
    JSON.stringify(snapshotJitoEvidence(last)) !== JSON.stringify(b.value) ||
    a.value.minimumSlot !== b.value.minimumSlot ||
    JSON.stringify(a.value.keys) !== JSON.stringify(b.value.keys) ||
    a.value.maximumSlot > copiedFrames.slot ||
    b.value.minimumReadSlot < copiedFrames.slot ||
    b.value.maximumSlot - a.value.minimumSlot > 32
  )
    return fail();
  requireRuntimePrograms(profile, a.value.programs, b.value.programs);
  const keys = [...new Set(copiedFrames.frames.flatMap((f) => f.keys))];
  if (JSON.stringify(keys) !== JSON.stringify(a.value.keys)) return fail();
  const identities = new Map(a.value.programs.map((p) => [p.address, p]));
  for (const frame of copiedFrames.frames) {
    for (const i of frame.invokedProgramIndexes)
      if (frame.requestedWritable[i] || !identities.has(frame.keys[i]))
        return fail();
    for (let i = 0; i < frame.keys.length; i++) {
      const key = frame.keys[i],
        index = a.value.keys.indexOf(key),
        prior = a.inventory[index],
        after = b.inventory[index];
      if (
        prior?.executable !== after?.executable ||
        prior?.owner !== after?.owner
      )
        return fail();
      if (frame.requestedWritable[i]) {
        if (prior?.executable || after?.executable) return fail();
        if (JITO_RESERVED_WRITE_KEYS.includes(key)) return fail();
        for (const state of [frame.preAccounts[i], frame.postAccounts[i]]) {
          const raw = state
            ? {
                ...state,
                data: [Buffer.from(state.data).toString('base64'), 'base64'],
              }
            : null;
          assertPairRuntimeWritableAccount(raw);
        }
      }
      if (prior?.executable || after?.executable) {
        if (
          [frame.preAccounts[i], frame.postAccounts[i]].some(
            (state) => !state?.executable || state.owner !== prior?.owner,
          )
        )
          return fail();
      }
      for (const state of [frame.preAccounts[i], frame.postAccounts[i]]) {
        if (!state?.executable) continue;
        const identity = identities.get(key);
        if (
          !identity ||
          frame.requestedWritable[i] ||
          state.owner !== identity.loader
        )
          return fail();
        const raw = {
          ...state,
          data: [Buffer.from(state.data).toString('base64'), 'base64'] as [
            string,
            'base64',
          ],
        };
        if (identity.programData) {
          if (pumpGroupProgramDataLink(key, raw) !== identity.programData)
            return fail();
        } else if (
          (await jitoEvidenceSha256(state.data)) !== identity.codeSha256
        )
          return fail();
      }
    }
  }
  signal.throwIfAborted();
  return {
    format: 'jito-runtime-bracket-v1' as const,
    slot: copiedFrames.slot,
    programs: snapshotJitoEvidence(a.value.programs),
    fullCodeScansMatched: true as const,
    reviewedCodePolicyMatched: profile === 'reviewed',
    reservedWritableKeysRefused: true as const,
    requestedExecutableWritableRefused: true as const,
    conservativeRuntimeChecksPassed: true as const,
    runtimeModel:
      'pinned Jito reserved-key superset; only requested-readonly program/executable keys' as const,
    runtimePrivilegesVerified: false as const,
    runtimeAttested: false as const,
    providerQualified: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
