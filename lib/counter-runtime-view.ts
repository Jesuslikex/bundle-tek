import bs58 from 'bs58';
import { z } from 'zod';
import type { CounterPlan } from './counter-trade-store';
import type { CounterPreviewRequest } from './counter-owned-preview';
import { counterPreviewView } from './counter-preview-view';
import { pairRuntimeDigest } from './pair-runtime-trace';
const SYSTEM = '11111111111111111111111111111111';
const COMPUTE = 'ComputeBudget111111111111111111111111111111';
const NATIVE = 'NativeLoader1111111111111111111111111111111';
const UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
const LEGACY = ['BPFLoader2111111111111111111111111111111111'];
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const address = z
  .string()
  .min(32)
  .max(44)
  .refine((value) => {
    try {
      const raw = bs58.decode(value);
      return raw.length === 32 && bs58.encode(raw) === value;
    } catch {
      return false;
    }
  });
const slot = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const iso = z.iso
  .datetime()
  .refine((value) => new Date(value).toISOString() === value);
const program = z
  .object({
    address,
    loader: address,
    programData: address.nullable(),
    deploymentSlot: z
      .string()
      .regex(/^(0|[1-9]\d{0,19})$/)
      .refine((v) => BigInt(v) <= (1n << 64n) - 1n)
      .nullable(),
    upgradeAuthority: address.nullable(),
    codeSha256: hash,
    codeBytes: z
      .number()
      .int()
      .min(0)
      .max(10 * 1024 * 1024),
    identityKind: z.enum(['native-system', 'elf-code', 'native-marker']),
  })
  .strict();
const runtime = z
  .object({
    format: z.literal('counter-buy-runtime-evidence-v1'),
    packetSha256: hash,
    minimumSlot: slot,
    maximumSlot: slot,
    simulationSlot: slot,
    observedAt: iso,
    expiresAt: iso,
    programs: z.array(program).min(1).max(16),
    traceSha256: hash,
    rawInstructionCoverageComplete: z.boolean(),
    providerObservationOnly: z.literal(true),
    clocks: z
      .array(
        z
          .object({
            slot,
            unixTimestamp: z
              .string()
              .regex(/^(0|-?[1-9]\d{0,18})$/)
              .refine(
                (v) => BigInt(v) >= -(1n << 63n) && BigInt(v) < 1n << 63n,
              ),
            evaluatedAt: iso,
          })
          .strict(),
      )
      .min(2)
      .max(300),
    codeIdentityObserved: z.literal(true),
    ordinaryClockVerified: z.literal(true),
    codeScanCount: z.literal(2),
    programCodeAttested: z.literal(false),
    semanticAuditEstablished: z.literal(false),
    trustedProgramPolicyEstablished: z.literal(false),
    innerInstructionPolicyVerified: z.literal(false),
    signingAllowed: z.literal(false),
    executionAllowed: z.literal(false),
    sha256: hash,
  })
  .strict();
export type CounterRuntimeEvidenceView = z.infer<typeof runtime>;
const PREVIEW_KEYS =
  'actualSimulatedInputRaw,approvalAllowed,decisionIdentity,executionAllowed,expiresAt,format,grossSettlementReviewed,limitations,maximumFeeAndRentRaw,maximumQuoteInputRaw,maximumSolInputRaw,mint,networkFeeLamports,observedAt,outputTargetRaw,ownershipContextRechecked,packetSha256,planId,planRevision,programCodeAttested,projectId,projectRevision,requiredSolInputRaw,reservationCreated,signingAllowed,sourceRecheckedAt,sourceRevalidated,sourceTradeCount,sourceValidUntil,tokenDecimals,wallet,walletRevision';
function fail(): never {
  throw Error(
    'Counter runtime evidence differs or expired. Request a fresh read-only check.',
  );
}
export async function counterRuntimeView(
  value: unknown,
  plan: CounterPlan,
  request: CounterPreviewRequest,
  now = Date.now(),
) {
  try {
    const outer = z
      .object({ preview: z.unknown(), runtime })
      .strict()
      .parse(value);
    const preview = counterPreviewView(
        { preview: outer.preview },
        plan,
        request,
        now,
      ),
      r = outer.runtime;
    if (Object.keys(preview).sort().join(',') !== PREVIEW_KEYS) fail();
    for (const timestamp of [
      preview.observedAt,
      preview.expiresAt,
      preview.sourceRecheckedAt,
      preview.sourceValidUntil,
    ])
      iso.parse(timestamp);
    z.string().min(1).max(4096).parse(preview.limitations);
    if (
      r.packetSha256 !== preview.packetSha256 ||
      r.maximumSlot < r.minimumSlot ||
      r.maximumSlot - r.minimumSlot > 32 ||
      r.simulationSlot < r.minimumSlot ||
      r.simulationSlot > r.maximumSlot ||
      Date.parse(r.observedAt) > Date.parse(preview.observedAt) ||
      Date.parse(r.expiresAt) <= now ||
      Date.parse(r.expiresAt) <= Date.parse(r.observedAt) ||
      Date.parse(r.expiresAt) - Date.parse(r.observedAt) > 30000
    )
      fail();
    let previous = '';
    let bytes = 0;
    const dataLinks = new Set<string>();
    for (const p of r.programs) {
      if (p.address <= previous) fail();
      previous = p.address;
      bytes += p.codeBytes;
      if (
        p.identityKind === 'native-system' ||
        p.identityKind === 'native-marker'
      ) {
        if (
          p.address !==
            (p.identityKind === 'native-system' ? SYSTEM : COMPUTE) ||
          p.loader !== NATIVE ||
          p.programData !== null ||
          p.deploymentSlot !== null ||
          p.upgradeAuthority !== null ||
          (p.identityKind === 'native-marker' && p.codeBytes < 1) ||
          p.codeBytes > 45
        )
          fail();
      } else {
        if (p.codeBytes < 4 || p.address === SYSTEM || p.address === COMPUTE)
          fail();
        if (p.loader === UPGRADEABLE) {
          if (
            !p.programData ||
            p.deploymentSlot === null ||
            BigInt(p.deploymentSlot) > BigInt(r.maximumSlot) ||
            dataLinks.has(p.programData)
          )
            fail();
          dataLinks.add(p.programData);
        } else if (
          !LEGACY.includes(p.loader) ||
          p.programData !== null ||
          p.deploymentSlot !== null ||
          p.upgradeAuthority !== null
        )
          fail();
      }
    }
    if (bytes > 32 * 1024 * 1024) fail();
    for (const clock of r.clocks) {
      const evaluated = Date.parse(clock.evaluatedAt),
        skew = BigInt(clock.unixTimestamp) * 1000n - BigInt(evaluated);
      if (
        clock.slot < r.minimumSlot ||
        clock.slot > r.maximumSlot ||
        evaluated < Date.parse(r.observedAt) ||
        evaluated > now + 1000 ||
        evaluated >= Date.parse(r.expiresAt) ||
        skew < -30000n ||
        skew > 30000n
      )
        fail();
    }
    const { sha256, ...receipt } = r;
    if ((await pairRuntimeDigest(receipt)) !== sha256) fail();
    return { preview, runtime: r };
  } catch {
    return fail();
  }
}
