import type { JitoBundleManifest } from './jito-bundle';

export const JITO_SEQUENTIAL_CHECK_AUTHORITY = {
  signingAllowed: false,
  executionAllowed: false,
  automaticExecutionAllowed: false,
  economicOutputVerified: false,
  providerQualified: false,
  sourceAuthenticated: false,
  signatureVerified: false,
  altStateVerified: false,
  runtimePrivilegesVerified: false,
} as const;
export const JITO_SEQUENTIAL_CHECK_REASONS = [
  'frame-integrity-only',
  'bank-unavailable',
  'fees-refused',
  'simulation-refused',
  'rate-limited',
  'interrupted',
  'transport-unavailable',
  'http-refused',
  'request-binding-differs',
  'plan-refused',
] as const;
export type JitoSequentialCheckResult = {
  format: 'jito-sequential-check-v1';
  bundleId: string;
  manifestSha256: string;
  expiresAt: string;
  observedAt: string;
  status: 'frames-observed' | 'refused';
  reason: (typeof JITO_SEQUENTIAL_CHECK_REASONS)[number];
  packetCount: number;
  minimumSlot: number;
  simulationSlot: number | null;
  fees: { packet: number; feeLamports: string; slot: number }[];
} & typeof JITO_SEQUENTIAL_CHECK_AUTHORITY;

const fail = (): never => {
  throw Error('Sequential check response differs from this bundle.');
};
const record = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail();
  return value as Record<string, unknown>;
};
const safeSlot = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
/** Public diagnostic projection only. It cannot become a signing approval. */
export function requireJitoSequentialCheckResult(
  value: unknown,
  manifest: JitoBundleManifest,
): JitoSequentialCheckResult {
  const result = record(value);
  const keys = [
    'format',
    'bundleId',
    'manifestSha256',
    'expiresAt',
    'observedAt',
    'status',
    'reason',
    'packetCount',
    'minimumSlot',
    'simulationSlot',
    'fees',
    ...Object.keys(JITO_SEQUENTIAL_CHECK_AUTHORITY),
  ];
  if (
    Object.keys(result).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(result, key)) ||
    Object.keys(result).some((key) => !keys.includes(key)) ||
    result.format !== 'jito-sequential-check-v1' ||
    result.bundleId !== manifest.id ||
    result.manifestSha256 !== manifest.sha256 ||
    result.expiresAt !== manifest.expiresAt ||
    result.packetCount !== manifest.swaps.length + 1 ||
    typeof result.packetCount !== 'number' ||
    result.packetCount < 2 ||
    result.packetCount > 5 ||
    !safeSlot(result.minimumSlot) ||
    typeof result.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(result.observedAt)) ||
    new Date(result.observedAt).toISOString() !== result.observedAt ||
    Date.parse(result.observedAt) < Date.parse(manifest.createdAt) ||
    Date.parse(result.observedAt) >= Date.parse(manifest.expiresAt) ||
    typeof result.status !== 'string' ||
    !['frames-observed', 'refused'].includes(result.status) ||
    !JITO_SEQUENTIAL_CHECK_REASONS.includes(
      result.reason as JitoSequentialCheckResult['reason'],
    ) ||
    Object.keys(JITO_SEQUENTIAL_CHECK_AUTHORITY).some(
      (key) => result[key] !== false,
    ) ||
    !Array.isArray(result.fees) ||
    result.fees.length > manifest.swaps.length + 1
  )
    return fail();
  const floor = result.minimumSlot;
  const simulationSlot = result.simulationSlot;
  if (
    simulationSlot !== null &&
    (!safeSlot(simulationSlot) ||
      simulationSlot < floor ||
      simulationSlot - floor > 32)
  )
    return fail();
  for (let i = 0; i < result.fees.length; i++) {
    const fee = record(result.fees[i]);
    const cap =
      manifest.swaps[i]?.maximumFeeLamports ?? manifest.tip.feeLamports;
    if (
      Object.keys(fee).length !== 3 ||
      !Object.hasOwn(fee, 'packet') ||
      !Object.hasOwn(fee, 'feeLamports') ||
      !Object.hasOwn(fee, 'slot') ||
      fee.packet !== i ||
      !safeSlot(fee.slot) ||
      fee.slot < floor ||
      fee.slot - floor > 32 ||
      typeof fee.feeLamports !== 'string' ||
      !/^[1-9]\d{0,19}$/.test(fee.feeLamports) ||
      BigInt(fee.feeLamports) > (1n << 64n) - 1n ||
      BigInt(fee.feeLamports) > BigInt(cap)
    )
      return fail();
  }
  if (result.status === 'frames-observed') {
    if (
      result.reason !== 'frame-integrity-only' ||
      simulationSlot === null ||
      result.fees.length !== manifest.swaps.length + 1 ||
      result.fees.some((fee) => record(fee).slot !== simulationSlot)
    )
      return fail();
  } else if (result.reason === 'frame-integrity-only') return fail();
  return value as JitoSequentialCheckResult;
}
