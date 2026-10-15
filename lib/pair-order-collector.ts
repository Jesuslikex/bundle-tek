import {
  getBase64Encoder,
  getBase64Decoder,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit';
import { reviewUnsignedSwapEnvelope } from './unsigned-swap-order';
import { reviewSwapInstructions } from './swap-instruction-review';
import {
  readSwapLookupAccounts,
  assertSameSwapLookups,
} from './swap-lookup-accounts';
import { assessJupiterRoute } from './jupiter-route-assessment';
import { requireConsistentSolanaSlots } from './solana-rpc';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { pairWalletUint } from './pair-wallet-evidence';
import {
  readPairMintEvidence,
  assertSamePairMintEvidence,
  type PairMintEvidence,
} from './pair-mint-evidence';
import {
  reviewPairOrderInstructions,
  type PairOrderAccountSnapshot,
} from './pair-order-review';
import { SWAP_WRAPPED_SOL } from './swap-token-program-evidence';
import type { ImportedPairWalletPreflight } from './imported-pair-wallet-preflight';
import type { SolanaPairPreparation } from './warmup-swap-quote';
type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
function slot(value: unknown, floor: number) {
  if (
    typeof value !== 'string' ||
    !/^[1-9]\d{0,15}$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < floor ||
    Number(value) > floor + 32
  )
    throw Error('Pair candidate RPC context differs.');
  return Number(value);
}
/** Reads and reviews an unsigned candidate. It does not simulate, sign, send or create a reservation. */
export async function collectPairOrderReview(
  preflight: ImportedPairWalletPreflight,
  order: SolanaPairPreparation,
  rpc: Rpc,
  now: () => number = Date.now,
) {
  const observedAt = now(),
    slots = [
      preflight.quote.pair.mintPolicy.slot,
      preflight.quote.pair.mintPolicy.recheckSlot,
      preflight.evidence.slot,
    ],
    floor = () => Math.max(...slots);
  const fresh = () => {
    const timestamp = now();
    if (
      !Number.isFinite(timestamp) ||
      timestamp < observedAt - 1000 ||
      timestamp >=
        Math.min(Date.parse(preflight.expiresAt), Date.parse(order.expiresAt))
    )
      throw Error('Pair candidate expired during review.');
  };
  fresh();
  if (
    order.preparation.executionAllowed !== false ||
    order.preparation.instructionsVerified !== false
  )
    throw Error('Pair candidate cannot grant provider signing authority.');
  const envelope = await reviewUnsignedSwapEnvelope(
    order.preparation.transaction,
    preflight.wallet,
  );
  if (
    envelope.sha256 !== order.preparation.sha256 ||
    envelope.accountCount !== order.preparation.accountCount ||
    envelope.lookupTableCount !== order.preparation.lookupTableCount
  )
    throw Error('Pair candidate packet fingerprint differs.');
  const tx = getTransactionDecoder().decode(
    getBase64Encoder().encode(order.preparation.transaction),
  );
  const message = getCompiledTransactionMessageDecoder().decode(
    tx.messageBytes,
  );
  if (message.version !== 0) throw Error('Pair candidate version differs.');
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw Error('Pair candidate provider is not mainnet.');
  const height = pairWalletUint(
      await rpc('getBlockHeight', [{ commitment: 'confirmed' }]),
    ),
    last = pairWalletUint(order.preparation.lastValidBlockHeight);
  if (height + 10n > last || last > height + 200n)
    throw Error(
      'Pair candidate block height is expired or outside the bounded window.',
    );
  const lookups = await readSwapLookupAccounts(message, floor(), rpc);
  if (lookups) slots.push(lookups.observedSlot);
  const keys = [
    ...message.staticAccounts.map(String),
    ...(lookups?.writable ?? []),
    ...(lookups?.readonly ?? []),
  ];
  if (
    new Set(keys).size !== keys.length ||
    keys.length !== envelope.accountCount
  )
    throw Error('Pair candidate resolved accounts overlap.');
  const writable = keys.filter((_key, i) =>
    i < message.staticAccounts.length
      ? i < message.header.numSignerAccounts
        ? i <
          message.header.numSignerAccounts -
            message.header.numReadonlySignerAccounts
        : i <
          message.staticAccounts.length -
            message.header.numReadonlyNonSignerAccounts
      : i < message.staticAccounts.length + (lookups?.writable.length ?? 0),
  );
  if (writable.length > 100 || !writable.includes(preflight.wallet))
    throw Error('Pair candidate writable account count differs.');
  const instructions = reviewSwapInstructions(message, lookups ?? undefined),
    route = assessJupiterRoute(instructions, order);
  if (route.status !== 'Matched fields' || !route.decoded)
    throw Error(
      'Pair candidate route differs from the selected assets or limits.',
    );
  const selected = [
    preflight.wallet,
    route.decoded.sourceAccount,
    route.decoded.destinationAccount,
  ];
  if (
    new Set(selected).size !== 3 ||
    selected.some((a) => !writable.includes(a))
  )
    throw Error('Pair candidate selected account privileges differ.');
  const readAccounts = async (
    addresses: string[],
    slice: boolean,
  ): Promise<PairOrderAccountSnapshot[]> => {
    if (!addresses.length) return [];
    const response = (await rpc('getMultipleAccounts', [
      addresses,
      {
        encoding: 'base64',
        commitment: 'confirmed',
        minContextSlot: floor(),
        ...(slice ? { dataSlice: { offset: 0, length: 166 } } : {}),
      },
    ])) as { context?: { slot?: unknown }; value?: unknown[] };
    slots.push(slot(response?.context?.slot, floor()));
    if (
      !Array.isArray(response.value) ||
      response.value.length !== addresses.length
    )
      throw Error('Pair candidate writable snapshot is incomplete.');
    return addresses.map((address, i) => ({
      address,
      raw: response.value![i],
    }));
  };
  const other = await readAccounts(
      writable.filter((a) => !selected.includes(a)),
      true,
    ),
    before = await readAccounts(selected, false),
    snapshots = [...before, ...other];
  const pair = preflight.quote.pair;
  const quoted: PairMintEvidence = {
    slot: pair.mintPolicy.recheckSlot,
    unixTimestamp: pair.mintPolicy.recheckUnixTimestamp,
    mints: [pair.base, pair.quote].map((a, i) => ({
      address: a.address,
      program: a.program,
      decimals: a.decimals,
      amountPolicy: a.amountPolicy,
      extensions: a.extensions,
      issuerControls: a.issuerControls,
      policySha256:
        i === 0 ? pair.mintPolicy.baseSha256 : pair.mintPolicy.quoteSha256,
    })),
  };
  const mints = await readPairMintEvidence(
    { inputMint: pair.base.address, outputMint: pair.quote.address },
    floor(),
    rpc,
    now(),
  );
  slots.push(mints.slot);
  assertSamePairMintEvidence(quoted, mints);
  const rentByMint: Record<string, string> = {};
  if (
    pairWalletUint(
      await rpc('getMinimumBalanceForRentExemption', [
        0,
        { commitment: 'confirmed' },
      ]),
    ).toString() !== preflight.evidence.systemRentMinimumRaw
  )
    throw Error('Pair candidate system-wallet rent changed.');
  for (const asset of [pair.base, pair.quote]) {
    const account = preflight.evidence.accounts.find(
      (a) => a.mint === asset.address,
    )!;
    const size =
      asset.address === SWAP_WRAPPED_SOL
        ? 165
        : account.byteLength || account.expectedByteLength;
    const rent = pairWalletUint(
      await rpc('getMinimumBalanceForRentExemption', [
        size,
        { commitment: 'confirmed' },
      ]),
    );
    if (rent < 1n) throw Error('Pair candidate rent is unavailable.');
    rentByMint[asset.address] = rent.toString();
    if (
      asset.address !== SWAP_WRAPPED_SOL &&
      rent.toString() !== account.rentMinimumRaw
    )
      throw Error('Pair candidate rent changed after funding review.');
  }
  const fee = (await rpc('getFeeForMessage', [
    getBase64Decoder().decode(tx.messageBytes),
    { commitment: 'confirmed', minContextSlot: floor() },
  ])) as { context?: { slot?: unknown }; value?: unknown };
  slots.push(slot(fee?.context?.slot, floor()));
  const networkFee = pairWalletUint(fee.value).toString();
  const assessment = await reviewPairOrderInstructions(
    preflight,
    order,
    instructions,
    snapshots,
    rentByMint,
    networkFee,
  );
  fresh();
  const after = await readAccounts(selected, false);
  const identity = (a: PairOrderAccountSnapshot) => {
    if (a.raw === null) return [a.address, null];
    const r = a.raw as {
      owner: unknown;
      executable: unknown;
      lamports: unknown;
      data: unknown;
    };
    return [a.address, r.owner, r.executable, r.lamports, r.data];
  };
  if (
    JSON.stringify(before.map(identity)) !== JSON.stringify(after.map(identity))
  )
    throw Error('Pair candidate selected balances or custody changed.');
  if (lookups) {
    const recheck = await readSwapLookupAccounts(message, floor(), rpc);
    assertSameSwapLookups(lookups, recheck, null);
    slots.push(recheck!.observedSlot);
  }
  const finalMints = await readPairMintEvidence(
    { inputMint: pair.base.address, outputMint: pair.quote.address },
    floor(),
    rpc,
    now(),
  );
  slots.push(finalMints.slot);
  assertSamePairMintEvidence(mints, finalMints);
  const validity = (await rpc('isBlockhashValid', [
    message.lifetimeToken,
    { commitment: 'confirmed', minContextSlot: floor() },
  ])) as { context?: { slot?: unknown }; value?: unknown };
  slots.push(slot(validity?.context?.slot, floor()));
  const finalHeight = pairWalletUint(
    await rpc('getBlockHeight', [{ commitment: 'confirmed' }]),
  );
  if (
    validity.value !== true ||
    finalHeight < height ||
    finalHeight + 10n > last ||
    (await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS
  )
    throw Error('Pair candidate lifetime or network changed.');
  requireConsistentSolanaSlots(slots);
  fresh();
  const sha = async (value: unknown) =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(JSON.stringify(value)),
        ),
      ),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
  const result = {
    format: 'pair-order-review-v1' as const,
    packetSha256: envelope.sha256,
    wallet: preflight.wallet,
    pairSha256: pair.sha256,
    preflightSha256: preflight.contextSha256,
    assessment,
    lookupTables:
      lookups?.tables.map((t) => ({
        address: t.address,
        sha256: t.sha256,
        lastExtendedSlot: t.lastExtendedSlot,
      })) ?? [],
    writableAccounts: writable,
    sourceSnapshotSha256: await sha(snapshots.map(identity)),
    minimumSlot: Math.min(...slots),
    maximumSlot: floor(),
    blockHeight: height.toString(),
    recheckBlockHeight: finalHeight.toString(),
    lastValidBlockHeight: last.toString(),
    observedAt: new Date(observedAt).toISOString(),
    expiresAt: new Date(
      Math.min(Date.parse(preflight.expiresAt), Date.parse(order.expiresAt)),
    ).toISOString(),
    economicSimulationVerified: false as const,
    programCodeAttested: false as const,
    applicationReservationsChecked: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
  const sha256 = await sha(result);
  fresh();
  return { ...result, sha256 };
}
