import bs58 from 'bs58';
import { readBoundedPanelJson } from './read-bounded-panel-json';
import {
  validateLaunchRecoveryItem,
  type LaunchRecoveryItem,
} from './launch-recovery-discovery';

export type LaunchInspectionReference = Pick<
  LaunchRecoveryItem,
  | 'source'
  | 'reviewKind'
  | 'id'
  | 'projectId'
  | 'mint'
  | 'createdAt'
  | 'expiresAt'
>;
export const LAUNCH_INSPECTION_BUDGET_LIMIT = 1600;
export const LAUNCH_INSPECTION_HOLDER_LIMIT = 200;
export type LaunchInspectionParticipant = {
  role: 'developer' | 'holder';
  address: string;
  mode:
    | 'not-requested'
    | 'exact-base-output'
    | 'exact-quote-input'
    | 'unavailable';
};
export const LAUNCH_INSPECTION_BUDGET_UNITS = {
  'fee-rent-limit': 'lamports',
  'terms-fee-rent-limit': 'lamports',
  'developer-input-max-quote': 'raw-quote',
  'holder-input-max-quote': 'raw-quote',
  'holder-input-min-output': 'raw-token',
  'deployer-fee-rent-limit': 'lamports',
  'developer-max-quote': 'raw-quote',
  'developer-token-output': 'raw-token',
  'holder-fee-rent-limit': 'lamports',
  'holder-token-output': 'raw-token',
  'holder-quote-input': 'raw-quote',
  'holder-max-quote': 'raw-quote',
  'holder-min-output': 'raw-token',
  'developer-buy': 'raw-quote',
  'minimum-token-output': 'raw-token',
  'sol-cost-estimate': 'lamports',
  'sol-spend-limit': 'lamports',
  'pool-creation-fee': 'lamports',
} as const;
export type LaunchInspectionBudget = {
  kind: keyof typeof LAUNCH_INSPECTION_BUDGET_UNITS;
  address: string | null;
  raw: string | null;
  units: 'lamports' | 'raw-quote' | 'raw-token';
};
export type LaunchRecoveryInspection = {
  format: 'launch-recovery-inspection-v1';
  reference: LaunchInspectionReference;
  inspectedAt: string;
  recordedState:
    | 'review'
    | 'approved'
    | 'signed'
    | 'submitting'
    | 'submitted'
    | 'finalized'
    | 'failed'
    | 'cancelled';
  name: string;
  symbol: string;
  payer: string;
  payerRevision: number | null;
  projectUpdatedAt: string | null;
  quoteMint: string | null;
  hashes: {
    kind: 'packet' | 'context' | 'manifest' | 'simulation' | 'release';
    index: number | null;
    sha256: string;
  }[];
  budgets: LaunchInspectionBudget[];
  participants: LaunchInspectionParticipant[];
  signature: string | null;
  signatureScope: 'single-transaction' | 'first-group-packet';
  receiptPresent: boolean;
  packetCount: number;
  signingAllowed: false;
  executionAllowed: false;
  receiptVerified: false;
};
export class LaunchInspectionReadError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401
        ? 'Sign in to inspect this saved launch.'
        : status === 404
          ? 'The saved launch was not found for this account.'
          : status === 409
            ? 'This saved launch format or reference cannot be inspected. Keep the original reference.'
            : 'Saved launch inspection is unavailable. Keep the original reference and try again manually.',
    );
  }
}
export class LaunchInspectionRequestError extends Error {}
function fail(): never {
  throw new LaunchInspectionReadError(502);
}
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
    return fail();
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== 'string' || !keys.includes(key))
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) return fail();
    result[key] = d.value;
  }
  return result;
}
function list(value: unknown, limit: number): unknown[] {
  if (
    !Array.isArray(value) ||
    value.length > limit ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  const result: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) return fail();
    result.push(d.value);
  }
  return result;
}
function iso(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) &&
    Number.isFinite(Date.parse(v)) &&
    new Date(v).toISOString() === v
  );
}
function unsafeDisplayText(text: string) {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (
      code < 32 ||
      code === 127 ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    )
      return true;
  }
  return false;
}
function publicKey(v: unknown, bytes = 32): v is string {
  try {
    return (
      typeof v === 'string' &&
      v.length <= 90 &&
      bs58.decode(v).length === bytes &&
      bs58.encode(bs58.decode(v)) === v
    );
  } catch {
    return false;
  }
}
const referenceKeys = [
  'source',
  'reviewKind',
  'id',
  'projectId',
  'mint',
  'createdAt',
  'expiresAt',
] as const;
export function validateLaunchInspectionReference(
  value: unknown,
): LaunchInspectionReference {
  const v = object(value, referenceKeys);
  const item = validateLaunchRecoveryItem({
    ...v,
    projectName: null,
    state: 'review',
    hasSignature: false,
    hasReceipt: false,
  });
  return {
    source: item.source,
    reviewKind: item.reviewKind,
    id: item.id,
    projectId: item.projectId,
    mint: item.mint,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
  };
}
export function launchInspectionRequest(
  params: URLSearchParams,
): LaunchInspectionReference | null {
  if (!params.has('view')) return null;
  try {
    if (
      params.size !== referenceKeys.length + 1 ||
      params.getAll('view').length !== 1 ||
      params.get('view') !== 'inspection' ||
      [...params.keys()].some(
        (key) =>
          key !== 'view' &&
          !referenceKeys.includes(key as (typeof referenceKeys)[number]),
      ) ||
      referenceKeys.some((key) => params.getAll(key).length !== 1)
    )
      throw Error();
    return validateLaunchInspectionReference(
      Object.fromEntries(referenceKeys.map((key) => [key, params.get(key)])),
    );
  } catch {
    throw new LaunchInspectionRequestError(
      'Invalid saved launch inspection request.',
    );
  }
}
export function launchRecoveryInspectionUrl(
  reference: LaunchInspectionReference,
) {
  const ref = validateLaunchInspectionReference(reference);
  if (ref.reviewKind === 'uncategorized')
    throw new LaunchInspectionReadError(409);
  return (
    '/api/account-launch-recoveries?' +
    new URLSearchParams({ view: 'inspection', ...ref }).toString()
  );
}
export function validateLaunchRecoveryInspection(
  value: unknown,
  expected: LaunchInspectionReference,
): LaunchRecoveryInspection {
  const expectedRef = validateLaunchInspectionReference(expected);
  const v = object(value, [
    'format',
    'reference',
    'inspectedAt',
    'recordedState',
    'name',
    'symbol',
    'payer',
    'payerRevision',
    'projectUpdatedAt',
    'quoteMint',
    'hashes',
    'budgets',
    'participants',
    'signature',
    'signatureScope',
    'receiptPresent',
    'packetCount',
    'signingAllowed',
    'executionAllowed',
    'receiptVerified',
  ]);
  const reference = validateLaunchInspectionReference(v.reference);
  const group =
    reference.source === 'pump' && reference.reviewKind === 'groups';
  if (
    reference.reviewKind === 'uncategorized' ||
    JSON.stringify(reference) !== JSON.stringify(expectedRef) ||
    v.format !== 'launch-recovery-inspection-v1' ||
    !iso(v.inspectedAt) ||
    ![
      'review',
      'approved',
      'signed',
      'submitting',
      'submitted',
      'finalized',
      'failed',
      'cancelled',
    ].includes(v.recordedState as string) ||
    !publicKey(v.payer) ||
    (v.quoteMint !== null && !publicKey(v.quoteMint)) ||
    (v.signature !== null && !publicKey(v.signature, 64)) ||
    v.signatureScope !==
      (group ? 'first-group-packet' : 'single-transaction') ||
    typeof v.receiptPresent !== 'boolean' ||
    !Number.isInteger(v.packetCount) ||
    (v.packetCount as number) < 1 ||
    (v.packetCount as number) > 5 ||
    (!group && v.packetCount !== 1) ||
    (v.payerRevision !== null &&
      (!Number.isSafeInteger(v.payerRevision) ||
        (v.payerRevision as number) < 1 ||
        (v.payerRevision as number) > 1e9)) ||
    (v.projectUpdatedAt !== null && !iso(v.projectUpdatedAt)) ||
    v.signingAllowed !== false ||
    v.executionAllowed !== false ||
    v.receiptVerified !== false
  )
    return fail();
  for (const [text, max] of [
    [v.name, 128],
    [v.symbol, 32],
  ] as const)
    if (
      typeof text !== 'string' ||
      !text.trim() ||
      text.length > max ||
      unsafeDisplayText(text)
    )
      return fail();
  const hashKeys = new Set<string>();
  const hashes = list(v.hashes, 16).map((raw) => {
    const h = object(raw, ['kind', 'index', 'sha256']);
    if (
      !['packet', 'context', 'manifest', 'simulation', 'release'].includes(
        h.kind as string,
      ) ||
      typeof h.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(h.sha256) ||
      (h.kind !== 'packet' && h.index !== null) ||
      (h.kind === 'packet' &&
        (group
          ? !Number.isInteger(h.index) ||
            (h.index as number) < 0 ||
            (h.index as number) >= (v.packetCount as number)
          : h.index !== null))
    )
      return fail();
    const key = JSON.stringify([h.kind, h.index]);
    if (hashKeys.has(key)) return fail();
    hashKeys.add(key);
    return {
      kind: h.kind as LaunchRecoveryInspection['hashes'][number]['kind'],
      index: h.index as number | null,
      sha256: h.sha256,
    };
  });
  if (
    hashes.filter((h) => h.kind === 'packet').length !==
      (v.packetCount as number) ||
    (group && !hashKeys.has(JSON.stringify(['manifest', null])))
  )
    return fail();
  const participantKeys = new Set<string>();
  const participants = list(
    v.participants,
    LAUNCH_INSPECTION_HOLDER_LIMIT + 1,
  ).map((raw) => {
    const p = object(raw, ['role', 'address', 'mode']);
    if (
      !['developer', 'holder'].includes(p.role as string) ||
      !publicKey(p.address) ||
      ![
        'not-requested',
        'exact-base-output',
        'exact-quote-input',
        'unavailable',
      ].includes(p.mode as string)
    )
      return fail();
    const key = JSON.stringify([p.role, p.address]);
    if (participantKeys.has(key)) return fail();
    participantKeys.add(key);
    return {
      role: p.role,
      address: p.address,
      mode: p.mode,
    } as LaunchInspectionParticipant;
  });
  if (
    participants.filter((p) => p.role === 'developer').length !== 1 ||
    participants.find((p) => p.role === 'developer')?.address !== v.payer ||
    participants.filter((p) => p.role === 'holder').length >
      LAUNCH_INSPECTION_HOLDER_LIMIT
  )
    return fail();
  const budgetKeys = new Set<string>();
  const budgets = list(v.budgets, LAUNCH_INSPECTION_BUDGET_LIMIT).map((raw) => {
    const b = object(raw, ['kind', 'address', 'raw', 'units']);
    if (
      typeof b.kind !== 'string' ||
      !Object.hasOwn(LAUNCH_INSPECTION_BUDGET_UNITS, b.kind) ||
      b.units !==
        LAUNCH_INSPECTION_BUDGET_UNITS[
          b.kind as LaunchInspectionBudget['kind']
        ] ||
      (b.address !== null && !publicKey(b.address)) ||
      (b.raw !== null &&
        (typeof b.raw !== 'string' || !/^(0|[1-9]\d{0,79})$/.test(b.raw)))
    )
      return fail();
    const key = JSON.stringify([b.kind, b.address]);
    if (budgetKeys.has(key)) return fail();
    budgetKeys.add(key);
    return {
      kind: b.kind as LaunchInspectionBudget['kind'],
      address: b.address as string | null,
      raw: b.raw as string | null,
      units: b.units as LaunchInspectionBudget['units'],
    };
  });
  return {
    format: 'launch-recovery-inspection-v1',
    reference,
    inspectedAt: v.inspectedAt as string,
    recordedState: v.recordedState as LaunchRecoveryInspection['recordedState'],
    name: v.name as string,
    symbol: v.symbol as string,
    payer: v.payer,
    payerRevision: v.payerRevision as number | null,
    projectUpdatedAt: v.projectUpdatedAt as string | null,
    quoteMint: v.quoteMint as string | null,
    hashes,
    budgets,
    participants,
    signature: v.signature as string | null,
    signatureScope:
      v.signatureScope as LaunchRecoveryInspection['signatureScope'],
    receiptPresent: v.receiptPresent,
    packetCount: v.packetCount as number,
    signingAllowed: false,
    executionAllowed: false,
    receiptVerified: false,
  };
}
export async function readLaunchRecoveryInspection(
  response: Response,
  reference: LaunchInspectionReference,
  signal: AbortSignal,
): Promise<LaunchRecoveryInspection> {
  if (signal.aborted) {
    void response.body?.cancel().catch(() => {});
    signal.throwIfAborted();
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new LaunchInspectionReadError(response.status);
  }
  try {
    const value = await readBoundedPanelJson(response, signal);
    signal.throwIfAborted();
    return validateLaunchRecoveryInspection(value, reference);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof LaunchInspectionReadError) throw error;
    return fail();
  }
}
