import { readBoundedPanelJson } from './read-bounded-panel-json';
import type {
  AutoSellRunProgress,
  AutoSellRunProgressEvidence,
} from './auto-sell-run-progress';

export type AutoSellRunProgressFloor = {
  sequence: number;
  accountedRaw: string;
  stopped: boolean;
  headSha256?: string;
  headSequence?: number;
  observedAt?: string;
  startedAttemptIds?: string[];
};
export type AutoSellRunProgressSelection = {
  ownerScope: string;
  projectId: string;
  runId: string;
  runSha256: string;
  minimum: AutoSellRunProgressFloor;
  previousEvidence?: AutoSellRunProgressEvidence;
};
const failed = () =>
  Error(
    'Complete saved progress could not be verified. Previous observations and charged allowance are retained. No session was resumed.',
  );
const cancelled = () =>
  Error(
    'Saved progress checking stopped. No session was resumed or allowance released.',
  );
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
function capture(
  value: unknown,
  depth = 0,
  budget = { nodes: 100000, units: 1048576 },
): unknown {
  if (depth > 16 || --budget.nodes < 0) throw failed();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw failed();
    return value;
  }
  if (typeof value === 'string') {
    budget.units -= value.length;
    if (budget.units < 0) throw failed();
    return value;
  }
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > 2048 ||
      Reflect.ownKeys(value).length !== value.length + 1
    )
      throw failed();
    return Array.from({ length: value.length }, (_, i) => {
      const d = Object.getOwnPropertyDescriptor(value, String(i));
      if (!d?.enumerable || !Object.hasOwn(d, 'value')) throw failed();
      return capture(d.value, depth + 1, budget);
    });
  }
  if (
    !value ||
    typeof value !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw failed();
  const names = Reflect.ownKeys(value);
  if (names.length > 128) throw failed();
  const result: Record<string, unknown> = {};
  for (const key of names) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      key === '__proto__' ||
      !d?.enumerable ||
      !Object.hasOwn(d, 'value')
    )
      throw failed();
    budget.units -= key.length;
    if (budget.units < 0) throw failed();
    result[key] = capture(d.value, depth + 1, budget);
  }
  return result;
}
function closed(value: unknown, required: string[], optional: string[] = []) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw failed();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length < required.length ||
    keys.length > required.length + optional.length ||
    required.some((k) => !Object.hasOwn(value, k))
  )
    throw failed();
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      ![...required, ...optional].includes(key) ||
      !d?.enumerable ||
      !Object.hasOwn(d, 'value')
    )
      throw failed();
    copy[key] = d.value;
  }
  return copy;
}
function field(value: unknown, pattern: RegExp) {
  if (typeof value !== 'string' || !pattern.test(value)) throw failed();
  return value;
}
function stamp(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length !== 24 ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw failed();
  return value;
}
function selection(value: AutoSellRunProgressSelection) {
  const v = closed(
    value,
    ['ownerScope', 'projectId', 'runId', 'runSha256', 'minimum'],
    ['previousEvidence'],
  );
  const f = closed(
    v.minimum,
    ['sequence', 'accountedRaw', 'stopped'],
    ['headSha256', 'headSequence', 'observedAt', 'startedAttemptIds'],
  );
  if (
    typeof f.sequence !== 'number' ||
    !Number.isSafeInteger(f.sequence) ||
    Object.is(f.sequence, -0) ||
    f.sequence < 0 ||
    f.sequence > 1000 ||
    typeof f.stopped !== 'boolean'
  )
    throw failed();
  let startedAttemptIds: string[] | undefined;
  if (f.startedAttemptIds !== undefined) {
    if (
      !Array.isArray(f.startedAttemptIds) ||
      Object.getPrototypeOf(f.startedAttemptIds) !== Array.prototype ||
      f.startedAttemptIds.length > 1000 ||
      Reflect.ownKeys(f.startedAttemptIds).length !==
        f.startedAttemptIds.length + 1
    )
      throw failed();
    startedAttemptIds = Array.from(
      { length: f.startedAttemptIds.length },
      (_, i) => {
        const d = Object.getOwnPropertyDescriptor(
          f.startedAttemptIds,
          String(i),
        );
        if (!d?.enumerable || !Object.hasOwn(d, 'value')) throw failed();
        return field(d.value, UUID);
      },
    );
    if (new Set(startedAttemptIds).size !== startedAttemptIds.length)
      throw failed();
  }
  const raw = field(f.accountedRaw, /^(0|[1-9][0-9]{0,22})$/);
  if (
    f.headSequence !== undefined &&
    (f.headSha256 === undefined ||
      typeof f.headSequence !== 'number' ||
      !Number.isSafeInteger(f.headSequence) ||
      Object.is(f.headSequence, -0) ||
      f.headSequence < 0 ||
      f.headSequence > f.sequence)
  )
    throw failed();
  if (
    BigInt(raw) > ((1n << 64n) - 1n) * BigInt(f.sequence) ||
    (f.sequence === 0) !== (raw === '0')
  )
    throw failed();
  const previousEvidence =
    v.previousEvidence === undefined ? undefined : capture(v.previousEvidence);
  if (
    previousEvidence !== undefined &&
    new TextEncoder().encode(JSON.stringify(previousEvidence)).byteLength >
      1048576
  )
    throw failed();
  return {
    ownerScope: field(v.ownerScope, HASH),
    projectId: field(v.projectId, UUID),
    runId: field(v.runId, UUID),
    runSha256: field(v.runSha256, HASH),
    previousEvidence,
    minimum: {
      sequence: f.sequence,
      accountedRaw: raw,
      stopped: f.stopped,
      ...(f.headSha256 === undefined
        ? {}
        : {
            headSha256: field(f.headSha256, HASH),
            headSequence:
              typeof f.headSequence === 'number' ? f.headSequence : f.sequence,
          }),
      ...(f.observedAt === undefined
        ? {}
        : { observedAt: stamp(f.observedAt) }),
      ...(startedAttemptIds === undefined ? {} : { startedAttemptIds }),
    },
  };
}
function active(signal: AbortSignal) {
  if (signal.aborted) throw cancelled();
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
export async function loadAutoSellRunProgress(
  value: AutoSellRunProgressSelection,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<AutoSellRunProgress> {
  const expected = selection(value);
  active(signal);
  const { readAutoSellRunProgress } = await untilAbort(
    import('./auto-sell-run-progress'),
    signal,
  ).catch(() => {
    throw signal.aborted ? cancelled() : failed();
  });
  let previous: AutoSellRunProgress | null = null;
  if (expected.previousEvidence !== undefined) {
    try {
      previous = await untilAbort(
        readAutoSellRunProgress(expected.previousEvidence),
        signal,
      );
      if (
        previous.run.id !== expected.runId ||
        previous.run.sha256 !== expected.runSha256 ||
        previous.run.profile.terms.projectId !== expected.projectId
      )
        throw failed();
    } catch {
      throw signal.aborted ? cancelled() : failed();
    }
  }
  let response: Response;
  try {
    response = await untilAbort(
      fetcher(
        '/api/imported-projects/auto-sell-run-progress?' +
          new URLSearchParams({
            projectId: expected.projectId,
            runId: expected.runId,
          }),
        {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          headers: { accept: 'application/json' },
          signal,
        },
      ),
      signal,
    );
  } catch {
    throw signal.aborted ? cancelled() : failed();
  }
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => {});
    if (signal.aborted) throw cancelled();
    if (response.status === 409)
      throw Error(
        'Complete saved progress exceeds this view or is unavailable. Use the paged saved attempts; no partial progress was accepted and no session was resumed.',
      );
    throw failed();
  }
  try {
    const body = closed(
      await untilAbort(readBoundedPanelJson(response, signal), signal),
      [
        'ownerScope',
        'evidence',
        'signingAllowed',
        'executionAllowed',
        'automaticResumeAllowed',
        'allowanceReleased',
      ],
    );
    if (
      body.ownerScope !== expected.ownerScope ||
      [
        'signingAllowed',
        'executionAllowed',
        'automaticResumeAllowed',
        'allowanceReleased',
      ].some((k) => body[k] !== false)
    )
      throw failed();
    const progress = await untilAbort(
      readAutoSellRunProgress(body.evidence),
      signal,
    );
    active(signal);
    const { run, accounting } = progress,
      floor = expected.minimum;
    const stopped = progress.evidence.stop !== null;
    if (
      run.id !== expected.runId ||
      run.sha256 !== expected.runSha256 ||
      run.profile.terms.projectId !== expected.projectId ||
      accounting.sequence < floor.sequence ||
      BigInt(accounting.accountedRaw) < BigInt(floor.accountedRaw) ||
      (floor.stopped && !stopped) ||
      (floor.headSha256 &&
        (floor.headSequence === 0
          ? run.sha256
          : progress.evidence.attempts[
              (floor.headSequence ?? floor.sequence) - 1
            ]?.sha256) !== floor.headSha256) ||
      (floor.observedAt && progress.evidence.observedAt < floor.observedAt) ||
      floor.startedAttemptIds?.some(
        (id) =>
          !progress.evidence.preparationStarts.some(
            (start) => start.attemptId === id,
          ),
      )
    )
      throw failed();
    if (
      previous &&
      (JSON.stringify(run) !== JSON.stringify(previous.run) ||
        accounting.sequence < previous.accounting.sequence ||
        BigInt(accounting.accountedRaw) <
          BigInt(previous.accounting.accountedRaw) ||
        progress.evidence.observedAt < previous.evidence.observedAt ||
        previous.evidence.attempts.some(
          (attempt, index) =>
            JSON.stringify(attempt) !==
            JSON.stringify(progress.evidence.attempts[index]),
        ) ||
        previous.evidence.preparationStarts.some(
          (start) =>
            !progress.evidence.preparationStarts.some(
              (current) => JSON.stringify(current) === JSON.stringify(start),
            ),
        ) ||
        (previous.evidence.stop !== null &&
          JSON.stringify(previous.evidence.stop) !==
            JSON.stringify(progress.evidence.stop)))
    )
      throw failed();
    return progress;
  } catch {
    throw signal.aborted ? cancelled() : failed();
  }
}
