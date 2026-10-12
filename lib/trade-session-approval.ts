import type { ImportedApprovalRow } from './imported-approval-history';
import {
  sessionEntryNotBefore,
  type TradeSession,
} from './imported-trade-session';
export type SessionApprovalSelection = {
  intentId: string;
  session: TradeSession;
  entry: number;
};
export async function requireSessionApproval(
  row: ImportedApprovalRow,
  selection: SessionApprovalSelection,
) {
  const { session, entry, intentId } = selection,
    terms = session.terms,
    e = terms.entries.find((e) => e.entry === entry),
    capture = row.document.session;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(terms)),
  );
  const hash = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  if (
    !e ||
    row.id !== intentId ||
    row.projectId !== terms.projectId ||
    row.projectRevision !== terms.projectRevision ||
    row.side !== terms.side ||
    row.wallet !== e.wallet ||
    row.walletRevision !== e.walletRevision ||
    !capture ||
    capture.sessionId !== session.id ||
    capture.sessionRevision !== 1 ||
    capture.entry !== entry ||
    capture.unitsRaw !== e.unitsRaw ||
    capture.termsSha256 !== hash ||
    capture.notBefore !== sessionEntryNotBefore(terms, entry) ||
    row.document.inputRaw !== e.unitsRaw ||
    (terms.side === 'Buy'
      ? row.document.outputMint
      : row.document.inputMint) !== terms.mint
  )
    throw new Error('Approval differs from the selected saved session entry.');
}
