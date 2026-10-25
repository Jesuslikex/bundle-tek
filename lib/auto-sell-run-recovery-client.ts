import bs58 from 'bs58';
import type { SavedSwapPreparation } from './imported-swap-preparation-history';
import {
  readBoundedPanelJson,
  PANEL_JSON_RESPONSE_BYTES,
} from './read-bounded-panel-json';

const authority = {
  signingAllowed: false,
  executionAllowed: false,
  automaticResumeAllowed: false,
} as const;
type Authority = typeof authority;
type Cursor = { createdAt: string; id: string };
type RunSummary = {
  id: string;
  createdAt: string;
  profileSaveId: string;
  profileSha256: string;
  runSha256: string;
  attemptCount: number;
  accountedRaw: string;
  stopped: boolean;
};
export type AutoSellRunIndex = Authority & {
  projectId: string;
  runs: RunSummary[];
  nextCursor: Cursor | null;
};
export type AutoSellRunAttemptSummary = {
  id: string;
  sequence: number;
  attemptSha256: string;
  strategyId: string;
  wallet: string;
  walletRevision: number;
  inputRaw: string;
  preparationId: string;
  reservedAt: string;
  preparationStarted: boolean;
};
type Context = {
  projectId: string;
  projectRevision: number;
  mint: string;
  decimals: number;
};
export type AutoSellRunAttemptPage = Authority & {
  runId: string;
  runSha256: string;
  context: Context;
  accounting: { sequence: number; headSha256: string; accountedRaw: string };
  stopped: boolean;
  attempts: AutoSellRunAttemptSummary[];
  nextBeforeSequence: number | null;
};
type Packet = Authority & {
  format: 'auto-sell-run-packet-v1';
  runId: string;
  attemptId: string;
  preparationId: string;
  runSha256: string;
  attemptSha256: string;
  projectId: string;
  projectRevision: number;
  wallet: string;
  walletRevision: number;
  packetSha256: string;
  summarySha256: string;
  transaction: string;
  packetBytes: number;
  createdAt: string;
  sha256: string;
};
export type AutoSellRunRecovery = Authority & {
  format: 'auto-sell-run-packet-recovery-v1';
  status:
    | 'retained'
    | 'summary-only'
    | 'started-without-result'
    | 'not-started';
  runId: string;
  attemptId: string;
  preparationId: string;
  summary: SavedSwapPreparation | null;
  packet: Packet | null;
  allowanceReleased: false;
};
type IndexSelection = { projectId: string; before?: Cursor };
type AccountingFloor = {
  sequence: number;
  accountedRaw: string;
  stopped: boolean;
};
type AttemptSelection = {
  projectId: string;
  runId: string;
  runSha256: string;
  beforeSequence?: number;
  minimumAccounting?: AccountingFloor;
};
type RecoverySelection = {
  runId: string;
  runSha256: string;
  context: Context;
  attempt: AutoSellRunAttemptSummary;
};
const unavailable = () =>
  Error(
    'Saved Auto Sell recovery is unavailable or its original context differs. Keep the original IDs; no allowance was released.',
  );
