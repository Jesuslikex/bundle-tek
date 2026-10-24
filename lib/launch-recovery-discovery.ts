import bs58 from 'bs58';
import { readBoundedPanelJson } from './read-bounded-panel-json';

export const LAUNCH_RECOVERY_PAGE_LIMIT = 20;
export const LAUNCH_RECOVERY_SOURCES = [
  'pump',
  'meteora-dbc',
  'stonkfun',
  'launchlab',
] as const;
export type LaunchRecoverySource = (typeof LAUNCH_RECOVERY_SOURCES)[number];
export type LaunchRecoveryState =
  | 'review'
  | 'approved'
  | 'signed'
  | 'submitting'
  | 'submitted';
export type LaunchRecoveryItem = {
  source: LaunchRecoverySource;
  reviewKind:
    | 'create'
    | 'developer'
    | 'holders'
    | 'groups'
    | 'uncategorized'
    | 'single';
  id: string;
  projectId: string;
  projectName: string | null;
  mint: string;
  state: LaunchRecoveryState;
  createdAt: string;
  expiresAt: string;
  hasSignature: boolean;
  hasReceipt: boolean;
};
export type LaunchRecoveryDiscovery = {
  format: 'launch-recovery-discovery-v1';
  scope: 'saved-solana-nonterminal';
  observedAt: string;
  cursor: string | null;
  nextCursor: string | null;
  items: LaunchRecoveryItem[];
  signingAllowed: false;
  executionAllowed: false;
  receiptVerified: false;
};
type Cursor = {
  v: 1;
  source: LaunchRecoverySource;
  createdAt: string;
  id: string;
};
export class LaunchRecoveryDiscoveryRequestError extends Error {}
const unavailable = (): never => {
  throw Error('Saved launch recovery discovery is unavailable.');
};
function record(value: unknown, keys: string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return unavailable();
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some(
      (key) =>
        typeof key !== 'string' ||
        !keys.includes(key) ||
        !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'),
    )
  )
    return unavailable();
  return value as Record<string, unknown>;
}
const date = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[\x21-\x7e]{1,128}$/.test(v);
const source = (v: unknown): v is LaunchRecoverySource =>
  LAUNCH_RECOVERY_SOURCES.includes(v as LaunchRecoverySource);
