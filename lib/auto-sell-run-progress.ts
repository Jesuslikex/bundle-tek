import {
  readAutoSellRun,
  readAutoSellRunAttempt,
  replayAutoSellRun,
  type AutoSellRun,
  type AutoSellRunAttempt,
  type AutoSellRunAccounting,
} from './auto-sell-run';
import { PANEL_JSON_RESPONSE_BYTES } from './read-bounded-panel-json';

export const AUTO_SELL_RUN_PROGRESS_MAX_BYTES = PANEL_JSON_RESPONSE_BYTES;
const authority = {
  signingAllowed: false,
  executionAllowed: false,
  automaticResumeAllowed: false,
  allowanceReleased: false,
} as const;
type Authority = typeof authority;
export type AutoSellRunProgressStart = {
  attemptId: string;
  preparationId: string;
  headSequence: number;
  headSha256: string;
  createdAt: string;
};
export type AutoSellRunProgressStop = {
  format: 'auto-sell-run-stop-v1';
  id: string;
  runId: string;
  runSha256: string;
  createdAt: string;
  signingAllowed: false;
  executionAllowed: false;
  automaticResumeAllowed: false;
};
export type AutoSellRunProgressEvidence = Authority & {
  format: 'auto-sell-run-progress-evidence-v1';
  run: AutoSellRun;
  attempts: AutoSellRunAttempt[];
  head: { sequence: number; headSha256: string };
  preparationStarts: AutoSellRunProgressStart[];
  stop: AutoSellRunProgressStop | null;
  observedAt: string;
};
export type AutoSellRunProgressLifecycle =
  | 'scheduled'
  | 'open'
  | 'expired'
  | 'stopped'
  | 'allowance-exhausted';
export type AutoSellRunProgress = Authority & {
  evidence: AutoSellRunProgressEvidence;
  run: AutoSellRun;
  accounting: AutoSellRunAccounting;
  lifecycle: AutoSellRunProgressLifecycle;
  strategies: {
    id: string;
    chargedRaw: string;
    remainingRaw: string | null;
    endsAt: string | null;
    nextDcaIndex: number;
    nextDcaAt: string | null;
    consumedKeys: string[];
    lifecycle: AutoSellRunProgressLifecycle;
  }[];
  unresolvedAttempts: {
    id: string;
    sequence: number;
    strategyId: string;
    wallet: string;
    walletRevision: number;
    inputRaw: string;
    preparationId: string;
    attemptSha256: string;
    preparationStarted: boolean;
  }[];
  unavailable: {
    historicalQueue: true;
    skippedTriggers: true;
    randomDecisions: true;
    finalizedSales: true;
  };
};
const invalid = () =>
  Error(
    'The complete original Auto Sell progress evidence could not be verified. No allowance or trading authority was restored.',
  );
