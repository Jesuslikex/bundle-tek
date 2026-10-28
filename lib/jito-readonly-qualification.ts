import {
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit';
import { requireJitoManifest, type JitoBundleManifest } from './jito-bundle';
import {
  replayJitoSwapSimulation,
  type JitoSwapSimulationCapture,
} from './jito-swap-simulation-capture';
import {
  buildJitoAssetRead,
  readJitoAssetEvidence,
  verifyJitoAssetBracket,
} from './jito-asset-evidence';
import {
  collectJitoRuntimeEvidence,
  verifyJitoRuntimeBracket,
  jitoRuntimePolicyRefusal,
} from './jito-runtime-evidence';
import { createJitoQualificationTransport } from './jito-qualification-transport';
import { collectJitoCoherentSimulationAttempt } from './jito-coherent-simulation-attempt';
import { buildJitoBundleSimulationRequest } from './jito-bundle-simulation-frames';
import { verifyJitoBundleEconomicObservation } from './jito-bundle-economics';
import {
  readSwapLookupAccounts,
  assertSameSwapLookups,
} from './swap-lookup-accounts';
import { snapshotJitoEvidence } from './jito-evidence-json';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import type { paceWalletRpc } from './wallet-rpc-pacing';

const authority = {
  providerQualified: false as const,
  sourceCurrent: false as const,
  signatureVerified: false as const,
  runtimePrivilegesVerified: false as const,
  runtimeAttested: false as const,
  signingAllowed: false as const,
  executionAllowed: false as const,
  automaticExecutionAllowed: false as const,
  receiptVerified: false as const,
};
// The reason alone hides which step and which status; carry the detail when the
// refusal has one.
const refusedDetail = (refused: { reason: string; detail?: string }) =>
  Error(refused.detail ? refused.reason + ': ' + refused.detail : refused.reason);
// Which stage refused. Module scope so fail() can name it; the campaign is
// sequential, so one shared value is enough.
let stage = 'setup';
const fail = (): never => {
  throw Error('Jito read-only qualification refused at ' + stage);
};
/** Private server-only diagnostic. Full newly captured baseline evidence is
 * mandatory; saved scalar summaries and arbitrary caller-created proof objects
 * cannot substitute. No owned-source/DB, signing, execution or node-attestation
 * authority is created. Existing UI/HTTP signing diagnostics are unchanged.
 * Independent bounded asset/runtime stages ADD work; they do not increase the
 * existing bundle transport's 12HTTP/18method limit. Every stage shares F..F+32. */
export async function collectJitoReadOnlyQualification(
  manifestInput: JitoBundleManifest,
  capsulesInput: JitoSwapSimulationCapture[],
  signal: AbortSignal,
  dependencies: { fetcher?: typeof fetch; pace?: typeof paceWalletRpc } = {},
) {
  const timingOriginMs = performance.now();
  const timingEvents: {
    phase: string;
    event: 'begin' | 'finish' | 'refused';
    atMs: number;
  }[] = [];
  let timingClosed = false;
  const openTimingPhases = new Set<string>();
  const mark = (phase: string, event: 'begin' | 'finish' | 'refused') => {
    if (timingClosed) return;
    timingEvents.push({
      phase,
      event,
      atMs: Math.max(0, performance.now() - timingOriginMs),
    });
    if (event === 'begin') openTimingPhases.add(phase);
    else openTimingPhases.delete(phase);
  };
  mark('collector', 'begin');
  const manifest = snapshotJitoEvidence(manifestInput);
  if (
    !Array.isArray(capsulesInput) ||
    capsulesInput.length < 1 ||
    capsulesInput.length > 4 ||
    Reflect.ownKeys(capsulesInput).length !== capsulesInput.length + 1
  )
    return fail();
  const capsules: JitoSwapSimulationCapture[] = [];
  for (let i = 0; i < capsulesInput.length; i++) {
    const d = Object.getOwnPropertyDescriptor(capsulesInput, String(i));
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) return fail();
    capsules.push(d.value);
  }
  mark('manifest-validation', 'begin');
  await requireJitoManifest(manifest, false);
  if (
    capsules.length !== manifest.swaps.length ||
    Date.parse(manifest.expiresAt) <= Date.now()
  )
    return fail();
  mark('manifest-validation', 'finish');
  mark('baseline-replay', 'begin');
  const source = await Promise.all(
    capsules.map((c) => replayJitoSwapSimulation(c, signal)),
  );
  mark('baseline-replay', 'finish');
  const slots = [
    manifest.tip.slot,
    ...source.flatMap((s) => [
      s.simulation.feeSlot,
      s.simulation.simulationSlot,
      ...(s.simulation.accountBindings.slot === null
        ? []
        : [s.simulation.accountBindings.slot]),
      ...(s.simulation.lookupObservation
        ? [
            s.simulation.lookupObservation.slot,
            s.simulation.lookupObservation.recheckSlot,
          ]
        : []),
    ]),
  ];
  const minimumSlot = Math.min(...slots);
  const floor = () => {
    if (
      slots.some((s) => !Number.isSafeInteger(s) || s < minimumSlot) ||
      Math.max(...slots) - minimumSlot > 32
    )
      return fail();
    return Math.max(...slots);
  };
  floor();
  for (let i = 0; i < source.length; i++)
    if (
      source[i].order.preparation.transaction !==
        manifest.swaps[i].transaction ||
      source[i].order.preparation.sha256 !== manifest.swaps[i].sha256
    )
      return fail();
  const owner = new AbortController(),
    control = AbortSignal.any([
      signal,
      owner.signal,
      AbortSignal.timeout(45000),
    ]);
  const bundle = createJitoQualificationTransport(
      'bundle',
      minimumSlot,
      control,
      dependencies,
    ),
    assets = createJitoQualificationTransport(
      'assets',
      minimumSlot,
      control,
      dependencies,
    ),
    initialCode = createJitoQualificationTransport(
      'runtime',
      minimumSlot,
      control,
      dependencies,
    ),
    finalCode = createJitoQualificationTransport(
      'runtime',
      minimumSlot,
      control,
      dependencies,
    );
  stage = 'network';
  let beforeAssets: Awaited<ReturnType<typeof readJitoAssetEvidence>> | null =
      null,
    afterAssets: Awaited<ReturnType<typeof readJitoAssetEvidence>> | null =
      null;
  let beforeCode: Awaited<
      ReturnType<typeof collectJitoRuntimeEvidence>
    > | null = null,
    afterCode: Awaited<ReturnType<typeof collectJitoRuntimeEvidence>> | null =
      null;
  let attempt: Awaited<
    ReturnType<typeof collectJitoCoherentSimulationAttempt>
  > | null = null;
  const evidence = (terminal: 'finish' | 'refused') => {
    mark('collector', terminal);
    const timing = snapshotJitoEvidence({
      clock: 'process-monotonic' as const,
      originMs: timingOriginMs,
      diagnosticOnly: true as const,
      originalMinimumSlot: minimumSlot,
      maximumCapturedContextSlot: Math.max(
        ...slots,
        ...[bundle, assets, initialCode, finalCode].map(
          (t) => t.summary().maximumObservedSlot ?? minimumSlot,
        ),
      ),
      contextSlotsAdmitted: false as const,
      events: timingEvents,
    });
    timingClosed = true;
    return {
      timing,
      baselineCaptures: capsules,
      assetsBefore: beforeAssets,
      assetsAfter: afterAssets,
      runtimeBefore: beforeCode,
      runtimeAfter: afterCode,
      attempt,
      transports: [bundle, assets, initialCode, finalCode].map((t) => ({
        summary: t.summary(),
        captures: t.captures(),
      })),
    };
  };
  const rpc: typeof bundle.rpc = async (method, params, s) => {
    const result = await bundle.rpc(method, params, s);
    if (method === 'getMultipleAccounts') {
      slots.push(
        Number((result as { context: { slot: string } }).context.slot),
      );
      floor();
    }
    return result;
  };
  try {
    mark('network', 'begin');
    if ((await rpc('getGenesisHash', [], control)) !== SOLANA_MAINNET_GENESIS)
      return fail();
    mark('network', 'finish');
    stage = 'lookup-before';
    mark('lookup-before', 'begin');
    const messages = source.map((s) =>
      getCompiledTransactionMessageDecoder().decode(
        getTransactionDecoder().decode(
          Buffer.from(s.order.preparation.transaction, 'base64'),
        ).messageBytes,
      ),
    );
    const lookups: Awaited<ReturnType<typeof readSwapLookupAccounts>>[] = [];
    for (let i = 0; i < messages.length; i++) {
      const lookup = await readSwapLookupAccounts(
        messages[i],
        floor(),
        (m, p) => rpc(m, p, control),
      );
      const approved = manifest.swaps[i].settlement?.lookupTables;
      if (
        !approved ||
        JSON.stringify(
          lookup?.tables.map(({ address, sha256, lastExtendedSlot }) => ({
            address,
            sha256,
            lastExtendedSlot,
          })) ?? [],
        ) !== JSON.stringify(approved)
      )
        return fail();
      lookups.push(lookup);
    }
    mark('lookup-before', 'finish');
    mark('packet-scope', 'begin');
    const packets = manifest.swaps.map((r, i) => ({
      transaction: r.transaction,
      loadedAddresses: lookups[i]
        ? { writable: lookups[i]!.writable, readonly: lookups[i]!.readonly }
        : null,
      maximumFeeLamports: r.maximumFeeLamports,
      expectedFeeLamports: r.maximumFeeLamports,
    }));
    packets.push({
      transaction: manifest.tip.transaction,
      loadedAddresses: null,
      maximumFeeLamports: manifest.tip.feeLamports,
      expectedFeeLamports: manifest.tip.feeLamports,
    });
    const request = await buildJitoBundleSimulationRequest(
      packets,
      minimumSlot,
      { bankEncoding: 'slot-object', verifySignatures: false },
    );
    const keys = [
      ...new Set(
        request.params[1].preExecutionAccountsConfigs.flatMap(
          (c) => c.addresses,
        ),
      ),
    ];
    const mints = [
      ...new Set(
        source.flatMap((s) => [s.order.inputMint, s.order.outputMint]),
      ),
    ];
    mark('packet-scope', 'finish');
    // Independent pre-simulation reads share one admitted phase-start floor.
    // Neither result can renew F or start simulation before the other finishes.
    const beforeFloor = floor();
    stage = 'preflight';
    const failures: { stage: string; error: unknown }[] = [];
    const guardedRead = async <T>(name: string, read: () => Promise<T>) => {
      mark(name, 'begin');
      try {
        const value = await read();
        mark(name, 'finish');
        return value;
      } catch (error) {
        mark(name, 'refused');
        if (!failures.length) {
          failures.push({ stage: name, error });
          owner.abort();
        }
        throw error;
      }
    };
    const beforeReads = await Promise.allSettled([
      guardedRead('assets-before', async () => {
        const beforePlan = buildJitoAssetRead(
          mints,
          minimumSlot,
          beforeFloor,
          'jito-assets:before',
        );
        const value = await readJitoAssetEvidence(
          beforePlan,
          (await assets.request(beforePlan.body, control)).body,
          control,
        );
        slots.push(value.slot);
        floor();
        return value;
      }),
      guardedRead('runtime-before', async () => {
        const value = await collectJitoRuntimeEvidence(
          keys,
          minimumSlot,
          beforeFloor,
          control,
          initialCode.rpc,
        );
        slots.push(value.maximumSlot);
        floor();
        return value;
      }),
    ]);
    // Settle both logical branches before capturing refusal evidence or closing
    // their transports. A failed branch never leaves a scan issuing more reads.
    if (beforeReads[0].status === 'fulfilled')
      beforeAssets = beforeReads[0].value;
    if (beforeReads[1].status === 'fulfilled')
      beforeCode = beforeReads[1].value;
    const refused = beforeReads.find((r) => r.status === 'rejected');
    if (refused?.status === 'rejected') {
      const failure = failures[0];
      stage = failure?.stage ?? 'preflight';
      throw failure?.error ?? refusedDetail(refused.reason);
    }
    control.throwIfAborted();
    if (!beforeAssets || !beforeCode) return fail();
    floor();
    stage = 'exact-simulation';
    mark('exact-simulation', 'begin');
    attempt = await collectJitoCoherentSimulationAttempt({
      packets,
      minimumSlot,
      minimumReadSlot: floor(),
      feeIdPrefix: 'jito-qualified-fees',
      simulationRpcId: 'jito-qualified-exact',
      verifySignatures: false,
      signal: control,
      transport: ({ body, signal: s }) => bundle.request(body, s),
    });
    mark('exact-simulation', 'finish');
    if (attempt.status !== 'captured') return fail();
    const bank = attempt.simulation.frames.slot;
    if (lookups.some((lookup) => lookup && lookup.observedSlot > bank))
      return fail();
    slots.push(bank);
    floor();
    // Independent post-simulation branches all begin at the admitted bank floor.
    // Later lookup reads chain their own observations, never a sibling's timing.
    const afterFloor = floor(),
      frames = attempt.simulation.frames;
    stage = 'postflight';
    const afterReads = await Promise.allSettled([
      guardedRead('assets-after', async () => {
        const afterPlan = buildJitoAssetRead(
          mints,
          minimumSlot,
          afterFloor,
          'jito-assets:after',
        );
        const value = await readJitoAssetEvidence(
          afterPlan,
          (await assets.request(afterPlan.body, control)).body,
          control,
        );
        slots.push(value.slot);
        floor();
        return value;
      }),
      guardedRead('lookup-after', async () => {
        let lookupFloor = afterFloor;
        for (let i = 0; i < messages.length; i++) {
          if (!lookups[i]) continue;
          const value = await readSwapLookupAccounts(
            messages[i],
            lookupFloor,
            (m, p) => rpc(m, p, control),
          );
          assertSameSwapLookups(
            lookups[i]!,
            value,
            frames.frames[i].loadedAddresses,
          );
          if (!value) return fail();
          lookupFloor = Math.max(lookupFloor, value.observedSlot);
        }
      }),
      guardedRead('runtime-after', async () => {
        const value = await collectJitoRuntimeEvidence(
          keys,
          minimumSlot,
          afterFloor,
          control,
          finalCode.rpc,
        );
        slots.push(value.maximumSlot);
        floor();
        return value;
      }),
    ]);
    if (afterReads[0].status === 'fulfilled') afterAssets = afterReads[0].value;
    if (afterReads[2].status === 'fulfilled') afterCode = afterReads[2].value;
    const postflightRefused = afterReads.find((r) => r.status === 'rejected');
    if (postflightRefused?.status === 'rejected') {
      const failure = failures[0];
      stage = failure?.stage ?? 'postflight';
      throw failure?.error ?? refusedDetail(postflightRefused.reason);
    }
    control.throwIfAborted();
    if (!afterAssets || !afterCode) return fail();
    floor();
    mark('final-genesis', 'begin');
    if ((await rpc('getGenesisHash', [], control)) !== SOLANA_MAINNET_GENESIS)
      return fail();
    mark('final-genesis', 'finish');
    stage = 'replay';
    mark('asset-runtime-replay', 'begin');
    const assetProof = await verifyJitoAssetBracket(
        beforeAssets,
        afterAssets,
        bank,
        control,
      ),
      runtimeProof = await verifyJitoRuntimeBracket(
        beforeCode,
        afterCode,
        attempt.simulation.frames,
        control,
      );
    mark('asset-runtime-replay', 'finish');
    const observations = source.map((s) => ({
      ...s,
      mintAccounts: {
        slot: assetProof.beforeSlot,
        recheckSlot: assetProof.afterSlot,
        before: [s.order.inputMint, s.order.outputMint].map(
          (m) => assetProof.mintAccounts.find((a) => a.address === m)!.before,
        ),
        after: [s.order.inputMint, s.order.outputMint].map(
          (m) => assetProof.mintAccounts.find((a) => a.address === m)!.after,
        ),
      },
    }));
    mark('economic-replay', 'begin');
    const economic = await verifyJitoBundleEconomicObservation({
      manifest,
      observations,
      result: attempt.simulation.normalizedResult,
      minimumSlot,
      simulationBankSlot: bank,
      rentAccounts: assetProof.rentAccounts,
    });
    mark('economic-replay', 'finish');
    control.throwIfAborted();
    if (Date.parse(manifest.expiresAt) <= Date.now()) return fail();
    return {
      status: 'checks-passed' as const,
      stage,
      minimumSlot,
      maximumSlot: floor(),
      assetProof,
      runtimeProof,
      economic,
      rawSimulationChecksPassed: true as const,
      readOnlyLocalChecksPassed: true as const,
      fullProviderQualification: false as const,
      evidence: evidence('finish'),
      ...authority,
    };
  } catch (error) {
    const unfinishedTimingPhases = [...openTimingPhases].filter(
      (phase) => phase !== 'collector',
    );
    for (const phase of unfinishedTimingPhases) mark(phase, 'refused');
    if (
      !unfinishedTimingPhases.length &&
      !timingEvents.some(
        (event) => event.phase === stage && event.event === 'refused',
      )
    )
      mark(stage, 'refused');
    return {
      status: 'refused' as const,
      diagnosis: jitoRuntimePolicyRefusal(error),
      stage,
      minimumSlot,
      maximumSlot: Math.max(
        ...slots,
        ...[bundle, assets, initialCode, finalCode].map(
          (t) => t.summary().maximumObservedSlot ?? minimumSlot,
        ),
      ),
      readOnlyLocalChecksPassed: false as const,
      fullProviderQualification: false as const,
      evidence: evidence('refused'),
      ...authority,
    };
  } finally {
    owner.abort();
    [bundle, assets, initialCode, finalCode].forEach((t) => t.close());
  }
}
