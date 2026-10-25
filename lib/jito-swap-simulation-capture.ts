import {
  simulateImportedSwap,
  type ImportedSwapSimulation,
} from './imported-swap-simulation';
import { requireWarmupSigningReview } from './warmup-signing';
import { getSolanaIndexerRpcEndpoint } from './solana-rpc';
import { readJitoSimulationPayload } from './jito-simulation-json';
import { snapshotJitoEvidence, jitoEvidenceSha256 } from './jito-evidence-json';
import type { SolanaSwapPreparation } from './warmup-swap-quote';
import { createJitoRetainedRpcReplay } from './jito-retained-rpc-replay';

type Read = {
  requestBody: string;
  requestSha256: string;
  rawBody: Uint8Array;
  rawSha256: string;
};
export type JitoSwapSimulationCapture = {
  format: 'jito-full-swap-capture-v1';
  order: SolanaSwapPreparation;
  simulation: ImportedSwapSimulation;
  reads: Read[];
  sha256: string;
  signingAllowed: false;
  executionAllowed: false;
};
type Private = {
  endpoint: string;
  order: SolanaSwapPreparation;
  simulation: ImportedSwapSimulation;
  reads: Read[];
  digest: string;
};
const issued = new WeakMap<object, Private>();
const fail = (): never => {
  throw Error('Jito full swap capture refused.');
};
const cancel = (r: Response) => {
  try {
    void r.body?.cancel().catch(() => {});
  } catch {
    /* no evidence admission */
  }
};
const allowed = new Set([
  'getGenesisHash',
  'getBlockHeight',
  'getFeeForMessage',
  'getMultipleAccounts',
  'getMinimumBalanceForRentExemption',
  'simulateTransaction',
]);
const digest = async (
  order: SolanaSwapPreparation,
  simulation: ImportedSwapSimulation,
  reads: Read[],
) =>
  jitoEvidenceSha256(
    new TextEncoder().encode(
      JSON.stringify({
        order,
        simulation,
        reads: reads.map((r) => ({
          requestBody: r.requestBody,
          requestSha256: r.requestSha256,
          rawSha256: r.rawSha256,
        })),
      }),
    ),
  );
