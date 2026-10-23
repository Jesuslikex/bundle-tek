import {
  getBase64Encoder,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit';
import type { CounterBuyPreparation } from './counter-buy-preparation';
import {
  simulateCounterBuyPreparation,
  type CounterSimulationRpc,
} from './counter-buy-simulation';
import { reviewUnsignedSwapEnvelope } from './unsigned-swap-order';
import { reviewSwapInstructions } from './swap-instruction-review';
import { assessJupiterExactOutRoute } from './jupiter-exact-out-assessment';
import { collectPumpProgramIdentities } from './pump-group-code-identity';
import {
  pumpRpcAccount,
  pumpAccountBytes,
  pumpUnsignedInteger,
} from './pump-launch-simulation';
import {
  pairRuntimeDigest,
  reviewPairRuntimeTrace,
} from './pair-runtime-trace';
import { assertPairRuntimeWritableAccount } from './pair-runtime-exposure';
import { pairAccountProvenance } from './pair-account-provenance';
import { PAIR_CLOCK, pairClockUnixTimestamp } from './pair-stock-clock';
import {
  PAIR_RENT,
  inspectPairRentAccount,
  pairRentMinimumRaw,
} from './pair-rent-evidence';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import {
  getSolanaIndexerRpcEndpoint,
  requireConsistentSolanaSlots,
} from './solana-rpc';
const COMPUTE = 'ComputeBudget111111111111111111111111111111',
  NATIVE = 'NativeLoader1111111111111111111111111111111';
const METHODS = new Set([
  'getGenesisHash',
  'getSlot',
  'getMultipleAccounts',
  'getBlockHeight',
  'getFeeForMessage',
  'getMinimumBalanceForRentExemption',
  'isBlockhashValid',
  'simulateTransaction',
]);
type ProgramIdentity = Omit<
  Awaited<ReturnType<typeof collectPumpProgramIdentities>>['programs'][number],
  'identityKind'
> & { identityKind: 'native-system' | 'elf-code' | 'native-marker' };
const fail = (): never => {
  throw Error(
    'Counter unsigned runtime evidence is unavailable for the exact original packet.',
  );
};
function integer(value: unknown) {
  const n = pumpUnsignedInteger(value);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) return fail();
  return Number(n);
}
/** Observe the original ExactOut packet, never an ExactIn adaptation. All RPCs use
 * one captured provider. Complete serial code scans bracket ONE actual simulation;
 * the original Counter collector then performs its unchanged custody/LUT checks.
 * Observed code/trace identity is not a trusted policy, approval or signing grant.
 */
