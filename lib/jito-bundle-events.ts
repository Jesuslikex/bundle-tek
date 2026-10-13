import {
  isJitoBundleActivity,
  jitoBundleActivityLabel,
  jitoBundleActivityTerms,
  type JitoBundleActivity,
} from './jito-bundle-activity';
import type { JitoBundleManifest } from './jito-bundle';
export type JitoBundleEvent = {
  id: string;
  sequence: number;
  bundleId: string;
  projectId: string;
  sessionId: string;
  type:
    | 'bundle.baseline'
    | 'bundle.reviewed'
    | 'packet.registered'
    | 'bundle.submitting'
    | 'bundle.submitted'
    | 'bundle.finalized'
    | 'bundle.cancelled'
    | 'bundle.expired';
  packet: number | null;
  document: JitoBundleActivity;
  createdAt: string;
};
export function isJitoBundleEvent(value: unknown): value is JitoBundleEvent {
  if (!value || typeof value !== 'object') return false;
  const r = value as JitoBundleEvent;
  return (
    typeof r.id === 'string' &&
    /^[a-f0-9]{32}$/.test(r.id) &&
    Number.isSafeInteger(r.sequence) &&
    r.sequence > 0 &&
    isJitoBundleActivity(r.document) &&
    r.bundleId === r.document.id &&
    r.projectId === r.document.projectId &&
    r.sessionId === r.document.sessionId &&
    typeof r.createdAt === 'string' &&
    Number.isFinite(Date.parse(r.createdAt)) &&
    (r.type === 'bundle.baseline'
      ? r.packet === null
      : r.type === 'packet.registered'
        ? r.document.state === 'reviewed' &&
          Number.isSafeInteger(r.packet) &&
          r.packet! >= 0 &&
          r.packet! < r.document.packetCount &&
          r.document.signedCount > 0
        : typeof r.type === 'string' &&
          r.type === 'bundle.' + r.document.state &&
          r.packet === null)
  );
}
export function jitoBundleEventLabel(event: JitoBundleEvent) {
  if (event.type === 'bundle.baseline') return 'Retained Jito bundle state';
  if (event.type === 'packet.registered')
    return `Jito packet ${event.packet! + 1} signature registered`;
  return jitoBundleActivityLabel(event.document);
}
export function jitoEventMatchesManifest(
  event: JitoBundleEvent,
  manifest: JitoBundleManifest,
) {
  return (
    isJitoBundleEvent(event) &&
    event.bundleId === manifest.id &&
    event.projectId === manifest.projectId &&
    event.sessionId === manifest.sessionId &&
    event.document.sessionRevision === manifest.sessionRevision &&
    event.document.sha256 === manifest.sha256 &&
    event.document.swapCount === manifest.swaps.length &&
    event.document.packetCount === manifest.swaps.length + 1 &&
    event.document.tipLamports === manifest.tip.amountRaw &&
    event.document.createdAt === manifest.createdAt
  );
}
export function jitoBundleEventDetail(event: JitoBundleEvent) {
  const terms = jitoBundleActivityTerms(event.document);
  return `${terms} · captured ${event.document.state}${event.type === 'bundle.baseline' ? ' · prior transitions were not reconstructed' : ''}${event.document.state === 'reviewed' ? ' · registered signatures do not establish submission' : ''}`;
}
