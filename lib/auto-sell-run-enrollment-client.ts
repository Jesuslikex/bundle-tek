import type { SavedAutoSellProfile } from './auto-sell-profile';
import type { AutoSellRun } from './auto-sell-run';
import {
  readBoundedPanelJson,
  PANEL_JSON_RESPONSE_BYTES,
} from './read-bounded-panel-json';

export type AutoSellRunEnrollmentReminder = {
  format: 'auto-sell-run-enrollment-v1';
  ownerScope: string;
  projectId: string;
  runId: string;
  profileSaveId: string;
  profileSha256: string;
};
export type AutoSellRunEnrollmentTarget = {
  ownerScope: string;
  projectId: string;
  profileSaveId: string;
  profileSha256: string;
  runId?: string;
};
export type AutoSellRunEnrollmentResult = {
  run: AutoSellRun;
  reminder: AutoSellRunEnrollmentReminder;
  reminderRetained: boolean;
};
type LocalStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type BrowserOptions = {
  fetcher?: typeof fetch;
  storage?: LocalStore;
  locks?: Pick<LockManager, 'request'> | null;
};
type RecordInput = AutoSellRunEnrollmentTarget & {
  profile: SavedAutoSellProfile;
  approved: boolean;
  mode: 'new' | 'retry';
};
const flags = ['signingAllowed', 'executionAllowed', 'automaticResumeAllowed'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const U64 = (1n << 64n) - 1n;
const profileEndpoint = '/api/imported-projects/auto-sell-profiles';
const runEndpoint = '/api/imported-projects/auto-sell-runs';
const unavailable = () =>
  Error(
    'The original Auto Sell record could not be verified. Keep its recovery reference; no new record should replace it.',
  );
const stopped = () =>
  Error(
    'Record waiting stopped. Its original reference is retained; stopping a wait does not cancel a server write.',
  );
const storageFailure = () =>
  Error(
    'Auto Sell record recovery storage is unavailable or invalid. No new record was sent. Keep the original recovery reference.',
  );
const pendingFailure = () =>
  Error(
    'An original Auto Sell record still needs checking for this account and project. Recover that same ID before recording another.',
  );
const locksFailure = () =>
  Error(
    'This browser cannot protect Auto Sell records across tabs. Use an up-to-date browser on the secure app URL. Original-record inspection remains available.',
  );
type Review = {
  target: AutoSellRunEnrollmentTarget;
  profileText: string;
  used: boolean;
};
const reviews = new WeakMap<SavedAutoSellProfile, Review>();

function unicode(value: string) {
  for (const c of value)
    if (
      c.length === 1 &&
      c.charCodeAt(0) >= 0xd800 &&
      c.charCodeAt(0) <= 0xdfff
    )
      throw unavailable();
}
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
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      (!required.includes(key) && !optional.includes(key)) ||
      !d?.enumerable ||
      !Object.hasOwn(d, 'value')
    )
      throw unavailable();
  }
  return value as Record<string, unknown>;
}
function snapshot(
  value: unknown,
  depth = 0,
  budget = { nodes: 20000, units: PANEL_JSON_RESPONSE_BYTES },
): unknown {
  if (depth > 16 || --budget.nodes < 0) throw unavailable();
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
      value.length > 2048 ||
      Reflect.ownKeys(value).length !== value.length + 1
    )
      throw unavailable();
    return Array.from({ length: value.length }, (_, i) => {
      const d = Object.getOwnPropertyDescriptor(value, String(i));
      if (!d?.enumerable || !Object.hasOwn(d, 'value')) throw unavailable();
      return snapshot(d.value, depth + 1, budget);
    });
  }
  if (
    !value ||
    typeof value !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw unavailable();
  const keys = Reflect.ownKeys(value);
  if (keys.length > 64) throw unavailable();
  const copy: Record<string, unknown> = {};
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
    copy[key] = snapshot(d.value, depth + 1, budget);
  }
  return copy;
}
function captured(value: unknown) {
  const copy = snapshot(value);
  if (
    new TextEncoder().encode(JSON.stringify(copy)).byteLength >
    PANEL_JSON_RESPONSE_BYTES
  )
    throw unavailable();
  return copy;
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
function raw(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,22})$/.test(value) ||
    BigInt(value) > U64 * 1000n
  )
    throw unavailable();
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
function authority(row: Record<string, unknown>) {
  if (flags.some((k) => row[k] !== false)) throw unavailable();
}
async function digest(text: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
function active(signal: AbortSignal) {
  if (signal.aborted) throw stopped();
}
function target(value: unknown): AutoSellRunEnrollmentTarget {
  const row = record(
    value,
    ['ownerScope', 'projectId', 'profileSaveId', 'profileSha256'],
    ['runId'],
  );
  return {
    ownerScope: hash(row.ownerScope),
    projectId: id(row.projectId),
    profileSaveId: id(row.profileSaveId),
    profileSha256: hash(row.profileSha256),
    ...(row.runId === undefined ? {} : { runId: id(row.runId) }),
  };
}
export async function autoSellRunEnrollmentScope(
  ownerId: string,
): Promise<string> {
  if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 128)
    throw unavailable();
  unicode(ownerId);
  return digest(JSON.stringify(['auto-sell-run-enrollment-owner-v1', ownerId]));
}
export function autoSellRunEnrollmentKey(
  ownerScope: string,
  projectId: string,
) {
  return (
    'bundle:auto-sell-run-enrollment:v1:' +
    hash(ownerScope) +
    ':' +
    id(projectId)
  );
}
export function readAutoSellRunEnrollmentReminder(
  value: unknown,
): AutoSellRunEnrollmentReminder {
  const row = record(value, [
    'format',
    'ownerScope',
    'projectId',
    'runId',
    'profileSaveId',
    'profileSha256',
  ]);
  if (row.format !== 'auto-sell-run-enrollment-v1') throw unavailable();
  const result = {
    format: 'auto-sell-run-enrollment-v1' as const,
    ownerScope: hash(row.ownerScope),
    projectId: id(row.projectId),
    runId: id(row.runId),
    profileSaveId: id(row.profileSaveId),
    profileSha256: hash(row.profileSha256),
  };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 1024)
    throw unavailable();
  return result;
}
function browserStore(options: BrowserOptions = {}): LocalStore | null {
  try {
    return options.storage ?? globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
function browserLocks(
  options: BrowserOptions = {},
): Pick<LockManager, 'request'> | null {
  try {
    const value = Object.hasOwn(options, 'locks')
      ? options.locks
      : typeof navigator === 'undefined'
        ? null
        : navigator.locks;
    return value && typeof value.request === 'function' ? value : null;
  } catch {
    return null;
  }
}
function stored(storage: LocalStore, ownerScope: string, projectId: string) {
  try {
    const text = storage.getItem(
      autoSellRunEnrollmentKey(ownerScope, projectId),
    );
    if (text === null) return null;
    if (text.length > 1024) throw storageFailure();
    const reminder = readAutoSellRunEnrollmentReminder(JSON.parse(text));
    if (reminder.ownerScope !== ownerScope || reminder.projectId !== projectId)
      throw storageFailure();
    return { reminder, text };
  } catch {
    throw storageFailure();
  }
}
export function loadAutoSellRunEnrollmentReminder(
  ownerScope: string,
  projectId: string,
  storage?: LocalStore,
) {
  hash(ownerScope);
  id(projectId);
  const local = browserStore(storage ? { storage } : {});
  if (!local) throw storageFailure();
  return stored(local, ownerScope, projectId)?.reminder ?? null;
}
function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  active(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(stopped());
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
async function request(
  url: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
  body?: string,
) {
  try {
    active(signal);
    const response = await untilAbort(
      fetcher(url, {
        method: body === undefined ? 'GET' : 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'error',
        signal,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body }),
      }),
      signal,
    );
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      throw unavailable();
    }
    const parsed = await untilAbort(
      readBoundedPanelJson(response, signal),
      signal,
    );
    active(signal);
    return parsed;
  } catch {
    throw signal.aborted ? stopped() : unavailable();
  }
}
export async function reviewAutoSellRunEnrollmentProfile(
  input: AutoSellRunEnrollmentTarget,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<SavedAutoSellProfile> {
  const expected = target(input);
  try {
    const body = captured(
      await request(
        profileEndpoint +
          '?' +
          new URLSearchParams({
            projectId: expected.projectId,
            id: expected.profileSaveId,
          }),
        signal,
        fetcher,
      ),
    );
    const row = record(body, ['profile', ...flags]);
    authority(row);
    const { readSavedAutoSellProfile } = await untilAbort(
      import('./auto-sell-profile'),
      signal,
    );
    const profile = await untilAbort(
      readSavedAutoSellProfile(row.profile),
      signal,
    );
    if (
      profile.id !== expected.profileSaveId ||
      profile.sha256 !== expected.profileSha256 ||
      profile.terms.projectId !== expected.projectId
    )
      throw unavailable();
    active(signal);
    reviews.set(profile, {
      target: expected,
      profileText: JSON.stringify(profile),
      used: false,
    });
    return profile;
  } catch {
    throw signal.aborted ? stopped() : unavailable();
  }
}
function reminderFor(
  target: AutoSellRunEnrollmentTarget,
  runId: string,
): AutoSellRunEnrollmentReminder {
  return readAutoSellRunEnrollmentReminder({
    format: 'auto-sell-run-enrollment-v1',
    ownerScope: target.ownerScope,
    projectId: target.projectId,
    runId,
    profileSaveId: target.profileSaveId,
    profileSha256: target.profileSha256,
  });
}
async function verifiedRun(
  value: unknown,
  expected: AutoSellRunEnrollmentReminder,
  kind: 'record' | 'recover',
  signal: AbortSignal,
) {
  const body = captured(value);
  const row = record(
    body,
    kind === 'record'
      ? ['run', ...flags]
      : ['run', 'accounting', 'preparationStarts', 'stopped', 'stop', ...flags],
  );
  authority(row);
  const { readAutoSellRun } = await untilAbort(
    import('./auto-sell-run'),
    signal,
  );
  const run = await untilAbort(readAutoSellRun(row.run), signal);
  if (
    run.id !== expected.runId ||
    run.profile.id !== expected.profileSaveId ||
    run.profile.sha256 !== expected.profileSha256 ||
    run.profile.terms.projectId !== expected.projectId
  )
    throw unavailable();
  if (kind === 'recover') {
    const a = record(row.accounting, [
      'sequence',
      'headSha256',
      'accountedRaw',
      'strategies',
    ]);
    const sequence = integer(a.sequence),
      head = hash(a.headSha256),
      amount = raw(a.accountedRaw);
    if (
      BigInt(amount) > U64 * BigInt(sequence) ||
      (sequence === 0 && (amount !== '0' || head !== run.sha256)) ||
      !Array.isArray(a.strategies) ||
      a.strategies.length !==
        run.profile.terms.configuration.strategies.length ||
      !Array.isArray(row.preparationStarts) ||
      row.preparationStarts.length > sequence ||
      typeof row.stopped !== 'boolean'
    )
      throw unavailable();
    const ids = new Set<string>();
    let total = 0n;
    for (const value of a.strategies) {
      const s = record(value, [
        'id',
        'accountedRaw',
        'claimedKeyCount',
        'nextDcaIndex',
        'nextDcaAt',
      ]);
      if (
        typeof s.id !== 'string' ||
        ids.has(s.id) ||
        !run.profile.terms.configuration.strategies.some(
          (strategy) => strategy.id === s.id,
        )
      )
        throw unavailable();
      ids.add(s.id);
      total += BigInt(raw(s.accountedRaw));
      integer(s.claimedKeyCount, 0, 128000);
      integer(s.nextDcaIndex);
      if (s.nextDcaAt !== null) timestamp(s.nextDcaAt);
    }
    if (total !== BigInt(amount)) throw unavailable();
    const started = new Set<string>(),
      preparations = new Set<string>();
    for (const value of row.preparationStarts) {
      const s = record(value, [
        'attemptId',
        'preparationId',
        'headSequence',
        'headSha256',
        'createdAt',
      ]);
      const attemptId = id(s.attemptId),
        preparationId = id(s.preparationId),
        seq = integer(s.headSequence, 1, sequence);
      const sha = hash(s.headSha256);
      timestamp(s.createdAt);
      if (
        started.has(attemptId) ||
        preparations.has(preparationId) ||
        (seq === sequence && sha !== head)
      )
        throw unavailable();
      started.add(attemptId);
      preparations.add(preparationId);
    }
    if (row.stopped) {
      const stop = record(row.stop, [
        'format',
        'id',
        'runId',
        'runSha256',
        'createdAt',
        ...flags,
      ]);
      authority(stop);
      if (
        stop.format !== 'auto-sell-run-stop-v1' ||
        stop.runId !== run.id ||
        stop.runSha256 !== run.sha256
      )
        throw unavailable();
      id(stop.id);
      timestamp(stop.createdAt);
    } else if (row.stop !== null) throw unavailable();
  }
  active(signal);
  return run;
}
function clearExact(
  storage: LocalStore,
  reminder: AutoSellRunEnrollmentReminder,
  text: string,
) {
  try {
    const key = autoSellRunEnrollmentKey(
      reminder.ownerScope,
      reminder.projectId,
    );
    const before = storage.getItem(key);
    if (before !== null && before !== text) return false;
    if (before === text) storage.removeItem(key);
    return storage.getItem(key) === null;
  } catch {
    return false;
  }
}
export async function recordAutoSellRunEnrollment(
  input: RecordInput,
  signal: AbortSignal,
  options: BrowserOptions = {},
): Promise<AutoSellRunEnrollmentResult> {
  const row = record(
    input,
    [
      'ownerScope',
      'projectId',
      'profileSaveId',
      'profileSha256',
      'profile',
      'approved',
      'mode',
    ],
    ['runId'],
  );
  if (row.approved !== true || (row.mode !== 'new' && row.mode !== 'retry'))
    throw Error(
      'Separately review and approve recording this original Auto Sell metadata.',
    );
  const expected = target({
    ownerScope: row.ownerScope,
    projectId: row.projectId,
    profileSaveId: row.profileSaveId,
    profileSha256: row.profileSha256,
    ...(row.runId === undefined ? {} : { runId: row.runId }),
  });
  const originalProfile = row.profile as SavedAutoSellProfile;
  const review = reviews.get(originalProfile);
  if (
    !review ||
    review.used ||
    JSON.stringify(review.target) !== JSON.stringify(expected) ||
    (row.mode === 'new' && expected.runId !== undefined) ||
    (row.mode === 'retry' && expected.runId === undefined)
  )
    throw Error(
      'Read and review the exact original saved configuration again before approving this record request.',
    );
  const profileCopy = captured(originalProfile);
  const mode = row.mode;
  const store = browserStore(options),
    locks = browserLocks(options);
  if (!store) throw storageFailure();
  if (!locks) throw locksFailure();
  const { readSavedAutoSellProfile } = await untilAbort(
    import('./auto-sell-profile'),
    signal,
  );
  const profile = await untilAbort(
    readSavedAutoSellProfile(profileCopy),
    signal,
  );
  if (JSON.stringify(profile) !== review.profileText) throw unavailable();
  active(signal);
  let result: AutoSellRunEnrollmentResult | null = null;
  await untilAbort(
    locks.request(
      autoSellRunEnrollmentKey(expected.ownerScope, expected.projectId),
      { ifAvailable: true },
      async (lock) => {
        active(signal);
        if (!lock)
          throw Error(
            'Another tab is recording or checking this account and project. No new request was sent.',
          );
        if (review.used)
          throw Error(
            'Review the saved configuration again before another record request.',
          );
        const existing = stored(store, expected.ownerScope, expected.projectId);
        if (mode === 'new' && existing) throw pendingFailure();
        if (
          mode === 'retry' &&
          (!existing ||
            existing.reminder.runId !== expected.runId ||
            existing.reminder.profileSaveId !== expected.profileSaveId ||
            existing.reminder.profileSha256 !== expected.profileSha256)
        )
          throw pendingFailure();
        const reminder =
          existing?.reminder ?? reminderFor(expected, crypto.randomUUID());
        const text = existing?.text ?? JSON.stringify(reminder);
        if (!existing) {
          try {
            store.setItem(
              autoSellRunEnrollmentKey(expected.ownerScope, expected.projectId),
              text,
            );
            if (
              store.getItem(
                autoSellRunEnrollmentKey(
                  expected.ownerScope,
                  expected.projectId,
                ),
              ) !== text
            )
              throw storageFailure();
          } catch {
            throw storageFailure();
          }
        }
        active(signal);
        review.used = true;
        const body = JSON.stringify({
          action: 'create',
          id: reminder.runId,
          projectId: reminder.projectId,
          profileSaveId: reminder.profileSaveId,
          profileSha256: reminder.profileSha256,
          consent: 'record-auto-sell-run-v1',
        });
        const reply = await request(
          runEndpoint,
          signal,
          options.fetcher ?? fetch,
          body,
        );
        const run = await verifiedRun(reply, reminder, 'record', signal);
        active(signal);
        const cleared = clearExact(store, reminder, text);
        result = { run, reminder, reminderRetained: !cleared };
      },
    ),
    signal,
  );
  active(signal);
  if (!result) throw unavailable();
  return result;
}
export async function recoverAutoSellRunEnrollment(
  input: AutoSellRunEnrollmentReminder,
  signal: AbortSignal,
  options: BrowserOptions = {},
): Promise<AutoSellRunEnrollmentResult> {
  const reminder = readAutoSellRunEnrollmentReminder(input);
  try {
    const reply = await request(
      runEndpoint + '?' + new URLSearchParams({ runId: reminder.runId }),
      signal,
      options.fetcher ?? fetch,
    );
    const run = await verifiedRun(reply, reminder, 'recover', signal);
    active(signal);
    const reminderRetained = !(await clearVerifiedAutoSellRunEnrollmentReminder(
      reminder,
      signal,
      options,
    ));
    return { run, reminder, reminderRetained };
  } catch {
    throw signal.aborted ? stopped() : unavailable();
  }
}
/** Local cleanup only. Caller must first independently verify positive original-record proof. */
export async function clearVerifiedAutoSellRunEnrollmentReminder(
  input: AutoSellRunEnrollmentReminder,
  signal: AbortSignal,
  options: Pick<BrowserOptions, 'storage' | 'locks'> = {},
): Promise<boolean> {
  const reminder = readAutoSellRunEnrollmentReminder(input);
  active(signal);
  const store = browserStore(options),
    locks = browserLocks(options);
  if (!store) return false;
  let prior;
  try {
    prior = stored(store, reminder.ownerScope, reminder.projectId);
  } catch {
    return false;
  }
  if (prior === null) return true;
  if (JSON.stringify(prior.reminder) !== JSON.stringify(reminder) || !locks)
    return false;
  let cleared = false;
  try {
    await untilAbort(
      locks.request(
        autoSellRunEnrollmentKey(reminder.ownerScope, reminder.projectId),
        { ifAvailable: true },
        (lock) => {
          active(signal);
          if (lock) cleared = clearExact(store, reminder, prior.text);
        },
      ),
      signal,
    );
  } catch {
    active(signal);
  }
  active(signal);
  return cleared;
}
