import { address } from '@solana/kit';
import { prepareSolanaSwap, WRAPPED_SOL } from './warmup-swap-quote';
import { formatNativeBalance } from './wallet-balance-format';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import {
  getSolanaIndexerRpcEndpoint,
  requireConsistentSolanaSlots,
} from './solana-rpc';
import {
  readPairMintEvidence,
  assertSamePairMintEvidence,
} from './pair-mint-evidence';
import {
  readPairWalletEvidence,
  assertStablePairWalletEvidence,
  assessPairWalletFunding,
  pairWalletUint,
} from './pair-wallet-evidence';
import {
  stockPairRpcScope,
  pairClockUnixTimestamp,
  PAIR_CLOCK,
  type StockPairRpc,
} from './pair-stock-clock';
import { collectPairRuntimePreview } from './pair-runtime-preview';
import { pairRuntimeDigest } from './pair-runtime-trace';
import type { SolanaSwapRuntimeContext } from './solana-swap-runtime-context';
import type { WarmupSessionSimulationObservation } from './unsigned-swap-summary-simulation';
import type { WarmupSellInventory } from './warmup-sell-inventory';

/** Server-internal captured read request. This is not an HTTP consent or execution grant. */
export type WarmupRuntimeOrderRequest = {
  requestSha256: string;
  wallet: string;
  mint: string;
  side: 'Buy' | 'Sell';
  inputRaw: string;
  feeAndRentLimitRaw: string;
  deadline: number;
  inventory: WarmupSellInventory | null;
};
export type WarmupRuntimeOrderDependencies = {
  apiKey: string | undefined;
  signal: AbortSignal;
  rpc?: StockPairRpc;
  programRpc?: StockPairRpc;
  prepare?: typeof prepareSolanaSwap;
  now?: () => number;
};
const READ_METHODS = new Set([
  'getGenesisHash',
  'getSlot',
  'getMultipleAccounts',
  'getBlockHeight',
  'getFeeForMessage',
  'isBlockhashValid',
  'simulateTransaction',
]);
const fail = (): never => {
  throw Error(
    'Warmup runtime observations are unavailable for the exact original request.',
  );
};
/** Domain-separated read terms only. It is not an owned lease or consent hash. */
export async function walletWarmupRuntimeOrderRequestDigest(
  value: WarmupRuntimeOrderRequest,
) {
  const { requestSha256: _digest, ...terms } = value;
  return pairRuntimeDigest({
    format: 'wallet-warmup-runtime-read-request-v1',
    terms,
  });
}

/**
 * One unsigned order and one raw-account simulation, bracketed by full serial
 * code observations. No database write, saved consent, trusted policy or signing.
 * The caller must separately establish the owned lease/source and atomically
 * retain a runtime-specific purpose/result before exposing this as a saved mode.
 */
