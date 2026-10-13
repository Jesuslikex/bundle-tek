import {
  decodeTradeSession,
  type TradeSession,
} from './imported-trade-session';
import {
  decodeSessionJobEvent,
  type SessionJobEvent,
} from './session-preparation-job-events';
import { UUID } from './wallet-operation';
import { walletAddress } from './wallet-workspace';
import { transactionSignature } from './transaction-signature';
import type { ImportedSwapReceipt } from './imported-approval-history';

export const sessionOutcomeSources = [
  'preparation',
  'approval',
  'receipts',
] as const;
export type SessionOutcomeSource = (typeof sessionOutcomeSources)[number];
export type SessionEntryApproval = {
  intentId: string;
  preparationId: string;
  state:
    | 'awaiting_signature'
    | 'signed'
    | 'submitted'
    | 'finalized'
    | 'failed'
    | 'cancelled';
  signature: string | null;
  receiptId: string | null;
  sha256: string;
  observedAt: string;
};
export type SessionEntryOutcome = TradeSession['terms']['entries'][number] & {
  preparation: SessionJobEvent | null;
  approval: SessionEntryApproval | null;
  receipt: ImportedSwapReceipt | null;
  receiptEvidence:
    | 'not-applicable'
    | 'unavailable'
    | 'contradictory'
    | 'matching';
};
export type SessionEntryOutcomes = {
  projectId: string;
  sourceEventId?: string;
  session: TradeSession;
  sampledAt: string;
  executionAllowed: false;
  missingSources: SessionOutcomeSource[];
  entries: SessionEntryOutcome[];
};
export function sessionOutcomeDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
export function matchingSessionOutcomeReceipt(
  value: unknown,
  session: TradeSession,
  entry: SessionEntryOutcome,
  sampledAt: string,
): ImportedSwapReceipt {
  const receipt = value as ImportedSwapReceipt;
  const a = entry.approval;
  const d = receipt?.document;
  if (
    !a ||
    a.state !== 'finalized' ||
    !a.signature ||
    !receipt ||
    !UUID.test(receipt.id) ||
    receipt.id !== a.receiptId ||
    receipt.projectId !== session.terms.projectId ||
    receipt.preparationId !== a.preparationId ||
    receipt.projectRevision !== session.terms.projectRevision ||
    receipt.walletRevision !== entry.walletRevision ||
    !sessionOutcomeDate(receipt.createdAt) ||
    !sessionOutcomeDate(d?.observedAt) ||
    Date.parse(d.observedAt) < Date.parse(session.createdAt) ||
    Date.parse(d.observedAt) > Date.parse(receipt.createdAt) ||
    Date.parse(receipt.createdAt) > Date.parse(a.observedAt) ||
    Date.parse(a.observedAt) > Date.parse(sampledAt) ||
    d.wallet !== entry.wallet ||
    d.mint !== session.terms.mint ||
    d.side !== session.terms.side ||
    d.decimals !== session.terms.decimals ||
    d.preparationSha256 !== a.sha256 ||
    d.signature !== a.signature ||
    d.network !== 'mainnet' ||
    d.commitment !== 'finalized' ||
    d.signatureVerified !== true ||
    typeof d.tokenUnitsRaw !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(d.tokenUnitsRaw) ||
    BigInt(d.tokenUnitsRaw) > (1n << 64n) - 1n ||
    (d.side === 'Sell' && d.tokenUnitsRaw !== entry.unitsRaw) ||
    typeof d.source !== 'string' ||
    !/^[A-Za-z0-9.-]{1,253}$/.test(d.source)
  )
    throw new Error('Matching session receipt unavailable.');
  transactionSignature(d.signature);
  return receipt;
}
export function decodeSessionEntryOutcomes(
  value: unknown,
  expected: TradeSession,
  expectedEventId?: string,
): SessionEntryOutcomes {
  const page = value as SessionEntryOutcomes;
  if (
    !page ||
    page.projectId !== expected.terms.projectId ||
    page.executionAllowed !== false ||
    (expectedEventId !== undefined
      ? !/^[a-f0-9]{32}$/.test(expectedEventId) ||
        page.sourceEventId !== expectedEventId
      : page.sourceEventId !== undefined) ||
    !sessionOutcomeDate(page.sampledAt) ||
    !Array.isArray(page.missingSources) ||
    page.missingSources.some(
      (source) => !sessionOutcomeSources.includes(source),
    ) ||
    new Set(page.missingSources).size !== page.missingSources.length ||
    !Array.isArray(page.entries)
  )
    throw new Error('Session outcome coverage unavailable.');
  const session = decodeTradeSession(page.session);
  if (
    session.id !== expected.id ||
    session.createdAt !== expected.createdAt ||
    JSON.stringify(session.terms) !== JSON.stringify(expected.terms) ||
    page.entries.length !== session.terms.entries.length ||
    Date.parse(session.updatedAt) > Date.parse(page.sampledAt)
  )
    throw new Error('Saved session outcome terms differ.');
  for (const [index, row] of page.entries.entries()) {
    const entry = session.terms.entries[index];
    if (
      !row ||
      row.entry !== entry.entry ||
      row.wallet !== entry.wallet ||
      row.walletRevision !== entry.walletRevision ||
      row.unitsRaw !== entry.unitsRaw ||
      row.amount !== entry.amount ||
      !['not-applicable', 'unavailable', 'contradictory', 'matching'].includes(
        row.receiptEvidence,
      )
    )
      throw new Error('Session outcome entry differs.');
    if (row.preparation !== null) {
      const p = decodeSessionJobEvent(row.preparation);
      if (
        p.projectId !== page.projectId ||
        p.sessionId !== session.id ||
        p.document.entry !== row.entry ||
        !sessionOutcomeDate(p.createdAt) ||
        Date.parse(p.createdAt) < Date.parse(session.createdAt) ||
        Date.parse(p.createdAt) > Date.parse(page.sampledAt) ||
        page.missingSources.includes('preparation')
      )
        throw new Error('Session preparation outcome differs.');
    }
    if (row.approval !== null) {
      const a = row.approval;
      if (
        !UUID.test(a.intentId) ||
        !UUID.test(a.preparationId) ||
        !/^[a-f0-9]{64}$/.test(a.sha256) ||
        ![
          'awaiting_signature',
          'signed',
          'submitted',
          'finalized',
          'failed',
          'cancelled',
        ].includes(a.state) ||
        !sessionOutcomeDate(a.observedAt) ||
        Date.parse(a.observedAt) < Date.parse(session.createdAt) ||
        Date.parse(a.observedAt) > Date.parse(page.sampledAt) ||
        page.missingSources.includes('approval') ||
        (a.state === 'finalized'
          ? !a.receiptId || !UUID.test(a.receiptId)
          : a.receiptId !== null) ||
        (['awaiting_signature', 'cancelled'].includes(a.state)
          ? a.signature !== null
          : a.signature === null)
      )
        throw new Error('Session approval outcome differs.');
      if (a.signature !== null) transactionSignature(a.signature);
    }
    if (row.receiptEvidence === 'matching') {
      if (page.missingSources.includes('receipts'))
        throw new Error('Receipt coverage differs.');
      matchingSessionOutcomeReceipt(row.receipt, session, row, page.sampledAt);
    } else if (
      row.receipt !== null ||
      (row.approval?.state === 'finalized'
        ? row.receiptEvidence === 'not-applicable'
        : row.receiptEvidence !== 'not-applicable')
    )
      throw new Error('Session receipt state differs.');
    walletAddress(row.wallet, 'Solana');
  }
  return { ...page, session };
}
