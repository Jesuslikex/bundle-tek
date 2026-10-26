import type { AutoSellRun } from './auto-sell-run';
import type { AutoSellRunRecordStop } from './auto-sell-run-record-stop';
import {
  readAutoSellRunEnrollmentReminder,
  clearVerifiedAutoSellRunEnrollmentReminder,
  type AutoSellRunEnrollmentReminder,
} from './auto-sell-run-enrollment-client';
import { readBoundedPanelJson } from './read-bounded-panel-json';

type Options = {
  fetcher?: typeof fetch;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  locks?: Pick<LockManager, 'request'> | null;
};
export type AutoSellRunRecordStopCapability = {
  ownerScope: string;
  recordStopSupported: true;
  signingAllowed: false;
  executionAllowed: false;
  automaticResumeAllowed: false;
};
export type AutoSellRunRecordStopResult = {
  stop: AutoSellRunRecordStop;
  run: AutoSellRun | null;
  reminder: AutoSellRunEnrollmentReminder;
  reminderRetained: boolean;
};
export class AutoSellRunRecordStopNotFoundError extends Error {
  constructor() {
    super(
      'No terminal original-record receipt is saved. Keep its original reference and check the original run record.',
    );
    this.name = 'AutoSellRunRecordStopNotFoundError';
  }
}
const endpoint = '/api/imported-projects/auto-sell-run-record-stops';
const flags = ['signingAllowed', 'executionAllowed', 'automaticResumeAllowed'];
const failure = () =>
  Error(
    'The original record-stop result could not be verified. Its recovery reference is retained. No transfer or running strategy was cancelled.',
  );
const cancelled = () =>
  Error(
    'Waiting stopped locally. The original record-stop may still be saved; keep checking the same original ID.',
  );
