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
import {
  pairWalletUint,
  requiredPairAccountExtensions,
} from './pair-wallet-evidence';
import { getTokenSize } from '@solana-program/token-2022';
import {
  discoverPairAuxiliaryAccounts,
  readPairAuxiliaryMints,
} from './pair-order-auxiliary';
import {
  readPairMintEvidence,
  assertSamePairMintEvidence,
  type PairMintEvidence,
} from './pair-mint-evidence';
import {
  reviewPairOrderInstructions,
  type PairOrderAccountSnapshot,
} from './pair-order-review';
import { SWAP_TOKEN, SWAP_WRAPPED_SOL } from './swap-token-program-evidence';
import { reviewPairOrderSimulation } from './pair-order-simulation';
import { reviewPairRuntimeTrace } from './pair-runtime-trace';
import { assertPairRuntimeWritableAccount } from './pair-runtime-exposure';
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
/** Reviews and simulates an unsigned candidate, without signing, sending or reserving funds. */
export async function collectPairOrderReview(
  preflight: ImportedPairWalletPreflight,
  order: SolanaPairPreparation,
  rpc: Rpc,
  now: () => number = Date.now,
  captureRuntimeTrace = false,
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
  const [genesis, initialHeight] = await Promise.all([
    rpc('getGenesisHash', []),
    rpc('getBlockHeight', [{ commitment: 'confirmed' }]),
  ]);
  if (genesis !== SOLANA_MAINNET_GENESIS)
    throw Error('Pair candidate provider is not mainnet.');
  const height = pairWalletUint(initialHeight),
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
    const requestedFloor = floor();
    const response = (await rpc('getMultipleAccounts', [
      addresses,
      {
        encoding: 'base64',
        commitment: 'confirmed',
        minContextSlot: requestedFloor,
        ...(slice ? { dataSlice: { offset: 0, length: 166 } } : {}),
      },
    ])) as { context?: { slot?: unknown }; value?: unknown[] };
    slots.push(slot(response?.context?.slot, requestedFloor));
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
  );
  const pair = preflight.quote.pair;
  const discovered = discoverPairAuxiliaryAccounts(
    preflight.wallet,
    selected,
    [pair.base.address, pair.quote.address],
    instructions,
    other,
  );
  const checkedAccounts = [...selected, ...discovered.map((a) => a.address)];
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
  const beforeFloor = floor();
  const [before, mints, auxiliaryMints] = await Promise.all([
    readAccounts(checkedAccounts, false),
    readPairMintEvidence(
      { inputMint: pair.base.address, outputMint: pair.quote.address },
      beforeFloor,
      rpc,
      now(),
    ),
    discovered.length
      ? readPairAuxiliaryMints(
          [...new Set(discovered.map((a) => a.mint))],
          beforeFloor,
          rpc,
          now,
        )
      : Promise.resolve(null),
  ]);
  const snapshots = [
    ...before,
    ...other.filter((a) => !checkedAccounts.includes(a.address)),
  ];
  slots.push(mints.slot);
  assertSamePairMintEvidence(quoted, mints);
  if (auxiliaryMints) slots.push(auxiliaryMints.slot);
  const auxiliary = discovered.map((a) => ({
    ...a,
    mint: auxiliaryMints!.mints.find((m) => m.address === a.mint)!,
  }));
  const rentByMint: Record<string, string> = {};
  const assetSizes = [...mints.mints, ...auxiliary.map((a) => a.mint)].map(
    (asset) => {
      const account = preflight.evidence.accounts.find(
        (a) => a.mint === asset.address,
      );
      const extra = auxiliary.find((a) => a.mint.address === asset.address);
      const raw = extra
        ? (before.find((a) => a.address === extra.address)!.raw as {
            data?: unknown;
          } | null)
        : null;
      let extraSize =
        asset.program === SWAP_TOKEN
          ? 165
          : getTokenSize(requiredPairAccountExtensions(asset));
      if (extra && raw !== null) {
        if (
          !Array.isArray(raw?.data) ||
          typeof raw.data[0] !== 'string' ||
          raw.data[0].length > 5464
        )
          throw Error('Auxiliary account layout is unsupported.');
        extraSize = atob(raw.data[0]).length;
        if (extraSize > 4096) throw Error('Auxiliary account size differs.');
      }
      const size =
        asset.address === SWAP_WRAPPED_SOL
          ? 165
          : account
            ? account.byteLength || account.expectedByteLength
            : extraSize;
      return { asset, account, size };
    },
  );
  const rentSizes = [...new Set([0, ...assetSizes.map((a) => a.size)])];
  const observedRents = new Map(
    await Promise.all(
      rentSizes.map(async (size) => {
        const rent = pairWalletUint(
          await rpc('getMinimumBalanceForRentExemption', [
            size,
            { commitment: 'confirmed' },
          ]),
        );
        if (rent < 1n) throw Error('Pair candidate rent is unavailable.');
        return [size, rent] as const;
      }),
    ),
  );
  if (
    observedRents.get(0)!.toString() !== preflight.evidence.systemRentMinimumRaw
  )
    throw Error('Pair candidate system-wallet rent changed.');
  for (const { asset, account, size } of assetSizes) {
    const rent = observedRents.get(size)!;
    rentByMint[asset.address] = rent.toString();
    if (
      account &&
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
    auxiliary,
  );
  fresh();
  const simulationResponse = await rpc('simulateTransaction', [
    order.preparation.transaction,
    {
      encoding: 'base64',
      commitment: 'confirmed',
      sigVerify: false,
      replaceRecentBlockhash: false,
      minContextSlot: floor(),
      accounts: { encoding: 'base64', addresses: writable },
      ...(captureRuntimeTrace ? { innerInstructions: true } : {}),
    },
  ]);
  slots.push(
    slot(
      (simulationResponse as { context?: { slot?: unknown } })?.context?.slot,
      floor(),
    ),
  );
  const simulation = await reviewPairOrderSimulation(
    preflight,
    assessment,
    snapshots,
    writable,
    simulationResponse,
  );
  const runtimeTrace = captureRuntimeTrace
    ? await reviewPairRuntimeTrace(
        (simulationResponse as { value?: { innerInstructions?: unknown } })
          ?.value?.innerInstructions,
        instructions,
        keys,
        writable,
      )
    : null;
  if (captureRuntimeTrace)
    (
      simulationResponse as { value: { accounts: unknown[] } }
    ).value.accounts.forEach(assertPairRuntimeWritableAccount);
  fresh();
  const afterFloor = floor();
  const [
    after,
    finalMints,
    finalAuxiliaryMints,
    recheck,
    rawValidity,
    rawFinalHeight,
    finalGenesis,
  ] = await Promise.all([
    readAccounts(checkedAccounts, false),
    readPairMintEvidence(
      { inputMint: pair.base.address, outputMint: pair.quote.address },
      afterFloor,
      rpc,
      now(),
    ),
    auxiliaryMints
      ? readPairAuxiliaryMints(
          auxiliaryMints.mints.map((m) => m.address),
          afterFloor,
          rpc,
          now,
        )
      : Promise.resolve(null),
    lookups
      ? readSwapLookupAccounts(message, afterFloor, rpc)
      : Promise.resolve(null),
    rpc('isBlockhashValid', [
      message.lifetimeToken,
      { commitment: 'confirmed', minContextSlot: afterFloor },
    ]),
    rpc('getBlockHeight', [{ commitment: 'confirmed' }]),
    rpc('getGenesisHash', []),
  ]);
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
    assertSameSwapLookups(lookups, recheck, null);
    slots.push(recheck!.observedSlot);
  }
  slots.push(finalMints.slot);
  assertSamePairMintEvidence(mints, finalMints);
  if (finalAuxiliaryMints) {
    slots.push(finalAuxiliaryMints.slot);
    for (const [i, m] of auxiliaryMints!.mints.entries())
      assertSamePairMintEvidence(
        { ...auxiliaryMints!, mints: [m, mints.mints[0]] },
        {
          ...finalAuxiliaryMints,
          mints: [finalAuxiliaryMints.mints[i], finalMints.mints[0]],
        },
      );
  }
  const validity = rawValidity as {
    context?: { slot?: unknown };
    value?: unknown;
  };
  slots.push(slot(validity?.context?.slot, afterFloor));
  const finalHeight = pairWalletUint(rawFinalHeight);
  if (
    validity.value !== true ||
    finalHeight < height ||
    finalHeight + 10n > last ||
    finalGenesis !== SOLANA_MAINNET_GENESIS
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
    auxiliaryMintEvidence: finalAuxiliaryMints,
    simulation,
    runtimeTrace,
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
    economicSimulationVerified: true as const,
    programCodeAttested: false as const,
    applicationReservationsChecked: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
  const sha256 = await sha(result);
  fresh();
  return { ...result, sha256 };
}
