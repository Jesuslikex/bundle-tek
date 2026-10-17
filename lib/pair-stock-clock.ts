import {
  pairReviewDiagnostic,
  pairDiagnosticComparisons,
} from './pair-review-diagnostic';

export const PAIR_CLOCK = 'SysvarC1ock11111111111111111111111111111111';
export const PAIR_SYSVAR_OWNER = 'Sysvar1111111111111111111111111111111111111';
export type PairClockObservation = {
  contextSlot: number;
  clockSlot: number;
  slot: number;
  relation: 'equal' | '+1';
  unixTimestamp: string;
};
export class StockPairEvidenceError extends Error {}
export type StockPairRpc = (
  method: string,
  params: unknown[],
  signal?: AbortSignal,
) => Promise<unknown>;
type Rpc = StockPairRpc;
const stockResponses = new WeakMap<object, PairClockObservation>();
type StockScope = {
  rpc: Rpc;
  programRpc: Rpc;
  observations: PairClockObservation[];
  accountLimit: 5 | 100;
  signal?: AbortSignal;
  now: () => number;
  latest: () => number;
  partitions: unknown[];
};
const stockScopes = new WeakMap<Rpc, StockScope>();
export function stockPairRpcScope(rpc: Rpc) {
  return stockScopes.get(rpc);
}
export function inheritStockPairRpcScope<T extends Rpc>(
  source: Rpc,
  target: T,
): T {
  const scope = stockScopes.get(source);
  if (scope) stockScopes.set(target, scope);
  return target;
}
/** SOLANA_STOCK_RUNTIME_ACCOUNT_LIMIT overrides the host default, e.g. 100 after a QuickNode plan upgrade. */
export function stockPairAccountLimit(
  endpoint: string,
  configured = typeof process === 'undefined'
    ? undefined
    : process.env.SOLANA_STOCK_RUNTIME_ACCOUNT_LIMIT,
): 5 | 100 {
  if (configured === '5' || configured === '100')
    return configured === '5' ? 5 : 100;
  if (configured) throw Error('Stock runtime account limit must be 5 or 100.');
  const url = new URL(endpoint);
  return url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    url.hostname.endsWith('.quiknode.pro')
    ? 5
    : 100;
}
/** Only removes the final redundant Clock from an already verified real response. */
export function trimStockPairClockResponse(response: {
  context?: { slot?: unknown };
  value?: unknown[];
}) {
  const observation = stockResponses.get(response);
  if (
    !observation ||
    !Array.isArray(response.value) ||
    response.value.length < 2
  )
    throw Error('Verified stock Clock response required.');
  const result = { ...response, value: response.value.slice(0, -1) };
  stockResponses.set(result, observation);
  return result;
}