export async function collectWalletWarmupRuntimeOrder(
  value: WarmupRuntimeOrderRequest,
  dependencies: WarmupRuntimeOrderDependencies,
) {
  const request = structuredClone(value),
    now = dependencies.now ?? Date.now,
    started = now();
  dependencies.signal.throwIfAborted();
  address(request.wallet);
  address(request.mint);
  if (
    !/^[a-f0-9]{64}$/.test(request.requestSha256) ||
    request.mint === WRAPPED_SOL ||
    !['Buy', 'Sell'].includes(request.side) ||
    !Number.isSafeInteger(started) ||
    !Number.isSafeInteger(request.deadline) ||
    request.deadline <= started ||
    !dependencies.apiKey ||
    dependencies.apiKey.length > 1000 ||
    /\s/.test(dependencies.apiKey) ||
    pairWalletUint(request.inputRaw) === 0n ||
    pairWalletUint(request.feeAndRentLimitRaw) === 0n ||
    (dependencies.rpc && stockPairRpcScope(dependencies.rpc)) ||
    (dependencies.programRpc && stockPairRpcScope(dependencies.programRpc)) ||
    Boolean(dependencies.rpc) !== Boolean(dependencies.programRpc)
  )
    fail();
  const inventory = request.inventory;
  if (
    request.side === 'Buy'
      ? inventory !== null
      : !inventory ||
        inventory.wallet !== request.wallet ||
        inventory.mint !== request.mint ||
        inventory.requestedRaw !== request.inputRaw ||
        inventory.amountCovered !== true ||
        inventory.preparationSupported !== true ||
        inventory.executionAllowed !== false ||
        !Number.isInteger(inventory.decimals) ||
        inventory.decimals < 0 ||
        inventory.decimals > 18 ||
        !Number.isFinite(Date.parse(inventory.expiresAt)) ||
        Date.parse(inventory.expiresAt) <= started ||
        !Number.isFinite(Date.parse(inventory.observedAt)) ||
        Date.parse(inventory.observedAt) > started + 1000 ||
        started - Date.parse(inventory.observedAt) > 60000 ||
        Date.parse(inventory.expiresAt) <= Date.parse(inventory.observedAt) ||
        pairWalletUint(inventory.unfrozenRaw) <
          pairWalletUint(request.inputRaw) ||
        pairWalletUint(inventory.totalRaw) -
          pairWalletUint(inventory.frozenRaw) !==
          pairWalletUint(inventory.unfrozenRaw)
  )
    fail();
  if (
    (await walletWarmupRuntimeOrderRequestDigest(request)) !==
    request.requestSha256
  )
    fail();
  const end = Math.min(
      request.deadline,
      started + 25000,
      inventory ? Date.parse(inventory.expiresAt) : Infinity,
    ),
    controller = new AbortController(),
    signal = AbortSignal.any([
      dependencies.signal,
      controller.signal,
      AbortSignal.timeout(end - started),
    ]),
    slots: number[] = inventory
      ? [
          inventory.minSlot,
          inventory.maxSlot,
          ...(inventory.mintSlot === null ? [] : [inventory.mintSlot]),
        ]
      : [];
  if (
    slots.some((s) => !Number.isSafeInteger(s) || s < 1) ||
    (inventory && inventory.minSlot > inventory.maxSlot)
  )
    fail();
  let calls = 0,
    simulations = 0;
  const simulationContext = {
    feeSlot: null as number | null,
    simulationSlot: null as number | null,
  };
  const observations: {
    method: string;
    slot: number;
    channel: 'account' | 'code';
  }[] = [];
  const clockObservations: {
    channel: 'account' | 'code';
    slot: number;
    unixTimestamp: string;
  }[] = [];
  const fresh = () => {
    signal.throwIfAborted();
    const time = now();
    if (!Number.isSafeInteger(time) || time < started - 1000 || time >= end)
      fail();
  };
  const floor = () => {
    if (slots.length) requireConsistentSolanaSlots(slots);
    return slots.length ? Math.max(...slots) : 1;
  };
  const observed = (
    raw: unknown,
    minimum: number,
    method: string,
    channel: 'account' | 'code',
  ) => {
    const n = Number(pairWalletUint(raw));
    if (!Number.isSafeInteger(n) || n < minimum) fail();
    slots.push(n);
    floor();
    observations.push({ method, slot: n, channel });
    return n;
  };
  // No new endpoint fallback or stock profile. Both ordinary channels retain
  // the existing indexer selection (including its legacy fallback) and pacing.
  const endpoint = dependencies.rpc ? null : getSolanaIndexerRpcEndpoint();
  const base: StockPairRpc =
    dependencies.rpc ??
    ((method, params, readSignal) =>
      balanceRpc(endpoint!, method, params, readSignal ?? signal, fetch));
  const codeBase: StockPairRpc =
    dependencies.programRpc ??
    ((method, params, readSignal) =>
      balanceRpc(
        endpoint!,
        method,
        params,
        readSignal ?? signal,
        fetch,
        2097152,
      ));
  const channel =
    (rpc: StockPairRpc, kind: 'account' | 'code'): StockPairRpc =>
    async (method, params, readSignal) => {
      fresh();
      if (
        !READ_METHODS.has(method) ||
        (kind === 'code' &&
          !['getGenesisHash', 'getMultipleAccounts'].includes(method)) ||
        ++calls > 300
      )
        fail();
      if (method === 'simulateTransaction' && ++simulations !== 1) fail();
      const configIndex = ['getSlot', 'getBlockHeight'].includes(method)
        ? 0
        : 1;
      const minimum = floor(),
        args = structuredClone(params);
      if (method !== 'getGenesisHash') {
        const settings = args[configIndex];
        if (
          settings !== undefined &&
          (!settings || typeof settings !== 'object' || Array.isArray(settings))
        )
          fail();
        const config = settings as { minContextSlot?: number } | undefined;
        if (
          config?.minContextSlot !== undefined &&
          (!Number.isSafeInteger(config.minContextSlot) ||
            config.minContextSlot < 1)
        )
          fail();
        args[configIndex] = {
          ...config,
          minContextSlot: Math.max(minimum, config?.minContextSlot ?? 0),
        };
      }
      const requested =
        (args[configIndex] as { minContextSlot?: number } | undefined)
          ?.minContextSlot ?? minimum;
      const result = await rpc(
        method,
        args,
        AbortSignal.any([signal, ...(readSignal ? [readSignal] : [])]),
      );
      fresh();
      if (method === 'getSlot') observed(result, requested, method, kind);
      else if (
        [
          'getMultipleAccounts',
          'getFeeForMessage',
          'isBlockhashValid',
          'simulateTransaction',
        ].includes(method)
      ) {
        const r = result as { context?: { slot?: unknown }; value?: unknown[] };
        const slot = observed(r?.context?.slot, requested, method, kind);
        if (method === 'getFeeForMessage') simulationContext.feeSlot = slot;
        if (method === 'simulateTransaction')
          simulationContext.simulationSlot = slot;
        if (method === 'getMultipleAccounts') {
          const keys = args[0] as string[];
          const clocks = keys.flatMap((key, i) =>
            key === PAIR_CLOCK ? [r.value?.[i]] : [],
          );
          // Explicit ordinary Clock parser also refuses a tagged stock response.
          for (const clock of clocks)
            clockObservations.push({
              channel: kind,
              slot,
              unixTimestamp: pairClockUnixTimestamp(clock, slot, now()),
            });
          if (
            clocks.some(
              (clock) => JSON.stringify(clock) !== JSON.stringify(clocks[0]),
            )
          )
            fail();
        }
      }
      return result;
    };
  const rpc = channel(base, 'account'),
    codeRpc = channel(codeBase, 'code');
  try {
    fresh();
    const initialFloor = floor();
    const [genesis] = await Promise.all([
      rpc('getGenesisHash', []),
      rpc('getSlot', [
        { commitment: 'confirmed', minContextSlot: initialFloor },
      ]),
    ]);
    if (genesis !== SOLANA_MAINNET_GENESIS) fail();
    const pair = { inputMint: request.mint, outputMint: WRAPPED_SOL },
      beforeMints = await readPairMintEvidence(pair, floor(), rpc, now()),
      beforeWallet = await readPairWalletEvidence(
        beforeMints,
        request.wallet,
        rpc,
        now(),
      );
    const decimals = request.side === 'Buy' ? 9 : beforeMints.mints[0].decimals;
    if (
      inventory &&
      (inventory.decimals !== decimals ||
        inventory.tokenProgram !== beforeMints.mints[0].program)
    )
      fail();
    fresh();
    const order = structuredClone(
      await (dependencies.prepare ?? prepareSolanaSwap)(
        {
          tokenMint: request.mint,
          side: request.side,
          amount: formatNativeBalance(request.inputRaw, decimals),
          decimals,
          wallet: request.wallet,
        },
        dependencies.apiKey,
        signal,
      ),
    );
    fresh();
    if (
      order.executionAllowed !== false ||
      order.side !== request.side ||
      order.preparation.wallet !== request.wallet ||
      order.inputMint !==
        (request.side === 'Buy' ? WRAPPED_SOL : request.mint) ||
      order.outputMint !==
        (request.side === 'Sell' ? WRAPPED_SOL : request.mint) ||
      order.inAmount !== request.inputRaw ||
      !Number.isFinite(Date.parse(order.expiresAt)) ||
      Date.parse(order.expiresAt) <= now()
    )
      fail();
    const estimates = order.preparation.estimates,
      quotedNetwork =
        pairWalletUint(estimates.signatureFeeLamports) +
        pairWalletUint(estimates.prioritizationFeeLamports),
      quotedRent = pairWalletUint(estimates.rentFeeLamports);
    if (
      quotedNetwork + quotedRent !==
        pairWalletUint(order.preparation.estimatedFeesLamports) ||
      quotedNetwork + quotedRent > pairWalletUint(request.feeAndRentLimitRaw)
    )
      fail();
    const afterMints = await readPairMintEvidence(pair, floor(), rpc, now());
    assertSamePairMintEvidence(beforeMints, afterMints);
    const afterWallet = await readPairWalletEvidence(
      afterMints,
      request.wallet,
      rpc,
      now(),
    );
    assertStablePairWalletEvidence(beforeWallet, afterWallet);
    const mintPolicy = {
      slot: beforeMints.slot,
      recheckSlot: afterMints.slot,
      baseSha256: beforeMints.mints[0].policySha256,
      quoteSha256: beforeMints.mints[1].policySha256,
      unixTimestamp: beforeMints.unixTimestamp,
      recheckUnixTimestamp: afterMints.unixTimestamp,
    };
    const assets = {
      base: afterMints.mints[0],
      quote: afterMints.mints[1],
      mintPolicy,
    };
    const context: SolanaSwapRuntimeContext = {
      wallet: request.wallet,
      expiresAt: new Date(
        Math.min(end, Date.parse(order.expiresAt)),
      ).toISOString(),
      contextSha256: await pairRuntimeDigest({
        format: 'warmup-runtime-context-v1',
        request,
        assets,
        wallet: afterWallet,
        packetSha256: order.preparation.sha256,
      }),
      quote: {
        side: request.side,
        inputRaw: request.inputRaw,
        pair: {
          ...assets,
          sha256: await pairRuntimeDigest({
            format: 'warmup-runtime-assets-v1',
            ...assets,
          }),
        },
        quote: {
          minimumOutAmount: order.minimumOutAmount,
          ...(order.platformFee ? { platformFee: order.platformFee } : {}),
        },
      },
      evidence: afterWallet,
      funding: { userFeeAndRentLimitRaw: request.feeAndRentLimitRaw },
    };
    for (const wallet of [beforeWallet, afterWallet])
      if (
        !assessPairWalletFunding(
          context.quote,
          wallet,
          request.feeAndRentLimitRaw,
        ).canRequestUnsignedOrder
      )
        fail();
    const runtime = await collectPairRuntimePreview(
      { preflight: context, order },
      rpc,
      codeRpc,
      signal,
      now,
      'strict',
      100,
      1,
    );
    fresh();
    floor();
    const feeSlot = simulationContext.feeSlot ?? fail(),
      simulationSlot = simulationContext.simulationSlot ?? fail();
    if (simulations !== 1) fail();
    const { review } = runtime,
      economic = review.simulation;
    const observedFee = pairWalletUint(economic.networkFeeRaw),
      bound =
        (quotedNetwork > observedFee ? quotedNetwork : observedFee) +
        quotedRent;
    // Do not silently replace a provider's underestimated setup cost or reserve.
    if (
      pairWalletUint(review.assessment.accountCreationRentRaw) > quotedRent ||
      bound > pairWalletUint(request.feeAndRentLimitRaw)
    )
      fail();
    const changes: WarmupSessionSimulationObservation['tokenChanges'] =
      economic.tokenDeltas.map((delta) => {
        const mint = afterMints.mints.find((m) => m.address === delta.mint);
        if (!mint) return fail();
        return {
          mint: delta.mint,
          program: mint.program,
          decimals: mint.decimals,
          beforeRaw: delta.beforeRaw,
          afterRaw: delta.afterRaw,
          changeRaw: delta.deltaRaw,
          accounts: [delta.account],
        };
      });
    // Raw economic inspection omits selected native token deltas. Reconstruct
    // only its proven close/preserved balance, never provider token summaries.
    for (const account of review.assessment.accounts.filter(
      (a) => a.mint === WRAPPED_SOL,
    )) {
      const afterRaw = account.closed ? '0' : account.beforeAmountRaw;
      changes.push({
        mint: WRAPPED_SOL,
        program: account.program,
        decimals: 9,
        beforeRaw: account.beforeAmountRaw,
        afterRaw,
        changeRaw: (
          BigInt(afterRaw) - BigInt(account.beforeAmountRaw)
        ).toString(),
        accounts: [account.address],
      });
    }
    // Warmup's existing unrelated-token policy is stricter than pair routing.
    if (economic.auxiliaryTokenDeltas.some((d) => d.deltaRaw !== '0')) fail();
    const simulation: WarmupSessionSimulationObservation = {
      executionAllowed: false,
      instructionsVerified: false,
      sha256: review.packetSha256,
      wallet: request.wallet,
      succeeded: true,
      source: 'selected-runtime-rpc',
      observedAt: new Date(now()).toISOString(),
      feeSlot,
      simulationSlot,
      networkFeeLamports: economic.networkFeeRaw,
      unitsConsumed: economic.unitsConsumed,
      nativeChangeRaw: (
        BigInt(economic.walletLamportsAfterRaw) -
        BigInt(economic.walletLamportsBeforeRaw)
      ).toString(),
      tokensComplete: true,
      tokenChanges: changes,
      inputAmountMatches: request.side === 'Sell' ? true : null,
      minimumOutputCovered: request.side === 'Buy' ? true : null,
      routeAssessment: { status: 'Matched fields' },
      // Summary vocabulary for the full collector's custody checks, not a
      // claim that the legacy bindings reader or signing policy ran.
      accountBindings: { status: 'Matched bindings' },
    };
    return {
      order,
      simulation,
      context,
      runtime,
      observation: {
        format: 'wallet-warmup-runtime-observation-v1' as const,
        requestSha256: request.requestSha256,
        packetSha256: review.packetSha256,
        minimumSlot: Math.min(...slots),
        maximumSlot: floor(),
        calls,
        referenceMinimum: 'order-self' as const,
        independentPriceProtectionEstablished: false as const,
        observations,
        clockObservations,
        codeClockPolicy: 'context-slot-floor-only' as const,
        priorInventory: inventory
          ? {
              minSlot: inventory.minSlot,
              maxSlot: inventory.maxSlot,
              mintSlot: inventory.mintSlot,
              observedAt: inventory.observedAt,
              readWithinThisCollector: false as const,
            }
          : null,
        nativeSettlement: {
          walletLamportsBeforeRaw: economic.walletLamportsBeforeRaw,
          walletLamportsAfterRaw: economic.walletLamportsAfterRaw,
          networkFeeRaw: economic.networkFeeRaw,
          nativeTradeDeltaRaw: economic.nativeTradeDeltaRaw,
          retainedAccountRentRaw: economic.retainedAccountRentRaw,
          retainedNonNativeAccountRentRaw:
            economic.retainedNonNativeAccountRentRaw,
          retainedNativeAccountRentRaw: economic.retainedNativeAccountRentRaw,
          refundedNonNativeAccountRentRaw:
            economic.refundedNonNativeAccountRentRaw,
          auxiliaryWrappedSolGainRaw: economic.auxiliaryWrappedSolGainRaw,
        },
        codeReadConcurrency: 1 as const,
        programCodeAttested: false as const,
        trustedProgramPolicyEstablished: false as const,
        signingAllowed: false as const,
        executionAllowed: false as const,
      },
    };
  } finally {
    controller.abort();
  }
}