function active(signal: AbortSignal) {
  if (signal.aborted) throw cancelled();
}
function scope(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw failure();
  return value;
}
function closed(value: unknown, keys: readonly string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw failure();
  const names = Reflect.ownKeys(value);
  if (names.length !== keys.length) throw failure();
  const copy: Record<string, unknown> = {};
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      !keys.includes(key) ||
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    )
      throw failure();
    copy[key] = descriptor.value;
  }
  return copy;
}
function snapshot(
  value: unknown,
  depth = 0,
  budget = { nodes: 20000, units: 1_048_576 },
): unknown {
  if (depth > 16 || --budget.nodes < 0) throw failure();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    budget.units -= value.length;
    if (budget.units < 0) throw failure();
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw failure();
    return value;
  }
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > 2048 ||
      Reflect.ownKeys(value).length !== value.length + 1
    )
      throw failure();
    return Array.from({ length: value.length }, (_, index) => {
      const d = Object.getOwnPropertyDescriptor(value, String(index));
      if (!d?.enumerable || !Object.hasOwn(d, 'value')) throw failure();
      return snapshot(d.value, depth + 1, budget);
    });
  }
  if (
    !value ||
    typeof value !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw failure();
  const names = Reflect.ownKeys(value);
  if (names.length > 64) throw failure();
  const result: Record<string, unknown> = {};
  for (const key of names) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      key === '__proto__' ||
      !d?.enumerable ||
      !Object.hasOwn(d, 'value')
    )
      throw failure();
    budget.units -= key.length;
    if (budget.units < 0) throw failure();
    result[key] = snapshot(d.value, depth + 1, budget);
  }
  return result;
}
function authority(value: Record<string, unknown>) {
  if (flags.some((key) => value[key] !== false)) throw failure();
}
function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  active(signal);
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
async function request(
  query: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
  body?: string,
) {
  try {
    active(signal);
    const response = await untilAbort(
      fetcher(endpoint + query, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
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
      throw failure();
    }
    const value = await untilAbort(
      readBoundedPanelJson(response, signal),
      signal,
    );
    active(signal);
    return snapshot(value);
  } catch {
    throw signal.aborted ? cancelled() : failure();
  }
}
export async function loadAutoSellRunRecordStopCapability(
  ownerScope: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<AutoSellRunRecordStopCapability> {
  const expected = scope(ownerScope);
  const row = closed(await request('?capability=1', signal, fetcher), [
    'ownerScope',
    'recordStopSupported',
    ...flags,
  ]);
  authority(row);
  if (row.ownerScope !== expected || row.recordStopSupported !== true)
    throw failure();
  active(signal);
  return {
    ownerScope: expected,
    recordStopSupported: true,
    signingAllowed: false,
    executionAllowed: false,
    automaticResumeAllowed: false,
  };
}
async function verified(
  value: unknown,
  reminder: AutoSellRunEnrollmentReminder,
  signal: AbortSignal,
) {
  const row = closed(snapshot(value), ['ownerScope', 'stop', 'run', ...flags]);
  authority(row);
  if (row.ownerScope !== reminder.ownerScope) throw failure();
  if (row.stop === null) {
    if (row.run !== null) {
      const { readAutoSellRun } = await untilAbort(
        import('./auto-sell-run'),
        signal,
      );
      const original = await untilAbort(readAutoSellRun(row.run), signal);
      if (
        original.id !== reminder.runId ||
        original.profile.id !== reminder.profileSaveId ||
        original.profile.sha256 !== reminder.profileSha256 ||
        original.profile.terms.projectId !== reminder.projectId
      )
        throw failure();
    }
    active(signal);
    throw new AutoSellRunRecordStopNotFoundError();
  }
  const { readAutoSellRunRecordStop } = await untilAbort(
    import('./auto-sell-run-record-stop'),
    signal,
  );
  const stop = await untilAbort(readAutoSellRunRecordStop(row.stop), signal);
  if (
    stop.projectId !== reminder.projectId ||
    stop.runId !== reminder.runId ||
    stop.profileSaveId !== reminder.profileSaveId ||
    stop.profileSha256 !== reminder.profileSha256
  )
    throw failure();
  let run: AutoSellRun | null = null;
  if (stop.status === 'creation-fenced') {
    if (row.run !== null) throw failure();
  } else {
    const { readAutoSellRun } = await untilAbort(
      import('./auto-sell-run'),
      signal,
    );
    run = await untilAbort(readAutoSellRun(row.run), signal);
    if (
      run.id !== reminder.runId ||
      run.sha256 !== stop.runSha256 ||
      run.profile.id !== reminder.profileSaveId ||
      run.profile.sha256 !== reminder.profileSha256 ||
      run.profile.terms.projectId !== reminder.projectId
    )
      throw failure();
  }
  active(signal);
  return { stop, run };
}
async function terminal(
  reminder: AutoSellRunEnrollmentReminder,
  signal: AbortSignal,
  options: Options,
  body?: string,
): Promise<AutoSellRunRecordStopResult> {
  try {
    const reply = await request(
      body === undefined
        ? '?' + new URLSearchParams({ runId: reminder.runId })
        : '',
      signal,
      options.fetcher ?? fetch,
      body,
    );
    const { stop, run } = await verified(reply, reminder, signal);
    const cleared = await clearVerifiedAutoSellRunEnrollmentReminder(
      reminder,
      signal,
      options,
    );
    active(signal);
    return { stop, run, reminder, reminderRetained: !cleared };
  } catch (error) {
    if (signal.aborted) throw cancelled();
    if (error instanceof AutoSellRunRecordStopNotFoundError) throw error;
    throw failure();
  }
}
export function recoverAutoSellRunRecordStop(
  input: AutoSellRunEnrollmentReminder,
  signal: AbortSignal,
  options: Options = {},
) {
  const reminder = readAutoSellRunEnrollmentReminder(input);
  return terminal(reminder, signal, options);
}
export function stopAutoSellRunRecord(
  input: { reminder: AutoSellRunEnrollmentReminder; approved: boolean },
  signal: AbortSignal,
  options: Options = {},
) {
  const row = closed(input, ['reminder', 'approved']);
  if (row.approved !== true)
    throw Error(
      'Separately approve stopping this exact original run-record request.',
    );
  const reminder = readAutoSellRunEnrollmentReminder(row.reminder);
  const body = JSON.stringify({
    projectId: reminder.projectId,
    runId: reminder.runId,
    profileSaveId: reminder.profileSaveId,
    profileSha256: reminder.profileSha256,
    consent: 'stop-original-run-record-v1',
  });
  return terminal(reminder, signal, options, body);
}
