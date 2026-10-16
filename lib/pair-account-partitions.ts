import {
  createStockPairEvidenceRpc,
  PAIR_CLOCK,
  pairEvidenceClock,
  stockPairRpcScope,
  trimStockPairClockResponse,
  type PairClockObservation,
} from './pair-stock-clock';

type Rpc = (
  method: string,
  params: unknown[],
  signal?: AbortSignal,
) => Promise<unknown>;
type AccountConfig = {
  encoding: 'base64';
  commitment: 'confirmed';
  minContextSlot: number;
};

/** Returns actual partition responses, never a fabricated RPC snapshot.
 * The caller must provide a request-scoped, bounded, paced transport capped at five accounts.
 * The explicit QuickNode stock scope shares its existing Clock lifecycle. */
export async function collectPairAccountPartitions(
  keys: readonly string[],
  config: AccountConfig,
  source: Rpc,
  signal: AbortSignal,
  now: () => number = Date.now,
) {
  signal.throwIfAborted();
  const controller = new AbortController();
  const lifecycle = AbortSignal.any([signal, controller.signal]);
  function cancellable<T>(pending: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        lifecycle.removeEventListener('abort', abort);
        reject(
          new DOMException('Stock partition read cancelled.', 'AbortError'),
        );
      };
      lifecycle.addEventListener('abort', abort, { once: true });
      if (lifecycle.aborted) abort();
      void pending.then(
        (value) => {
          lifecycle.removeEventListener('abort', abort);
          resolve(value);
        },
        (error) => {
          lifecycle.removeEventListener('abort', abort);
          reject(error);
        },
      );
    });
  }
  if (
    keys.length < 1 ||
    keys.length > 100 ||
    keys.filter((key) => key === PAIR_CLOCK).length !== 1 ||
    keys.some((key) => !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(key)) ||
    Object.keys(config).sort().join(',') !==
      'commitment,encoding,minContextSlot' ||
    config.encoding !== 'base64' ||
    config.commitment !== 'confirmed' ||
    !Number.isSafeInteger(config.minContextSlot) ||
    config.minContextSlot < 1
  )
    throw Error('Stock account partition request differs.');
  const requestKeys = [...keys],
    requestConfig = { ...config };
  const providerResponses: { params: unknown[]; response: unknown }[] = [];
  const shared = stockPairRpcScope(source);
  const localObservations: PairClockObservation[] = [];
  const scope = createStockPairEvidenceRpc(
    async (method, params) => {
      lifecycle.throwIfAborted();
      const record = {
        params: structuredClone(params),
        response: undefined as unknown,
      };
      providerResponses.push(record);
      const result = await cancellable(source(method, params, lifecycle));
      lifecycle.throwIfAborted();
      record.response = result;
      return result;
    },
    undefined,
    now,
  );
  // Three original positions plus two real Clocks per provider request. Never
  // deduplicate original non-Clock positions or borrow one response's Clock.
  const positions = requestKeys.flatMap((key, index) =>
    key === PAIR_CLOCK ? [] : [index],
  );
  const groups: number[][] = [];
  for (let i = 0; i < positions.length; i += 3)
    groups.push(positions.slice(i, i + 3));
  if (!groups.length) groups.push([]);
  const tasks = groups.map(async (originalPositions) => {
    const accountKeys = [
      ...originalPositions.map((i) => requestKeys[i]),
      PAIR_CLOCK,
    ];
    const params: unknown[] = [accountKeys, { ...requestConfig }];
    let observed: unknown;
    if (shared) {
      params[0] = [...accountKeys, PAIR_CLOCK];
      params[1] = {
        ...requestConfig,
        minContextSlot: Math.max(requestConfig.minContextSlot, shared.latest()),
      };
      const record = {
        params: structuredClone(params),
        response: undefined as unknown,
      };
      providerResponses.push(record);
      const raw = (await cancellable(
        source('getMultipleAccounts', params, lifecycle),
      )) as { context?: { slot?: unknown }; value?: unknown[] };
      lifecycle.throwIfAborted();
      record.response = raw;
      const observation = pairEvidenceClock(
        raw,
        raw.value?.at(-1),
        Number(raw.context?.slot),
        now(),
      );
      if (
        observation.contextSlot < requestConfig.minContextSlot ||
        observation.slot > requestConfig.minContextSlot + 32
      )
        throw Error('Stock partition effective context differs.');
      localObservations.push(observation);
      observed = trimStockPairClockResponse(raw);
    } else observed = await scope.rpc('getMultipleAccounts', params);
    const response = observed as {
      context: { slot: string };
      value: unknown[];
    };
    lifecycle.throwIfAborted();
    return { originalPositions, accountKeys, response };
  });
  const partitions = await Promise.all(tasks).catch(async (error: unknown) => {
    controller.abort();
    await Promise.allSettled(tasks);
    throw error;
  });
  lifecycle.throwIfAborted();
  const first = partitions[0];
  const canonical = (value: unknown) =>
    JSON.stringify(
      Object.entries(value as object).sort(([a], [b]) => a.localeCompare(b)),
    );
  const firstClock = canonical(first.response.value.at(-1));
  for (const partition of partitions) {
    if (
      partition.response.context.slot !== first.response.context.slot ||
      canonical(partition.response.value.at(-1)) !== firstClock
    )
      throw Error(
        'Stock account partitions do not share one context and Clock.',
      );
  }
  if (
    new TextEncoder().encode(JSON.stringify(providerResponses)).byteLength >
    524288
  )
    throw Error('Stock account partition aggregate exceeds bounds.');
  return {
    format: 'stock-account-partitions-v1' as const,
    requestKeys,
    requestedFloor: requestConfig.minContextSlot,
    partitions,
    providerResponses,
    observations: shared ? localObservations : [...scope.observations],
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