function inspectClock(
  raw: unknown,
  contextSlot: number,
  now: number,
  stock = false,
): PairClockObservation {
  const a = raw as { owner?: unknown; executable?: unknown; data?: unknown };
  if (!Number.isSafeInteger(contextSlot) || contextSlot < 1)
    throw Error('Pair chain clock slot is invalid.');
  if (
    !a ||
    a.owner !== PAIR_SYSVAR_OWNER ||
    a.executable !== false ||
    !Array.isArray(a.data) ||
    a.data.length !== 2 ||
    a.data[1] !== 'base64' ||
    typeof a.data[0] !== 'string' ||
    a.data[0].length !== 56
  )
    throw Error('Pair clock RPC account is unavailable.');
  const text = atob(a.data[0]);
  if (text.length !== 40 || btoa(text) !== a.data[0])
    throw Error('Pair clock RPC account is noncanonical.');
  const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    clockSlot = view.getBigUint64(0, true),
    unix = view.getBigInt64(32, true);
  if (
    (clockSlot !== BigInt(contextSlot) &&
      (!stock || clockSlot !== BigInt(contextSlot) + 1n)) ||
    clockSlot > BigInt(Number.MAX_SAFE_INTEGER) ||
    unix < 1n ||
    unix > BigInt(Number.MAX_SAFE_INTEGER) ||
    !Number.isFinite(now) ||
    Math.abs(Number(unix) * 1000 - now) > 30000
  )
    throw pairReviewDiagnostic(
      new Error('Pair chain clock is inconsistent or stale.'),
      'chain-clock',
      {
        contextSlot,
        clockSlot: Number(clockSlot),
        wallSkewMs: now - Number(unix) * 1000,
        evaluatedServerTimeMs: now,
        comparisons: pairDiagnosticComparisons(
          {
            slot: contextSlot,
            unixTimestamp: String(Math.floor(now / 1000)),
            wallSkewLimitMs: '30000',
          },
          {
            slot: clockSlot.toString(),
            unixTimestamp: unix.toString(),
            wallSkewLimitMs: '30000',
          },
        ),
      },
    );
  return {
    contextSlot,
    clockSlot: Number(clockSlot),
    slot: Number(clockSlot),
    relation: clockSlot === BigInt(contextSlot) ? 'equal' : '+1',
    unixTimestamp: unix.toString(),
  };
}
/** Every ordinary caller, including other Clock paths, retains exact equality. */
export function pairClockUnixTimestamp(
  raw: unknown,
  slot: number,
  now = Date.now(),
) {
  return inspectClock(raw, slot, now).unixTimestamp;
}
/** Only responses observed through the stock-specific server wrapper opt in. Raw context is never rewritten. */
export function pairEvidenceClock(
  response: object,
  raw: unknown,
  contextSlot: number,
  now: number,
) {
  const recorded = stockResponses.get(response),
    measured = inspectClock(raw, contextSlot, now, !!recorded);
  if (recorded && JSON.stringify(recorded) !== JSON.stringify(measured))
    throw Error('Stock Clock observation changed.');
  return measured;
}
/** One lifecycle, one floor shared by ordinary and code reads. No settings or signing authority. */
export function createStockPairEvidenceRpc(
  rpc: Rpc,
  codeRpc: Rpc = rpc,
  now: () => number = Date.now,
  options?: { endpoint: string; signal: AbortSignal },
) {
  const existing = stockScopes.get(rpc);
  if (existing?.accountLimit === 5) {
    if (codeRpc !== rpc && stockScopes.get(codeRpc) !== existing)
      throw Error('Stock RPC scopes differ.');
    return existing;
  }
  let latest = 0;
  const observations: PairClockObservation[] = [];
  const stockClock = (raw: unknown, slot: number) => {
    try {
      return inspectClock(raw, slot, now(), true);
    } catch (cause) {
      throw new StockPairEvidenceError(
        cause instanceof Error
          ? cause.message
          : 'Stock Clock observation refused.',
        { cause },
      );
    }
  };
  const wrap =
    (source: Rpc): Rpc =>
    async (method, params, requestSignal) => {
      requestSignal?.throwIfAborted();
      options?.signal.throwIfAborted();
      const configIndex = ['getSlot', 'getBlockHeight'].includes(method)
        ? 0
        : 1;
      const config = params[configIndex] as
        | { minContextSlot?: number; dataSlice?: unknown }
        | undefined;
      const keys =
        method === 'getMultipleAccounts' ? (params[0] as string[]) : [];
      const clocks = keys.flatMap((key, i) => (key === PAIR_CLOCK ? [i] : []));
      if (clocks.length && config?.dataSlice)
        throw new StockPairEvidenceError(
          'Stock Clock requires full account bytes.',
        );
      const floor = Math.max(latest, config?.minContextSlot ?? 0);
      const scoped = [...params];
      if (config?.minContextSlot !== undefined)
        scoped[configIndex] = { ...config, minContextSlot: floor };
      // Obtain two actual Clock values in the same response, without hiding duplicate disagreement.
      if (clocks.length === 1) scoped[0] = [...keys, PAIR_CLOCK];
      const result = (await source(method, scoped, requestSignal)) as {
        context?: { slot?: unknown };
        value?: unknown[];
      };
      requestSignal?.throwIfAborted();
      options?.signal.throwIfAborted();
      if (
        config?.minContextSlot !== undefined &&
        [
          'getMultipleAccounts',
          'getFeeForMessage',
          'isBlockhashValid',
          'simulateTransaction',
        ].includes(method)
      ) {
        const context = result?.context?.slot;
        if (
          typeof context !== 'string' ||
          !/^[1-9]\d{0,15}$/.test(context) ||
          !Number.isSafeInteger(Number(context)) ||
          Number(context) < floor ||
          Number(context) > floor + 32
        )
          throw new StockPairEvidenceError(
            'Stock evidence response context differs from its requested floor.',
          );
      }
      if (!clocks.length) return result;
      const slot = result?.context?.slot;
      if (
        typeof slot !== 'string' ||
        !/^[1-9]\d{0,15}$/.test(slot) ||
        !Number.isSafeInteger(Number(slot)) ||
        Number(slot) < floor ||
        Number(slot) > floor + 32 ||
        !Array.isArray(result.value) ||
        result.value.length !== keys.length + (clocks.length === 1 ? 1 : 0)
      )
        throw new StockPairEvidenceError(
          'Stock Clock response floor or mapping differs.',
        );
      const positions = clocks.length === 1 ? [...clocks, keys.length] : clocks;
      const values = positions.map((i) => result.value![i]);
      const observation = stockClock(values[0], Number(slot));
      const canonical = (value: unknown) =>
        JSON.stringify(
          Object.entries(value as object).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        );
      for (const value of values.slice(1)) {
        stockClock(value, Number(slot));
        if (canonical(value) !== canonical(values[0]))
          throw new StockPairEvidenceError(
            'Duplicate stock Clock accounts disagree.',
          );
      }
      if (observation.slot - floor > 32)
        throw new StockPairEvidenceError(
          'Stock Clock observation exceeds the 32-slot span.',
        );
      latest = Math.max(latest, observation.slot);
      if (observations.length >= 300)
        throw new StockPairEvidenceError(
          'Stock Clock observation budget exceeded.',
        );
      observations.push(Object.freeze(observation));
      const published =
        clocks.length === 1
          ? { ...result, value: result.value.slice(0, keys.length) }
          : result;
      stockResponses.set(published, observation);
      return published;
    };
  const scope: StockScope = {
    rpc: wrap(rpc),
    programRpc: wrap(codeRpc),
    observations,
    accountLimit: options ? stockPairAccountLimit(options.endpoint) : 100,
    signal: options?.signal,
    now,
    latest: () => latest,
    partitions: [],
  };
  stockScopes.set(scope.rpc, scope);
  stockScopes.set(scope.programRpc, scope);
  return scope;
}