const cancelled = () =>
  Error(
    'Saved Auto Sell checking stopped. Original evidence is retained; no allowance was released.',
  );
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const U64 = (1n << 64n) - 1n;
const flagKeys = Object.keys(authority);
function unicode(value: string) {
  for (const c of value)
    if (
      c.length === 1 &&
      c.charCodeAt(0) >= 0xd800 &&
      c.charCodeAt(0) <= 0xdfff
    )
      throw unavailable();
}
/** Closed descriptor-safe records also protect local expected selections. */
function record(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw unavailable();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > required.length + optional.length ||
    required.some((k) => !Object.hasOwn(value, k))
  )
    throw unavailable();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      (!required.includes(key) && !optional.includes(key)) ||
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    )
      throw unavailable();
  }
  return value as Record<string, unknown>;
}
function detach(
  value: unknown,
  depth = 0,
  budget = { units: PANEL_JSON_RESPONSE_BYTES, nodes: 1500 },
): unknown {
  if (depth > 7 || --budget.nodes < 0) throw unavailable();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    unicode(value);
    budget.units -= value.length;
    if (budget.units < 0) throw unavailable();
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw unavailable();
    return value;
  }
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > 20 ||
      Reflect.ownKeys(value).length !== value.length + 1
    )
      throw unavailable();
    return Array.from({ length: value.length }, (_, i) => {
      const d = Object.getOwnPropertyDescriptor(value, String(i));
      if (!d?.enumerable || !Object.hasOwn(d, 'value')) throw unavailable();
      return detach(d.value, depth + 1, budget);
    });
  }
  if (
    !value ||
    typeof value !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw unavailable();
  const copy: Record<string, unknown> = {};
  const keys = Reflect.ownKeys(value);
  if (keys.length > 32) throw unavailable();
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      key === '__proto__' ||
      !d?.enumerable ||
      !Object.hasOwn(d, 'value')
    )
      throw unavailable();
    budget.units -= key.length;
    if (budget.units < 0) throw unavailable();
    copy[key] = detach(d.value, depth + 1, budget);
  }
  return copy;
}
function response(value: unknown) {
  const captured = detach(value);
  if (
    new TextEncoder().encode(JSON.stringify(captured)).byteLength >
    PANEL_JSON_RESPONSE_BYTES
  )
    throw unavailable();
  return captured;
}
function flags(row: Record<string, unknown>) {
  if (flagKeys.some((key) => row[key] !== false)) throw unavailable();
}
function id(value: unknown) {
  if (typeof value !== 'string' || !UUID.test(value)) throw unavailable();
  return value;
}
function hash(value: unknown) {
  if (typeof value !== 'string' || !HASH.test(value)) throw unavailable();
  return value;
}
function integer(value: unknown, min = 0, max = 1000) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < min ||
    value > max
  )
    throw unavailable();
  return value;
}
function bool(value: unknown) {
  if (typeof value !== 'boolean') throw unavailable();
  return value;
}
function timestamp(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length !== 24 ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw unavailable();
  return value;
}
function raw(value: unknown, count = 1, positive = false) {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,22})$/.test(value) ||
    BigInt(value) > U64 * BigInt(count) ||
    (positive && value === '0')
  )
    throw unavailable();
  return value;
}
function address(value: unknown) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44)
    throw unavailable();
  try {
    const bytes = bs58.decode(value);
    if (bytes.length !== 32 || bs58.encode(bytes) !== value)
      throw unavailable();
  } catch {
    throw unavailable();
  }
  return value;
}
function cursor(value: unknown): Cursor {
  const row = record(value, ['createdAt', 'id']);
  return { createdAt: timestamp(row.createdAt), id: id(row.id) };
}
function older(a: Cursor, b: Cursor) {
  return (
    a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id < b.id)
  );
}
function indexSelection(value: IndexSelection) {
  const row = record(value, ['projectId'], ['before']);
  return {
    projectId: id(row.projectId),
    before: row.before == null ? null : cursor(row.before),
  };
}
function attemptSelection(value: AttemptSelection) {
  const row = record(
    value,
    ['projectId', 'runId', 'runSha256'],
    ['beforeSequence', 'minimumAccounting'],
  );
  let minimumAccounting: AccountingFloor | null = null;
  if (row.minimumAccounting != null) {
    const floor = record(row.minimumAccounting, [
      'sequence',
      'accountedRaw',
      'stopped',
    ]);
    const sequence = integer(floor.sequence),
      accountedRaw = raw(floor.accountedRaw, sequence);
    if (
      (sequence === 0 && accountedRaw !== '0') ||
      (sequence > 0 && BigInt(accountedRaw) < BigInt(sequence))
    )
      throw unavailable();
    minimumAccounting = {
      sequence,
      accountedRaw,
      stopped: bool(floor.stopped),
    };
  }
  return {
    projectId: id(row.projectId),
    runId: id(row.runId),
    runSha256: hash(row.runSha256),
    beforeSequence:
      row.beforeSequence == null ? null : integer(row.beforeSequence, 1),
    minimumAccounting,
  };
}
function context(value: unknown): Context {
  const row = record(value, [
    'projectId',
    'projectRevision',
    'mint',
    'decimals',
  ]);
  return {
    projectId: id(row.projectId),
    projectRevision: integer(row.projectRevision, 1, 1e9),
    mint: address(row.mint),
    decimals: integer(row.decimals, 0, 255),
  };
}
function attemptSummary(value: unknown): AutoSellRunAttemptSummary {
  const row = record(value, [
    'id',
    'sequence',
    'attemptSha256',
    'strategyId',
    'wallet',
    'walletRevision',
    'inputRaw',
    'preparationId',
    'reservedAt',
    'preparationStarted',
  ]);
  if (
    typeof row.strategyId !== 'string' ||
    !row.strategyId ||
    row.strategyId.length > 128 ||
    row.strategyId !== row.strategyId.trim()
  )
    throw unavailable();
  unicode(row.strategyId);
  return {
    id: id(row.id),
    sequence: integer(row.sequence, 1),
    attemptSha256: hash(row.attemptSha256),
    strategyId: row.strategyId,
    wallet: address(row.wallet),
    walletRevision: integer(row.walletRevision, 1, 1e9),
    inputRaw: raw(row.inputRaw, 1, true),
    preparationId: id(row.preparationId),
    reservedAt: timestamp(row.reservedAt),
    preparationStarted: bool(row.preparationStarted),
  };
}
function recoverySelection(value: RecoverySelection) {
  const row = record(value, ['runId', 'runSha256', 'context', 'attempt']);
  return {
    runId: id(row.runId),
    runSha256: hash(row.runSha256),
    context: context(row.context),
    attempt: attemptSummary(row.attempt),
  };
}
export function readAutoSellRunIndex(
  value: unknown,
  selection: IndexSelection,
): AutoSellRunIndex {
  const expected = indexSelection(selection);
  const row = record(response(value), [
    'projectId',
    'runs',
    'nextCursor',
    ...flagKeys,
  ]);
  flags(row);
  if (
    row.projectId !== expected.projectId ||
    !Array.isArray(row.runs) ||
    row.runs.length > 20
  )
    throw unavailable();
  const runs = row.runs.map((value) => {
    const r = record(value, [
      'id',
      'createdAt',
      'profileSaveId',
      'profileSha256',
      'runSha256',
      'attemptCount',
      'accountedRaw',
      'stopped',
    ]);
    const count = integer(r.attemptCount);
    const accountedRaw = raw(r.accountedRaw, count);
    if (
      (count === 0 && accountedRaw !== '0') ||
      (count > 0 && BigInt(accountedRaw) < BigInt(count))
    )
      throw unavailable();
    return {
      id: id(r.id),
      createdAt: timestamp(r.createdAt),
      profileSaveId: id(r.profileSaveId),
      profileSha256: hash(r.profileSha256),
      runSha256: hash(r.runSha256),
      attemptCount: count,
      accountedRaw,
      stopped: bool(r.stopped),
    };
  });
  if (
    new Set(runs.map((r) => r.id)).size !== runs.length ||
    runs.some(
      (r, i) =>
        (i > 0 && !older(r, runs[i - 1])) ||
        (expected.before !== null && !older(r, expected.before)),
    )
  )
    throw unavailable();
  const nextCursor = row.nextCursor === null ? null : cursor(row.nextCursor);
  const last = runs.at(-1);
  if (
    nextCursor &&
    (runs.length !== 20 ||
      !last ||
      nextCursor.id !== last.id ||
      nextCursor.createdAt !== last.createdAt)
  )
    throw unavailable();
  return { projectId: expected.projectId, runs, nextCursor, ...authority };
}
export function readAutoSellRunAttemptPage(
  value: unknown,
  selection: AttemptSelection,
): AutoSellRunAttemptPage {
  const expected = attemptSelection(selection);
  const row = record(response(value), [
    'runId',
    'runSha256',
    'context',
    'accounting',
    'stopped',
    'attempts',
    'nextBeforeSequence',
    ...flagKeys,
  ]);
  flags(row);
  const capturedContext = context(row.context);
  if (
    row.runId !== expected.runId ||
    row.runSha256 !== expected.runSha256 ||
    capturedContext.projectId !== expected.projectId ||
    !Array.isArray(row.attempts)
  )
    throw unavailable();
  const a = record(row.accounting, ['sequence', 'headSha256', 'accountedRaw']);
  const sequence = integer(a.sequence),
    headSha256 = hash(a.headSha256),
    accountedRaw = raw(a.accountedRaw, sequence);
  if (
    (sequence === 0 &&
      (headSha256 !== expected.runSha256 || accountedRaw !== '0')) ||
    (sequence > 0 && BigInt(accountedRaw) < BigInt(sequence)) ||
    (expected.beforeSequence !== null && expected.beforeSequence > sequence)
  )
    throw unavailable();
  const highest =
    expected.beforeSequence === null ? sequence : expected.beforeSequence - 1;
  const stopped = bool(row.stopped);
  if (
    expected.minimumAccounting &&
    (sequence < expected.minimumAccounting.sequence ||
      BigInt(accountedRaw) < BigInt(expected.minimumAccounting.accountedRaw) ||
      (expected.minimumAccounting.stopped && !stopped))
  )
    throw unavailable();
  const attempts = row.attempts.map(attemptSummary);
  if (
    attempts.length !== Math.min(20, highest) ||
    attempts.some((r, i) => r.sequence !== highest - i) ||
    new Set(attempts.map((r) => r.id)).size !== attempts.length ||
    new Set(attempts.map((r) => r.preparationId)).size !== attempts.length ||
    (expected.beforeSequence === null &&
      sequence > 0 &&
      attempts[0].attemptSha256 !== headSha256)
  )
    throw unavailable();
  const visibleRaw = attempts.reduce(
    (sum, attempt) => sum + BigInt(attempt.inputRaw),
    0n,
  );
  if (
    visibleRaw > BigInt(accountedRaw) ||
    (expected.beforeSequence === null &&
      sequence <= 20 &&
      visibleRaw !== BigInt(accountedRaw))
  )
    throw unavailable();
  const next = highest > 20 ? attempts.at(-1)!.sequence : null;
  if (row.nextBeforeSequence !== next) throw unavailable();
  return {
    runId: expected.runId,
    runSha256: expected.runSha256,
    context: capturedContext,
    accounting: { sequence, headSha256, accountedRaw },
    stopped,
    attempts,
    nextBeforeSequence: next,
    ...authority,
  };
}
async function digest(text: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
    ),
    (value) => value.toString(16).padStart(2, '0'),
  ).join('');
}
export async function readAutoSellRunPacketRecovery(
  value: unknown,
  selection: RecoverySelection,
): Promise<AutoSellRunRecovery> {
  // Capture both sides before any asynchronous digest or packet decoding.
  const expected = recoverySelection(selection);
  const row = record(response(value), [
    'format',
    'status',
    'runId',
    'attemptId',
    'preparationId',
    'summary',
    'packet',
    'allowanceReleased',
    ...flagKeys,
  ]);
  flags(row);
  if (
    row.format !== 'auto-sell-run-packet-recovery-v1' ||
    row.allowanceReleased !== false ||
    row.runId !== expected.runId ||
    row.attemptId !== expected.attempt.id ||
    row.preparationId !== expected.attempt.preparationId ||
    typeof row.status !== 'string' ||
    ![
      'retained',
      'summary-only',
      'started-without-result',
      'not-started',
    ].includes(row.status)
  )
    throw unavailable();
  const status = row.status as AutoSellRunRecovery['status'];
  const base = {
    format: 'auto-sell-run-packet-recovery-v1' as const,
    status,
    runId: expected.runId,
    attemptId: expected.attempt.id,
    preparationId: expected.attempt.preparationId,
    allowanceReleased: false as const,
    ...authority,
  };
  if (status === 'not-started' || status === 'started-without-result') {
    if (
      row.summary !== null ||
      row.packet !== null ||
      (status === 'not-started' && expected.attempt.preparationStarted)
    )
      throw unavailable();
    return { ...base, summary: null, packet: null };
  }
  const {
    readAutoSellRunPacketSummary,
    autoSellRunSummarySha256,
    validateAutoSellRunPacket,
  } = await import('./auto-sell-run-packet');
  const s = record(row.summary, [
    'id',
    'projectId',
    'projectRevision',
    'walletRevision',
    'createdAt',
    'document',
  ]);
  const document = readAutoSellRunPacketSummary(s.document);
  if (
    s.id !== expected.attempt.preparationId ||
    s.projectId !== expected.context.projectId ||
    s.projectRevision !== expected.context.projectRevision ||
    s.walletRevision !== expected.attempt.walletRevision ||
    document.wallet !== expected.attempt.wallet ||
    document.inputMint !== expected.context.mint ||
    document.inAmountRaw !== expected.attempt.inputRaw
  )
    throw unavailable();
  const summary = {
    id: id(s.id),
    projectId: id(s.projectId),
    projectRevision: integer(s.projectRevision, 1, 1e9),
    walletRevision: integer(s.walletRevision, 1, 1e9),
    createdAt: timestamp(s.createdAt),
    document,
  };
  if (status === 'summary-only') {
    if (row.packet !== null) throw unavailable();
    return { ...base, summary, packet: null };
  }
  const p = record(row.packet, [
    'format',
    'runId',
    'attemptId',
    'preparationId',
    'runSha256',
    'attemptSha256',
    'projectId',
    'projectRevision',
    'wallet',
    'walletRevision',
    'packetSha256',
    'summarySha256',
    'transaction',
    'packetBytes',
    'createdAt',
    'sha256',
    ...flagKeys,
  ]);
  flags(p);
  if (
    p.format !== 'auto-sell-run-packet-v1' ||
    p.runId !== expected.runId ||
    p.attemptId !== expected.attempt.id ||
    p.preparationId !== expected.attempt.preparationId ||
    p.runSha256 !== expected.runSha256 ||
    p.attemptSha256 !== expected.attempt.attemptSha256 ||
    p.projectId !== expected.context.projectId ||
    p.projectRevision !== expected.context.projectRevision ||
    p.wallet !== expected.attempt.wallet ||
    p.walletRevision !== expected.attempt.walletRevision
  )
    throw unavailable();
  if (typeof p.transaction !== 'string') throw unavailable();
  const body = {
    format: 'auto-sell-run-packet-v1' as const,
    runId: expected.runId,
    attemptId: expected.attempt.id,
    preparationId: expected.attempt.preparationId,
    runSha256: hash(p.runSha256),
    attemptSha256: hash(p.attemptSha256),
    projectId: expected.context.projectId,
    projectRevision: expected.context.projectRevision,
    wallet: expected.attempt.wallet,
    walletRevision: expected.attempt.walletRevision,
    packetSha256: hash(p.packetSha256),
    summarySha256: hash(p.summarySha256),
    transaction: p.transaction,
    packetBytes: integer(p.packetBytes, 1, 1232),
    createdAt: timestamp(p.createdAt),
    ...authority,
  };
  const packetHash = hash(p.sha256);
  const checked = await validateAutoSellRunPacket(body.transaction, document);
  if (
    checked.sha256 !== body.packetSha256 ||
    document.transaction.bytes !== body.packetBytes ||
    (await autoSellRunSummarySha256(JSON.stringify(document))) !==
      body.summarySha256 ||
    (await digest(JSON.stringify(['auto-sell-run-packet-v1', body]))) !==
      packetHash
  )
    throw unavailable();
  return { ...base, summary, packet: { ...body, sha256: packetHash } };
}

