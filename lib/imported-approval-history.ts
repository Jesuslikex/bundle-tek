import { validatedTradeSessionCapture } from './imported-trade-session';
import { validatedConditionalSigning } from './conditional-signing';
import { validatedImportedAcquisitionSelection } from './imported-acquisition';
import { validatedSwapFailure } from './swap-failure';
import type { ImportedSwapApproval } from './imported-swap-approval';
import type { ImportedTokenProject } from './imported-token-project';
import { UUID } from './wallet-operation';
export type ImportedApprovalRow = ImportedSwapApproval & {
  projectId: string;
  projectRevision: number;
  walletRevision: number;
  side: 'Buy' | 'Sell';
};
const states = [
  'awaiting_signature',
  'signed',
  'submitted',
  'cancelled',
  'failed',
  'finalized',
];
export function importedApprovalPage(value: unknown, projectId: string) {
  const page = value as {
    projectId: string;
    intents: ImportedApprovalRow[];
    nextCursor: string | null;
  };
  if (
    !page ||
    page.projectId !== projectId ||
    !Array.isArray(page.intents) ||
    page.intents.length > 50 ||
    (page.nextCursor !== null &&
      (typeof page.nextCursor !== 'string' || !UUID.test(page.nextCursor))) ||
    new Set(page.intents.map((row) => row?.id)).size !== page.intents.length ||
    page.intents.some(
      (row) =>
        !row ||
        !UUID.test(row.id) ||
        !UUID.test(row.preparationId) ||
        row.projectId !== projectId ||
        !Number.isSafeInteger(row.projectRevision) ||
        row.projectRevision < 1 ||
        !Number.isSafeInteger(row.walletRevision) ||
        row.walletRevision < 1 ||
        !['Buy', 'Sell'].includes(row.side) ||
        !states.includes(row.state) ||
        !Number.isFinite(Date.parse(row.createdAt)) ||
        row.document?.id !== row.id ||
        row.document?.preparationId !== row.preparationId ||
        row.document?.wallet !== row.wallet ||
        row.document?.network !== 'mainnet' ||
        !Number.isFinite(Date.parse(row.document.expiresAt)) ||
        !/^[a-f0-9]{64}$/.test(row.document.sha256) ||
        (row.signature !== null &&
          (typeof row.signature !== 'string' ||
            !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(row.signature))) ||
        (['signed', 'submitted', 'failed', 'finalized'].includes(row.state) &&
          !row.signature) ||
        (['awaiting_signature', 'cancelled'].includes(row.state) &&
          row.signature !== null),
    )
  )
    throw new Error('Approval history context differs.');
  for (const row of page.intents) {
    if (row.document.session)
      validatedTradeSessionCapture(row.document.session, row.document.inputRaw);
    if (row.document.conditional) {
      if (row.side !== 'Sell')
        throw new Error('Conditional approval requires a sell.');
      validatedConditionalSigning(
        row.document.conditional,
        row.document.inputRaw,
      );
    }
    if (row.document.acquisition) {
      if (row.side !== 'Sell') throw new Error('Acquisition requires a sell.');
      validatedImportedAcquisitionSelection(row.document.acquisition, {
        projectId,
        wallet: row.wallet,
        mint: row.document.inputMint,
        unitsRaw: row.document.inputRaw,
      });
    }
    if (row.failureReceipt) {
      if (row.state !== 'failed' || !row.signature)
        throw new Error('Failure context differs.');
      validatedSwapFailure(row.failureReceipt, row.document, row.signature);
    }
  }
  return page;
}
export function canSubmitImportedApproval(
  row: ImportedApprovalRow,
  project: Pick<ImportedTokenProject, 'id' | 'revision' | 'archived'>,
  now: number,
  uncertain = false,
) {
  return (
    row.projectId === project.id &&
    row.projectRevision === project.revision &&
    !project.archived &&
    !uncertain &&
    row.state === 'signed' &&
    !!row.signature &&
    Date.parse(row.document.expiresAt) > now
  );
}
export type ImportedSwapReceipt = {
  id: string;
  projectId: string;
  preparationId: string;
  projectRevision: number;
  walletRevision: number;
  createdAt: string;
  document: {
    network: string;
    mint: string;
    decimals: number;
    preparationSha256: string;
    signature: string;
    wallet: string;
    signatureVerified: boolean;
    commitment: string;
    side: 'Buy' | 'Sell';
    tokenUnitsRaw: string;
    source: string;
    observedAt: string;
  };
};
export function matchingImportedReceipt(
  value: unknown,
  row: Pick<
    ImportedApprovalRow,
    | 'projectId'
    | 'preparationId'
    | 'projectRevision'
    | 'walletRevision'
    | 'wallet'
    | 'signature'
    | 'side'
    | 'document'
  >,
) {
  const receipt = value as ImportedSwapReceipt;
  if (
    !receipt ||
    !UUID.test(receipt.id) ||
    receipt.projectId !== row.projectId ||
    receipt.preparationId !== row.preparationId ||
    receipt.projectRevision !== row.projectRevision ||
    receipt.walletRevision !== row.walletRevision ||
    receipt.document?.signature !== row.signature ||
    receipt.document?.wallet !== row.wallet ||
    receipt.document?.side !== row.side ||
    receipt.document?.network !== 'mainnet' ||
    receipt.document?.mint !==
      (row.side === 'Buy' ? row.document.outputMint : row.document.inputMint) ||
    receipt.document?.preparationSha256 !== row.document.sha256 ||
    !Number.isInteger(receipt.document?.decimals) ||
    receipt.document.decimals < 0 ||
    receipt.document.decimals > 255 ||
    receipt.document?.signatureVerified !== true ||
    receipt.document?.commitment !== 'finalized' ||
    !/^[1-9]\d{0,19}$/.test(receipt.document.tokenUnitsRaw) ||
    BigInt(receipt.document.tokenUnitsRaw) > (1n << 64n) - 1n
  )
    throw new Error('Finalized matching receipt unavailable.');
  return receipt;
}
