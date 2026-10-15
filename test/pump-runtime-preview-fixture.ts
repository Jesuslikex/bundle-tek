import {
  pumpGroupRuntimeProgramScope,
  type PumpGroupRuntimePreview,
} from '../lib/pump-group-runtime-authorization';
import type { PumpLaunchGroupReview } from '../lib/pump-launch-group-review';
import { pumpHolderDigest } from '../lib/pump-holder-review';
export async function pumpRuntimePreviewFixture(
  review: PumpLaunchGroupReview,
): Promise<PumpGroupRuntimePreview> {
  const programs = (await pumpGroupRuntimeProgramScope(review)).map((key) => ({
    address: key,
    loader:
      key === '11111111111111111111111111111111'
        ? 'NativeLoader1111111111111111111111111111111'
        : 'BPFLoader2111111111111111111111111111111111',
    programData: null,
    deploymentSlot: null,
    upgradeAuthority: null,
    codeSha256: 'a'.repeat(64),
    codeBytes: 64,
    identityKind:
      key === '11111111111111111111111111111111'
        ? ('native-system' as const)
        : ('elf-code' as const),
  }));
  const now = Date.now();
  return {
    format: 'pump-group-runtime-preview-v1',
    id: crypto.randomUUID(),
    reviewId: review.id,
    contextSha256: review.contextSha256,
    manifestSha256: review.manifestSha256,
    simulationSha256: review.simulationSha256,
    programs,
    identitySha256: await pumpHolderDigest({
      reviewId: review.id,
      contextSha256: review.contextSha256,
      programs,
    }),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(
      Math.min(now + 30000, Date.parse(review.expiresAt)),
    ).toISOString(),
    codeIdentityVerified: true,
    semanticAuditEstablished: false,
    signingAllowed: false,
    executionAllowed: false,
  };
}
