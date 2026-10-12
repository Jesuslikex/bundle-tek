import { validatedSwapFailure, type SwapFailureReceipt } from './swap-failure';
import bs58 from 'bs58';
export type WarmupSigningEvent = {
  id: string;
  sequence: number;
  intentId: string;
  preparationId: string;
  planId: string;
  planRevision: number;
  cycle: number;
  wallet: string;
  type:
    | 'approval.baseline'
    | 'approval.reviewed'
    | 'approval.signed'
    | 'approval.submission_started'
    | 'approval.finalized'
    | 'approval.failed'
    | 'approval.cancelled';
  state:
    | 'awaiting_signature'
    | 'signed'
    | 'submitted'
    | 'finalized'
    | 'failed'
    | 'cancelled';
  signature: string | null;
  failureReceipt?: SwapFailureReceipt | null;
  createdAt: string;
  document: {
    side: 'Buy' | 'Sell';
    sha256: string;
    inputMint: string;
    outputMint: string;
    inputRaw: string;
    minimumOutputRaw: string;
  };
};
export function warmupSigningEventLabel(type: WarmupSigningEvent['type']) {
  return {
    'approval.baseline': 'Retained approval state',
    'approval.reviewed': 'Approval reserved; awaiting signature',
    'approval.signed': 'Signature registered; not submitted',
    'approval.submission_started':
      'Submission attempt reserved; check finalized outcome',
    'approval.finalized': 'Matching finalized receipt recorded',
    'approval.failed': 'Finalized transaction failure verified',
    'approval.cancelled': 'Unsigned approval cancelled',
  }[type];
}
export function isWarmupSigningEvent(row: WarmupSigningEvent) {
  const idPattern =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const expected = {
    'approval.reviewed': 'awaiting_signature',
    'approval.signed': 'signed',
    'approval.submission_started': 'submitted',
    'approval.finalized': 'finalized',
    'approval.failed': 'failed',
    'approval.cancelled': 'cancelled',
  };
  try {
    if (row.failureReceipt !== undefined && row.failureReceipt !== null) {
      if (row.state !== 'failed' || !row.signature) return false;
      validatedSwapFailure(
        row.failureReceipt,
        { wallet: row.wallet, ...row.document },
        row.signature,
      );
    }
    if (
      bs58.decode(row.wallet).length !== 32 ||
      (row.signature !== null && bs58.decode(row.signature).length !== 64)
    )
      return false;
  } catch {
    return false;
  }
  return (
    !!row &&
    /^[a-f0-9]{32}$/.test(row.id) &&
    Number.isSafeInteger(row.sequence) &&
    row.sequence > 0 &&
    idPattern.test(row.intentId) &&
    idPattern.test(row.preparationId) &&
    /^[a-zA-Z0-9-]{1,64}$/.test(row.planId) &&
    Number.isSafeInteger(row.planRevision) &&
    row.planRevision > 0 &&
    Number.isSafeInteger(row.cycle) &&
    row.cycle > 0 &&
    typeof row.wallet === 'string' &&
    Object.hasOwn(
      {
        'approval.baseline': 1,
        'approval.reviewed': 1,
        'approval.signed': 1,
        'approval.submission_started': 1,
        'approval.finalized': 1,
        'approval.failed': 1,
        'approval.cancelled': 1,
      },
      row.type,
    ) &&
    [
      'awaiting_signature',
      'signed',
      'submitted',
      'finalized',
      'failed',
      'cancelled',
    ].includes(row.state) &&
    (row.type === 'approval.baseline' ||
      expected[row.type as keyof typeof expected] === row.state) &&
    (['awaiting_signature', 'cancelled'].includes(row.state)
      ? row.signature === null
      : row.signature !== null) &&
    ['Buy', 'Sell'].includes(row.document?.side) &&
    /^[a-f0-9]{64}$/.test(row.document?.sha256) &&
    [row.document?.inputMint, row.document?.outputMint].every(
      (value) => typeof value === 'string' && value.length > 0,
    ) &&
    [row.document?.inputRaw, row.document?.minimumOutputRaw].every(
      (value) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value),
    ) &&
    Number.isFinite(Date.parse(row.createdAt))
  );
}