export async function collectCounterBuyRuntimeEvidence(
  value: CounterBuyPreparation,
  reviewedFeeAndRentLimitRaw: string,
  parentSignal: AbortSignal,
  suppliedRpc?: CounterSimulationRpc,
  now: () => number = Date.now,
) {
  const order = structuredClone(value),
    controller = new AbortController(),
    signal = AbortSignal.any([
      parentSignal,
      controller.signal,
      AbortSignal.timeout(25000),
    ]),
    started = now();
  const slots = [order.quote.contextSlot],
    clocks: { slot: number; unixTimestamp: string; evaluatedAt: string }[] = [],
    rentQuotes: string[] = [];
  let calls = 0,
    simulations = 0;
  const expires = Date.parse(order.expiresAt);
  function fresh() {
    signal.throwIfAborted();
    if (
      !Number.isSafeInteger(started) ||
      !Number.isSafeInteger(now()) ||
      now() < started ||
      !Number.isFinite(expires) ||
      now() >= expires
    )
      return fail();
  }
  function floor() {
    return Math.max(...slots);
  }
  function observed(raw: unknown, minimum: number) {
    const slot = integer(raw);
    if (slot < minimum) return fail();
    slots.push(slot);
    requireConsistentSolanaSlots(slots);
    return slot;
  }
  try {
    fresh();
    if (
      !Number.isSafeInteger(order.quote.contextSlot) ||
      order.quote.contextSlot < 1 ||
      order.quote.swapMode !== 'ExactOut' ||
      order.executionAllowed !== false ||
      order.instructionsVerified !== false ||
      order.quote.expiresAt !== order.expiresAt ||
      order.review.expiresAt !== order.expiresAt
    )
      return fail();
    const envelope = await reviewUnsignedSwapEnvelope(
      order.preparation.transaction,
      order.preparation.wallet,
    );
    if (envelope.sha256 !== order.preparation.sha256) return fail();
    const message = getCompiledTransactionMessageDecoder().decode(
      getTransactionDecoder().decode(
        getBase64Encoder().encode(envelope.transaction),
      ).messageBytes,
    );
    if (message.version !== 0) return fail();
    const lookup = order.preparation.lookupAccounts,
      keys = [
        ...message.staticAccounts.map(String),
        ...(lookup?.writable ?? []),
        ...(lookup?.readonly ?? []),
      ];
    if (
      keys.length !== envelope.accountCount ||
      keys.length > 256 ||
      new Set(keys).size !== keys.length
    )
      return fail();
    const writable = keys.filter((_key, i) =>
      i < message.staticAccounts.length
        ? i < message.header.numSignerAccounts
          ? i <
            message.header.numSignerAccounts -
              message.header.numReadonlySignerAccounts
          : i <
            message.staticAccounts.length -
              message.header.numReadonlyNonSignerAccounts
        : i < message.staticAccounts.length + (lookup?.writable.length ?? 0),
    );
    if (!writable.includes(envelope.wallet) || writable.length > 100)
      return fail();
    const top = reviewSwapInstructions(message, lookup ?? undefined),
      assessment = assessJupiterExactOutRoute(top, {
        swapMode: 'ExactOut',
        wallet: envelope.wallet,
        inputMint: order.quote.inputMint,
        outputMint: order.quote.outputMint,
        quotedInputRaw: order.quote.requiredSolInputRaw,
        outputTargetRaw: order.quote.outputTargetRaw,
        maximumInputRaw: order.quote.maximumSolInputRaw,
        reviewedInputBudgetRaw: order.quote.reviewedSolBudgetRaw,
        slippageBps: order.quote.slippageBps,
      });
    if (
      assessment.status !== 'Matched fields' ||
      JSON.stringify(assessment) !== JSON.stringify(order.review.assessment)
    )
      return fail();
    let provider = suppliedRpc;
    if (!provider) {
      const endpoint = getSolanaIndexerRpcEndpoint(),
        url = new URL(endpoint);
      if (url.protocol !== 'https:' || url.username || url.password)
        return fail();
      provider = (method, params, s) =>
        balanceRpc(endpoint, method, params, s, fetch, 2097152);
    }
    const rawCall: CounterSimulationRpc = async (
      method,
      params,
      readSignal,
    ) => {
      fresh();
      readSignal.throwIfAborted();
      if (!METHODS.has(method) || ++calls > 300) return fail();
      const args = structuredClone(params),
        index = ['getSlot', 'getBlockHeight'].includes(method) ? 0 : 1;
      const config = args[index] as Record<string, unknown> | undefined;
      if (
        method !== 'getGenesisHash' &&
        config !== undefined &&
        (!config || typeof config !== 'object' || Array.isArray(config))
      )
        return fail();
      const requestedFloor = Math.max(
        floor(),
        config?.minContextSlot === undefined
          ? 0
          : typeof config.minContextSlot === 'number' &&
              Number.isSafeInteger(config.minContextSlot) &&
              config.minContextSlot >= 1
            ? config.minContextSlot
            : fail(),
      );
      if (
        method !== 'getGenesisHash' &&
        method !== 'getMinimumBalanceForRentExemption'
      )
        args[index] = { ...config, minContextSlot: requestedFloor };
      const requestSignal = AbortSignal.any([signal, readSignal]);
      // Reject promptly even when a supplied transport ignores cancellation.
      const result = await new Promise<unknown>((resolve, reject) => {
        const abort = () =>
          reject(requestSignal.reason ?? Error('Counter runtime cancelled.'));
        requestSignal.addEventListener('abort', abort, { once: true });
        if (requestSignal.aborted) abort();
        Promise.resolve()
          .then(() => {
            requestSignal.throwIfAborted();
            return provider!(method, args, requestSignal);
          })
          .then(resolve, reject)
          .finally(() => requestSignal.removeEventListener('abort', abort));
      });
      fresh();
      readSignal.throwIfAborted();
      if (method === 'getGenesisHash') {
        if (result !== SOLANA_MAINNET_GENESIS) return fail();
      } else if (method === 'getSlot') observed(result, requestedFloor);
      else if (
        [
          'getMultipleAccounts',
          'getFeeForMessage',
          'isBlockhashValid',
          'simulateTransaction',
        ].includes(method)
      )
        observed(
          (result as { context?: { slot?: unknown } })?.context?.slot,
          requestedFloor,
        );
      else if (method === 'getMinimumBalanceForRentExemption')
        rentQuotes.push(pumpUnsignedInteger(result).toString());
      return result;
    };
    const accountCall: CounterSimulationRpc = async (
      method,
      params,
      readSignal,
    ) => {
      if (method !== 'getMultipleAccounts')
        return rawCall(method, params, readSignal);
      const args = structuredClone(params),
        original = args[0];
      if (
        !Array.isArray(original) ||
        !original.length ||
        original.some((k) => typeof k !== 'string') ||
        original.length > 100
      )
        return fail();
      const config = args[1] as
        | { dataSlice?: { offset?: unknown; length?: unknown } }
        | undefined;
      if (
        config?.dataSlice &&
        (config.dataSlice.offset !== 0 ||
          typeof config.dataSlice.length !== 'number' ||
          config.dataSlice.length < 40)
      )
        return fail();
      const partitioned = original.length > 98,
        pieces = partitioned
          ? [original.slice(0, 97), original.slice(97)]
          : [original];
      const accounts: unknown[] = [];
      let first: { context: { slot: unknown }; value: unknown[] } | undefined,
        clockIdentity: string | undefined,
        rentIdentity: string | undefined;
      for (const piece of pieces) {
        const overhead = partitioned
            ? [PAIR_RENT, PAIR_CLOCK, PAIR_CLOCK]
            : [PAIR_CLOCK, PAIR_CLOCK],
          requested = [...piece, ...overhead];
        const result = (await rawCall(
          method,
          [requested, ...args.slice(1)],
          readSignal,
        )) as { context: { slot: unknown }; value: unknown[] };
        if (
          !Array.isArray(result?.value) ||
          result.value.length !== requested.length
        )
          return fail();
        const clockValues = requested.flatMap((key, i) =>
            key === PAIR_CLOCK ? [result.value[i]] : [],
          ),
          slot = integer(result.context.slot),
          evaluated = now();
        if (clocks.length + clockValues.length > 300) return fail();
        for (const clock of clockValues) {
          const unixTimestamp = pairClockUnixTimestamp(clock, slot, evaluated);
          clocks.push({
            slot,
            unixTimestamp,
            evaluatedAt: new Date(evaluated).toISOString(),
          });
        }
        if (
          clockValues.some(
            (clock) => JSON.stringify(clock) !== JSON.stringify(clockValues[0]),
          )
        )
          return fail();
        const clock = JSON.stringify(clockValues[0]);
        if (
          first &&
          (JSON.stringify(first.context) !== JSON.stringify(result.context) ||
            clockIdentity !== clock)
        )
          return fail();
        if (partitioned) {
          const rent = result.value[piece.length];
          inspectPairRentAccount(rent);
          const encoded = JSON.stringify(rent);
          if (rentIdentity !== undefined && rentIdentity !== encoded)
            return fail();
          rentIdentity = encoded;
        }
        first ??= result;
        clockIdentity = clock;
        accounts.push(...result.value.slice(0, piece.length));
      }
      if (!first || accounts.length !== original.length) return fail();
      // A synthetic combined value is returned ONLY for identical actual bank,
      // full duplicate Clock and Rent responses. No provider retry or slot relabel.
      return { ...first, value: accounts };
    };
    async function inventory(
      phase: 'before-inventory' | 'after-inventory',
      previous?: unknown[],
    ) {
      const accounts: unknown[] = [];
      let rent: ReturnType<typeof inspectPairRentAccount> | undefined;
      for (let offset = 0; offset < keys.length; offset += 97) {
        const batch = keys.slice(offset, offset + 97),
          result = (await accountCall(
            'getMultipleAccounts',
            [
              [...batch, PAIR_RENT],
              {
                encoding: 'base64',
                commitment: 'confirmed',
                minContextSlot: floor(),
                dataSlice: { offset: 0, length: 166 },
              },
            ],
            signal,
          )) as { context: { slot: unknown }; value: unknown[] };
        const readRent = inspectPairRentAccount(result.value.at(-1));
        if (rent && JSON.stringify(rent) !== JSON.stringify(readRent))
          return fail();
        rent = readRent;
        for (let i = 0; i < batch.length; i++) {
          const position = offset + i,
            raw = result.value[i];
          pumpRpcAccount(raw);
          if (writable.includes(keys[position]))
            assertPairRuntimeWritableAccount(raw, {
              address: keys[position],
              phase,
              slot: integer(result.context.slot),
              before: previous?.[position],
              packetScope: () =>
                pairAccountProvenance(
                  message,
                  lookup,
                  position,
                  keys[position],
                  envelope.sha256,
                ),
              rpcAccountPosition: i,
              rpcAccountCount: batch.length,
            });
          accounts.push(raw);
        }
      }
      if (!rent || accounts.length !== keys.length) return fail();
      const programs = keys.filter(
        (_key, i) => pumpRpcAccount(accounts[i])?.executable,
      );
      if (
        !programs.length ||
        programs.length > 16 ||
        top.instructions.some(
          (i) =>
            !programs.includes(i.program.address) ||
            writable.includes(i.program.address),
        )
      )
        return fail();
      return { accounts, rent, programs };
    }
    async function identities(state: Awaited<ReturnType<typeof inventory>>) {
      const programs = state.programs.filter((key) => key !== COMPUTE);
      if (!programs.length) return fail();
      const code = await collectPumpProgramIdentities(
        programs,
        floor(),
        signal,
        (method, params) => rawCall(method, params, signal),
        1,
      );
      const result: ProgramIdentity[] = [...code.programs];
      if (state.programs.includes(COMPUTE)) {
        const a = pumpRpcAccount(state.accounts[keys.indexOf(COMPUTE)]);
        if (!a || !a.executable || a.owner !== NATIVE) return fail();
        const bytes = pumpAccountBytes(a);
        if (!bytes.length || bytes.length > 45) return fail();
        const declared = (
          state.accounts[keys.indexOf(COMPUTE)] as { space?: unknown }
        ).space;
        if (
          declared !== undefined &&
          pumpUnsignedInteger(declared) !== BigInt(bytes.length)
        )
          return fail();
        const codeSha256 = Array.from(
          new Uint8Array(
            await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)),
          ),
          (b) => b.toString(16).padStart(2, '0'),
        ).join('');
        result.push({
          address: COMPUTE,
          loader: NATIVE,
          programData: null,
          deploymentSlot: null,
          upgradeAuthority: null,
          codeSha256,
          codeBytes: bytes.length,
          identityKind: 'native-marker',
        });
      }
      return result.sort((a, b) =>
        a.address < b.address ? -1 : a.address > b.address ? 1 : 0,
      );
    }
    let beforeCode: ProgramIdentity[] | undefined,
      afterCode: ProgramIdentity[] | undefined,
      trace: Awaited<ReturnType<typeof reviewPairRuntimeTrace>> | undefined,
      rentBefore: ReturnType<typeof inspectPairRentAccount> | undefined;
    const wrapped: CounterSimulationRpc = async (
      method,
      params,
      readSignal,
    ) => {
      if (method !== 'simulateTransaction')
        return accountCall(method, params, readSignal);
      if (++simulations !== 1 || params[0] !== envelope.transaction)
        return fail();
      const original = structuredClone(params),
        settings = original[1] as Record<string, unknown>;
      if (
        !settings ||
        settings.replaceRecentBlockhash !== false ||
        settings.sigVerify !== false
      )
        return fail();
      const before = await inventory('before-inventory');
      rentBefore = before.rent;
      for (const quote of rentQuotes)
        if (quote !== pairRentMinimumRaw(before.rent, 165)) return fail();
      beforeCode = await identities(before);
      fresh();
      original[1] = { ...settings, innerInstructions: true };
      const raw = (await rawCall(method, original, readSignal)) as {
        context: { slot: unknown };
        value: {
          err?: unknown;
          accounts?: unknown[];
          innerInstructions?: unknown;
          replacementBlockhash?: unknown;
        };
      };
      if (
        raw?.value?.err !== null ||
        raw.value.replacementBlockhash != null ||
        !Array.isArray(raw.value.accounts) ||
        raw.value.accounts.length !== keys.length
      )
        return fail();
      trace = await reviewPairRuntimeTrace(
        raw.value.innerInstructions,
        top,
        keys,
        writable,
      );
      if (trace.programs.some((program) => !before.programs.includes(program)))
        return fail();
      for (let i = 0; i < keys.length; i++)
        if (writable.includes(keys[i]))
          assertPairRuntimeWritableAccount(raw.value.accounts[i], {
            address: keys[i],
            phase: 'simulation-post-state',
            slot: integer(raw.context.slot),
            before: before.accounts[i],
            packetScope: () =>
              pairAccountProvenance(
                message,
                lookup,
                i,
                keys[i],
                envelope.sha256,
              ),
            rpcAccountPosition: i,
            rpcAccountCount: keys.length,
          });
      const after = await inventory('after-inventory', before.accounts);
      if (
        JSON.stringify(before.programs) !== JSON.stringify(after.programs) ||
        JSON.stringify(before.rent) !== JSON.stringify(after.rent)
      )
        return fail();
      for (let i = 0; i < keys.length; i++) {
        const a = pumpRpcAccount(before.accounts[i]),
          b = pumpRpcAccount(after.accounts[i]);
        if (a?.owner !== b?.owner || a?.executable !== b?.executable)
          return fail();
      }
      afterCode = await identities(after);
      if (JSON.stringify(beforeCode) !== JSON.stringify(afterCode))
        return fail();
      return raw;
    };
    // The original collector retains all its ExactOut, fee, gross-account and final
    // stable-wallet/mint/LUT checks after our second full code collection.
    const simulation = await simulateCounterBuyPreparation(
      order,
      reviewedFeeAndRentLimitRaw,
      signal,
      wrapped,
    );
    if (
      simulations !== 1 ||
      !beforeCode ||
      !afterCode ||
      !trace ||
      !rentBefore ||
      !clocks.length
    )
      return fail();
    const final = (await accountCall(
      'getMultipleAccounts',
      [
        [PAIR_RENT],
        {
          encoding: 'base64',
          commitment: 'confirmed',
          minContextSlot: floor(),
        },
      ],
      signal,
    )) as { value: unknown[] };
    if (
      JSON.stringify(inspectPairRentAccount(final.value[0])) !==
      JSON.stringify(rentBefore)
    )
      return fail();
    const validity = (await rawCall(
      'isBlockhashValid',
      [
        message.lifetimeToken,
        { commitment: 'confirmed', minContextSlot: floor() },
      ],
      signal,
    )) as { value?: unknown };
    const height = await rawCall(
      'getBlockHeight',
      [{ commitment: 'confirmed', minContextSlot: floor() }],
      signal,
    );
    if (
      validity?.value !== true ||
      pumpUnsignedInteger(height) + 10n >
        pumpUnsignedInteger(order.preparation.lastValidBlockHeight)
    )
      return fail();
    await rawCall('getGenesisHash', [], signal);
    await rawCall(
      'getSlot',
      [{ commitment: 'confirmed', minContextSlot: floor() }],
      signal,
    );
    fresh();
    if (
      !Number.isSafeInteger(simulation.simulationSlot) ||
      simulation.simulationSlot < 1
    )
      return fail();
    const runtime = {
      format: 'counter-buy-runtime-evidence-v1' as const,
      packetSha256: envelope.sha256,
      minimumSlot: Math.min(...slots),
      maximumSlot: floor(),
      simulationSlot: simulation.simulationSlot,
      observedAt: new Date(started).toISOString(),
      expiresAt: order.expiresAt,
      programs: afterCode,
      traceSha256: trace.sha256,
      rawInstructionCoverageComplete: trace.rawInstructionCoverageComplete,
      providerObservationOnly: true as const,
      codeIdentityObserved: true as const,
      ordinaryClockVerified: true as const,
      codeScanCount: 2 as const,
      clocks,
      programCodeAttested: false as const,
      semanticAuditEstablished: false as const,
      trustedProgramPolicyEstablished: false as const,
      innerInstructionPolicyVerified: false as const,
      signingAllowed: false as const,
      executionAllowed: false as const,
    };
    const sha256 = await pairRuntimeDigest(runtime);
    fresh();
    return {
      simulation,
      runtime: { ...runtime, sha256 },
      codeScans: [beforeCode, afterCode] as const,
    };
  } finally {
    controller.abort();
  }
}
export type CounterBuyRuntimeEvidence = Awaited<
  ReturnType<typeof collectCounterBuyRuntimeEvidence>
>;
