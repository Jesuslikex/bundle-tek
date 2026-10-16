import { pairEvidenceClock } from './pair-stock-clock';
import bs58 from 'bs58';
import { address } from '@solana/kit';
import {
  PAIR_CLOCK,
  inspectPairMintAccount,
  type PairMintMetadata,
  type PairMintEvidence,
} from './pair-mint-evidence';
import {
  SWAP_TOKEN,
  SWAP_TOKEN_2022,
  SWAP_WRAPPED_SOL,
} from './swap-token-program-evidence';
import type { PairOrderAccountSnapshot } from './pair-order-review';
import type { SwapInstructionReview } from './swap-instruction-review';
export type PairAuxiliaryAccount = {
  address: string;
  mint: PairMintMetadata;
  seededCandidate: boolean;
};
/** Discover potential protected intermediates. Discovery never approves custody or spending. */
export function discoverPairAuxiliaryAccounts(
  wallet: string,
  selected: string[],
  selectedMints: string[],
  review: SwapInstructionReview,
  snapshots: PairOrderAccountSnapshot[],
) {
  const found = new Map<
    string,
    { address: string; mint: string; seededCandidate: boolean }
  >();
  const add = (key: string, mint: string, seededCandidate = false) => {
    if (selected.includes(key)) return;
    address(key);
    address(mint);
    if (selectedMints.includes(mint))
      throw Error('Auxiliary account duplicates a selected mint.');
    const prior = found.get(key);
    if (
      prior &&
      (prior.mint !== mint || prior.seededCandidate !== seededCandidate)
    )
      throw Error('Auxiliary account identity conflicts.');
    found.set(key, { address: key, mint, seededCandidate });
    if (found.size > 8) throw Error('Auxiliary account budget exceeded.');
  };
  for (const { address: key, raw } of snapshots) {
    const r = raw as {
      owner?: unknown;
      data?: unknown;
      executable?: unknown;
    } | null;
    if (
      !r ||
      ![SWAP_TOKEN, SWAP_TOKEN_2022].includes(String(r.owner)) ||
      r.executable ||
      !Array.isArray(r.data) ||
      typeof r.data[0] !== 'string'
    )
      continue;
    if (
      r.data.length !== 2 ||
      r.data[1] !== 'base64' ||
      r.data[0].length > 5464
    )
      throw Error('Auxiliary account discovery envelope differs.');
    const text = atob(r.data[0]);
    if (btoa(text) !== r.data[0])
      throw Error('Auxiliary account discovery encoding differs.');
    const b = Uint8Array.from(text, (c) => c.charCodeAt(0));
    if (
      b.length >= 165 &&
      (b.length === 165 || b[165] === 2) &&
      bs58.encode(b.slice(32, 64)) === wallet
    )
      add(key, bs58.encode(b.slice(0, 32)));
  }
  for (const ix of review.instructions) {
    const a = ix.accounts;
    if (
      ix.program.address === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' &&
      a[0]?.address === wallet &&
      a[2]?.address === wallet
    )
      add(a[1]?.address, a[3]?.address);
    if (
      ix.program.address === SWAP_TOKEN &&
      [1, 16, 18].includes(parseInt(ix.dataHex.slice(0, 2), 16)) &&
      a[1]?.address === SWAP_WRAPPED_SOL
    )
      add(a[0]?.address, SWAP_WRAPPED_SOL, true);
  }
  return [...found.values()];
}
export async function readPairAuxiliaryMints(
  mints: string[],
  minimumSlot: number,
  rpc: (method: string, params: unknown[]) => Promise<unknown>,
  now: () => number,
): Promise<PairMintEvidence> {
  if (!mints.length || mints.length > 8 || new Set(mints).size !== mints.length)
    throw Error('Auxiliary mint scope differs.');
  mints.forEach(address);
  const raw = (await rpc('getMultipleAccounts', [
    [...mints, PAIR_CLOCK],
    {
      encoding: 'base64',
      commitment: 'confirmed',
      minContextSlot: minimumSlot,
    },
  ])) as { context?: { slot?: unknown }; value?: unknown[] };
  const s = raw?.context?.slot;
  if (
    typeof s !== 'string' ||
    !/^[1-9]\d{0,15}$/.test(s) ||
    !Number.isSafeInteger(Number(s)) ||
    Number(s) < minimumSlot ||
    Number(s) > minimumSlot + 32 ||
    !Array.isArray(raw.value) ||
    raw.value.length !== mints.length + 1
  )
    throw Error('Auxiliary mint context differs.');
  const clock = pairEvidenceClock(raw, raw.value.at(-1), Number(s), now());
  return {
    slot: clock.slot,
    unixTimestamp: clock.unixTimestamp,
    clock,
    mints: await Promise.all(
      mints.map((mint, i) => inspectPairMintAccount(raw.value![i], mint)),
    ),
  };
}