function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(cancelled());
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
async function get(url: string, signal: AbortSignal, fetcher: typeof fetch) {
  try {
    signal.throwIfAborted();
    const reply = await untilAbort(
      fetcher(url, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'error',
        signal,
        headers: { accept: 'application/json' },
      }),
      signal,
    );
    if (reply.status !== 200) {
      void reply.body?.cancel().catch(() => {});
      throw unavailable();
    }
    const result = await untilAbort(
      readBoundedPanelJson(reply, signal),
      signal,
    );
    signal.throwIfAborted();
    return result;
  } catch {
    throw signal.aborted ? cancelled() : unavailable();
  }
}
export async function loadAutoSellRunIndex(
  selection: IndexSelection,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<AutoSellRunIndex> {
  const s = indexSelection(selection),
    query = new URLSearchParams({ projectId: s.projectId, index: '1' });
  if (s.before) {
    query.set('beforeId', s.before.id);
    query.set('beforeAt', s.before.createdAt);
  }
  const body = await get(
    '/api/imported-projects/auto-sell-runs?' + query,
    signal,
    fetcher,
  );
  if (signal.aborted) throw cancelled();
  return readAutoSellRunIndex(
    body,
    s.before
      ? { projectId: s.projectId, before: s.before }
      : { projectId: s.projectId },
  );
}
export async function loadAutoSellRunAttempts(
  selection: AttemptSelection,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<AutoSellRunAttemptPage> {
  const s = attemptSelection(selection),
    query = new URLSearchParams({ runId: s.runId, attempts: '1' });
  if (s.beforeSequence !== null)
    query.set('beforeSequence', String(s.beforeSequence));
  const body = await get(
    '/api/imported-projects/auto-sell-runs?' + query,
    signal,
    fetcher,
  );
  if (signal.aborted) throw cancelled();
  return readAutoSellRunAttemptPage(body, {
    projectId: s.projectId,
    runId: s.runId,
    runSha256: s.runSha256,
    ...(s.beforeSequence === null ? {} : { beforeSequence: s.beforeSequence }),
    ...(s.minimumAccounting === null
      ? {}
      : { minimumAccounting: s.minimumAccounting }),
  });
}
export async function loadAutoSellRunPacketRecovery(
  selection: RecoverySelection,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<AutoSellRunRecovery> {
  const s = recoverySelection(selection),
    query = new URLSearchParams({ runId: s.runId, attemptId: s.attempt.id });
  const body = await get(
    '/api/imported-projects/auto-sell-run-recovery?' + query,
    signal,
    fetcher,
  );
  try {
    const result = await untilAbort(
      readAutoSellRunPacketRecovery(body, s),
      signal,
    );
    if (signal.aborted) throw cancelled();
    return result;
  } catch {
    throw signal.aborted ? cancelled() : unavailable();
  }
}
