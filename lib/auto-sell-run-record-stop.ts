import { autoSellRunId } from './auto-sell-run';

export const autoSellRunRecordStopAuthority = {
  signingAllowed: false,
  executionAllowed: false,
  automaticResumeAllowed: false,
} as const;
export type AutoSellRunRecordStopRequest = {
  projectId: string;
  runId: string;
  profileSaveId: string;
  profileSha256: string;
  consent: 'stop-original-run-record-v1';
};
export type AutoSellRunRecordStop = Omit<
  AutoSellRunRecordStopRequest,
  'consent'
> &
  typeof autoSellRunRecordStopAuthority & {
    format: 'auto-sell-run-record-stop-v1';
    requestSha256: string;
    status: 'creation-fenced' | 'record-found';
    runSha256: string | null;
    createdAt: string;
  };
function record(value: unknown, keys: string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((k) => typeof k !== 'string') ||
    Object.keys(value).sort().join(',') !== keys.sort().join(',')
  )
    throw Error('Invalid original record request.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of keys)
    if (!descriptors[key] || !Object.hasOwn(descriptors[key], 'value'))
      throw Error('Invalid original record request.');
  return Object.fromEntries(
    keys.map((k) => [k, descriptors[k].value]),
  ) as Record<string, unknown>;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw Error('Invalid record hash.');
  return value;
}
async function digest(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
export function readAutoSellRunRecordStopRequest(
  value: unknown,
): AutoSellRunRecordStopRequest {
  const r = record(value, [
    'projectId',
    'runId',
    'profileSaveId',
    'profileSha256',
    'consent',
  ]);
  if (r.consent !== 'stop-original-run-record-v1')
    throw Error('Separately approve stopping the original record request.');
  return {
    projectId: autoSellRunId(r.projectId),
    runId: autoSellRunId(r.runId),
    profileSaveId: autoSellRunId(r.profileSaveId),
    profileSha256: hash(r.profileSha256),
    consent: r.consent,
  };
}
export async function autoSellRunRecordStopRequestSha256(
  request: AutoSellRunRecordStopRequest,
) {
  const r = readAutoSellRunRecordStopRequest(request);
  return digest([
    'auto-sell-run-record-stop-request-v1',
    r.projectId,
    r.runId,
    r.profileSaveId,
    r.profileSha256,
    r.consent,
  ]);
}
export async function autoSellRunEnrollmentOwnerScope(owner: string) {
  if (typeof owner !== 'string' || owner.length < 1 || owner.length > 128)
    throw Error('Invalid signed-in owner.');
  return digest(['auto-sell-run-enrollment-owner-v1', owner]);
}
export async function readAutoSellRunRecordStop(
  value: unknown,
): Promise<AutoSellRunRecordStop> {
  const r = record(value, [
    'format',
    'projectId',
    'runId',
    'profileSaveId',
    'profileSha256',
    'requestSha256',
    'status',
    'runSha256',
    'createdAt',
    'signingAllowed',
    'executionAllowed',
    'automaticResumeAllowed',
  ]);
  const request = readAutoSellRunRecordStopRequest({
    projectId: r.projectId,
    runId: r.runId,
    profileSaveId: r.profileSaveId,
    profileSha256: r.profileSha256,
    consent: 'stop-original-run-record-v1',
  });
  if (
    r.format !== 'auto-sell-run-record-stop-v1' ||
    r.requestSha256 !== (await autoSellRunRecordStopRequestSha256(request)) ||
    (r.status !== 'creation-fenced' && r.status !== 'record-found') ||
    (r.status === 'creation-fenced'
      ? r.runSha256 !== null
      : !hash(r.runSha256)) ||
    typeof r.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(r.createdAt)) ||
    new Date(r.createdAt).toISOString() !== r.createdAt ||
    r.signingAllowed !== false ||
    r.executionAllowed !== false ||
    r.automaticResumeAllowed !== false
  )
    throw Error('Invalid terminal record-stop receipt.');
  return {
    format: 'auto-sell-run-record-stop-v1',
    projectId: request.projectId,
    runId: request.runId,
    profileSaveId: request.profileSaveId,
    profileSha256: request.profileSha256,
    requestSha256: r.requestSha256 as string,
    status: r.status,
    runSha256: r.runSha256 as string | null,
    createdAt: r.createdAt,
    ...autoSellRunRecordStopAuthority,
  };
}
