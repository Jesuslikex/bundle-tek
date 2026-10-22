export const WARMUP_ASSET_PROBE_MINT =
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const WARMUP_ASSET_PROBE_ACCOUNTS = Object.freeze([
  'So11111111111111111111111111111111111111112',
  WARMUP_ASSET_PROBE_MINT,
  'SysvarC1ock11111111111111111111111111111111',
  'SysvarRent111111111111111111111111111111111',
]);
const methods = [
  'getGenesisHash',
  'getSlot',
  'getMultipleAccounts',
  'getMultipleAccounts',
];
/** @returns {never} */
const fail = () => {
  throw Error('Public warmup probe refused an unexpected request or response.');
};
export function requireWarmupAssetProbeRuntime(
  version = process.versions.node,
) {
  if (typeof version !== 'string' || !/^24\.\d+\.\d+$/.test(version))
    throw Error(
      'Public warmup qualification requires production Node24. No provider read started.',
    );
  return { nodeVersion: version, requiredNodeMajor: 24 };
}
export function requireWarmupAssetProbeArgs(args) {
  if (args.length !== 1 || args[0] !== '--live-readonly')
    throw Error(
      'Use only --live-readonly for one fixed public USDC asset check. No signing/send mode exists.',
    );
}
export function warmupAssetProbeConfiguration(config) {
  const setting = config.SOLANA_INDEXER_RPC_URL
    ? 'SOLANA_INDEXER_RPC_URL'
    : 'SOLANA_MAINNET_RPC_URL';
  const endpoint = config[setting];
  try {
    if (typeof endpoint !== 'string' || /\s|\$\{/.test(endpoint)) fail();
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      fail();
  } catch {
    throw Error(
      'An existing private HTTPS mainnet/indexer setting is required. No fallback or provider read started.',
    );
  }
  const pacing = config.SOLANA_RPC_MIN_INTERVAL_MS;
  if (
    pacing !== undefined &&
    pacing !== '' &&
    (typeof pacing !== 'string' ||
      !/^\d{1,4}$/.test(pacing) ||
      Number(pacing) > 2000)
  )
    throw Error('Existing RPC pacing is invalid. No provider read started.');
  return { endpoint, setting, pacing };
}
function diagnostic(bytes) {
  try {
    const r = JSON.parse(new TextDecoder().decode(bytes)).result;
    const context = r?.context?.slot;
    const data = r?.value?.[2]?.data;
    if (
      !Number.isSafeInteger(context) ||
      context < 1 ||
      !Array.isArray(data) ||
      data[1] !== 'base64'
    )
      return {};
    const raw = atob(data[0]);
    if (raw.length !== 40 || btoa(raw) !== data[0]) return {};
    const view = new DataView(
      Uint8Array.from(raw, (c) => c.charCodeAt(0)).buffer,
    );
    const clock = view.getBigUint64(0, true),
      unix = view.getBigInt64(32, true);
    return {
      reportedContextSlot: String(context),
      reportedClockSlot: String(clock),
      reportedClockOffset: String(clock - BigInt(context)),
      reportedUnixTimestamp: String(unix),
    };
  } catch {
    return {};
  }
}
/** Exact fixed read scope. Diagnostic JSON is not proof; unchanged bytes go to
 * the application's integer-preserving reader and strict account decoders. */
export function createWarmupAssetProbeFetch(endpoint, fetcher = fetch) {
  warmupAssetProbeConfiguration({ SOLANA_INDEXER_RPC_URL: endpoint });
  const trace = [];
  let admitted = 0;
  let stopped = false;
  /** @returns {never} */
  const refuse = () => {
    stopped = true;
    return fail();
  };
  return {
    trace,
    fetch: /** @returns {Promise<Response>} */ async (input, init = {}) => {
      if (
        stopped ||
        input !== endpoint ||
        init?.method !== 'POST' ||
        init.redirect !== 'manual' ||
        init.cache !== 'no-store' ||
        !(init.signal instanceof AbortSignal) ||
        typeof init.body !== 'string' ||
        init.body.length > 2048
      )
        refuse();
      if (init.signal.aborted) refuse();
      let request;
      try {
        request = JSON.parse(init.body);
      } catch {
        refuse();
      }
      if (
        request.jsonrpc !== '2.0' ||
        request.id !== 1 ||
        request.method !== methods[admitted] ||
        !Array.isArray(request.params)
      )
        refuse();
      const params = request.params;
      if (admitted === 0 && params.length !== 0) refuse();
      if (
        admitted === 1 &&
        JSON.stringify(params) !== '[{"commitment":"confirmed"}]'
      )
        refuse();
      if (admitted >= 2) {
        const cfg = params[1];
        if (
          params.length !== 2 ||
          JSON.stringify(params[0]) !==
            JSON.stringify(WARMUP_ASSET_PROBE_ACCOUNTS) ||
          !cfg ||
          Object.keys(cfg).sort().join(',') !==
            'commitment,encoding,minContextSlot' ||
          cfg.encoding !== 'base64' ||
          cfg.commitment !== 'confirmed' ||
          !Number.isSafeInteger(cfg.minContextSlot) ||
          cfg.minContextSlot < 1
        )
          refuse();
      }
      admitted++;
      const row = {
        ordinal: admitted,
        method: request.method,
        startedAt: new Date().toISOString(),
        status: null,
        bytes: 0,
      };
      trace.push(row);
      let response;
      try {
        response = await fetcher(input, init);
      } catch {
        stopped = true;
        row.transportFailed = true;
        fail();
      }
      row.status = response.status;
      if (!response.ok) {
        stopped = true;
        return response;
      }
      const reader = response.body?.getReader();
      if (!reader) refuse();
      const chunks = [];
      try {
        for (;;) {
          init.signal.throwIfAborted();
          const { value, done } = await reader.read();
          init.signal.throwIfAborted();
          if (done) break;
          row.bytes += value.byteLength;
          if (row.bytes > 524288) {
            await reader.cancel();
            fail();
          }
          chunks.push(value);
        }
      } catch {
        stopped = true;
        await reader.cancel().catch(() => {});
        fail();
      } finally {
        reader.releaseLock();
      }
      const body = new Uint8Array(row.bytes);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      // Diagnostics never replace the original integer-preserving response.
      // An RPC error ends this campaign, even when its HTTP status is 200.
      try {
        const envelope = JSON.parse(new TextDecoder().decode(body));
        if (
          envelope?.jsonrpc !== '2.0' ||
          envelope.id !== 1 ||
          !Object.hasOwn(envelope, 'result') ||
          Object.hasOwn(envelope, 'error')
        )
          refuse();
      } catch {
        refuse();
      }
      row.receivedAt = new Date().toISOString();
      if (request.method === 'getMultipleAccounts')
        Object.assign(row, diagnostic(body));
      return new Response(body, {
        status: response.status,
        headers: response.headers,
      });
    },
  };
}
