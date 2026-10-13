import bs58 from 'bs58';
import { UUID } from './wallet-operation';
import type { JitoBundleRecord, JitoBundleState } from './jito-bundle';

export type JitoBundleActivity = {
  format: 'jito-bundle-activity-v1';
  id: string;
  projectId: string;
  sessionId: string;
  sessionRevision: number;
  sha256: string;
  state: JitoBundleState;
  bundleId: string | null;
  swapCount: number;
  signedCount: number;
  packetCount: number;
  tipLamports: string;
  createdAt: string;
  updatedAt: string;
};
const labels: Record<JitoBundleState, string> = {
  reviewed: 'Jito bundle reviewed; signing incomplete or awaiting submission',
  submitting: 'Jito submission reserved; outcome uncertain',
  submitted: 'Jito bundle submitted; finalization pending',
  finalized: 'Jito bundle finalized',
  cancelled: 'Jito bundle cancelled',
  expired: 'Jito bundle expired',
};
export function isJitoBundleActivity(
  value: unknown,
): value is JitoBundleActivity {
  if (!value || typeof value !== 'object') return false;
  const r = value as JitoBundleActivity;
  return (
    r.format === 'jito-bundle-activity-v1' &&
    typeof r.id === 'string' &&
    UUID.test(r.id) &&
    typeof r.projectId === 'string' &&
    UUID.test(r.projectId) &&
    typeof r.sessionId === 'string' &&
    UUID.test(r.sessionId) &&
    Number.isSafeInteger(r.sessionRevision) &&
    r.sessionRevision > 0 &&
    typeof r.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(r.sha256) &&
    typeof r.state === 'string' &&
    Object.hasOwn(labels, r.state) &&
    (r.bundleId === null ||
      (typeof r.bundleId === 'string' && /^[a-f0-9]{64}$/.test(r.bundleId))) &&
    Number.isSafeInteger(r.swapCount) &&
    r.swapCount >= 1 &&
    r.swapCount <= 4 &&
    r.packetCount === r.swapCount + 1 &&
    Number.isSafeInteger(r.signedCount) &&
    r.signedCount >= 0 &&
    r.signedCount <= r.packetCount &&
    (!['submitting', 'submitted', 'finalized'].includes(r.state) ||
      r.signedCount === r.packetCount) &&
    (r.state !== 'submitted' || r.bundleId !== null) &&
    typeof r.tipLamports === 'string' &&
    /^[1-9]\d{0,7}$/.test(r.tipLamports) &&
    BigInt(r.tipLamports) >= 1000n &&
    BigInt(r.tipLamports) <= 10000000n &&
    typeof r.createdAt === 'string' &&
    Number.isFinite(Date.parse(r.createdAt)) &&
    typeof r.updatedAt === 'string' &&
    Number.isFinite(Date.parse(r.updatedAt)) &&
    Date.parse(r.updatedAt) >= Date.parse(r.createdAt)
  );
}
export function jitoBundleActivity(
  record: JitoBundleRecord,
): JitoBundleActivity {
  if (
    record.signatures.length !== record.manifest.swaps.length + 1 ||
    record.signatures.some(
      (s) =>
        s !== null &&
        (typeof s !== 'string' ||
          (() => {
            try {
              return bs58.decode(s).length !== 64;
            } catch {
              return true;
            }
          })()),
    ) ||
    new Set(record.signatures.filter((s) => s !== null)).size !==
      record.signatures.filter((s) => s !== null).length
  )
    throw new Error('Bundle signature progress unavailable.');
  const result: JitoBundleActivity = {
    format: 'jito-bundle-activity-v1',
    id: record.manifest.id,
    projectId: record.manifest.projectId,
    sessionId: record.manifest.sessionId,
    sessionRevision: record.manifest.sessionRevision,
    sha256: record.manifest.sha256,
    state: record.state,
    bundleId: record.bundleId,
    swapCount: record.manifest.swaps.length,
    signedCount: record.signatures.filter((s) => s !== null).length,
    packetCount: record.signatures.length,
    tipLamports: record.manifest.tip.amountRaw,
    createdAt: record.manifest.createdAt,
    updatedAt: record.updatedAt,
  };
  if (!isJitoBundleActivity(result))
    throw new Error('Bundle activity unavailable.');
  return result;
}
export function jitoBundleActivityLabel(record: JitoBundleActivity) {
  return labels[record.state];
}
export function jitoBundleActivityTerms(record: JitoBundleActivity) {
  return `Bundle ${record.id} · session ${record.sessionId} revision ${record.sessionRevision} · ${record.swapCount} swaps + tip ${record.tipLamports} lamports · ${record.signedCount}/${record.packetCount} signatures registered · fingerprint ${record.sha256}${record.bundleId ? ` · Jito ID ${record.bundleId}` : ''}`;
}
