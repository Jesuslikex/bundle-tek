import {
  decodeTradeSession,
  sessionEntryNotBefore,
  validatedTradeSessionCapture,
} from './imported-trade-session';
import { decodeTradeSessionEvent } from './imported-trade-session-events';
import { decodeSessionJobEvent } from './session-preparation-job-events';
import {
  decodeSessionEntryOutcomes,
  matchingSessionOutcomeReceipt,
  sessionOutcomeDate,
  type SessionEntryOutcomes,
  type SessionEntryApproval,
  type SessionOutcomeSource,
} from './session-entry-outcomes';
import type { ImportedSwapReceipt } from './imported-approval-history';

const parse = (value: unknown) => {
  if (typeof value !== 'string')
    throw new Error('Retained outcome document unavailable.');
  return JSON.parse(value) as Record<string, unknown>;
};
const sessionSelect =
  'SELECT id,revision,state,document,created_at AS createdAt,updated_at AS updatedAt FROM imported_trade_sessions WHERE owner_id=? AND project_id=? AND id=?';

export async function readSessionEntryOutcomes(
  db: D1Database,
  owner: string,
  projectId: string,
  sessionId: string,
) {
  const tables = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('session_preparation_job_events','imported_trade_session_events','imported_swap_receipts','imported_swap_preparations')",
    )
    .all<{ name: string }>();
  const available = new Set(tables.results.map((table) => table.name));
  const preparationAvailable = available.has('session_preparation_job_events');
  const approvalAvailable = available.has('imported_trade_session_events');
  const receiptAvailable =
    approvalAvailable &&
    available.has('imported_swap_receipts') &&
    available.has('imported_swap_preparations');
  const empty = 'SELECT NULL WHERE 0';
  // One read batch keeps the current retained session and its outcome sources in
  // one database transaction. No roster/balance lookup reconstructs old outcomes.
  const [sessionRows, jobRows, approvalRows, receiptRows] = await db.batch<
    Record<string, unknown>
  >([
    db.prepare(sessionSelect).bind(owner, projectId, sessionId),
    preparationAvailable
      ? db
          .prepare(
            `WITH ranked AS (SELECT id,sequence,project_id AS projectId,session_id AS sessionId,job_id AS jobId,document,created_at AS createdAt,ROW_NUMBER() OVER (PARTITION BY json_extract(document,'$.entry') ORDER BY sequence DESC) AS ranking FROM session_preparation_job_events WHERE owner_id=? AND project_id=? AND session_id=?) SELECT * FROM ranked WHERE ranking=1 LIMIT 26`,
          )
          .bind(owner, projectId, sessionId)
      : db.prepare(empty),
    approvalAvailable
      ? db
          .prepare(
            `WITH ranked AS (SELECT id,sequence,project_id AS projectId,session_id AS sessionId,type,document,approval,control,created_at AS createdAt,ROW_NUMBER() OVER (PARTITION BY json_extract(approval,'$.entry') ORDER BY sequence DESC) AS ranking FROM imported_trade_session_events WHERE owner_id=? AND project_id=? AND session_id=? AND type LIKE 'approval.%') SELECT * FROM ranked WHERE ranking=1 LIMIT 26`,
          )
          .bind(owner, projectId, sessionId)
      : db.prepare(empty),
    receiptAvailable
      ? db
          .prepare(
            `SELECT r.id,r.intent_id AS intentId,r.preparation_id AS preparationId,r.project_id AS projectId,r.project_revision AS projectRevision,r.wallet_revision AS walletRevision,r.signature,r.document,r.created_at AS createdAt,p.document AS preparationDocument,p.wallet_address AS preparationWallet,p.project_revision AS preparationRevision,p.wallet_revision AS preparationWalletRevision,p.created_at AS preparationCreatedAt FROM imported_swap_receipts r LEFT JOIN imported_swap_preparations p ON p.owner_id=r.owner_id AND p.project_id=r.project_id AND p.id=r.preparation_id WHERE r.owner_id=? AND r.project_id=? AND EXISTS(SELECT 1 FROM imported_trade_session_events e WHERE e.owner_id=r.owner_id AND e.project_id=r.project_id AND e.session_id=? AND json_extract(e.approval,'$.id')=r.intent_id) LIMIT 201`,
          )
          .bind(owner, projectId, sessionId)
      : db.prepare(empty),
  ]);
  const row = sessionRows.results?.[0];
  if (!row) return null;
  const session = decodeTradeSession({
    id: row.id,
    revision: row.revision,
    state: row.state,
    terms: parse(row.document),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  const sampledAt = new Date().toISOString();
  if (
    session.id !== sessionId ||
    session.terms.projectId !== projectId ||
    !sessionOutcomeDate(session.createdAt) ||
    !sessionOutcomeDate(session.updatedAt) ||
    Date.parse(session.updatedAt) > Date.parse(sampledAt)
  )
    throw new Error('Retained session outcome context differs.');
  if (
    jobRows.results.length > 25 ||
    approvalRows.results.length > 25 ||
    receiptRows.results.length > 200
  )
    throw new Error('Retained session outcome capacity exceeded.');
  const missingSources: SessionOutcomeSource[] = [];
  if (!preparationAvailable) missingSources.push('preparation');
  if (!approvalAvailable) missingSources.push('approval');
  if (!receiptAvailable) missingSources.push('receipts');
  const page: SessionEntryOutcomes = {
    projectId,
    session,
    sampledAt,
    executionAllowed: false,
    missingSources,
    entries: session.terms.entries.map((entry) => ({
      ...entry,
      preparation: null,
      approval: null,
      receipt: null,
      receiptEvidence: 'not-applicable',
    })),
  };
  const termsSha256 = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(row.document as string),
      ),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
  for (const raw of jobRows.results) {
    const event = decodeSessionJobEvent({
      ...raw,
      document: parse(raw.document),
    });
    const entry = page.entries.find(
      (entry) => entry.entry === event.document.entry,
    );
    if (
      !entry ||
      event.projectId !== projectId ||
      event.sessionId !== sessionId ||
      entry.preparation
    )
      throw new Error('Retained job outcome context differs.');
    // Project only the established event contract; SQL ranking/leases/payloads
    // are not part of the browser's outcome response.
    entry.preparation = {
      id: event.id,
      sequence: event.sequence,
      projectId,
      sessionId,
      jobId: event.jobId,
      document: event.document,
      createdAt: event.createdAt,
    };
  }
  for (const raw of approvalRows.results) {
    const event = decodeTradeSessionEvent({
      ...raw,
      document: parse(raw.document),
      approval: raw.approval === null ? null : parse(raw.approval),
      control: raw.control === null ? null : parse(raw.control),
    });
    const approval = event.approval;
    const entry = page.entries.find((entry) => entry.entry === approval?.entry);
    if (
      !approval ||
      !entry ||
      entry.approval ||
      event.projectId !== projectId ||
      event.sessionId !== sessionId ||
      event.document.createdAt !== session.createdAt ||
      JSON.stringify(event.document.terms) !== JSON.stringify(session.terms) ||
      !sessionOutcomeDate(event.createdAt) ||
      Date.parse(event.createdAt) > Date.parse(sampledAt)
    )
      throw new Error('Retained approval outcome context differs.');
    entry.approval = {
      intentId: approval.id,
      preparationId: approval.preparationId,
      state: approval.state as SessionEntryApproval['state'],
      signature: approval.signature,
      receiptId: approval.receiptId,
      sha256: approval.sha256,
      observedAt: event.createdAt,
    };
    if (approval.state !== 'finalized') continue;
    entry.receiptEvidence = 'unavailable';
    const rawReceipt = receiptRows.results.find(
      (receipt) => receipt.intentId === approval.id,
    );
    if (!rawReceipt || rawReceipt.preparationDocument === null) continue;
    try {
      if (rawReceipt.signature !== approval.signature) throw new Error();
      const doc = parse(rawReceipt.document);
      const prep = parse(rawReceipt.preparationDocument);
      const capture = validatedTradeSessionCapture(
        prep.session,
        entry.unitsRaw,
      );
      const wrapped = 'So11111111111111111111111111111111111111112';
      const minimum = prep.minimumOutRaw;
      const settlement = doc.nativeSettlementRaw;
      if (
        rawReceipt.preparationWallet !== entry.wallet ||
        rawReceipt.preparationRevision !== session.terms.projectRevision ||
        rawReceipt.preparationWalletRevision !== entry.walletRevision ||
        !sessionOutcomeDate(rawReceipt.preparationCreatedAt) ||
        Date.parse(rawReceipt.preparationCreatedAt) <
          Date.parse(session.createdAt) ||
        Date.parse(rawReceipt.preparationCreatedAt) >
          Date.parse(doc.observedAt as string) ||
        prep.wallet !== entry.wallet ||
        prep.chain !== 'Solana' ||
        prep.executionAllowed !== false ||
        prep.side !== session.terms.side ||
        prep.inAmountRaw !== entry.unitsRaw ||
        (prep.transaction as { sha256?: string })?.sha256 !== approval.sha256 ||
        prep.inputMint !==
          (session.terms.side === 'Buy' ? wrapped : session.terms.mint) ||
        prep.outputMint !==
          (session.terms.side === 'Buy' ? session.terms.mint : wrapped) ||
        capture.sessionId !== session.id ||
        capture.sessionRevision !== 1 ||
        capture.entry !== entry.entry ||
        capture.termsSha256 !== termsSha256 ||
        capture.notBefore !==
          sessionEntryNotBefore(session.terms, entry.entry) ||
        typeof minimum !== 'string' ||
        !/^(0|[1-9]\d{0,19})$/.test(minimum) ||
        BigInt(minimum) > (1n << 64n) - 1n ||
        doc.tokenProgram !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' ||
        typeof settlement !== 'string' ||
        !/^-?(0|[1-9]\d{0,19})$/.test(settlement) ||
        BigInt(settlement).toString() !== settlement ||
        (session.terms.side === 'Buy'
          ? settlement !== (-BigInt(entry.unitsRaw)).toString() ||
            BigInt(doc.tokenUnitsRaw as string) < BigInt(minimum)
          : BigInt(settlement) < BigInt(minimum))
      )
        throw new Error('Retained receipt preparation or settlement differs.');
      // Never return packets, extra metadata or unvalidated source fields.
      const safe: ImportedSwapReceipt = {
        id: rawReceipt.id as string,
        projectId: rawReceipt.projectId as string,
        preparationId: rawReceipt.preparationId as string,
        projectRevision: rawReceipt.projectRevision as number,
        walletRevision: rawReceipt.walletRevision as number,
        createdAt: rawReceipt.createdAt as string,
        document: {
          network: doc.network as string,
          mint: doc.mint as string,
          decimals: doc.decimals as number,
          preparationSha256: doc.preparationSha256 as string,
          signature: doc.signature as string,
          wallet: doc.wallet as string,
          signatureVerified: doc.signatureVerified as boolean,
          commitment: doc.commitment as string,
          side: doc.side as 'Buy' | 'Sell',
          tokenUnitsRaw: doc.tokenUnitsRaw as string,
          source: doc.source as string,
          observedAt: doc.observedAt as string,
        },
      };
      entry.receipt = matchingSessionOutcomeReceipt(
        safe,
        session,
        entry,
        sampledAt,
      );
      entry.receiptEvidence = 'matching';
    } catch {
      entry.receiptEvidence = 'contradictory';
    }
  }
  return decodeSessionEntryOutcomes(page, session);
}
