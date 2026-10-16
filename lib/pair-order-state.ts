import { readPairPartitionObservation } from './pair-partition-observation';
import { pairEvidenceClock } from './pair-stock-clock';
import { address } from '@solana/kit';
import {
  PAIR_CLOCK,
  inspectPairMintAccount,
  type PairMintEvidence,
} from './pair-mint-evidence';
import type { PairOrderAccountSnapshot } from './pair-order-review';
import { PAIR_RENT, inspectPairRentAccount } from './pair-rent-evidence';
/** One bounded bank response binds full protected accounts and their mint/Clock evidence. */
export async function readPairOrderState(
  protectedAccounts: string[],
  selectedMints: [string, string],
  intermediateMints: string[],
  minimumSlot: number,
  rpc: (method: string, params: unknown[]) => Promise<unknown>,
  now: () => number = Date.now,
) {
  return collectPairOrderState(
    protectedAccounts,
    selectedMints,
    intermediateMints,
    minimumSlot,
    async (requested, floor) => {
      const response = (await rpc('getMultipleAccounts', [
        requested,
        { encoding: 'base64', commitment: 'confirmed', minContextSlot: floor },
      ])) as { context?: { slot?: unknown }; value?: unknown[] };
      return { values: response?.value, clockResponse: response };
    },
    now,
  );
}
/** Offline composition only; production callers retain their original single-read entry point. */
export async function readPartitionedPairOrderState(
  protectedAccounts: string[],
  selectedMints: [string, string],
  intermediateMints: string[],
  minimumSlot: number,
  rpc: (method: string, params: unknown[]) => Promise<unknown>,
  signal: AbortSignal,
  now: () => number = Date.now,
) {
  let observation:
    | Awaited<ReturnType<typeof readPairPartitionObservation>>
    | undefined;
  const state = await collectPairOrderState(
    protectedAccounts,
    selectedMints,
    intermediateMints,
    minimumSlot,
    async (requested, floor) => {
      observation = await readPairPartitionObservation(
        requested,
        floor,
        rpc,
        signal,
        now,
      );
      return observation;
    },
    now,
  );
  signal.throwIfAborted();
  if (!observation) throw Error('Partitioned order observation is missing.');
  return { state, partitions: observation.partitions };
}
async function collectPairOrderState(
  protectedAccounts: string[],
  selectedMints: [string, string],
  intermediateMints: string[],
  minimumSlot: number,
  readAccounts: (
    requested: string[],
    floor: number,
  ) => Promise<{
    values: unknown;
    clockResponse: { context?: { slot?: unknown }; value?: unknown[] };
  }>,
  now: () => number = Date.now,
) {
  const accounts = [...protectedAccounts],
    selected = [...selectedMints],
    auxiliary = [...intermediateMints];
  const requested = [
    ...accounts,
    ...selected,
    ...auxiliary,
    PAIR_RENT,
    PAIR_CLOCK,
  ];
  if (
    accounts.length < 3 ||
    accounts.length > 11 ||
    selected.length !== 2 ||
    auxiliary.length > 8 ||
    accounts.length !== 3 + auxiliary.length ||
    new Set(requested).size !== requested.length ||
    !Number.isSafeInteger(minimumSlot) ||
    minimumSlot < 1 ||
    minimumSlot > Number.MAX_SAFE_INTEGER - 32
  )
    throw Error('Pair order state scope differs.');
  requested.forEach(address);
  const { values, clockResponse: response } = await readAccounts(
    requested,
    minimumSlot,
  );
  const s = response?.context?.slot;
  if (
    typeof s !== 'string' ||
    !/^[1-9]\d{0,15}$/.test(s) ||
    !Number.isSafeInteger(Number(s)) ||
    Number(s) < minimumSlot ||
    Number(s) > minimumSlot + 32 ||
    !Array.isArray(values) ||
    values.length !== requested.length ||
    Array.from(values).some((value) => value === undefined)
  )
    throw Error('Pair order state bank or mapping differs.');
  const clock = pairEvidenceClock(
    response,
    response.value?.at(-1),
    Number(s),
    now(),
  );
  const { slot, unixTimestamp } = clock;
  const rent = inspectPairRentAccount(values.at(-2));
  const metadata = await Promise.all(
    [...selected, ...auxiliary].map((mint, i) =>
      inspectPairMintAccount(values![accounts.length + i], mint),
    ),
  );
  const mints: PairMintEvidence = {
    slot,
    unixTimestamp,
    clock,
    mints: metadata.slice(0, 2),
  };
  const auxiliaryMints: PairMintEvidence | null = auxiliary.length
    ? { slot, unixTimestamp, mints: metadata.slice(2) }
    : null;
  return {
    slot,
    unixTimestamp,
    clock,
    accounts: accounts.map(
      (key, i): PairOrderAccountSnapshot => ({
        address: key,
        raw: values![i],
      }),
    ),
    mints,
    auxiliaryMints,
    rent,
  };
}
