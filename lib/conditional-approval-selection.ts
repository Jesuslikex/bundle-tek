import {
  conditionalOrderSide,
  CONDITIONAL_BUY_INPUT_MINT,
  type ConditionalOrder,
} from './conditional-order';
import { requireConditionalSwapContext } from './conditional-signing';
import type { ImportedApprovalRow } from './imported-approval-history';
export type ConditionalApprovalSelection = {
  intentId: string;
  order: ConditionalOrder;
  level: number;
};
export async function requireConditionalApproval(
  row: ImportedApprovalRow,
  selection: ConditionalApprovalSelection,
) {
  const { order, level, intentId } = selection;
  const terms = order.terms;
  const saved = terms.levels.find((item) => item.level === level);
  const capture = row.document.conditional;
  if (capture)
    requireConditionalSwapContext(capture, {
      side: row.side,
      inputMint: row.document.inputMint,
      outputMint: row.document.outputMint,
      inputRaw: row.document.inputRaw,
      outputDecimals: terms.decimals,
    });
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(terms)),
  );
  const hash = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  if (
    !saved ||
    row.id !== intentId ||
    row.projectId !== terms.projectId ||
    row.projectRevision !== terms.projectRevision ||
    row.wallet !== terms.wallet ||
    row.walletRevision !== terms.walletRevision ||
    row.side !== conditionalOrderSide(order) ||
    row.document.inputMint !==
      (row.side === 'Buy' ? CONDITIONAL_BUY_INPUT_MINT : terms.mint) ||
    (row.side === 'Buy' && row.document.outputMint !== terms.mint) ||
    row.document.inputRaw !== saved.unitsRaw ||
    !capture ||
    capture.orderId !== order.id ||
    capture.orderRevision !== 1 ||
    capture.level !== level ||
    capture.termsSha256 !== hash ||
    capture.pair !== terms.pair ||
    capture.direction !== terms.direction ||
    capture.targetUsd !== saved.targetUsd ||
    capture.unitsRaw !== saved.unitsRaw
  )
    throw new Error(
      'Approval differs from the selected saved conditional level.',
    );
}
