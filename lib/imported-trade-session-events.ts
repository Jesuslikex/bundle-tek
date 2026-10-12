import {
  decodeTradeSession,
  decodeTradeSessionControl,
  type TradeSessionControl,
  type TradeSession,
} from './imported-trade-session';
import { UUID } from './wallet-operation';
import bs58 from 'bs58';
export const sessionEventLabels = {
  'session.baseline': 'Retained session state',
  'session.saved': 'Session saved',
  'session.cancelled': 'Remaining entries cancelled',
  'session.paused': 'Session paused',
  'session.resumed': 'Session resumed',
  'approval.reviewed': 'Entry reviewed',
  'approval.signed': 'Entry signature registered',
  'approval.submission_started': 'Entry submission started',
  'approval.finalized': 'Entry finalized',
  'approval.failed': 'Entry execution failed',
  'approval.cancelled': 'Unsigned entry approval cancelled',
} as const;
export type TradeSessionEvent = {
  id: string;
  sequence: number;
  projectId: string;
  sessionId: string;
  type: keyof typeof sessionEventLabels;
  document: TradeSession;
  createdAt: string;
  control?: TradeSessionControl | null;
  approval: null | {
    id: string;
    preparationId: string;
    entry: number;
    state: string;
    signature: string | null;
    sha256: string;
    receiptId: string | null;
  };
};
const states = {
  'approval.reviewed': 'awaiting_signature',
  'approval.signed': 'signed',
  'approval.submission_started': 'submitted',
  'approval.finalized': 'finalized',
  'approval.failed': 'failed',
  'approval.cancelled': 'cancelled',
};
export function decodeTradeSessionEvent(value: unknown): TradeSessionEvent {
  const v = value as TradeSessionEvent;
  if (
    !v ||
    !/^[a-f0-9]{32}$/.test(v.id) ||
    !Number.isSafeInteger(v.sequence) ||
    v.sequence < 1 ||
    !Object.hasOwn(sessionEventLabels, v.type) ||
    !Number.isFinite(Date.parse(v.createdAt))
  )
    throw new Error('Session event differs.');
  const s = decodeTradeSession(v.document);
  if (
    v.sessionId !== s.id ||
    v.projectId !== s.terms.projectId ||
    Date.parse(v.createdAt) < Date.parse(s.createdAt)
  )
    throw new Error('Session event context differs.');
  if (v.type === 'session.paused' || v.type === 'session.resumed') {
    const c = decodeTradeSessionControl(v.control);
    if (
      c.sessionId !== s.id ||
      c.projectId !== v.projectId ||
      c.state !== (v.type === 'session.paused' ? 'paused' : 'ready') ||
      c.revision < 2 ||
      c.createdAt !== s.createdAt ||
      c.updatedAt !== v.createdAt ||
      s.state !== 'active'
    )
      throw new Error('Session control event differs.');
  } else if (v.control !== undefined && v.control !== null)
    throw new Error('Unexpected session control capture.');
  if (v.type.startsWith('session.')) {
    if (
      v.approval !== null ||
      (v.type === 'session.saved' && s.state !== 'active') ||
      (v.type === 'session.cancelled' && s.state !== 'cancelled')
    )
      throw new Error('Session event state differs.');
  } else {
    const a = v.approval;
    if (
      !a ||
      !UUID.test(a.id) ||
      !UUID.test(a.preparationId) ||
      !s.terms.entries.some((e) => e.entry === a.entry) ||
      a.state !== states[v.type as keyof typeof states] ||
      !/^[a-f0-9]{64}$/.test(a.sha256) ||
      s.state !== 'active'
    )
      throw new Error('Session approval event differs.');
    if (['awaiting_signature', 'cancelled'].includes(a.state)) {
      if (a.signature !== null) throw new Error('Session signature differs.');
    } else if (
      typeof a.signature !== 'string' ||
      a.signature.length > 90 ||
      bs58.decode(a.signature).length !== 64
    )
      throw new Error('Session signature differs.');
    if (
      a.state === 'finalized'
        ? !a.receiptId || !UUID.test(a.receiptId)
        : a.receiptId !== null
    )
      throw new Error('Session receipt differs.');
  }
  return { ...v, document: s };
}
export function sessionEventDetail(e: TradeSessionEvent) {
  const s = e.document,
    a = e.approval,
    entry = s.terms.entries.find((v) => v.entry === a?.entry);
  return (
    `Session ${s.id} · captured ${s.state} revision ${s.revision} · project revision ${s.terms.projectRevision} · ${s.terms.side} · ${s.terms.entries.length} wallets · total ${s.terms.totalRaw} atomic input units` +
    (e.control
      ? ` · control ${e.control.state} revision ${e.control.revision}`
      : '') +
    (s.terms.schedule
      ? ` · scheduled start ${s.terms.schedule.startAt} · ${s.terms.schedule.spacingSeconds} seconds between wallets`
      : '') +
    (entry
      ? ` · entry ${entry.entry} · ${entry.wallet} · wallet revision ${entry.walletRevision} · exact ${entry.unitsRaw} atomic input units · approval ${a!.id} · preparation ${a!.preparationId} · packet ${a!.sha256} · captured ${a!.state}`
      : '') +
    (a?.signature ? ` · signature ${a.signature}` : '') +
    (a?.receiptId ? ` · receipt ${a.receiptId}` : '') +
    (e.type === 'session.baseline'
      ? ' · prior transitions were not reconstructed'
      : '')
  );
}
export function decodeTradeSessionEventPage(
  value: unknown,
  projectId?: string,
  sessionId?: string,
  after?: number,
) {
  const v = value as { events: unknown[]; nextCursor: string | null };
  if (!v || !Array.isArray(v.events) || v.events.length > 50)
    throw new Error('Session history unavailable.');
  const events = v.events.map(decodeTradeSessionEvent);
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (
      (projectId && e.projectId !== projectId) ||
      (sessionId && e.sessionId !== sessionId) ||
      (after !== undefined && e.sequence >= after) ||
      (i > 0 && e.sequence >= events[i - 1].sequence)
    )
      throw new Error('Session history ordering differs.');
  }
  if (
    new Set(events.map((e) => e.id)).size !== events.length ||
    (v.nextCursor !== null && v.nextCursor !== events.at(-1)?.id)
  )
    throw new Error('Session history cursor differs.');
  return { events, nextCursor: v.nextCursor };
}
