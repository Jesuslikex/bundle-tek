import { amountToRaw, endCapRaw, minimumAutoSellRaw } from './auto-sell';
import { autoSellSessionCap } from './auto-sell-session';
import {
  readSavedAutoSellProfile,
  type SavedAutoSellProfile,
} from './auto-sell-profile';
import bs58 from 'bs58';

export const AUTO_SELL_RUN_MAX_BYTES = 393216;
export const AUTO_SELL_RUN_ATTEMPT_MAX_BYTES = 32768;
export const AUTO_SELL_RUN_MAX_ATTEMPTS = 1000;
const U64 = (1n << 64n) - 1n;
const TOTAL_MAX = U64 * BigInt(AUTO_SELL_RUN_MAX_ATTEMPTS);
const BASE = 1_000_000_000n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const authority = {
  signingAllowed: false,
  executionAllowed: false,
  automaticResumeAllowed: false,
} as const;
type Authority = typeof authority;
export type AutoSellRunWallet = {
  address: string;
  revision: number;
  archived: boolean;
};
export type AutoSellRun = Authority & {
  format: 'auto-sell-run-v1';
  id: string;
  createdAt: string;
  activeAt: string;
  endsAt: string | null;
  profile: SavedAutoSellProfile;
  ownWallets: AutoSellRunWallet[];
  limits: {
    sessionRaw: string | null;
    strategies: { id: string; capRaw: string | null; endsAt: string | null }[];
  };
  sha256: string;
};
export type AutoSellRunOccurrence =
  | { kind: 'dca'; index: number; drawRaw: string }
  | { kind: 'limit'; ids: string[] }
  | { kind: 'counter'; sourceIds: string[]; bufferedRaw: string };
export type AutoSellRunAttemptInput = {
  id: string;
  runId: string;
  expectedSequence: number;
  expectedHeadSha256: string;
  strategyId: string;
  wallet: string;
  walletRevision: number;
  inputRaw: string;
  occurrence: AutoSellRunOccurrence;
  consent: 'reserve-auto-sell-attempt-v1';
};
export type AutoSellRunAttempt = Authority & {
  format: 'auto-sell-run-attempt-v1';
  id: string;
  runId: string;
  runSha256: string;
  sequence: number;
  previousSha256: string;
  strategyId: string;
  wallet: string;
  walletRevision: number;
  inputRaw: string;
  occurrence: AutoSellRunOccurrence;
  preparationId: string;
  reservedAt: string;
  sha256: string;
};
export type AutoSellRunAccounting = {
  sequence: number;
  headSha256: string;
  accountedRaw: string;
  strategies: {
    id: string;
    accountedRaw: string;
    claimedKeys: string[];
    nextDcaIndex: number;
    nextDcaAt: string | null;
  }[];
};
const invalid = () =>
  Error(
    'The original Auto Sell run journal is invalid. Keep its recovery references.',
  );
