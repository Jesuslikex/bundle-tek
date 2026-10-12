import { UUID } from './wallet-operation';
import bs58 from 'bs58';
import { walletAddress } from './wallet-workspace';
export type ImportedAcquisition = {
  projectId: string;
  buyReceiptId: string;
  buySignature: string;
  buyPreparationSha256: string;
  buyDocumentSha256: string;
  wallet: string;
  mint: string;
  decimals: number;
  acquiredRaw: string;
  assignedBeforeRaw: string;
  unitsRaw: string;
  buyCostLamports: string;
  allocatedCostLamports: string;
  linkRevision: number;
};
const integer = (v: unknown, max = (1n << 64n) - 1n) => {
  if (
    typeof v !== 'string' ||
    !/^(0|[1-9]\d{0,20})$/.test(v) ||
    BigInt(v) > max
  )
    throw new Error('Acquisition amount differs.');
  return BigInt(v);
};
export function validatedImportedAcquisition(
  value: unknown,
  context: {
    projectId?: string;
    wallet: string;
    mint: string;
    unitsRaw: string;
  },
): ImportedAcquisition {
  const a = value as ImportedAcquisition;
  if (
    !a ||
    !UUID.test(a.projectId) ||
    !UUID.test(a.buyReceiptId) ||
    (context.projectId !== undefined && a.projectId !== context.projectId) ||
    a.wallet !== context.wallet ||
    a.mint !== context.mint ||
    a.unitsRaw !== context.unitsRaw ||
    ![a.buyDocumentSha256, a.buyPreparationSha256].every(
      (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s),
    ) ||
    !Number.isSafeInteger(a.linkRevision) ||
    a.linkRevision < 0 ||
    a.linkRevision >= 1e9 ||
    !Number.isInteger(a.decimals) ||
    a.decimals < 0 ||
    a.decimals > 255
  )
    throw new Error('Acquisition context differs.');
  walletAddress(a.wallet, 'Solana');
  walletAddress(a.mint, 'Solana');
  if (
    typeof a.buySignature !== 'string' ||
    a.buySignature.length > 88 ||
    bs58.decode(a.buySignature).length !== 64
  )
    throw new Error('Acquisition signature differs.');
  const acquired = integer(a.acquiredRaw),
    before = integer(a.assignedBeforeRaw),
    units = integer(a.unitsRaw),
    cost = integer(a.buyCostLamports, 2n * ((1n << 64n) - 1n)),
    allocated = integer(a.allocatedCostLamports, 2n * ((1n << 64n) - 1n));
  if (
    acquired === 0n ||
    units === 0n ||
    before + units > acquired ||
    cost === 0n ||
    allocated !==
      (cost * (before + units)) / acquired - (cost * before) / acquired
  )
    throw new Error('Acquisition allocation differs.');
  return a;
}

export const IMPORTED_ACQUISITION_MAX_SOURCES = 8;
export type ImportedAcquisitionBasket = {
  kind: 'basket';
  version: 1;
  projectId: string;
  wallet: string;
  mint: string;
  decimals: number;
  unitsRaw: string;
  linkRevision: number;
  allocations: ImportedAcquisition[];
};
export type ImportedAcquisitionSelection =
  | ImportedAcquisition
  | ImportedAcquisitionBasket;
export type ImportedAcquisitionAllocation = {
  buyReceiptId: string;
  unitsRaw: string;
};
type AcquisitionContext = {
  projectId?: string;
  wallet: string;
  mint: string;
  unitsRaw: string;
};

// Request allocations are canonicalized once, before taking the ledger snapshot.
export function importedAcquisitionAllocations(
  value: unknown,
  unitsRaw: string,
): ImportedAcquisitionAllocation[] {
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    value.length > IMPORTED_ACQUISITION_MAX_SOURCES
  )
    throw new Error('Choose two to eight distinct acquisition sources.');
  const total = integer(unitsRaw),
    ids = new Set<string>();
  let sum = 0n;
  const parts = value.map((part: unknown) => {
    if (!part || typeof part !== 'object' || Array.isArray(part))
      throw new Error('Invalid acquisition allocation.');
    const p = part as ImportedAcquisitionAllocation;
    if (
      typeof p.buyReceiptId !== 'string' ||
      !UUID.test(p.buyReceiptId) ||
      ids.has(p.buyReceiptId)
    )
      throw new Error('Choose distinct retained buy receipts.');
    const units = integer(p.unitsRaw);
    if (units === 0n)
      throw new Error('Each acquisition allocation must be positive.');
    ids.add(p.buyReceiptId);
    sum += units;
    return { buyReceiptId: p.buyReceiptId, unitsRaw: p.unitsRaw };
  });
  if (total === 0n || sum !== total)
    throw new Error('Acquisition allocations must equal the exact sell input.');
  return parts.sort((a, b) => (a.buyReceiptId < b.buyReceiptId ? -1 : 1));
}
export function importedAcquisitionEntries(
  a: ImportedAcquisitionSelection,
): ImportedAcquisition[] {
  return 'kind' in a ? a.allocations : [a];
}
export function validatedImportedAcquisitionSelection(
  value: unknown,
  context: AcquisitionContext,
): ImportedAcquisitionSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Acquisition context differs.');
  if (!('kind' in value)) return validatedImportedAcquisition(value, context);
  const a = value as ImportedAcquisitionBasket;
  if (
    a.kind !== 'basket' ||
    a.version !== 1 ||
    !UUID.test(a.projectId) ||
    (context.projectId !== undefined && a.projectId !== context.projectId) ||
    a.wallet !== context.wallet ||
    a.mint !== context.mint ||
    a.unitsRaw !== context.unitsRaw ||
    !Number.isInteger(a.decimals) ||
    a.decimals < 0 ||
    a.decimals > 255 ||
    !Number.isSafeInteger(a.linkRevision) ||
    a.linkRevision < 0 ||
    a.linkRevision >= 1e9
  )
    throw new Error('Acquisition basket context differs.');
  const parts = importedAcquisitionAllocations(a.allocations, a.unitsRaw);
  for (const [index, part] of a.allocations.entries()) {
    validatedImportedAcquisition(part, {
      projectId: a.projectId,
      wallet: a.wallet,
      mint: a.mint,
      unitsRaw: parts[index].unitsRaw,
    });
    if (
      part.decimals !== a.decimals ||
      part.linkRevision !== a.linkRevision ||
      part.buyReceiptId !== parts[index].buyReceiptId
    )
      throw new Error('Unique ordered acquisition sources required.');
  }
  return a;
}
export function importedAcquisitionCost(a: ImportedAcquisitionSelection) {
  return importedAcquisitionEntries(a)
    .reduce((sum, p) => sum + BigInt(p.allocatedCostLamports), 0n)
    .toString();
}
export function importedAcquisitionDetail(a: ImportedAcquisitionSelection) {
  return importedAcquisitionEntries(a)
    .map(
      (p) =>
        'buy receipt ' +
        p.buyReceiptId +
        ' · assigned input ' +
        p.unitsRaw +
        ' · allocated buy cost ' +
        p.allocatedCostLamports +
        ' lamports',
    )
    .join('; ');
}
