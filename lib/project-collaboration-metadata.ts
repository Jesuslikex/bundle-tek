import { projectIdValid } from './workspace-project';

export type MetadataText = {
  tokenName: string;
  ticker: string;
  description: string;
};

export type MetadataEditSource = {
  format: 'shared-project-metadata-source-v1';
  shareId: string;
  projectId: string;
  projectUpdatedAt: string;
  expiresAt: string | null;
  values: MetadataText;
  editingAllowed: true;
  walletActionsAllowed: false;
  signingAllowed: false;
  publishingAllowed: false;
};

export type MetadataEditRequest = {
  mutationId: string;
  shareId: string;
  projectId: string;
  expectedUpdatedAt: string;
  values: MetadataText;
  reviewHash: string;
  approved: true;
};

export type MetadataEditReceipt = {
  format: 'shared-project-metadata-edit-receipt-v1';
  mutationId: string;
  shareId: string;
  projectId: string;
  beforeUpdatedAt: string;
  updatedAt: string;
  createdAt: string;
  reviewHash: string;
  before: MetadataText;
  after: MetadataText;
  metadataSaved: true;
  walletActionsAllowed: false;
  signingAllowed: false;
  publishingAllowed: false;
};

const UUID =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
const HASH = /^[0-9a-f]{64}$/;
const invalid = () => Error('Saved project metadata is invalid.');

function record(value: unknown, keys: readonly string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== keys.length
  )
    throw invalid();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      !keys.includes(key) ||
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    )
      throw invalid();
  }
  return value as Record<string, unknown>;
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid();
  return value;
}
function projectId(value: unknown): string {
  if (!projectIdValid(value)) throw invalid();
  return value;
}
function timestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length !== 24 ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw invalid();
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) throw invalid();
  return value;
}
function noWalletAuthority(row: Record<string, unknown>) {
  if (
    row.walletActionsAllowed !== false ||
    row.signingAllowed !== false ||
    row.publishingAllowed !== false
  )
    throw invalid();
}

function exactUnicodeText(value: string) {
  if (value.includes('\0')) throw invalid();
  for (const character of value) {
    const unit = character.charCodeAt(0);
    if (character.length === 1 && unit >= 0xd800 && unit <= 0xdfff)
      throw invalid();
  }
}

/** Canonicalize a draft before displaying the exact values for approval.
 * Limits match validateLaunchPlan; venue-specific validation stays server-side. */
export function normalizeMetadataText(value: unknown): MetadataText {
  const row = record(value, ['tokenName', 'ticker', 'description']);
  if (
    typeof row.tokenName !== 'string' ||
    typeof row.ticker !== 'string' ||
    typeof row.description !== 'string'
  )
    throw invalid();
  // UTF-8 hashing must preserve the reviewed string exactly; SQLite text length
  // must also agree with the browser rather than stopping at an embedded NUL.
  exactUnicodeText(row.tokenName);
  exactUnicodeText(row.ticker);
  exactUnicodeText(row.description);
  const tokenName = row.tokenName.trim();
  const ticker = row.ticker.trim().toUpperCase();
  const description = row.description.trim();
  if (tokenName.length < 2 || tokenName.length > 64)
    throw Error('Name must be 2 to 64 characters.');
  if (!/^[A-Z0-9]{1,16}$/.test(ticker))
    throw Error('Symbol must be 1 to 16 letters or numbers.');
  if (description.length > 280)
    throw Error('Description must be at most 280 characters.');
  return { tokenName, ticker, description };
}

/** Saved, reviewed and transported values must already be canonical. */
export function readMetadataText(value: unknown): MetadataText {
  const normalized = normalizeMetadataText(value);
  const row = value as Record<string, unknown>;
  if (
    row.tokenName !== normalized.tokenName ||
    row.ticker !== normalized.ticker ||
    row.description !== normalized.description
  )
    throw Error('Review the canonical saved text before saving.');
  return normalized;
}