function record(
  value: unknown,
  keys?: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw invalid();
  const names = Reflect.ownKeys(value);
  if (names.length > 64 || (keys && names.length !== keys.length))
    throw invalid();
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      (keys && !keys.includes(key)) ||
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    )
      throw invalid();
  }
  return value as Record<string, unknown>;
}
function list(value: unknown, max: number): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    throw invalid();
  return Array.from({ length: value.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) throw invalid();
    return d.value;
  });
}
function text(value: unknown, max = 128): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > max ||
    value !== value.trim()
  )
    throw invalid();
  for (const c of value)
    if (
      c.length === 1 &&
      c.charCodeAt(0) >= 0xd800 &&
      c.charCodeAt(0) <= 0xdfff
    )
      throw invalid();
  return value;
}
function integer(value: unknown, min: number, max = 1_000_000_000): number {
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
export function autoSellRunId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid();
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) throw invalid();
  return value;
}
function timestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length !== 24 ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw invalid();
  return value;
}
function raw(value: unknown, max = U64, zero = false): string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]{0,22})$/.test(value) ||
    BigInt(value) > max ||
    (!zero && value === '0')
  )
    throw invalid();
  return value;
}
function detached(value: unknown, max: number): unknown {
  let nodes = 40_000,
    units = max;
  function copy(v: unknown, depth: number): unknown {
    if (--nodes < 0 || depth > 20) throw invalid();
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      units -= v.length;
      if (units < 0) throw invalid();
      for (const c of v)
        if (
          c.length === 1 &&
          c.charCodeAt(0) >= 0xd800 &&
          c.charCodeAt(0) <= 0xdfff
        )
          throw invalid();
      return v;
    }
    if (typeof v === 'number') {
      if (!Number.isFinite(v) || Object.is(v, -0)) throw invalid();
      return v;
    }
    if (Array.isArray(v)) return list(v, 2048).map((x) => copy(x, depth + 1));
    const r = record(v);
    return Object.fromEntries(
      Object.keys(r).map((k) => [k, copy(r[k], depth + 1)]),
    );
  }
  const result = copy(value, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > max)
    throw invalid();
  return result;
}
async function digest(domain: string, value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify([domain, value]));
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
export function autoSellRunAmountLimbs(value: string) {
  const n = BigInt(raw(value, TOTAL_MAX, true));
  return {
    high: Number(n / BASE / BASE),
    middle: Number((n / BASE) % BASE),
    low: Number(n % BASE),
  };
}
export function autoSellRunLimbsRaw(value: unknown): string {
  const r = record(value, ['high', 'middle', 'low']);
  return raw(
    (
      BigInt(integer(r.high, 0, 999999999)) * BASE * BASE +
      BigInt(integer(r.middle, 0, 999999999)) * BASE +
      BigInt(integer(r.low, 0, 999999999))
    ).toString(),
    TOTAL_MAX,
    true,
  );
}
function wallets(value: unknown): AutoSellRunWallet[] {
  const result = list(value, 1000)
    .map((v) => {
      const r = record(v, ['address', 'revision', 'archived']);
      if (
        typeof r.address !== 'string' ||
        !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.address) ||
        bs58.decode(r.address).length !== 32 ||
        typeof r.archived !== 'boolean'
      )
        throw invalid();
      return {
        address: r.address,
        revision: integer(r.revision, 1),
        archived: r.archived,
      };
    })
    .sort((a, b) =>
      a.address < b.address ? -1 : a.address > b.address ? 1 : 0,
    );
  if (new Set(result.map((w) => w.address)).size !== result.length)
    throw invalid();
  return result;
}
export async function createAutoSellRun(
  id: string,
  savedProfile: unknown,
  ownWallets: unknown,
  createdAt: string,
): Promise<AutoSellRun> {
  const runId = autoSellRunId(id),
    profileInput = detached(savedProfile, 263168),
    roster = wallets(detached(ownWallets, 131072)),
    created = timestamp(createdAt);
  const profile = await readSavedAutoSellProfile(profileInput);
  if (
    Date.parse(created) < Date.parse(profile.createdAt) ||
    profile.terms.wallets.some(
      (w) =>
        !roster.some(
          (r) =>
            r.address === w.address && r.revision === w.revision && !r.archived,
        ),
    )
  )
    throw invalid();
  const active =
    Date.parse(created) +
    profile.terms.configuration.session.startDelaySeconds * 1000;
  const activeAt = new Date(active).toISOString();
  const session = profile.terms.configuration.session,
    supply = BigInt(profile.terms.token.totalSupplyRaw),
    decimals = profile.terms.token.decimals;
  const limits = {
    sessionRaw:
      autoSellSessionCap(session, supply, decimals)?.toString() ?? null,
    strategies: profile.terms.configuration.strategies.map((s) => ({
      id: text(s.id),
      capRaw: endCapRaw(s, supply, decimals)?.toString() ?? null,
      endsAt: s.endDurationSeconds
        ? new Date(active + s.endDurationSeconds * 1000).toISOString()
        : null,
    })),
  };
  const body = {
    format: 'auto-sell-run-v1' as const,
    id: runId,
    createdAt: created,
    activeAt,
    endsAt: session.endDurationSeconds
      ? new Date(active + session.endDurationSeconds * 1000).toISOString()
      : null,
    profile,
    ownWallets: roster,
    limits,
    ...authority,
  };
  const result = { ...body, sha256: await digest('auto-sell-run-v1', body) };
  if (
    new TextEncoder().encode(JSON.stringify(result)).byteLength >
    AUTO_SELL_RUN_MAX_BYTES
  )
    throw invalid();
  return result;
}
export async function readAutoSellRun(value: unknown): Promise<AutoSellRun> {
  const r = record(detached(value, AUTO_SELL_RUN_MAX_BYTES), [
    'format',
    'id',
    'createdAt',
    'activeAt',
    'endsAt',
    'profile',
    'ownWallets',
    'limits',
    'sha256',
    ...Object.keys(authority),
  ]);
  if (
    r.format !== 'auto-sell-run-v1' ||
    Object.keys(authority).some((k) => r[k] !== false)
  )
    throw invalid();
  const result = await createAutoSellRun(
    autoSellRunId(r.id),
    r.profile,
    r.ownWallets,
    timestamp(r.createdAt),
  );
  if (
    result.sha256 !== hash(r.sha256) ||
    result.activeAt !== r.activeAt ||
    result.endsAt !== r.endsAt ||
    JSON.stringify(result.limits) !== JSON.stringify(r.limits) ||
    JSON.stringify(result.ownWallets) !== JSON.stringify(r.ownWallets)
  )
    throw invalid();
  return result;
}
function ids(value: unknown): string[] {
  const result = list(value, 128).map((v) => text(v));
  if (!result.length || new Set(result).size !== result.length) throw invalid();
  return result;
}
function proposedRaw(value: unknown): string {
  // A configured draw can exceed one packet's U64 input before the existing
  // session/strategy caps clip it. Only the actually reserved input is U64.
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,511}$/.test(value))
    throw invalid();
  return value;
}
function occurrence(value: unknown): AutoSellRunOccurrence {
  const r = record(value);
  if (r.kind === 'dca') {
    record(r, ['kind', 'index', 'drawRaw']);
    return {
      kind: 'dca',
      index: integer(r.index, 0, 999),
      drawRaw: proposedRaw(r.drawRaw),
    };
  }
  if (r.kind === 'limit') {
    record(r, ['kind', 'ids']);
    return { kind: 'limit', ids: ids(r.ids) };
  }
  if (r.kind === 'counter') {
    record(r, ['kind', 'sourceIds', 'bufferedRaw']);
    return {
      kind: 'counter',
      sourceIds: ids(r.sourceIds),
      bufferedRaw: raw(r.bufferedRaw, TOTAL_MAX),
    };
  }
  throw invalid();
}
export function autoSellRunOccurrenceKeys(value: unknown): string[] {
  const o = occurrence(value);
  return o.kind === 'dca'
    ? ['dca:' + o.index]
    : o.kind === 'limit'
      ? o.ids.map((id) => 'limit:' + id)
      : o.sourceIds.map((id) => 'counter:' + id);
}
export function readAutoSellRunAttemptInput(
  value: unknown,
): AutoSellRunAttemptInput {
  const r = record(detached(value, AUTO_SELL_RUN_ATTEMPT_MAX_BYTES), [
    'id',
    'runId',
    'expectedSequence',
    'expectedHeadSha256',
    'strategyId',
    'wallet',
    'walletRevision',
    'inputRaw',
    'occurrence',
    'consent',
  ]);
  if (
    r.consent !== 'reserve-auto-sell-attempt-v1' ||
    typeof r.wallet !== 'string' ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.wallet)
  )
    throw invalid();
  return {
    id: autoSellRunId(r.id),
    runId: autoSellRunId(r.runId),
    expectedSequence: integer(r.expectedSequence, 0, 999),
    expectedHeadSha256: hash(r.expectedHeadSha256),
    strategyId: text(r.strategyId),
    wallet: r.wallet,
    walletRevision: integer(r.walletRevision, 1),
    inputRaw: raw(r.inputRaw),
    occurrence: occurrence(r.occurrence),
    consent: 'reserve-auto-sell-attempt-v1',
  };
}
export async function readAutoSellRunAttempt(
  value: unknown,
): Promise<AutoSellRunAttempt> {
  const r = record(detached(value, AUTO_SELL_RUN_ATTEMPT_MAX_BYTES), [
    'format',
    'id',
    'runId',
    'runSha256',
    'sequence',
    'previousSha256',
    'strategyId',
    'wallet',
    'walletRevision',
    'inputRaw',
    'occurrence',
    'preparationId',
    'reservedAt',
    'sha256',
    ...Object.keys(authority),
  ]);
  if (
    r.format !== 'auto-sell-run-attempt-v1' ||
    Object.keys(authority).some((k) => r[k] !== false) ||
    typeof r.wallet !== 'string' ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.wallet)
  )
    throw invalid();
  const body = {
    format: 'auto-sell-run-attempt-v1' as const,
    id: autoSellRunId(r.id),
    runId: autoSellRunId(r.runId),
    runSha256: hash(r.runSha256),
    sequence: integer(r.sequence, 1, 1000),
    previousSha256: hash(r.previousSha256),
    strategyId: text(r.strategyId),
    wallet: r.wallet,
    walletRevision: integer(r.walletRevision, 1),
    inputRaw: raw(r.inputRaw),
    occurrence: occurrence(r.occurrence),
    preparationId: autoSellRunId(r.preparationId),
    reservedAt: timestamp(r.reservedAt),
    ...authority,
  };
  const expected = await digest('auto-sell-run-attempt-v1', body);
  if (expected !== hash(r.sha256)) throw invalid();
  return { ...body, sha256: expected };
}
function initial(run: AutoSellRun): AutoSellRunAccounting {
  return {
    sequence: 0,
    headSha256: run.sha256,
    accountedRaw: '0',
    strategies: run.profile.terms.configuration.strategies.map((s) => ({
      id: s.id,
      accountedRaw: '0',
      claimedKeys: [],
      nextDcaIndex: 0,
      nextDcaAt: s.mode === 'dca' ? run.activeAt : null,
    })),
  };
}
function append(
  run: AutoSellRun,
  state: AutoSellRunAccounting,
  attempt: AutoSellRunAttempt,
) {
  const s = run.profile.terms.configuration.strategies.find(
      (s) => s.id === attempt.strategyId,
    ),
    st = state.strategies.find((s) => s.id === attempt.strategyId),
    limit = run.limits.strategies.find((s) => s.id === attempt.strategyId);
  if (
    !s ||
    !st ||
    !limit ||
    attempt.runId !== run.id ||
    attempt.runSha256 !== run.sha256 ||
    attempt.sequence !== state.sequence + 1 ||
    attempt.previousSha256 !== state.headSha256 ||
    !run.profile.terms.wallets.some(
      (w) =>
        w.address === attempt.wallet && w.revision === attempt.walletRevision,
    )
  )
    throw invalid();
  const at = Date.parse(attempt.reservedAt),
    active = Date.parse(run.activeAt);
  if (
    at < active ||
    (run.endsAt !== null && at >= Date.parse(run.endsAt)) ||
    (limit.endsAt !== null && at >= Date.parse(limit.endsAt))
  )
    throw invalid();
  const supply = BigInt(run.profile.terms.token.totalSupplyRaw),
    decimals = run.profile.terms.token.decimals,
    o = attempt.occurrence;
  let proposed: bigint, keys: string[];
  if (s.mode === 'dca' && o.kind === 'dca') {
    if (
      o.index !== st.nextDcaIndex ||
      st.nextDcaAt === null ||
      at < Date.parse(st.nextDcaAt)
    )
      throw invalid();
    proposed = BigInt(o.drawRaw);
    if (s.dcaRandomized) {
      if (
        proposed < amountToRaw(s, s.dcaMinAmount, supply, decimals) ||
        proposed > amountToRaw(s, s.dcaMaxAmount, supply, decimals)
      )
        throw invalid();
    } else if (proposed !== amountToRaw(s, s.dcaAmount, supply, decimals))
      throw invalid();
    keys = ['dca:' + o.index];
  } else if (s.mode === 'limit' && o.kind === 'limit') {
    proposed = 0n;
    keys = o.ids.map((id) => 'limit:' + id);
    for (const id of o.ids) {
      const row = s.limitOrders.find((r) => r.id === id);
      if (!row) throw invalid();
      proposed += amountToRaw(s, row.amount, supply, decimals);
    }
  } else if (s.mode === 'counter' && o.kind === 'counter') {
    proposed = BigInt(o.bufferedRaw);
    keys = o.sourceIds.map((id) => 'counter:' + id);
  } else throw invalid();
  if (keys.some((k) => st.claimedKeys.includes(k))) throw invalid();
  let expected = proposed;
  if (run.limits.sessionRaw !== null) {
    const room = BigInt(run.limits.sessionRaw) - BigInt(state.accountedRaw);
    if (room < expected) expected = room;
  }
  if (limit.capRaw !== null) {
    const room = BigInt(limit.capRaw) - BigInt(st.accountedRaw);
    if (room < expected) expected = room;
  }
  if (
    expected <= 0n ||
    expected > U64 ||
    expected.toString() !== attempt.inputRaw ||
    expected < minimumAutoSellRaw(s, supply)
  )
    throw invalid();
  state.accountedRaw = raw(
    (BigInt(state.accountedRaw) + expected).toString(),
    TOTAL_MAX,
    true,
  );
  st.accountedRaw = raw(
    (BigInt(st.accountedRaw) + expected).toString(),
    TOTAL_MAX,
    true,
  );
  st.claimedKeys.push(...keys);
  if (o.kind === 'dca') {
    st.nextDcaIndex++;
    st.nextDcaAt = new Date(at + s.dcaIntervalSeconds * 1000).toISOString();
  }
  state.sequence = attempt.sequence;
  state.headSha256 = attempt.sha256;
}
function captureHistory(value: unknown) {
  let bytes = 0;
  return list(value, AUTO_SELL_RUN_MAX_ATTEMPTS).map((v) => {
    const result = detached(v, AUTO_SELL_RUN_ATTEMPT_MAX_BYTES);
    bytes += new TextEncoder().encode(JSON.stringify(result)).byteLength;
    if (bytes > 32 * 1024 * 1024) throw invalid();
    return result;
  });
}
async function replay(
  run: AutoSellRun,
  values: unknown[],
): Promise<AutoSellRunAccounting> {
  const state = initial(run),
    ids = new Set<string>(),
    preparations = new Set<string>();
  let last = Date.parse(run.createdAt);
  for (const value of values) {
    const a = await readAutoSellRunAttempt(value);
    if (
      ids.has(a.id) ||
      preparations.has(a.preparationId) ||
      Date.parse(a.reservedAt) < last
    )
      throw invalid();
    ids.add(a.id);
    preparations.add(a.preparationId);
    last = Date.parse(a.reservedAt);
    append(run, state, a);
  }
  return state;
}
export async function replayAutoSellRun(
  value: unknown,
  attempts: unknown,
): Promise<AutoSellRunAccounting> {
  const captured = detached(value, AUTO_SELL_RUN_MAX_BYTES),
    history = captureHistory(attempts);
  return replay(await readAutoSellRun(captured), history);
}
/** Journal reservations are conservative exposure records, never a qualified trade decision. */
export async function createAutoSellRunAttempt(
  runValue: unknown,
  priorAttempts: unknown,
  inputValue: unknown,
  preparationId: string,
  reservedAt: string,
): Promise<AutoSellRunAttempt> {
  const captured = detached(runValue, AUTO_SELL_RUN_MAX_BYTES),
    history = captureHistory(priorAttempts),
    input = readAutoSellRunAttemptInput(inputValue),
    prep = autoSellRunId(preparationId),
    at = timestamp(reservedAt);
  const run = await readAutoSellRun(captured),
    state = await replay(run, history);
  if (
    input.runId !== run.id ||
    input.expectedSequence !== state.sequence ||
    input.expectedHeadSha256 !== state.headSha256 ||
    state.sequence >= AUTO_SELL_RUN_MAX_ATTEMPTS
  )
    throw invalid();
  const body = {
    format: 'auto-sell-run-attempt-v1' as const,
    id: input.id,
    runId: run.id,
    runSha256: run.sha256,
    sequence: state.sequence + 1,
    previousSha256: state.headSha256,
    strategyId: input.strategyId,
    wallet: input.wallet,
    walletRevision: input.walletRevision,
    inputRaw: input.inputRaw,
    occurrence: input.occurrence,
    preparationId: prep,
    reservedAt: at,
    ...authority,
  };
  const result = {
    ...body,
    sha256: await digest('auto-sell-run-attempt-v1', body),
  };
  if (
    history.some(
      (a) => record(a).id === result.id || record(a).preparationId === prep,
    ) ||
    Date.parse(at) <
      (history.length
        ? Date.parse(String(record(history.at(-1)).reservedAt))
        : Date.parse(run.createdAt))
  )
    throw invalid();
  append(run, state, result);
  return readAutoSellRunAttempt(result);
}
