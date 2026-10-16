import {
  getBase64Encoder,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit';
import { collectPumpProgramIdentities } from './pump-group-code-identity';
import {
  pumpRpcAccount,
  pumpAccountBytes,
  pumpUnsignedInteger,
} from './pump-launch-simulation';
import {
  readSwapLookupAccounts,
  assertSameSwapLookups,
} from './swap-lookup-accounts';
import { reviewSwapInstructions } from './swap-instruction-review';
import { pairRuntimeDigest } from './pair-runtime-trace';
import { collectPairOrderReview } from './pair-order-collector';
import { assertPairRuntimeWritableAccount } from './pair-runtime-exposure';
import type { PairQuoteBoundsMode } from './pair-order-quote-bounds';
import { pairAccountProvenance } from './pair-account-provenance';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { requireConsistentSolanaSlots } from './solana-rpc';
import { reviewUnsignedSwapEnvelope } from './unsigned-swap-order';
import { assessJupiterRoute } from './jupiter-route-assessment';
import { discoverPairAuxiliaryAccounts } from './pair-order-auxiliary';
import { PAIR_RENT, inspectPairRentAccount } from './pair-rent-evidence';
import { assertPairOrderQuoteBounds } from './pair-order-quote-bounds';
import type { prepareOwnedImportedPairOrder } from './imported-pair-order-candidate';
type Candidate = Pick<
  Awaited<ReturnType<typeof prepareOwnedImportedPairOrder>>,
  'preflight' | 'order'
>;
type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
const COMPUTE = 'ComputeBudget111111111111111111111111111111',
  NATIVE = 'NativeLoader1111111111111111111111111111111';
/** Two full code observations bracket the traced simulation. This establishes identity evidence, not a trusted program policy or semantic audit. */
export async function collectPairRuntimePreview(
  candidate: Candidate,
  rpc: Rpc,
  programRpc: Rpc,
  signal: AbortSignal,
  now: () => number = Date.now,
  quoteBoundsMode: PairQuoteBoundsMode = 'strict',
  inventoryAccountLimit: 5 | 100 = 100,
) {
  if (![5, 100].includes(inventoryAccountLimit))
    throw Error('Pair runtime inventory account limit differs.');
  const controller = new AbortController();
  try {
    return await inspectPairRuntime(
      candidate,
      rpc,
      programRpc,
      AbortSignal.any([signal, controller.signal]),
      now,
      quoteBoundsMode,
      inventoryAccountLimit,
    );
  } finally {
    controller.abort();
  }
}
async function inspectPairRuntime(
  candidate: Candidate,
  rpc: Rpc,
  programRpc: Rpc,
  signal: AbortSignal,
  now: () => number,
  quoteBoundsMode: PairQuoteBoundsMode,
  inventoryAccountLimit: 5 | 100,
) {
  const started = now(),
    slots = [
      candidate.preflight.quote.pair.mintPolicy.slot,
      candidate.preflight.quote.pair.mintPolicy.recheckSlot,
      candidate.preflight.evidence.slot,
    ],
    floor = () => Math.max(...slots);
  const fresh = () => {
    signal.throwIfAborted();
    const time = now();
    if (
      !Number.isFinite(time) ||
      time < started - 1000 ||
      time >=
        Math.min(
          Date.parse(candidate.preflight.expiresAt),
          Date.parse(candidate.order.expiresAt),
        )
    )
      throw Error('Pair runtime preview expired.');
  };
  const context = (raw: unknown, requestedFloor = floor()) => {
    const slot = Number(pumpUnsignedInteger(raw));
    if (!Number.isSafeInteger(slot) || slot < requestedFloor)
      throw Error('Pair runtime context moved backwards.');
    slots.push(slot);
    requireConsistentSolanaSlots(slots);
    return slot;
  };
  const call: Rpc = async (method, params) => {
    fresh();
    const config = params[1] as { minContextSlot?: number } | undefined;
    const scoped =
      config && typeof config.minContextSlot === 'number'
        ? [
            params[0],
            {
              ...config,
              minContextSlot: Math.max(config.minContextSlot, floor()),
            },
            ...params.slice(2),
          ]
        : params;
    const result = await rpc(method, scoped);
    fresh();
    const requestedFloor = (
      scoped[1] as { minContextSlot?: number } | undefined
    )?.minContextSlot;
    if (
      typeof requestedFloor === 'number' &&
      [
        'getMultipleAccounts',
        'getFeeForMessage',
        'isBlockhashValid',
        'simulateTransaction',
      ].includes(method)
    )
      context(
        (result as { context?: { slot?: unknown } })?.context?.slot,
        requestedFloor,
      );
    return result;
  };
  const codeCall: Rpc = async (method, params) => {
    fresh();
    if (!['getMultipleAccounts', 'getGenesisHash'].includes(method))
      throw Error('Pair code reader method differs.');
    const result = await programRpc(method, params);
    fresh();
    return result;
  };
  fresh();
  assertPairOrderQuoteBounds(
    candidate.preflight.quote,
    candidate.order,
    candidate.preflight.wallet,
    quoteBoundsMode,
  );
  const envelope = await reviewUnsignedSwapEnvelope(
    candidate.order.preparation.transaction,
    candidate.preflight.wallet,
  );
  if (
    envelope.sha256 !== candidate.order.preparation.sha256 ||
    envelope.accountCount !== candidate.order.preparation.accountCount ||
    envelope.lookupTableCount !== candidate.order.preparation.lookupTableCount
  )
    throw Error('Pair runtime packet fingerprint differs.');
  const message = getCompiledTransactionMessageDecoder().decode(
    getTransactionDecoder().decode(
      getBase64Encoder().encode(candidate.order.preparation.transaction),
    ).messageBytes,
  );
  const lookups = await readSwapLookupAccounts(message, floor(), call);
  if (lookups) context(String(lookups.observedSlot));
  const keys = [
    ...message.staticAccounts.map(String),
    ...(lookups?.writable ?? []),
    ...(lookups?.readonly ?? []),
  ];
  if (
    message.version !== 0 ||
    new Set(keys).size !== keys.length ||
    keys.length !== envelope.accountCount ||
    keys.length > 256
  )
    throw Error('Pair runtime account scope differs.');
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
  if (writable.length > 100 || !writable.includes(candidate.preflight.wallet))
    throw Error('Pair runtime writable scope differs.');
  const top = reviewSwapInstructions(message, lookups ?? undefined);
  const route = assessJupiterRoute(top, candidate.order);
  if (route.status !== 'Matched fields' || !route.decoded)
    throw Error('Pair runtime route fields differ.');
  async function read(
    keys: string[],
    sliced: boolean,
    onContext?: (slot: number) => void,
  ) {
    const requestedFloor = floor();
    const response = (await call('getMultipleAccounts', [
      keys,
      {
        encoding: 'base64',
        commitment: 'confirmed',
        minContextSlot: requestedFloor,
        ...(sliced ? { dataSlice: { offset: 0, length: 166 } } : {}),
      },
    ])) as { context?: { slot?: unknown }; value?: unknown[] };
    const observedSlot = context(response?.context?.slot, requestedFloor);
    onContext?.(observedSlot);
    if (!Array.isArray(response.value) || response.value.length !== keys.length)
      throw Error('Pair runtime account snapshot is incomplete.');
    return response.value.map((raw) => {
      const a = pumpRpcAccount(raw),
        declared = (raw as { space?: unknown } | null)?.space;
      return (
        a && {
          ...a,
          space:
            declared === undefined
              ? undefined
              : pumpUnsignedInteger(declared).toString(),
        }
      );
    });
  }
  async function inventory(
    phase: 'before-inventory' | 'after-inventory',
    previous?: unknown[],
  ) {
    const accounts = [];
    const observedSlots: number[] = [];
    for (let offset = 0; offset < keys.length; offset += inventoryAccountLimit)
      accounts.push(
        ...(await read(
          keys.slice(offset, offset + inventoryAccountLimit),
          true,
          (slot) => observedSlots.push(slot),
        )),
      );
    for (const [i, a] of accounts.entries())
      if (writable.includes(keys[i]))
        assertPairRuntimeWritableAccount(a, {
          address: keys[i],
          phase,
          slot: observedSlots[Math.floor(i / inventoryAccountLimit)],
          before: previous?.[i],
          packetScope: () =>
            pairAccountProvenance(
              message,
              lookups,
              i,
              keys[i],
              envelope.sha256,
            ),
          rpcAccountPosition: i % inventoryAccountLimit,
          rpcAccountCount: Math.min(
            inventoryAccountLimit,
            keys.length -
              Math.floor(i / inventoryAccountLimit) * inventoryAccountLimit,
          ),
        });
    const programs = accounts
      .flatMap((a, i) => (a?.executable ? [keys[i]] : []))
      .sort();
    if (
      !programs.length ||
      programs.length > 16 ||
      top.instructions.some((ix) => !programs.includes(ix.program.address))
    )
      throw Error('Pair runtime executable coverage differs.');
    return { programs, compute: accounts[keys.indexOf(COMPUTE)], accounts };
  }
  const selected = [
    candidate.preflight.wallet,
    route.decoded.sourceAccount,
    route.decoded.destinationAccount,
  ];
  if (
    new Set(selected).size !== 3 ||
    selected.some((key) => !writable.includes(key))
  )
    throw Error('Pair runtime selected privileges differ.');
  async function initialEvidence() {
    const beforeInventory = await inventory('before-inventory');
    // Reuse the bounded account inventory for intermediate discovery.
    const auxiliary = discoverPairAuxiliaryAccounts(
      candidate.preflight.wallet,
      selected,
      [
        candidate.preflight.quote.pair.base.address,
        candidate.preflight.quote.pair.quote.address,
      ],
      top,
      keys.flatMap((key, i) =>
        writable.includes(key) && !selected.includes(key)
          ? [{ address: key, raw: beforeInventory.accounts[i] }]
          : [],
      ),
    );
    selected.push(...auxiliary.map((a) => a.address));
    const protectedState = [...selected, PAIR_RENT];
    const [beforeCode, beforeAccounts] = await Promise.all([
      identities(beforeInventory),
      read(protectedState, false).then((accounts) => {
        inspectPairRentAccount(accounts.at(-1));
        return accounts;
      }),
    ]);
    return {
      beforeInventory,
      auxiliary,
      protectedState,
      beforeCode,
      beforeAccounts,
    };
  }
  async function observeCode(evidence: Awaited<ReturnType<typeof inventory>>) {
    const programs = evidence.programs.filter((p) => p !== COMPUTE);
    const requestedFloor = floor();
    const code = await collectPumpProgramIdentities(
      programs,
      requestedFloor,
      signal,
      (method, params) => codeCall(method, params),
      4,
    );
    context(String(code.maximumSlot), requestedFloor);
    return code;
  }
  async function identities(
    evidence: Awaited<ReturnType<typeof inventory>>,
    observation = observeCode(evidence),
  ) {
    const code = await observation;
    const result = code.programs.map((p) => ({
      ...p,
      identityKind: p.identityKind as string,
    }));
    if (evidence.programs.includes(COMPUTE)) {
      const a = evidence.compute;
      if (
        !a ||
        !a.executable ||
        a.owner !== NATIVE ||
        !pumpAccountBytes(a).length ||
        pumpAccountBytes(a).length > 45 ||
        (a.space !== undefined &&
          Number(pumpUnsignedInteger(a.space)) !== pumpAccountBytes(a).length)
      )
        throw Error('Pair compute-budget native marker differs.');
      result.push({
        address: COMPUTE,
        loader: NATIVE,
        programData: null,
        deploymentSlot: null,
        upgradeAuthority: null,
        codeSha256: Buffer.from(
          await crypto.subtle.digest('SHA-256', pumpAccountBytes(a)),
        ).toString('hex'),
        codeBytes: pumpAccountBytes(a).length,
        identityKind: 'native-marker',
      });
    }
    return result.sort((a, b) =>
      a.address < b.address ? -1 : a.address > b.address ? 1 : 0,
    );
  }
  let finalEvidence: ReturnType<typeof collectFinalEvidence> | undefined;
  let simulationFloor: number | undefined;
  const initial = initialEvidence();
  const [{ beforeInventory, auxiliary }, review] = await Promise.all([
    initial,
    collectPairOrderReview(
      candidate.preflight,
      candidate.order,
      call,
      now,
      true,
      {
        beforeSimulation: async () => {
          await initial;
          fresh();
        },
        afterSimulation: async (observedFloor) => {
          simulationFloor = observedFloor;
          const state = await initial;
          fresh();
          finalEvidence = collectFinalEvidence(state);
          await finalEvidence;
        },
      },
      quoteBoundsMode,
    ),
  ]);
  if (simulationFloor === undefined || !finalEvidence)
    throw Error('Pair runtime final evidence is missing.');
  context(String(review.maximumSlot), simulationFloor);
  if (
    JSON.stringify(
      review.assessment.auxiliaryAccounts.map((a) => a.address),
    ) !== JSON.stringify(auxiliary.map((a) => a.address))
  )
    throw Error('Pair runtime intermediate custody scope changed.');
  if (
    !review.runtimeTrace ||
    review.runtimeTrace.programs.some(
      (p) => !beforeInventory.programs.includes(p),
    )
  )
    throw Error(
      'Pair runtime inner program is not covered by executable identities.',
    );
  const { afterCode, height } = await finalEvidence;
  if (
    height < BigInt(review.recheckBlockHeight) ||
    height + 10n > BigInt(review.lastValidBlockHeight)
  )
    throw Error('Pair runtime lifetime or network changed.');
  fresh();
  const result = {
    format: 'pair-order-runtime-preview-v1' as const,
    packetSha256: review.packetSha256,
    preflightSha256: review.preflightSha256,
    pairSha256: review.pairSha256,
    reviewSha256: review.sha256,
    programs: afterCode,
    traceSha256: review.runtimeTrace.sha256,
    codeIdentityObserved: true as const,
    minimumSlot: Math.min(...slots),
    maximumSlot: floor(),
    recheckBlockHeight: height.toString(),
    observedAt: new Date(started).toISOString(),
    expiresAt: review.expiresAt,
    programCodeAttested: false as const,
    semanticAuditEstablished: false as const,
    trustedProgramPolicyEstablished: false as const,
    innerInstructionPolicyVerified: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
  const sha256 = await pairRuntimeDigest(result);
  fresh();
  return { review, runtime: { ...result, sha256 } };
  async function collectFinalEvidence(
    state: Awaited<ReturnType<typeof initialEvidence>>,
  ) {
    const { beforeInventory, protectedState, beforeCode, beforeAccounts } =
      state;
    const [afterInventory, observation] = await Promise.all([
      inventory('after-inventory', beforeInventory.accounts),
      observeCode(beforeInventory),
    ]);
    if (
      JSON.stringify(beforeInventory.programs) !==
      JSON.stringify(afterInventory.programs)
    )
      throw Error('Pair runtime executable coverage changed.');
    const afterCode = await identities(
      afterInventory,
      Promise.resolve(observation),
    );
    if (JSON.stringify(beforeCode) !== JSON.stringify(afterCode))
      throw Error(
        'Pair program code or upgrade authority changed around simulation.',
      );
    // Candidate final checks already ran alongside code. Preserve this last
    // runtime observation to catch custody/Rent/lifetime changes during code IO.
    const afterFloor = floor();
    const [afterAccounts, recheck, rawValidity, rawHeight, genesis] =
      await Promise.all([
        read(protectedState, false),
        lookups
          ? readSwapLookupAccounts(message, afterFloor, call)
          : Promise.resolve(null),
        call('isBlockhashValid', [
          message.lifetimeToken,
          { commitment: 'confirmed', minContextSlot: afterFloor },
        ]),
        call('getBlockHeight', [
          { commitment: 'confirmed', minContextSlot: afterFloor },
        ]),
        call('getGenesisHash', []),
      ]);
    const stateIdentity = (accounts: typeof beforeAccounts) =>
      accounts.map((a) => a && [a.owner, a.executable, a.lamports, a.data]);
    if (
      (await pairRuntimeDigest(stateIdentity(beforeAccounts))) !==
      (await pairRuntimeDigest(stateIdentity(afterAccounts)))
    )
      throw Error('Pair runtime wallet custody or balances changed.');
    if (lookups) {
      assertSameSwapLookups(lookups, recheck, null);
      context(String(recheck!.observedSlot), afterFloor);
    }
    const valid = rawValidity as {
      context?: { slot?: unknown };
      value?: unknown;
    };
    context(valid?.context?.slot, afterFloor);
    const height = pumpUnsignedInteger(rawHeight);
    if (
      valid.value !== true ||
      height + 10n > BigInt(candidate.order.preparation.lastValidBlockHeight) ||
      genesis !== SOLANA_MAINNET_GENESIS
    )
      throw Error('Pair runtime lifetime or network changed.');
    fresh();
    return { afterCode, height };
  }
}
