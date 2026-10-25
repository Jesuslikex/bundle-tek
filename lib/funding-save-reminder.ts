import {
  validateFunding,
  type FundingDocument,
  type SavedFunding,
} from './funding-plan';
import type { FundingMutation } from './funding-plan-storage';

/** A local recovery namespace, never authentication or permission to submit. */
export type FundingSaveReminder = {
  format: 'funding-save-reminder-v1';
  ownerScope: string;
  id: string;
  action: 'save' | 'archive' | 'restore';
  expectedRevision: number;
  documentHash: string;
};

const invalid = () =>
  Error(
    'The original funding save reminder is invalid. Keep it and inspect the original saved draft.',
  );
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9-]{1,64}$/;
const keys = [
  'format',
  'ownerScope',
  'id',
  'action',
  'expectedRevision',
  'documentHash',
] as const;

function record(value: unknown, expected?: readonly string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw invalid();
  const names = Reflect.ownKeys(value);
  if (names.length > 32 || (expected && names.length !== expected.length))
    throw invalid();
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      (expected && !expected.includes(key)) ||
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    )
      throw invalid();
  }
  return value as Record<string, unknown>;
}
function unicode(value: string) {
  for (const character of value) {
    const unit = character.charCodeAt(0);
    if (character.length === 1 && unit >= 0xd800 && unit <= 0xdfff)
      throw invalid();
  }
}
function revision(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < 0 ||
    value > 1_000_000_000
  )
    throw invalid();
  return value;
}
function action(value: unknown): FundingSaveReminder['action'] {
  if (value !== 'save' && value !== 'archive' && value !== 'restore')
    throw invalid();
  return value;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw invalid();
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) throw invalid();
  return value;
}

export function readFundingSaveReminder(value: unknown): FundingSaveReminder {
  const row = record(value, keys);
  if (row.format !== 'funding-save-reminder-v1') throw invalid();
  const reminder: FundingSaveReminder = {
    format: 'funding-save-reminder-v1',
    ownerScope: hash(row.ownerScope),
    id: id(row.id),
    action: action(row.action),
    expectedRevision: revision(row.expectedRevision),
    documentHash: hash(row.documentHash),
  };
  if (reminder.expectedRevision === 0 && reminder.action !== 'save')
    throw invalid();
  if (new TextEncoder().encode(JSON.stringify(reminder)).byteLength > 1024)
    throw invalid();
  return reminder;
}

/** Detach JSON before invoking validators; getters/toJSON/prototypes cannot run. */
function copyJson(
  value: unknown,
  depth = 0,
  budget = { units: 30_000, nodes: 2500 },
): unknown {
  if (depth > 8 || --budget.nodes < 0) throw invalid();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    unicode(value);
    budget.units -= value.length;
    if (budget.units < 0) throw invalid();
    return value;
  }
  if (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    !Object.is(value, -0)
  )
    return value;
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > 100 ||
      Reflect.ownKeys(value).length !== value.length + 1
    )
      throw invalid();
    return Array.from({ length: value.length }, (_, index) => {
      const item = Object.getOwnPropertyDescriptor(value, String(index));
      if (!item?.enumerable || !Object.hasOwn(item, 'value')) throw invalid();
      return copyJson(item.value, depth + 1, budget);
    });
  }
  const row = record(value);
  return Object.fromEntries(
    Object.keys(row)
      .sort()
      .map((key) => [
        key,
        copyJson(
          Object.getOwnPropertyDescriptor(row, key)!.value,
          depth + 1,
          budget,
        ),
      ]),
  );
}
function canonicalDocument(value: unknown): FundingDocument {
  try {
    const detached = copyJson(value);
    const canonical = validateFunding(detached);
    if (JSON.stringify(copyJson(canonical)) !== JSON.stringify(detached))
      throw invalid();
    const text = JSON.stringify(canonical);
    unicode(text);
    if (text.length > 30_000) throw invalid();
    return canonical;
  } catch {
    throw invalid();
  }
}
async function documentHash(document: FundingDocument) {
  const text = JSON.stringify(['funding-save-document-v1', document]);
  unicode(text);
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/** Detach and admit before asynchronous hashing or serializing a POST. */
export function readFundingSaveMutation(mutation: unknown): FundingMutation {
  const row = record(mutation, [
    'action',
    'id',
    'expectedRevision',
    'document',
  ]);
  const captured = {
    action: action(row.action),
    id: id(row.id),
    expectedRevision: revision(row.expectedRevision),
    document: canonicalDocument(row.document),
  };
  if (captured.expectedRevision === 0 && captured.action !== 'save')
    throw invalid();
  if (
    JSON.stringify({
      ...captured,
      document: captured.action === 'save' ? captured.document : undefined,
    }).length > 30_000
  )
    throw invalid();
  return captured;
}

export async function createFundingSaveReminder(
  ownerScope: string,
  mutation: FundingMutation,
): Promise<FundingSaveReminder> {
  hash(ownerScope);
  const captured = readFundingSaveMutation(mutation);
  return readFundingSaveReminder({
    format: 'funding-save-reminder-v1',
    ownerScope,
    id: captured.id,
    action: captured.action,
    expectedRevision: captured.expectedRevision,
    documentHash: await documentHash(captured.document),
  });
}

/** Only exact saved results confirm a draft mutation; this never authorizes a transfer. */
export async function fundingReminderOutcome(
  value: FundingSaveReminder,
  saved: SavedFunding,
): Promise<'confirmed' | 'unknown' | 'conflict'> {
  const reminder = readFundingSaveReminder(value);
  const row = record(saved, [
    'id',
    'revision',
    'archived',
    'updatedAt',
    'document',
  ]);
  const savedId = id(row.id);
  if (
    savedId !== reminder.id ||
    typeof row.revision !== 'number' ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    row.revision > 1_000_000_001 ||
    typeof row.archived !== 'boolean' ||
    typeof row.updatedAt !== 'string' ||
    row.updatedAt.length !== 24 ||
    !Number.isFinite(Date.parse(row.updatedAt)) ||
    new Date(row.updatedAt).toISOString() !== row.updatedAt
  )
    throw invalid();
  const savedRevision = row.revision;
  const archived = row.archived;
  const document = canonicalDocument(row.document);
  if (savedRevision <= reminder.expectedRevision) return 'unknown';
  if (
    savedRevision !== reminder.expectedRevision + 1 ||
    archived !== (reminder.action === 'archive')
  )
    return 'conflict';
  return (await documentHash(document)) === reminder.documentHash
    ? 'confirmed'
    : 'conflict';
}
