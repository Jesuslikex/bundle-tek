import bs58 from 'bs58';
import { address } from '@solana/kit';
import {
  inspectPairTokenAccount,
  pairWalletUint,
} from './pair-wallet-evidence';
import {
  SWAP_TOKEN,
  SWAP_TOKEN_2022,
  SWAP_WRAPPED_SOL,
} from './swap-token-program-evidence';
import type { ImportedPairWalletPreflight } from './imported-pair-wallet-preflight';
import type {
  reviewPairOrderInstructions,
  PairOrderAccountSnapshot,
} from './pair-order-review';

type Assessment = Awaited<ReturnType<typeof reviewPairOrderInstructions>>;
const SYSTEM = '11111111111111111111111111111111';
function account(raw: unknown) {
  const a = raw as {
    owner?: unknown;
    executable?: unknown;
    lamports?: unknown;
    data?: unknown;
  };
  if (
    !a ||
    typeof a.owner !== 'string' ||
    typeof a.executable !== 'boolean' ||
    !Array.isArray(a.data) ||
    a.data.length !== 2 ||
    a.data[1] !== 'base64' ||
    typeof a.data[0] !== 'string' ||
    a.data[0].length > 524288
  )
    throw Error('Pair simulation account envelope differs.');
  address(a.owner);
  const text = atob(a.data[0]);
  if (btoa(text) !== a.data[0])
    throw Error('Pair simulation account encoding differs.');
  return {
    owner: a.owner,
    executable: a.executable,
    lamports: pairWalletUint(a.lamports),
    bytes: Uint8Array.from(text, (c) => c.charCodeAt(0)),
  };
}
/** Inspect standard RPC post-account bytes, never provider-reported token deltas. */
export async function reviewPairOrderSimulation(
  preflight: ImportedPairWalletPreflight,
  assessment: Assessment,
  before: PairOrderAccountSnapshot[],
  writable: string[],
  rawResult: unknown,
) {
  const result = rawResult as {
    context?: { slot?: unknown };
    value?: {
      err?: unknown;
      accounts?: unknown;
      unitsConsumed?: unknown;
      replacementBlockhash?: unknown;
      fee?: unknown;
    };
  };
  const value = result?.value;
  if (
    !value ||
    value.err !== null ||
    (value.replacementBlockhash !== undefined &&
      value.replacementBlockhash !== null) ||
    !Array.isArray(value.accounts) ||
    value.accounts.length !== writable.length ||
    !writable.length ||
    writable.length > 100 ||
    new Set(writable).size !== writable.length
  )
    throw Error(
      'Pair simulation did not return complete original-packet post-state.',
    );
  const units = pairWalletUint(value.unitsConsumed);
  if (
    value.fee !== undefined &&
    pairWalletUint(value.fee).toString() !== assessment.networkFeeRaw
  )
    throw Error('Pair simulation fee contradicts the observed message fee.');
  if (units < 1n || units > BigInt(assessment.computeUnitLimitRaw))
    throw Error('Pair simulation compute usage differs.');
  const postValues = value.accounts;
  const post = new Map(
    writable.map((key, i) => [key, postValues[i] as unknown]),
  );
  const initial = new Map(before.map((a) => [a.address, a.raw]));
  if (
    initial.size !== before.length ||
    writable.some((key) => !initial.has(key))
  )
    throw Error('Pair simulation pre-state is incomplete.');
  const wallet = preflight.wallet;
  const oldWallet = account(initial.get(wallet)),
    newWallet = account(post.get(wallet));
  for (const w of [oldWallet, newWallet])
    if (w.owner !== SYSTEM || w.executable || w.bytes.length)
      throw Error('Pair simulation wallet custody changed.');
  if (newWallet.lamports < BigInt(preflight.evidence.systemRentMinimumRaw))
    throw Error('Pair simulation drains the system-wallet rent floor.');
  const pair = preflight.quote.pair;
  const inputMint = assessment.accounts[0].mint;
  const outputMint = assessment.accounts[1].mint;
  let nativeDelta = newWallet.lamports - oldWallet.lamports,
    nonnativeRent = 0n,
    retainedNativeRent = 0n;
  const tokenDeltas: {
    mint: string;
    account: string;
    beforeRaw: string;
    afterRaw: string;
    deltaRaw: string;
  }[] = [];
  for (const selected of assessment.accounts) {
    if (!post.has(selected.address) || !initial.has(selected.address))
      throw Error('Pair simulation selected account is absent.');
    const prior = initial.get(selected.address),
      next = post.get(selected.address);
    if (selected.mint === SWAP_WRAPPED_SOL) {
      const oldLamports = prior === null ? 0n : account(prior).lamports;
      if (selected.closed) {
        if (next !== null) {
          const closed = account(next);
          if (
            closed.lamports !== 0n ||
            closed.owner !== SYSTEM ||
            closed.executable ||
            closed.bytes.length
          )
            throw Error('Pair simulation failed native account cleanup.');
        }
        nativeDelta -= oldLamports;
      } else {
        const expectedReserve =
          prior === null
            ? BigInt(selected.rentRaw)
            : oldLamports - BigInt(selected.beforeAmountRaw);
        const a = account(next),
          b = a.bytes,
          v = new DataView(b.buffer);
        if (
          a.owner !== SWAP_TOKEN ||
          a.executable ||
          b.length !== 165 ||
          bs58.encode(b.slice(0, 32)) !== SWAP_WRAPPED_SOL ||
          bs58.encode(b.slice(32, 64)) !== wallet ||
          b[108] !== 1 ||
          v.getUint32(72, true) !== 0 ||
          v.getBigUint64(121, true) !== 0n ||
          v.getUint32(129, true) !== 0 ||
          v.getUint32(109, true) !== 1 ||
          a.lamports - v.getBigUint64(64, true) !== v.getBigUint64(113, true) ||
          v.getBigUint64(113, true) !== expectedReserve ||
          v.getBigUint64(64, true) !== BigInt(selected.beforeAmountRaw)
        )
          throw Error(
            'Pair simulation native custody or residual amount differs.',
          );
        nativeDelta += a.lamports - oldLamports;
        if (prior === null) retainedNativeRent += expectedReserve;
      }
      continue;
    }
    const mint = selected.mint === pair.base.address ? pair.base : pair.quote;
    if (mint.address !== selected.mint)
      throw Error('Pair simulation asset differs.');
    const metadata = {
      ...mint,
      policySha256:
        mint.address === pair.base.address
          ? pair.mintPolicy.baseSha256
          : pair.mintPolicy.quoteSha256,
    };
    const observed = await inspectPairTokenAccount(
      next,
      metadata,
      wallet,
      selected.address,
      preflight.evidence.unixTimestamp,
    );
    if (
      observed.status !== 'Ready' ||
      observed.byteLength !== observed.expectedByteLength ||
      BigInt(observed.lamportsRaw) < BigInt(selected.rentRaw)
    )
      throw Error('Pair simulation token custody or extension setup differs.');
    const oldAmount = BigInt(selected.beforeAmountRaw),
      afterAmount = BigInt(observed.amountRaw);
    const cost =
      prior === null ? BigInt(selected.rentRaw) : account(prior).lamports;
    if (BigInt(observed.lamportsRaw) !== cost)
      throw Error('Pair simulation token-account rent differs.');
    if (prior === null) nonnativeRent += cost;
    const delta = afterAmount - oldAmount;
    if (
      selected.mint === inputMint
        ? delta !== -BigInt(assessment.rawInput)
        : delta < BigInt(assessment.minimumOutputRaw)
    )
      throw Error(
        'Pair simulation raw token spending or output protection differs.',
      );
    tokenDeltas.push({
      mint: selected.mint,
      account: selected.address,
      beforeRaw: oldAmount.toString(),
      afterRaw: afterAmount.toString(),
      deltaRaw: delta.toString(),
    });
  }
  const fee = BigInt(assessment.networkFeeRaw);
  const tradeNativeDelta = nativeDelta + fee + nonnativeRent;
  if (
    inputMint === SWAP_WRAPPED_SOL
      ? tradeNativeDelta !== -BigInt(assessment.rawInput)
      : outputMint === SWAP_WRAPPED_SOL
        ? tradeNativeDelta < BigInt(assessment.minimumOutputRaw)
        : tradeNativeDelta !== 0n
  )
    throw Error(
      'Pair simulation SOL spending, fees, rent or refund conservation differs.',
    );
  // Other writable accounts may be AMM state, but cannot retain control over another wallet asset.
  for (const key of writable) {
    if (
      key === wallet ||
      assessment.accounts.some((a) => a.address === key) ||
      post.get(key) === null
    )
      continue;
    const a = account(post.get(key));
    if (![SWAP_TOKEN, SWAP_TOKEN_2022].includes(a.owner)) continue;
    if (a.executable) throw Error('Pair simulation token executable differs.');
    const b = a.bytes,
      v = new DataView(b.buffer);
    if (b.length >= 165 && (b.length === 165 || b[165] === 2)) {
      if (
        bs58.encode(b.slice(32, 64)) === wallet ||
        (v.getUint32(72, true) === 1 &&
          bs58.encode(b.slice(76, 108)) === wallet) ||
        (v.getUint32(129, true) === 1 &&
          bs58.encode(b.slice(133, 165)) === wallet)
      )
        throw Error(
          'Pair simulation introduced unrelated wallet token custody.',
        );
    } else if (
      b.length >= 82 &&
      ((v.getUint32(0, true) === 1 && bs58.encode(b.slice(4, 36)) === wallet) ||
        (v.getUint32(46, true) === 1 &&
          bs58.encode(b.slice(50, 82)) === wallet))
    )
      throw Error(
        'Pair simulation introduced unrelated wallet mint authority.',
      );
  }
  const fingerprint = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify(writable.map((key) => [key, post.get(key)])),
    ),
  );
  return {
    format: 'pair-order-simulation-v1' as const,
    tokenDeltas,
    walletLamportsBeforeRaw: oldWallet.lamports.toString(),
    walletLamportsAfterRaw: newWallet.lamports.toString(),
    nativeTradeDeltaRaw: tradeNativeDelta.toString(),
    networkFeeRaw: fee.toString(),
    retainedAccountRentRaw: (nonnativeRent + retainedNativeRent).toString(),
    retainedNonNativeAccountRentRaw: nonnativeRent.toString(),
    retainedNativeAccountRentRaw: retainedNativeRent.toString(),
    unitsConsumed: units.toString(),
    postAccountsSha256: Array.from(new Uint8Array(fingerprint), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join(''),
    economicSimulationVerified: true as const,
    signatureVerified: false as const,
    providerObservationOnly: true as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
