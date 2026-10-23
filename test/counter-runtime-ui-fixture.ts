import { counterPreviewUiFixture } from './counter-preview-ui-fixture';
import { pairRuntimeDigest } from '../lib/pair-runtime-trace';
import type { CounterRuntimeEvidenceView } from '../lib/counter-runtime-view';
export async function counterRuntimeUiFixture() {
  const f = counterPreviewUiFixture();
  const receipt: Omit<CounterRuntimeEvidenceView, 'sha256'> = {
    format: 'counter-buy-runtime-evidence-v1',
    packetSha256: f.preview.packetSha256,
    minimumSlot: 100,
    maximumSlot: 110,
    simulationSlot: 106,
    observedAt: f.preview.observedAt,
    expiresAt: f.preview.expiresAt,
    programs: [
      {
        address: '11111111111111111111111111111111',
        loader: 'NativeLoader1111111111111111111111111111111',
        programData: null,
        deploymentSlot: null,
        upgradeAuthority: null,
        codeSha256: '1'.repeat(64),
        codeBytes: 21,
        identityKind: 'native-system',
      },
      {
        address: 'ComputeBudget111111111111111111111111111111',
        loader: 'NativeLoader1111111111111111111111111111111',
        programData: null,
        deploymentSlot: null,
        upgradeAuthority: null,
        codeSha256: '2'.repeat(64),
        codeBytes: 22,
        identityKind: 'native-marker',
      },
      {
        address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        loader: 'BPFLoader2111111111111111111111111111111111',
        programData: null,
        deploymentSlot: null,
        upgradeAuthority: null,
        codeSha256: '3'.repeat(64),
        codeBytes: 1024,
        identityKind: 'elf-code',
      },
    ],
    traceSha256: '4'.repeat(64),
    rawInstructionCoverageComplete: true,
    providerObservationOnly: true,
    clocks: [
      {
        slot: 100,
        unixTimestamp: String(
          Math.floor(Date.parse(f.preview.observedAt) / 1000),
        ),
        evaluatedAt: f.preview.observedAt,
      },
      {
        slot: 100,
        unixTimestamp: String(
          Math.floor(Date.parse(f.preview.observedAt) / 1000),
        ),
        evaluatedAt: f.preview.observedAt,
      },
    ],
    codeIdentityObserved: true,
    ordinaryClockVerified: true,
    codeScanCount: 2,
    programCodeAttested: false,
    semanticAuditEstablished: false,
    trustedProgramPolicyEstablished: false,
    innerInstructionPolicyVerified: false,
    signingAllowed: false,
    executionAllowed: false,
  };
  const runtime = { ...receipt, sha256: await pairRuntimeDigest(receipt) };
  return { ...f, runtime };
}