function position(v: unknown): Cursor {
  const c = record(v, ['v', 'source', 'createdAt', 'id']);
  if (c.v !== 1 || !source(c.source) || !date(c.createdAt) || !id(c.id))
    return unavailable();
  return { v: 1, source: c.source, createdAt: c.createdAt, id: c.id };
}
export function encodeLaunchRecoveryCursor(
  item: Pick<LaunchRecoveryItem, 'source' | 'createdAt' | 'id'>,
) {
  const c = position({
    v: 1,
    source: item.source,
    createdAt: item.createdAt,
    id: item.id,
  });
  return btoa(JSON.stringify(c))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
export function decodeLaunchRecoveryCursor(
  value: string | null,
): Cursor | null {
  if (value === null) return null;
  try {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(value))
      return unavailable();
    const text = atob(
      value.replaceAll('-', '+').replaceAll('_', '/') +
        '='.repeat((4 - (value.length % 4)) % 4),
    );
    const c = position(JSON.parse(text));
    if (encodeLaunchRecoveryCursor(c) !== value) return unavailable();
    return c;
  } catch {
    throw new LaunchRecoveryDiscoveryRequestError(
      'Invalid saved recovery cursor. Return to newest records.',
    );
  }
}
export function launchRecoveryPageRequest(params: URLSearchParams) {
  if (
    [...params.keys()].some((key) => key !== 'cursor') ||
    params.getAll('cursor').length > 1
  )
    throw new LaunchRecoveryDiscoveryRequestError(
      'Unsupported saved recovery query.',
    );
  const cursor = params.get('cursor');
  decodeLaunchRecoveryCursor(cursor);
  return cursor;
}
/** Descending creation time, ascending source, descending original ID. */
function follows(
  item: Pick<LaunchRecoveryItem, 'source' | 'createdAt' | 'id'>,
  previous: Pick<LaunchRecoveryItem, 'source' | 'createdAt' | 'id'>,
) {
  return (
    item.createdAt < previous.createdAt ||
    (item.createdAt === previous.createdAt &&
      (item.source > previous.source ||
        (item.source === previous.source && item.id < previous.id)))
  );
}
export function validateLaunchRecoveryItem(value: unknown): LaunchRecoveryItem {
  const r = record(value, [
    'source',
    'reviewKind',
    'id',
    'projectId',
    'projectName',
    'mint',
    'state',
    'createdAt',
    'expiresAt',
    'hasSignature',
    'hasReceipt',
  ]);
  if (
    !source(r.source) ||
    !id(r.id) ||
    typeof r.projectId !== 'string' ||
    !/^[A-Za-z0-9-]{1,64}$/.test(r.projectId) ||
    !(
      r.projectName === null ||
      (typeof r.projectName === 'string' &&
        r.projectName.length > 0 &&
        r.projectName.length <= 128)
    ) ||
    typeof r.mint !== 'string' ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.mint) ||
    !['review', 'approved', 'signed', 'submitting', 'submitted'].includes(
      r.state as string,
    ) ||
    !date(r.createdAt) ||
    !date(r.expiresAt) ||
    r.expiresAt <= r.createdAt ||
    typeof r.hasSignature !== 'boolean' ||
    typeof r.hasReceipt !== 'boolean'
  )
    return unavailable();
  try {
    if (
      bs58.decode(r.mint).length !== 32 ||
      bs58.encode(bs58.decode(r.mint)) !== r.mint
    )
      return unavailable();
  } catch {
    return unavailable();
  }
  if (
    r.source === 'pump'
      ? !['create', 'developer', 'holders', 'groups', 'uncategorized'].includes(
          r.reviewKind as string,
        )
      : r.reviewKind !== 'single'
  )
    return unavailable();
  return {
    source: r.source,
    reviewKind: r.reviewKind as LaunchRecoveryItem['reviewKind'],
    id: r.id,
    projectId: r.projectId,
    projectName: r.projectName,
    mint: r.mint,
    state: r.state as LaunchRecoveryState,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    hasSignature: r.hasSignature,
    hasReceipt: r.hasReceipt,
  };
}
export function validateLaunchRecoveryDiscovery(
  value: unknown,
  cursor: string | null = null,
): LaunchRecoveryDiscovery {
  const v = record(value, [
    'format',
    'scope',
    'observedAt',
    'cursor',
    'nextCursor',
    'items',
    'signingAllowed',
    'executionAllowed',
    'receiptVerified',
  ]);
  const before = decodeLaunchRecoveryCursor(cursor);
  if (
    v.format !== 'launch-recovery-discovery-v1' ||
    v.scope !== 'saved-solana-nonterminal' ||
    !date(v.observedAt) ||
    v.cursor !== cursor ||
    v.signingAllowed !== false ||
    v.executionAllowed !== false ||
    v.receiptVerified !== false ||
    !Array.isArray(v.items) ||
    v.items.length > LAUNCH_RECOVERY_PAGE_LIMIT ||
    Reflect.ownKeys(v.items).length !== v.items.length + 1
  )
    return unavailable();
  const items: LaunchRecoveryItem[] = [],
    seen = new Set<string>();
  let previous: Pick<LaunchRecoveryItem, 'source' | 'createdAt' | 'id'> | null =
    before;
  for (let i = 0; i < v.items.length; i++) {
    const d = Object.getOwnPropertyDescriptor(v.items, String(i));
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) return unavailable();
    const item = validateLaunchRecoveryItem(d.value),
      key = JSON.stringify([item.source, item.id]);
    if (seen.has(key) || (previous && !follows(item, previous)))
      return unavailable();
    seen.add(key);
    items.push(item);
    previous = item;
  }
  if (
    v.nextCursor !== null &&
    (typeof v.nextCursor !== 'string' ||
      items.length !== LAUNCH_RECOVERY_PAGE_LIMIT ||
      v.nextCursor !== encodeLaunchRecoveryCursor(items.at(-1)!))
  )
    return unavailable();
  return {
    format: v.format,
    scope: v.scope,
    observedAt: v.observedAt,
    cursor,
    nextCursor: v.nextCursor as string | null,
    items,
    signingAllowed: false,
    executionAllowed: false,
    receiptVerified: false,
  };
}
export async function readLaunchRecoveryDiscovery(
  response: Response,
  signal: AbortSignal,
  cursor: string | null = null,
) {
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw Error(
      response.status === 401
        ? 'Sign in to find saved launch recoveries.'
        : 'Saved launch recovery discovery is unavailable.',
    );
  }
  try {
    return validateLaunchRecoveryDiscovery(
      await readBoundedPanelJson(response, signal),
      cursor,
    );
  } catch {
    return unavailable();
  }
}
