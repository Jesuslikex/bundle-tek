import {
  decodeTradeSession,
  sessionEntryNotBefore,
  validatedTradeSessionCapture,
  type TradeSessionRequest,
  type TradeSessionCapture,
} from './imported-trade-session';
import type { SavedSwapPreparation } from './imported-swap-preparation-history';
export type TradeSessionGuard = {
  selection: TradeSessionCapture;
  document: string;
  controlRevision: number;
};
export async function captureTradeSession(
  db: D1Database,
  owner: string,
  request: TradeSessionRequest,
  context: {
    projectId: string;
    projectRevision: number;
    wallet: string;
    walletRevision: number;
    side: string;
    unitsRaw: string;
    mint: string;
    decimals: number;
  },
  intentId?: string,
): Promise<TradeSessionGuard> {
  const row = await db
    .prepare(
      "SELECT id,revision,state,document,created_at AS createdAt,updated_at AS updatedAt FROM imported_trade_sessions WHERE owner_id=? AND id=? AND project_id=? AND revision=? AND state='active'",
    )
    .bind(owner, request.sessionId, context.projectId, request.revision)
    .first<{
      id: string;
      revision: number;
      state: 'active';
      document: string;
      createdAt: string;
      updatedAt: string;
    }>();
  const control = await db
    .prepare(
      'SELECT state,revision FROM imported_trade_session_controls WHERE owner_id=? AND session_id=?',
    )
    .bind(owner, request.sessionId)
    .first<{ state: string; revision: number }>();
  if (
    !control ||
    control.state !== 'ready' ||
    !Number.isSafeInteger(control.revision) ||
    control.revision < 1
  )
    throw new Error('Trade session is paused or unavailable.');
  if (!row) throw new Error('Trade session changed or unavailable.');
  const session = decodeTradeSession({
      ...row,
      terms: JSON.parse(row.document),
    }),
    entry = session.terms.entries.find((e) => e.entry === request.entry);
  if (
    !entry ||
    entry.wallet !== context.wallet ||
    entry.walletRevision !== context.walletRevision ||
    entry.unitsRaw !== context.unitsRaw ||
    session.terms.side !== context.side ||
    session.terms.projectRevision !== context.projectRevision ||
    session.terms.mint !== context.mint ||
    session.terms.decimals !== context.decimals
  )
    throw new Error('Trade differs from the saved session entry.');
  const notBefore = sessionEntryNotBefore(session.terms, entry.entry);
  if (session.terms.endsAt && Date.now() >= Date.parse(session.terms.endsAt))
    throw new Error('DCA session has reached its saved end time.');
  if (notBefore && Date.parse(notBefore) > Date.now())
    throw new Error('Trade session entry is not due yet.');
  const busy = await db
    .prepare(
      "SELECT i.id FROM imported_swap_signing_intents i JOIN imported_swap_preparations p ON p.owner_id=i.owner_id AND p.id=i.preparation_id WHERE i.owner_id=? AND json_extract(p.document,'$.session.sessionId')=? AND json_extract(p.document,'$.session.entry')=? AND i.state IN ('awaiting_signature','signed','submitted','finalized') AND (? IS NULL OR i.id<>?)",
    )
    .bind(owner, session.id, entry.entry, intentId ?? null, intentId ?? null)
    .first();
  if (busy)
    throw new Error(
      'Trade session entry already approved or filled. Recover its existing approval.',
    );
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(row.document),
  );
  return {
    document: row.document,
    controlRevision: control.revision,
    selection: {
      format: notBefore ? 'trade-session-entry-v2' : 'trade-session-entry-v1',
      ...(notBefore ? { notBefore } : {}),
      sessionId: session.id,
      sessionRevision: session.revision,
      entry: entry.entry,
      unitsRaw: entry.unitsRaw,
      termsSha256: Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join(''),
    },
  };
}
export function tradeSessionWriteGuard(
  owner: string,
  guard?: TradeSessionGuard,
  intentId?: string,
) {
  return guard
    ? {
        sql: " AND EXISTS(SELECT 1 FROM imported_trade_sessions t WHERE t.owner_id=? AND t.id=? AND t.revision=? AND t.state='active' AND t.document=? AND EXISTS(SELECT 1 FROM imported_trade_session_controls c WHERE c.owner_id=t.owner_id AND c.session_id=t.id AND c.state='ready' AND c.revision=?) AND (? IS NULL OR julianday(?)<=julianday('now')) AND (json_type(t.document,'$.endsAt') IS NULL OR julianday('now')<julianday(json_extract(t.document,'$.endsAt')))) AND NOT EXISTS(SELECT 1 FROM imported_swap_signing_intents i JOIN imported_swap_preparations p ON p.owner_id=i.owner_id AND p.id=i.preparation_id WHERE i.owner_id=? AND json_extract(p.document,'$.session.sessionId')=? AND json_extract(p.document,'$.session.entry')=? AND i.state IN ('awaiting_signature','signed','submitted','finalized') AND (? IS NULL OR i.id<>?))",
        bindings: [
          owner,
          guard.selection.sessionId,
          guard.selection.sessionRevision,
          guard.document,
          guard.controlRevision,
          guard.selection.notBefore ?? null,
          guard.selection.notBefore ?? null,
          owner,
          guard.selection.sessionId,
          guard.selection.entry,
          intentId ?? null,
          intentId ?? null,
        ],
      }
    : { sql: '', bindings: [] };
}
export async function currentTradeSession(
  db: D1Database,
  owner: string,
  saved: SavedSwapPreparation,
  intentId?: string,
) {
  const c = saved.document.session;
  if (c === undefined) return undefined;
  validatedTradeSessionCapture(c, saved.document.inAmountRaw);
  const project = await db
    .prepare(
      'SELECT document FROM imported_token_projects WHERE owner_id=? AND id=?',
    )
    .bind(owner, saved.projectId)
    .first<{ document: string }>();
  if (!project) throw new Error('Trade session project unavailable.');
  const guard = await captureTradeSession(
    db,
    owner,
    { sessionId: c.sessionId, revision: c.sessionRevision, entry: c.entry },
    {
      projectId: saved.projectId,
      projectRevision: saved.projectRevision,
      wallet: saved.document.wallet,
      walletRevision: saved.walletRevision,
      side: saved.document.side,
      unitsRaw: saved.document.inAmountRaw,
      mint:
        saved.document.side === 'Buy'
          ? saved.document.outputMint
          : saved.document.inputMint,
      decimals: JSON.parse(project.document).token.decimals,
    },
    intentId,
  );
  if (JSON.stringify(c) !== JSON.stringify(guard.selection))
    throw new Error('Trade session binding changed.');
  return guard;
}
