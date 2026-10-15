import { address } from '@solana/kit';
import {
  PAIR_CLOCK,
  inspectPairMintAccount,
  pairClockUnixTimestamp,
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
  const response = (await rpc('getMultipleAccounts', [
    requested,
    {
      encoding: 'base64',
      commitment: 'confirmed',
      minContextSlot: minimumSlot,
    },
  ])) as { context?: { slot?: unknown }; value?: unknown[] };
  const s = response?.context?.slot;
  if (
    typeof s !== 'string' ||
    !/^[1-9]\d{0,15}$/.test(s) ||
    !Number.isSafeInteger(Number(s)) ||
    Number(s) < minimumSlot ||
    Number(s) > minimumSlot + 32 ||
    !Array.isArray(response.value) ||
    response.value.length !== requested.length ||
    Array.from(response.value).some((value) => value === undefined)
  )
    throw Error('Pair order state bank or mapping differs.');
  const slot = Number(s),
    unixTimestamp = pairClockUnixTimestamp(response.value.at(-1), slot, now());
  const rent = inspectPairRentAccount(response.value.at(-2));
  const metadata = await Promise.all(
    [...selected, ...auxiliary].map((mint, i) =>
      inspectPairMintAccount(response.value![accounts.length + i], mint),
    ),
  );
  const mints: PairMintEvidence = {
    slot,
    unixTimestamp,
    mints: metadata.slice(0, 2),
  };
  const auxiliaryMints: PairMintEvidence | null = auxiliary.length
    ? { slot, unixTimestamp, mints: metadata.slice(2) }
    : null;
  return {
    slot,
    unixTimestamp,
    accounts: accounts.map(
      (key, i): PairOrderAccountSnapshot => ({
        address: key,
        raw: response.value![i],
      }),
    ),
    mints,
    auxiliaryMints,
    rent,
  };
}
