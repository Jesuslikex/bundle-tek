import {
  validatedImportedAcquisitionSelection,
  type ImportedAcquisitionSelection,
} from './imported-acquisition';
import { validatedSwapFailure, type SwapFailureReceipt } from './swap-failure';
import bs58 from 'bs58';
import { UUID } from './wallet-operation';
import type { WarmupSigningEvent } from './warmup-signing-events';
export { warmupSigningEventLabel as importedSigningEventLabel } from './warmup-signing-events';
export type ImportedSigningEvent = Omit<
  WarmupSigningEvent,
  'planId' | 'planRevision' | 'cycle' | 'document'
> & {
  document: WarmupSigningEvent['document'] & {
    acquisition?: ImportedAcquisitionSelection | null;
  };
  projectId: string;
  projectRevision: number;
  walletRevision: number;
  failureReceipt?: SwapFailureReceipt | null;
};
const expected = {
  'approval.reviewed': 'awaiting_signature',
  'approval.signed': 'signed',
  'approval.submission_started': 'submitted',
  'approval.finalized': 'finalized',
  'approval.failed': 'failed',
  'approval.cancelled': 'cancelled',
};
export function isImportedSigningEvent(
  value: unknown,
): value is ImportedSigningEvent {
  const row = value as ImportedSigningEvent;
  if (!row || !row.document) return false;
  try {
    if (row.document.acquisition) {
      if (row.document.side !== 'Sell') return false;
      validatedImportedAcquisitionSelection(row.document.acquisition, {
        projectId: row.projectId,
        wallet: row.wallet,
        mint: row.document.inputMint,
        unitsRaw: row.document.inputRaw,
      });
    }
    if (row.failureReceipt) {
      if (row.state !== 'failed' || !row.signature) return false;
      validatedSwapFailure(
        row.failureReceipt,
        { wallet: row.wallet, ...row.document },
        row.signature,
      );
    }
    for (const key of [
      row.wallet,
      row.document.inputMint,
      row.document.outputMint,
    ])
      if (
        typeof key !== 'string' ||
        key.length > 44 ||
        bs58.decode(key).length !== 32
      )
        return false;
    if (
      row.signature !== null &&
      (typeof row.signature !== 'string' ||
        row.signature.length > 90 ||
        bs58.decode(row.signature).length !== 64)
    )
      return false;
  } catch {
    return false;
  }
  return (
    /^[a-f0-9]{32}$/.test(row.id) &&
    Number.isSafeInteger(row.sequence) &&
    row.sequence > 0 &&
    UUID.test(row.intentId) &&
    UUID.test(row.preparationId) &&
    UUID.test(row.projectId) &&
    Number.isSafeInteger(row.projectRevision) &&
    row.projectRevision > 0 &&
    Number.isSafeInteger(row.walletRevision) &&
    row.walletRevision > 0 &&
    [
      'awaiting_signature',
      'signed',
      'submitted',
      'finalized',
      'failed',
      'cancelled',
    ].includes(row.state) &&
    (row.type === 'approval.baseline' ||
      (Object.hasOwn(expected, row.type) &&
        expected[row.type as keyof typeof expected] === row.state)) &&
    (['awaiting_signature', 'cancelled'].includes(row.state)
      ? row.signature === null
      : row.signature !== null) &&
    ['Buy', 'Sell'].includes(row.document.side) &&
    /^[a-f0-9]{64}$/.test(row.document.sha256) &&
    [row.document.inputRaw, row.document.minimumOutputRaw].every(
      (raw) =>
        typeof raw === 'string' &&
        /^[1-9]\d{0,19}$/.test(raw) &&
        BigInt(raw) <= (1n << 64n) - 1n,
    ) &&
    Number.isFinite(Date.parse(row.createdAt))
  );
}