async function bounded<T>(
  signal: AbortSignal,
  pending: Promise<T>,
): Promise<T> {
  let abort = () => {};
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(Error('Jito capture interrupted.'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([pending, stopped]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
/** Captures the ACTUAL complete simulation path, including raw mint/ALT/binding responses.
 * Uses the existing configured endpoint, decoders, pacing and settlement safeguards.
 * Never fabricates the omitted fields of a saved scalar preparation summary. */
export async function captureJitoSwapSimulation(
  orderInput: SolanaSwapPreparation,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<JitoSwapSimulationCapture> {
  const order = snapshotJitoEvidence(orderInput),
    endpoint = getSolanaIndexerRpcEndpoint();
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    return fail();
  const owner = new AbortController(),
    control = AbortSignal.any([
      signal,
      owner.signal,
      AbortSignal.timeout(45000),
    ]),
    reads: Read[] = [],
    responses: Response[] = [];
  let calls = 0,
    total = 0,
    stopped = false;
  const wrapped: typeof fetch = async (target, init) => {
    control.throwIfAborted();
    if (
      stopped ||
      typeof target !== 'string' ||
      target !== endpoint ||
      ++calls > 32 ||
      init?.method !== 'POST' ||
      typeof init.body !== 'string' ||
      Buffer.byteLength(init.body) > 32768
    )
      return fail();
    const requestBody = init.body,
      request = JSON.parse(requestBody);
    if (
      request.jsonrpc !== '2.0' ||
      request.id !== 1 ||
      !allowed.has(request.method) ||
      !Array.isArray(request.params)
    )
      return fail();
    if (
      request.method === 'simulateTransaction' &&
      (request.params[0] !== order.preparation.transaction ||
        request.params[1]?.sigVerify !== false ||
        request.params[1]?.replaceRecentBlockhash !== false)
    )
      return fail();
    const index = reads.length,
      read: Read = {
        requestBody,
        requestSha256: '',
        rawBody: new Uint8Array(),
        rawSha256: '',
      };
    reads.push(read);
    read.requestSha256 = await jitoEvidenceSha256(
      new TextEncoder().encode(requestBody),
    );
    const pending = Promise.resolve().then(async () => {
      control.throwIfAborted();
      if (stopped) return fail();
      const response = await fetcher(target, {
        ...init,
        signal: control,
        redirect: 'error',
        cache: 'no-store',
      });
      responses.push(response);
      if (control.aborted) {
        cancel(response);
        return fail();
      }
      return response;
    });
    const response = await bounded(control, pending);
    if (response.status === 429) {
      stopped = true;
      return fail();
    }
    if (!response.ok) return fail();
    const raw = await readJitoSimulationPayload(
      response.body,
      control,
      524288,
      { allowDecimalTokens: true },
    );
    const value = raw.value as { error?: { code?: unknown } };
    if (value?.error?.code === 429n) {
      stopped = true;
      return fail();
    }
    total += raw.byteLength;
    if (total > 16777216) return fail();
    reads[index] = {
      ...read,
      rawBody: Uint8Array.from(raw.rawBody),
      rawSha256: raw.rawSha256,
    };
    return new Response(Uint8Array.from(raw.rawBody), { status: 200 });
  };
  try {
    const simulation = await bounded(
      control,
      simulateImportedSwap(order, control, wrapped, true),
    );
    await requireWarmupSigningReview(order, simulation);
    if (
      reads.some((r) => !r.rawSha256) ||
      reads.filter(
        (r) => JSON.parse(r.requestBody).method === 'simulateTransaction',
      ).length !== 1
    )
      return fail();
    control.throwIfAborted();
    const privateOrder = snapshotJitoEvidence(order),
      privateSimulation = snapshotJitoEvidence(simulation),
      privateReads = reads.map((r) => ({
        ...r,
        rawBody: Uint8Array.from(r.rawBody),
      }));
    const sha256 = await digest(privateOrder, privateSimulation, privateReads);
    const capture = {
      format: 'jito-full-swap-capture-v1' as const,
      order: snapshotJitoEvidence(privateOrder),
      simulation: snapshotJitoEvidence(privateSimulation),
      reads: privateReads.map((r) => ({
        ...r,
        rawBody: Uint8Array.from(r.rawBody),
      })),
      sha256,
      signingAllowed: false as const,
      executionAllowed: false as const,
    };
    issued.set(capture, {
      endpoint,
      order: privateOrder,
      simulation: privateSimulation,
      reads: privateReads,
      digest: sha256,
    });
    control.throwIfAborted();
    return capture;
  } catch {
    owner.abort();
    return fail();
  } finally {
    owner.abort();
    responses.forEach(cancel);
  }
}

/** Re-executes existing simulation/settlement decoders against retained raw responses.
 * Freshness and packet expiry still apply. No network, fallback or renewed timestamps. */
export async function replayJitoSwapSimulation(
  capture: JitoSwapSimulationCapture,
  signal: AbortSignal,
) {
  const saved = issued.get(capture);
  if (
    !saved ||
    capture.format !== 'jito-full-swap-capture-v1' ||
    capture.signingAllowed !== false ||
    capture.executionAllowed !== false ||
    getSolanaIndexerRpcEndpoint() !== saved.endpoint ||
    capture.sha256 !== saved.digest ||
    (await digest(
      snapshotJitoEvidence(capture.order),
      snapshotJitoEvidence(capture.simulation),
      capture.reads,
    )) !== saved.digest ||
    capture.reads.length !== saved.reads.length
  )
    return fail();
  for (let i = 0; i < saved.reads.length; i++)
    if (
      (await jitoEvidenceSha256(capture.reads[i].rawBody)) !==
        saved.reads[i].rawSha256 ||
      (await jitoEvidenceSha256(
        new TextEncoder().encode(capture.reads[i].requestBody),
      )) !== saved.reads[i].requestSha256
    )
      return fail();
  const replay = createJitoRetainedRpcReplay(
    saved.endpoint,
    saved.reads,
    signal,
  );
  const reproduced = await simulateImportedSwap(
    snapshotJitoEvidence(saved.order),
    signal,
    replay.fetcher,
    true,
  );
  const stable = (v: ImportedSwapSimulation) => {
    const { observedAt: _time, ...rest } = snapshotJitoEvidence(v);
    return JSON.stringify(rest);
  };
  replay.assertComplete();
  if (stable(reproduced) !== stable(saved.simulation)) return fail();
  await requireWarmupSigningReview(saved.order, reproduced);
  signal.throwIfAborted();
  return {
    order: snapshotJitoEvidence(saved.order),
    simulation: snapshotJitoEvidence(saved.simulation),
    rawSimulationChecksPassed: true as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