/** Content admission only. The caller must also bind requested IDs and actor. */
export function readMetadataEditSource(value: unknown): MetadataEditSource {
  const row = record(value, [
    'format',
    'shareId',
    'projectId',
    'projectUpdatedAt',
    'expiresAt',
    'values',
    'editingAllowed',
    'walletActionsAllowed',
    'signingAllowed',
    'publishingAllowed',
  ]);
  if (
    row.format !== 'shared-project-metadata-source-v1' ||
    row.editingAllowed !== true
  )
    throw invalid();
  noWalletAuthority(row);
  return {
    format: 'shared-project-metadata-source-v1',
    shareId: uuid(row.shareId),
    projectId: projectId(row.projectId),
    projectUpdatedAt: timestamp(row.projectUpdatedAt),
    expiresAt: row.expiresAt === null ? null : timestamp(row.expiresAt),
    values: readMetadataText(row.values),
    editingAllowed: true,
    walletActionsAllowed: false,
    signingAllowed: false,
    publishingAllowed: false,
  };
}

export function readMetadataEditRequest(value: unknown): MetadataEditRequest {
  const row = record(value, [
    'mutationId',
    'shareId',
    'projectId',
    'expectedUpdatedAt',
    'values',
    'reviewHash',
    'approved',
  ]);
  if (row.approved !== true) throw invalid();
  return {
    mutationId: uuid(row.mutationId),
    shareId: uuid(row.shareId),
    projectId: projectId(row.projectId),
    expectedUpdatedAt: timestamp(row.expectedUpdatedAt),
    values: readMetadataText(row.values),
    reviewHash: hash(row.reviewHash),
    approved: true,
  };
}

/** A digest of the exact before/after review, not a permission or signature. */
export async function metadataEditReviewHash(
  source: MetadataEditSource,
  values: MetadataText,
): Promise<string> {
  const admitted = readMetadataEditSource(source);
  const after = readMetadataText(values);
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      'project-metadata-edit-v1',
      admitted.shareId,
      admitted.projectId,
      admitted.projectUpdatedAt,
      admitted.values,
      after,
    ]),
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  )
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Shape and canonical values only; verifyMetadataEditReceipt also checks digest. */
export function readMetadataEditReceipt(value: unknown): MetadataEditReceipt {
  const row = record(value, [
    'format',
    'mutationId',
    'shareId',
    'projectId',
    'beforeUpdatedAt',
    'updatedAt',
    'createdAt',
    'reviewHash',
    'before',
    'after',
    'metadataSaved',
    'walletActionsAllowed',
    'signingAllowed',
    'publishingAllowed',
  ]);
  if (
    row.format !== 'shared-project-metadata-edit-receipt-v1' ||
    row.metadataSaved !== true
  )
    throw invalid();
  noWalletAuthority(row);
  const beforeUpdatedAt = timestamp(row.beforeUpdatedAt);
  const updatedAt = timestamp(row.updatedAt);
  if (Date.parse(updatedAt) <= Date.parse(beforeUpdatedAt)) throw invalid();
  return {
    format: 'shared-project-metadata-edit-receipt-v1',
    mutationId: uuid(row.mutationId),
    shareId: uuid(row.shareId),
    projectId: projectId(row.projectId),
    beforeUpdatedAt,
    updatedAt,
    createdAt: timestamp(row.createdAt),
    reviewHash: hash(row.reviewHash),
    before: readMetadataText(row.before),
    after: readMetadataText(row.after),
    metadataSaved: true,
    walletActionsAllowed: false,
    signingAllowed: false,
    publishingAllowed: false,
  };
}

/** Authenticity/ownership remains the server's job; bind IDs at the call site. */
export async function verifyMetadataEditReceipt(
  value: unknown,
): Promise<MetadataEditReceipt> {
  const receipt = readMetadataEditReceipt(value);
  const expected = await metadataEditReviewHash(
    {
      format: 'shared-project-metadata-source-v1',
      shareId: receipt.shareId,
      projectId: receipt.projectId,
      projectUpdatedAt: receipt.beforeUpdatedAt,
      expiresAt: null,
      values: receipt.before,
      editingAllowed: true,
      walletActionsAllowed: false,
      signingAllowed: false,
      publishingAllowed: false,
    },
    receipt.after,
  );
  if (receipt.reviewHash !== expected)
    throw Error('Saved metadata edit receipt differs from its review.');
  return receipt;
}