function closed(value: unknown, keys: readonly string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw invalid();
  const names = Reflect.ownKeys(value);
  if (names.length !== keys.length) throw invalid();
  const result: Record<string, unknown> = {};
  for (const key of names) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      !keys.includes(key) ||
      !d?.enumerable ||
      !Object.hasOwn(d, 'value')
    )
      throw invalid();
    result[key] = d.value;
  }
  return result;
}
function capture(
  value: unknown,
  depth = 0,
  budget = { nodes: 100000, units: AUTO_SELL_RUN_PROGRESS_MAX_BYTES },
): unknown {
  if (depth > 16 || --budget.nodes < 0) throw invalid();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    budget.units -= value.length;
    if (budget.units < 0) throw invalid();
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw invalid();
    return value;
  }
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > 2048 ||
      Reflect.ownKeys(value).length !== value.length + 1
    )
      throw invalid();
    return Array.from({ length: value.length }, (_, index) => {
      const d = Object.getOwnPropertyDescriptor(value, String(index));
      if (!d?.enumerable || !Object.hasOwn(d, 'value')) throw invalid();
      return capture(d.value, depth + 1, budget);
    });
  }
  if (
    !value ||
    typeof value !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw invalid();
  const names = Reflect.ownKeys(value);
  if (names.length > 64) throw invalid();
  const result: Record<string, unknown> = {};
  for (const key of names) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      key === '__proto__' ||
      !d?.enumerable ||
      !Object.hasOwn(d, 'value')
    )
      throw invalid();
    budget.units -= key.length;
    if (budget.units < 0) throw invalid();
    result[key] = capture(d.value, depth + 1, budget);
  }
  return result;
}
function id(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      value,
    )
  )
    throw invalid();
  return value;
}
function hash(value: unknown) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw invalid();
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
    throw invalid();
  return value;
}
function timestamp(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length !== 24 ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw invalid();
  return value;
}
function falseAuthority(row: Record<string, unknown>, release = true) {
  for (const key of Object.keys(authority))
    if ((release || key !== 'allowanceReleased') && row[key] !== false)
      throw invalid();
}
function minimum(a: bigint | null, b: bigint | null): bigint | null {
  return a === null ? b : b === null ? a : a < b ? a : b;
}
/** Independent replay of a complete saved journal. This never reconstructs an executable queue. */
export async function readAutoSellRunProgress(
  value: unknown,
): Promise<AutoSellRunProgress> {
  const copy = capture(value);
  if (
    new TextEncoder().encode(JSON.stringify(copy)).byteLength >
    AUTO_SELL_RUN_PROGRESS_MAX_BYTES
  )
    throw invalid();
  const row = closed(copy, [
    'format',
    'run',
    'attempts',
    'head',
    'preparationStarts',
    'stop',
    'observedAt',
    ...Object.keys(authority),
  ]);
  falseAuthority(row);
  if (
    row.format !== 'auto-sell-run-progress-evidence-v1' ||
    !Array.isArray(row.attempts) ||
    row.attempts.length > 1000 ||
    !Array.isArray(row.preparationStarts) ||
    row.preparationStarts.length > row.attempts.length
  )
    throw invalid();
  const observedAt = timestamp(row.observedAt),
    observed = Date.parse(observedAt);
  const run = await readAutoSellRun(row.run);
  const attempts: AutoSellRunAttempt[] = [];
  for (const input of row.attempts)
    attempts.push(await readAutoSellRunAttempt(input));
  const accounting = await replayAutoSellRun(run, attempts);
  const h = closed(row.head, ['sequence', 'headSha256']);
  const head = {
    sequence: integer(h.sequence),
    headSha256: hash(h.headSha256),
  };
  if (
    head.sequence !== accounting.sequence ||
    head.headSha256 !== accounting.headSha256 ||
    observed < Date.parse(attempts.at(-1)?.reservedAt ?? run.createdAt)
  )
    throw invalid();
  let stop: AutoSellRunProgressStop | null = null;
  if (row.stop !== null) {
    const s = closed(row.stop, [
      'format',
      'id',
      'runId',
      'runSha256',
      'createdAt',
      'signingAllowed',
      'executionAllowed',
      'automaticResumeAllowed',
    ]);
    falseAuthority(s, false);
    if (
      s.format !== 'auto-sell-run-stop-v1' ||
      s.runId !== run.id ||
      s.runSha256 !== run.sha256
    )
      throw invalid();
    const createdAt = timestamp(s.createdAt);
    // SQL clocks are sampled before the awaited writes. A Stop can commit after
    // newer attempts/starts while retaining an earlier sampled timestamp.
    // These timestamps do not establish causal order or execution authority.
    if (
      Date.parse(createdAt) < Date.parse(run.createdAt) ||
      Date.parse(createdAt) > observed
    )
      throw invalid();
    stop = {
      format: 'auto-sell-run-stop-v1',
      id: id(s.id),
      runId: run.id,
      runSha256: run.sha256,
      createdAt,
      signingAllowed: false,
      executionAllowed: false,
      automaticResumeAllowed: false,
    };
  }
  const preparationStarts: AutoSellRunProgressStart[] = [];
  const started = new Set<string>(),
    preparations = new Set<string>();
  let previousStart = Date.parse(run.createdAt);
  let previousHead = 0;
  for (const input of row.preparationStarts) {
    const s = closed(input, [
      'attemptId',
      'preparationId',
      'headSequence',
      'headSha256',
      'createdAt',
    ]);
    const attemptId = id(s.attemptId),
      preparationId = id(s.preparationId),
      headSequence = integer(s.headSequence, 1, head.sequence),
      headSha256 = hash(s.headSha256),
      createdAt = timestamp(s.createdAt);
    const attempt = attempts.find((a) => a.id === attemptId),
      at = Date.parse(createdAt),
      atHead = attempts[headSequence - 1];
    if (
      !attempt ||
      attempt.preparationId !== preparationId ||
      headSequence < attempt.sequence ||
      (at > previousStart && headSequence < previousHead) ||
      !atHead ||
      atHead.sha256 !== headSha256 ||
      started.has(attemptId) ||
      preparations.has(preparationId) ||
      at < Date.parse(atHead.reservedAt) ||
      at < previousStart ||
      at > observed ||
      at < Date.parse(run.activeAt) ||
      (run.endsAt !== null && at >= Date.parse(run.endsAt))
    )
      throw invalid();
    const strategyEnd = run.limits.strategies.find(
      (s) => s.id === attempt.strategyId,
    )!.endsAt;
    if (strategyEnd !== null && at >= Date.parse(strategyEnd)) throw invalid();
    started.add(attemptId);
    preparations.add(preparationId);
    previousStart = at;
    previousHead = Math.max(previousHead, headSequence);
    preparationStarts.push({
      attemptId,
      preparationId,
      headSequence,
      headSha256,
      createdAt,
    });
  }
  const sessionRemaining =
    run.limits.sessionRaw === null
      ? null
      : BigInt(run.limits.sessionRaw) - BigInt(accounting.accountedRaw);
  const lifecycle: AutoSellRunProgressLifecycle = stop
    ? 'stopped'
    : run.endsAt !== null && observed >= Date.parse(run.endsAt)
      ? 'expired'
      : sessionRemaining !== null && sessionRemaining <= 0n
        ? 'allowance-exhausted'
        : observed < Date.parse(run.activeAt)
          ? 'scheduled'
          : 'open';
  const strategies = accounting.strategies.map((state) => {
    const limit = run.limits.strategies.find((s) => s.id === state.id)!;
    const ownRemaining =
      limit.capRaw === null
        ? null
        : BigInt(limit.capRaw) - BigInt(state.accountedRaw);
    const remaining = minimum(ownRemaining, sessionRemaining);
    const strategyLifecycle: AutoSellRunProgressLifecycle =
      lifecycle !== 'open'
        ? lifecycle
        : limit.endsAt !== null && observed >= Date.parse(limit.endsAt)
          ? 'expired'
          : remaining !== null && remaining <= 0n
            ? 'allowance-exhausted'
            : 'open';
    return {
      id: state.id,
      chargedRaw: state.accountedRaw,
      remainingRaw: remaining?.toString() ?? null,
      endsAt: limit.endsAt,
      nextDcaIndex: state.nextDcaIndex,
      nextDcaAt: state.nextDcaAt,
      consumedKeys: [...state.claimedKeys],
      lifecycle: strategyLifecycle,
    };
  });
  const evidence: AutoSellRunProgressEvidence = {
    format: 'auto-sell-run-progress-evidence-v1',
    run,
    attempts,
    head,
    preparationStarts,
    stop,
    observedAt,
    ...authority,
  };
  return {
    evidence,
    run,
    accounting,
    lifecycle,
    strategies,
    unresolvedAttempts: attempts.map((a) => ({
      id: a.id,
      sequence: a.sequence,
      strategyId: a.strategyId,
      wallet: a.wallet,
      walletRevision: a.walletRevision,
      inputRaw: a.inputRaw,
      preparationId: a.preparationId,
      attemptSha256: a.sha256,
      preparationStarted: started.has(a.id),
    })),
    unavailable: {
      historicalQueue: true,
      skippedTriggers: true,
      randomDecisions: true,
      finalizedSales: true,
    },
    ...authority,
  };
}
export const deriveAutoSellRunProgress = readAutoSellRunProgress;
