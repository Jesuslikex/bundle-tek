import {
  readFundingSaveReminder,
  type FundingSaveReminder,
} from './funding-save-reminder';

export type FundingSaveStopRequest = {
  format: 'funding-save-stop-request-v1';
  stopId: string;
  reminder: FundingSaveReminder;
  consent: 'stop-draft-save-v1';
};
export type FundingSaveStopReceipt = {
  format: 'funding-save-stop-receipt-v1';
  stopId: string;
  requestHash: string;
  reminder: FundingSaveReminder;
  outcome: 'creation_fenced' | 'revision_advanced' | 'already_advanced';
  beforeRevision: number | null;
  afterRevision: number | null;
  createdAt: string;
  transfersCancelled: false;
  signingAuthorized: false;
};

const invalid = () =>
  Error(
    'The original draft-save stop record is invalid. Keep its recovery details.',
  );
function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw invalid();
  const names = Reflect.ownKeys(value);
  if (names.length !== keys.length) throw invalid();
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (
      typeof name !== 'string' ||
      !keys.includes(name) ||
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    )
      throw invalid();
  }
  return value as Record<string, unknown>;
}
export function fundingSaveStopId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(value))
    throw invalid();
  return value;
}
export function readFundingSaveStopRequest(
  value: unknown,
): FundingSaveStopRequest {
  const row = object(value, ['format', 'stopId', 'reminder', 'consent']);
  if (
    row.format !== 'funding-save-stop-request-v1' ||
    row.consent !== 'stop-draft-save-v1'
  )
    throw invalid();
  return {
    format: 'funding-save-stop-request-v1',
    stopId: fundingSaveStopId(row.stopId),
    reminder: readFundingSaveReminder(row.reminder),
    consent: 'stop-draft-save-v1',
  };
}
export async function fundingSaveStopRequestHash(
  value: unknown,
): Promise<string> {
  const request = readFundingSaveStopRequest(value);
  const bytes = new TextEncoder().encode(
    JSON.stringify(['funding-save-stop-request-v1', request]),
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}
function revision(value: unknown): number | null {
  if (value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < 1 ||
    value > 1_000_000_001
  )
    throw invalid();
  return value;
}
/** Validates immutable stop evidence, independently of the current funding document. */
export async function readFundingSaveStopReceipt(
  value: unknown,
  expectedRequest?: FundingSaveStopRequest,
): Promise<FundingSaveStopReceipt> {
  const expectedCanonical = expectedRequest
    ? JSON.stringify(readFundingSaveStopRequest(expectedRequest))
    : undefined;
  const row = object(value, [
    'format',
    'stopId',
    'requestHash',
    'reminder',
    'outcome',
    'beforeRevision',
    'afterRevision',
    'createdAt',
    'transfersCancelled',
    'signingAuthorized',
  ]);
  const stopId = fundingSaveStopId(row.stopId);
  const reminder = readFundingSaveReminder(row.reminder);
  const beforeRevision = revision(row.beforeRevision),
    afterRevision = revision(row.afterRevision);
  if (
    row.format !== 'funding-save-stop-receipt-v1' ||
    typeof row.requestHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.requestHash) ||
    row.transfersCancelled !== false ||
    row.signingAuthorized !== false ||
    typeof row.createdAt !== 'string' ||
    row.createdAt.length !== 24 ||
    !Number.isFinite(Date.parse(row.createdAt)) ||
    new Date(row.createdAt).toISOString() !== row.createdAt
  )
    throw invalid();
  const requestHash = row.requestHash,
    createdAt = row.createdAt;
  const outcome = row.outcome;
  if (outcome === 'creation_fenced') {
    if (
      reminder.expectedRevision !== 0 ||
      reminder.action !== 'save' ||
      beforeRevision !== null ||
      afterRevision !== null
    )
      throw invalid();
  } else if (outcome === 'revision_advanced') {
    if (
      beforeRevision !== reminder.expectedRevision ||
      beforeRevision === null ||
      beforeRevision > 1_000_000_000 ||
      afterRevision !== beforeRevision + 1
    )
      throw invalid();
  } else if (outcome === 'already_advanced') {
    if (
      beforeRevision === null ||
      beforeRevision <= reminder.expectedRevision ||
      afterRevision !== beforeRevision
    )
      throw invalid();
  } else throw invalid();
  const request: FundingSaveStopRequest = {
    format: 'funding-save-stop-request-v1',
    stopId,
    reminder,
    consent: 'stop-draft-save-v1',
  };
  if (requestHash !== (await fundingSaveStopRequestHash(request)))
    throw invalid();
  if (
    expectedCanonical !== undefined &&
    expectedCanonical !== JSON.stringify(request)
  )
    throw invalid();
  return {
    format: 'funding-save-stop-receipt-v1',
    stopId,
    requestHash,
    reminder,
    outcome,
    beforeRevision,
    afterRevision,
    createdAt,
    transfersCancelled: false,
    signingAuthorized: false,
  };
}
