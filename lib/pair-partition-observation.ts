import { collectPairAccountPartitions } from './pair-account-partitions';
import { PAIR_CLOCK, pairEvidenceClock } from './pair-stock-clock';

/** Explicit account/Clock observation, never a synthetic merged JSON-RPC result. */
export async function readPairPartitionObservation(
  requested: readonly string[],
  minimumSlot: number,
  rpc: (method: string, params: unknown[]) => Promise<unknown>,
  signal: AbortSignal,
  now: () => number = Date.now,
) {
  const keys = [...requested];
  const hasClock = keys.includes(PAIR_CLOCK);
  const partitions = await collectPairAccountPartitions(
    hasClock ? keys : [...keys, PAIR_CLOCK],
    {
      encoding: 'base64',
      commitment: 'confirmed',
      minContextSlot: minimumSlot,
    },
    rpc,
    signal,
    now,
  );
  const mapped: unknown[] = Array(partitions.requestKeys.length);
  const seen = new Set<number>();
  for (const partition of partitions.partitions) {
    for (const [local, original] of partition.originalPositions.entries()) {
      if (
        seen.has(original) ||
        partitions.requestKeys[original] !== partition.accountKeys[local]
      )
        throw Error('Partition account mapping differs.');
      seen.add(original);
      mapped[original] = partition.response.value[local];
    }
  }
  const clockIndex = partitions.requestKeys.indexOf(PAIR_CLOCK);
  if (
    clockIndex < 0 ||
    seen.has(clockIndex) ||
    seen.size !== partitions.requestKeys.length - 1
  )
    throw Error('Partition account coverage differs.');
  const clockResponse = partitions.partitions[0].response;
  mapped[clockIndex] = clockResponse.value.at(-1);
  signal.throwIfAborted();
  for (const partition of partitions.partitions)
    pairEvidenceClock(
      partition.response,
      partition.response.value.at(-1),
      Number(partition.response.context.slot),
      now(),
    );
  return {
    values: hasClock ? mapped : mapped.slice(0, keys.length),
    clockResponse,
    partitions,
  };
}
