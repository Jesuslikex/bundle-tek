import { createStockPairEvidenceRpc, PAIR_CLOCK } from './pair-stock-clock';

type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
type AccountConfig = {
  encoding: 'base64';
  commitment: 'confirmed';
  minContextSlot: number;
};

/** Review prototype only. Returns actual partition responses, never a fabricated RPC snapshot.
 * The caller must provide a request-scoped, bounded, paced transport capped at five accounts.
 * No production call site uses this collector yet. */
export async function collectPairAccountPartitions(
  keys: readonly string[],
  config: AccountConfig,
  source: Rpc,
  signal: AbortSignal,
  now: () => number = Date.now,
) {
  signal.throwIfAborted();
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
  const scope = createStockPairEvidenceRpc(
    async (method, params) => {
      signal.throwIfAborted();
      const record = {
        params: structuredClone(params),
        response: undefined as unknown,
      };
      providerResponses.push(record);
      const result = await source(method, params);
      signal.throwIfAborted();
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
  const partitions = await Promise.all(
    groups.map(async (originalPositions) => {
      const accountKeys = [
        ...originalPositions.map((i) => requestKeys[i]),
        PAIR_CLOCK,
      ];
      const response = (await scope.rpc('getMultipleAccounts', [
        accountKeys,
        { ...requestConfig },
      ])) as {
        context: { slot: string };
        value: unknown[];
      };
      signal.throwIfAborted();
      return { originalPositions, accountKeys, response };
    }),
  );
  signal.throwIfAborted();
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
    observations: [...scope.observations],
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
