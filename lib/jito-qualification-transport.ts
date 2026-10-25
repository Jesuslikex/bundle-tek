import { getSolanaHolderRpcEndpoint } from './solana-rpc';
import { paceWalletRpc } from './wallet-rpc-pacing';
import { readJitoSimulationPayload } from './jito-simulation-json';
import { snapshotJitoEvidence, jitoEvidenceSha256 } from './jito-evidence-json';
import type { PumpLaunchRpc } from './pump-launch-simulation';
import bs58 from 'bs58';
type CaptureTiming = {
  queuedAtMs: number;
  pacedAtMs: number | null;
  sentAtMs: number | null;
  headersAtMs: number | null;
  capturedAtMs: number | null;
  finishedAtMs: number | null;
};
type Capture = {
  requestBody: string;
  requestSha256: string;
  rawBody: Uint8Array;
  rawSha256: string;
  httpStatus: number;
  captureStatus: 'not-captured' | 'captured';
  timing: CaptureTiming;
};
const fail = (): never => {
  throw Error('Jito qualification transport refused.');
};
const cancel = (r: Response) => {
  try {
    void r.body?.cancel().catch(() => {});
  } catch {
    /* no authority */
  }
};
function strings(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map(strings);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = Object.create(null);
    for (const [k, value] of Object.entries(v))
      Object.defineProperty(o, k, {
        value: strings(value),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    return o;
  }
  return fail();
}
/** Independent bounded stage transports. Existing bundle 12HTTP/18method policy
 * remains unchanged. Runtime uses the existing serial scanner's 300 calls plus
 * at most three inventory calls, not a higher limit on bundle simulation.
 * All observations retain original raw bodies; no settings or endpoint fallback. */
export function createJitoQualificationTransport(
  stage: 'bundle' | 'assets' | 'runtime',
  minimumSlot: number,
  signal: AbortSignal,
  dependencies: { fetcher?: typeof fetch; pace?: typeof paceWalletRpc } = {},
) {
  if (
    !['bundle', 'assets', 'runtime'].includes(stage) ||
    !Number.isSafeInteger(minimumSlot) ||
    minimumSlot < 0
  )
    return fail();
  const endpoint = getSolanaHolderRpcEndpoint(),
    url = new URL(endpoint);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.port
  )
    return fail();
  // Process-monotonic diagnostics only. Neither these timestamps nor their
  // differences participate in bank, expiry, pacing or evidence admission.
  const timingOriginMs = performance.now();
  const elapsed = () => Math.max(0, performance.now() - timingOriginMs);
  const owner = new AbortController(),
    control = AbortSignal.any([
      signal,
      owner.signal,
      AbortSignal.timeout(45000),
    ]),
    responses: Response[] = [],
    records: Capture[] = [];
  const fetcher = dependencies.fetcher ?? fetch,
    pace = dependencies.pace ?? paceWalletRpc;
  const allowed =
    stage === 'bundle'
      ? [
          'getGenesisHash',
          'getMultipleAccounts',
          'getFeeForMessage',
          'simulateBundle',
        ]
      : stage === 'runtime'
        ? ['getGenesisHash', 'getMultipleAccounts']
        : ['getMultipleAccounts'];
  const maxHttp = stage === 'bundle' ? 12 : stage === 'assets' ? 2 : 303,
    maxUnits = stage === 'bundle' ? 18 : maxHttp;
  let http = 0,
    units = 0,
    total = 0,
    next = 0,
    terminal = false,
    rateLimited = false,
    maximumObservedSlot: number | null = null;
  const close = () => {
    terminal = true;
    owner.abort();
    responses.forEach(cancel);
  };
  async function request(
    body: string,
    readSignal: AbortSignal,
  ): Promise<Response> {
    const active = AbortSignal.any([control, readSignal]);
    active.throwIfAborted();
    if (terminal || typeof body !== 'string' || Buffer.byteLength(body) > 32768)
      return fail();
    const decoded = JSON.parse(body),
      rows = Array.isArray(decoded) ? decoded : [decoded];
    if (stage !== 'bundle' && Array.isArray(decoded)) return fail();
    if (
      rows.length < 1 ||
      rows.length > 6 ||
      ++http > maxHttp ||
      (units += rows.length) > maxUnits
    )
      return fail();
    for (const row of rows) {
      if (
        row.jsonrpc !== '2.0' ||
        Object.keys(row).length !== 4 ||
        typeof row.id !== 'string' ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(row.id) ||
        !allowed.includes(row.method) ||
        !Array.isArray(row.params)
      )
        return fail();
      if (row.method === 'getMultipleAccounts') {
        const cfg = row.params[1],
          keys = row.params[0];
        if (
          row.params.length !== 2 ||
          !Array.isArray(keys) ||
          keys.length < 1 ||
          keys.length > (stage === 'assets' ? 9 : 100) ||
          keys.some(
            (key: unknown) =>
              typeof key !== 'string' ||
              key.length < 32 ||
              key.length > 44 ||
              bs58.decode(key).length !== 32 ||
              bs58.encode(bs58.decode(key)) !== key,
          ) ||
          !cfg ||
          typeof cfg !== 'object' ||
          Array.isArray(cfg) ||
          Object.keys(cfg).some(
            (k) =>
              ![
                'encoding',
                'commitment',
                'minContextSlot',
                ...(stage === 'runtime' ? ['dataSlice'] : []),
              ].includes(k),
          ) ||
          cfg?.encoding !== 'base64' ||
          cfg.commitment !== 'confirmed' ||
          !Number.isSafeInteger(cfg.minContextSlot) ||
          cfg.minContextSlot < minimumSlot ||
          cfg.minContextSlot - minimumSlot > 32
        )
          return fail();
        if (cfg.dataSlice !== undefined) {
          const slice = cfg.dataSlice;
          if (
            !slice ||
            typeof slice !== 'object' ||
            Object.keys(slice).length !== 2 ||
            !Number.isSafeInteger(slice.offset) ||
            slice.offset < 0 ||
            slice.offset > 10485805 ||
            !Number.isSafeInteger(slice.length) ||
            slice.length < 0 ||
            slice.length > 737280 ||
            keys.length * slice.length > 1048576
          )
            return fail();
        }
      }
    }
    const record: Capture = {
      requestBody: body,
      requestSha256: '',
      rawBody: new Uint8Array(),
      rawSha256: '',
      httpStatus: 0,
      captureStatus: 'not-captured',
      timing: {
        queuedAtMs: elapsed(),
        pacedAtMs: null,
        sentAtMs: null,
        headersAtMs: null,
        capturedAtMs: null,
        finishedAtMs: null,
      },
    };
    records.push(record);
    let abort = () => {};
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(Error('Jito read interrupted.'));
      active.addEventListener('abort', abort, { once: true });
      if (active.aborted) abort();
    });
    const pending = Promise.resolve().then(async () => {
      for (let i = 0; i < rows.length; i++) await pace(endpoint, active);
      active.throwIfAborted();
      if (terminal) return fail();
      record.timing.pacedAtMs = elapsed();
      record.requestSha256 = await jitoEvidenceSha256(
        new TextEncoder().encode(body),
      );
      active.throwIfAborted();
      record.timing.sentAtMs = elapsed();
      const response = await fetcher(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: active,
        cache: 'no-store',
        redirect: 'error',
      });
      responses.push(response);
      if (active.aborted) {
        cancel(response);
        return fail();
      }
      record.timing.headersAtMs = elapsed();
      return response;
    });
    try {
      const response = await Promise.race([pending, stopped]);
      record.httpStatus = response.status;
      if (response.status === 429) {
        rateLimited = true;
        close();
        return new Response(null, { status: 429 });
      }
      if (!response.ok) {
        close();
        return new Response(null, { status: response.status });
      }
      const raw = await readJitoSimulationPayload(
        response.body,
        active,
        stage === 'bundle' ? 4194304 : stage === 'runtime' ? 2097152 : 131072,
        stage === 'bundle' ? { allowDecimalTokens: true } : undefined,
      );
      total += raw.byteLength;
      if (total > (stage === 'runtime' ? 67108864 : 16777216)) return fail();
      record.rawBody = Uint8Array.from(raw.rawBody);
      record.rawSha256 = raw.rawSha256;
      record.captureStatus = 'captured';
      record.timing.capturedAtMs = elapsed();
      const values = Array.isArray(raw.value) ? raw.value : [raw.value];
      for (const value of values) {
        const observed = (
          value as { result?: { context?: { slot?: unknown } } } | null
        )?.result?.context?.slot;
        if (
          typeof observed === 'bigint' &&
          observed >= 0n &&
          observed <= BigInt(Number.MAX_SAFE_INTEGER)
        )
          maximumObservedSlot = Math.max(
            maximumObservedSlot ?? 0,
            Number(observed),
          );
      }
      if (
        values.some(
          (v) =>
            v &&
            typeof v === 'object' &&
            (v as { error?: { code?: unknown } }).error?.code === 429n,
        )
      ) {
        rateLimited = true;
        close();
      }
      active.throwIfAborted();
      return new Response(Uint8Array.from(raw.rawBody), { status: 200 });
    } catch {
      close();
      return fail();
    } finally {
      record.timing.finishedAtMs = elapsed();
      active.removeEventListener('abort', abort);
    }
  }
  const callRpc: PumpLaunchRpc = async (method, params, readSignal) => {
    const id = `jito-${stage}:${next++}`,
      body = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params: snapshotJitoEvidence(params),
      });
    const response = await request(body, readSignal);
    if (!response.ok) return fail();
    const raw = await readJitoSimulationPayload(
        response.body,
        readSignal,
        2097152,
      ),
      envelope = raw.value as {
        jsonrpc?: unknown;
        id?: unknown;
        result?: unknown;
        error?: unknown;
      };
    if (
      envelope?.jsonrpc !== '2.0' ||
      Object.keys(envelope).length !== 3 ||
      envelope.id !== id ||
      envelope.error ||
      !Object.hasOwn(envelope, 'result')
    )
      return fail();
    if (method === 'getMultipleAccounts') {
      const value = envelope.result as {
          context?: { slot?: unknown };
          value?: unknown;
        },
        slot = value?.context?.slot,
        floor = (params[1] as { minContextSlot?: number })?.minContextSlot;
      if (
        typeof slot !== 'bigint' ||
        typeof floor !== 'number' ||
        slot < BigInt(floor) ||
        slot < BigInt(minimumSlot) ||
        slot > BigInt(minimumSlot) + 32n
      )
        return fail();
    }
    return strings(envelope.result);
  };
  const rpc: PumpLaunchRpc = (method, params, readSignal) =>
    callRpc(method, params, readSignal).catch(() => {
      close();
      return fail();
    });
  return {
    request,
    rpc,
    close,
    signal: control,
    summary: () => ({
      stage,
      httpReads: http,
      methodUnits: units,
      responseBytes: total,
      terminal,
      rateLimited,
      maximumObservedSlot,
      timing: {
        clock: 'process-monotonic' as const,
        originMs: timingOriginMs,
        diagnosticOnly: true as const,
      },
      providerQualified: false as const,
      signingAllowed: false as const,
      executionAllowed: false as const,
    }),
    captures: () =>
      records.map((r) => ({
        ...r,
        timing: { ...r.timing },
        rawBody: Uint8Array.from(r.rawBody),
      })),
  };
}
