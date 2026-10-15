import { address } from '@solana/kit-v1';
import type { PumpProgramIdentity } from './pump-group-code-identity';
import type {
  PumpLaunchGroupReview,
  PumpLaunchGroupConsent,
} from './pump-launch-group-review';
import { pumpHolderDigest } from './pump-holder-review';
export type PumpGroupRuntimePreview = {
  format: 'pump-group-runtime-preview-v1';
  id: string;
  reviewId: string;
  contextSha256: string;
  manifestSha256: string;
  simulationSha256: string;
  programs: PumpProgramIdentity[];
  identitySha256: string;
  createdAt: string;
  expiresAt: string;
  codeIdentityVerified: true;
  semanticAuditEstablished: false;
  signingAllowed: false;
  executionAllowed: false;
};
export type PumpGroupCodeConsent = {
  approved: true;
  previewId: string;
  identitySha256: string;
  acknowledgeUpgradeableCode: true;
  acknowledgeNoSemanticAudit: true;
};
export type PumpGroupSigningAuthorization = {
  format: 'pump-group-signing-authorization-v1';
  id: string;
  reviewId: string;
  previewId: string;
  contextSha256: string;
  manifestSha256: string;
  simulationSha256: string;
  identitySha256: string;
  createdAt: string;
  expiresAt: string;
  scope: 'sign-complete-group-only';
  signingAllowed: true;
  executionAllowed: false;
  submissionAllowed: false;
  semanticAuditEstablished: false;
};
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
export function groupSigningConsent(
  review: PumpLaunchGroupReview,
): PumpLaunchGroupConsent {
  return {
    approved: true,
    reviewId: review.id,
    manifestSha256: review.manifestSha256,
    contextSha256: review.contextSha256,
    simulationSha256: review.simulationSha256,
    approvedScope: 'complete-create-developer-holder-packet-group',
    acknowledgeSimulationLimits: true,
  };
}
export async function pumpGroupRuntimeProgramScope(
  review: PumpLaunchGroupReview,
) {
  const [
    { requirePumpLaunchGroupReview },
    { buildPumpCreateMessage },
    { decodePumpSigningInput },
  ] = await Promise.all([
    import('./pump-launch-group-review'),
    import('./pump-launch-message'),
    import('./pump-launch-signing'),
  ]);
  const { built } = await requirePumpLaunchGroupReview(review, false);
  const created = await buildPumpCreateMessage(
    decodePumpSigningInput(review.input.create),
  );
  return [
    ...new Set([
      ...built.packets.flatMap((packet) =>
        packet.instructions.map((ix) => String(ix.programAddress)),
      ),
      ...created.instruction
        .accounts!.slice(7, 10)
        .map((a) => String(a.address)),
      built.quote.tokenProgram,
    ]),
  ];
}
export async function requirePumpRuntimePreview(
  value: unknown,
  review: PumpLaunchGroupReview,
  live = true,
): Promise<PumpGroupRuntimePreview> {
  if (
    !record(value) ||
    value.format !== 'pump-group-runtime-preview-v1' ||
    typeof value.id !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value.id,
    ) ||
    value.reviewId !== review.id ||
    value.contextSha256 !== review.contextSha256 ||
    value.manifestSha256 !== review.manifestSha256 ||
    value.simulationSha256 !== review.simulationSha256 ||
    value.codeIdentityVerified !== true ||
    value.semanticAuditEstablished !== false ||
    value.signingAllowed !== false ||
    value.executionAllowed !== false ||
    !Array.isArray(value.programs) ||
    !value.programs.length ||
    value.programs.length > 16 ||
    !Number.isFinite(Date.parse(String(value.createdAt))) ||
    !Number.isFinite(Date.parse(String(value.expiresAt))) ||
    Date.parse(String(value.createdAt)) > Date.now() + 1000 ||
    Date.parse(String(value.expiresAt)) > Date.parse(review.expiresAt) ||
    Date.parse(String(value.expiresAt)) >
      Date.parse(String(value.createdAt)) + 30000 ||
    Date.parse(String(value.expiresAt)) <=
      Date.parse(String(value.createdAt)) ||
    (live && Date.parse(String(value.expiresAt)) <= Date.now())
  )
    throw new Error('Runtime preview scope or lifetime differs.');
  const programs = value.programs as PumpProgramIdentity[];
  if (
    new Set(programs.map((p) => p.address)).size !== programs.length ||
    programs.some(
      (p) =>
        !p ||
        typeof p.address !== 'string' ||
        typeof p.loader !== 'string' ||
        !/^[a-f0-9]{64}$/.test(p.codeSha256) ||
        !Number.isSafeInteger(p.codeBytes) ||
        p.codeBytes < 1 ||
        p.codeBytes > 10 * 1024 * 1024 ||
        !['native-system', 'elf-code'].includes(p.identityKind),
    )
  )
    throw new Error('Runtime program identities differ.');
  for (const p of programs) {
    address(p.address);
    address(p.loader);
    if (p.programData !== null) address(p.programData);
    if (p.upgradeAuthority !== null) address(p.upgradeAuthority);
    if (
      p.identityKind === 'native-system'
        ? p.address !== '11111111111111111111111111111111' ||
          p.loader !== 'NativeLoader1111111111111111111111111111111' ||
          p.programData !== null ||
          p.deploymentSlot !== null ||
          p.upgradeAuthority !== null
        : p.loader === 'BPFLoaderUpgradeab1e11111111111111111111111'
          ? p.programData === null ||
            typeof p.deploymentSlot !== 'string' ||
            !/^\d{1,16}$/.test(p.deploymentSlot)
          : p.loader !== 'BPFLoader2111111111111111111111111111111111' ||
            p.programData !== null ||
            p.deploymentSlot !== null ||
            p.upgradeAuthority !== null
    )
      throw new Error('Runtime loader, code or authority profile differs.');
  }
  if (
    value.identitySha256 !==
    (await pumpHolderDigest({
      reviewId: review.id,
      contextSha256: review.contextSha256,
      programs,
    }))
  )
    throw new Error('Runtime identity digest differs.');
  const scope = await pumpGroupRuntimeProgramScope(review);
  if (
    scope.sort().join(',') !==
    programs
      .map((program) => program.address)
      .sort()
      .join(',')
  )
    throw new Error('Runtime preview must cover every group program.');
  if (live && Date.parse(String(value.expiresAt)) <= Date.now())
    throw new Error('Runtime preview expired during validation.');
  return structuredClone(value) as PumpGroupRuntimePreview;
}
export function requirePumpCodeConsent(
  preview: PumpGroupRuntimePreview,
  value: unknown,
): PumpGroupCodeConsent {
  if (
    !record(value) ||
    Object.keys(value).sort().join(',') !==
      'acknowledgeNoSemanticAudit,acknowledgeUpgradeableCode,approved,identitySha256,previewId' ||
    value.approved !== true ||
    value.previewId !== preview.id ||
    value.identitySha256 !== preview.identitySha256 ||
    value.acknowledgeUpgradeableCode !== true ||
    value.acknowledgeNoSemanticAudit !== true
  )
    throw new Error(
      'Approve these exact code identities and upgrade authorities.',
    );
  return value as PumpGroupCodeConsent;
}
export function requirePumpSigningAuthorization(
  value: unknown,
  preview: PumpGroupRuntimePreview,
  review: PumpLaunchGroupReview,
): PumpGroupSigningAuthorization {
  if (
    !record(value) ||
    value.format !== 'pump-group-signing-authorization-v1' ||
    typeof value.id !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value.id,
    ) ||
    value.reviewId !== review.id ||
    value.previewId !== preview.id ||
    value.contextSha256 !== review.contextSha256 ||
    value.manifestSha256 !== review.manifestSha256 ||
    value.simulationSha256 !== review.simulationSha256 ||
    value.identitySha256 !== preview.identitySha256 ||
    value.scope !== 'sign-complete-group-only' ||
    value.signingAllowed !== true ||
    value.executionAllowed !== false ||
    value.submissionAllowed !== false ||
    value.semanticAuditEstablished !== false ||
    !Number.isFinite(Date.parse(String(value.createdAt))) ||
    Date.parse(String(value.createdAt)) > Date.now() + 1000 ||
    !Number.isFinite(Date.parse(String(value.expiresAt))) ||
    Date.parse(String(value.expiresAt)) <= Date.now() ||
    Date.parse(String(value.expiresAt)) <=
      Date.parse(String(value.createdAt)) ||
    Date.parse(String(value.expiresAt)) >
      Date.parse(String(value.createdAt)) + 5000 ||
    Date.parse(String(value.expiresAt)) > Date.parse(review.expiresAt)
  )
    throw new Error('Fresh exact group signing authorization is required.');
  return structuredClone(value) as PumpGroupSigningAuthorization;
}
