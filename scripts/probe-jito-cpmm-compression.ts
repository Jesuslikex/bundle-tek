import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { zstdDecompressSync, constants } from 'node:zlib';
import { getSolanaHolderRpcEndpoint } from '../lib/solana-rpc';
import { paceWalletRpc } from '../lib/wallet-rpc-pacing';
import { readJitoSimulationPayload } from '../lib/jito-simulation-json';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';
const DATA = 'DMawCQzbgNTmbzaESc7o6pvL1KAeetY8zA7jNpzntHhU';
// First 524288 code bytes, derived only after reassembling the full captured
// artifact and matching its existing controlled-build b6dbea8c... digest.
const PREFIX_SHA256 =
  'fa256ecefa4e828d5f37a753383a58dbc97a2f76759fa12622b4e0b4bee3ed92';
const fail = (): never => {
  throw Error('CPMM compression probe refused.');
};
const slot = (v: unknown) => {
  if (typeof v !== 'bigint' || v < 1n || v > BigInt(Number.MAX_SAFE_INTEGER))
    return fail();
  return Number(v);
};
async function main() {
  if (
    process.versions.node.split('.')[0] !== '24' ||
    process.argv.length !== 3 ||
    process.argv[2] !== '--live-readonly'
  )
    return fail();
  const endpoint = getSolanaHolderRpcEndpoint(),
    url = new URL(endpoint),
    signal = AbortSignal.timeout(15000);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'solana-mainnet.g.alchemy.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash
  )
    return fail();
  const captures: { request: string; response: string }[] = [],
    observations: Record<string, unknown> = {};
  let calls = 0,
    rateLimited = false,
    floor: number | null = null,
    lastSlot: number | null = null,
    status = 'refused',
    stage = 'genesis';
  async function rpc(method: string, params: unknown[]) {
    const id = ++calls;
    if (
      id > 4 ||
      !['getGenesisHash', 'getSlot', 'getMultipleAccounts'].includes(method)
    )
      return fail();
    await paceWalletRpc(endpoint, signal);
    const request = JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      start = performance.now();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: request,
      signal,
      redirect: 'error',
      cache: 'no-store',
    });
    observations.httpEncoding = response.headers.get('content-encoding');
    if (!response.ok) {
      rateLimited = response.status === 429;
      void response.body?.cancel();
      return fail();
    }
    const body = await readJitoSimulationPayload(
      response.body,
      signal,
      1048576,
    );
    observations.lastResponseBytes = body.byteLength;
    observations.lastRequestMs = performance.now() - start;
    captures.push({
      request,
      response: Buffer.from(body.rawBody).toString('utf8'),
    });
    const envelope = body.value as Record<string, unknown>;
    if (
      envelope.jsonrpc !== '2.0' ||
      envelope.id !== BigInt(id) ||
      Object.keys(envelope).length !== 3 ||
      !Object.hasOwn(envelope, 'result')
    ) {
      const code = (envelope.error as { code?: unknown } | undefined)?.code;
      observations.rpcErrorCode =
        typeof code === 'bigint' ? code.toString() : null;
      rateLimited = code === 429n;
      return fail();
    }
    return envelope.result;
  }
  try {
    if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
      return fail();
    stage = 'initial-slot';
    floor = slot(await rpc('getSlot', [{ commitment: 'confirmed' }]));
    stage = 'compressed-code-read';
    const response = (await rpc('getMultipleAccounts', [
      [DATA],
      {
        commitment: 'confirmed',
        encoding: 'base64+zstd',
        minContextSlot: floor,
        dataSlice: { offset: 45, length: 524288 },
      },
    ])) as { context: { slot: unknown }; value: unknown[] };
    const at = slot(response.context.slot);
    if (
      at < floor ||
      at - floor > 32 ||
      !Array.isArray(response.value) ||
      response.value.length !== 1
    )
      return fail();
    const a = response.value[0] as {
      owner: unknown;
      executable: unknown;
      data: unknown;
      space: unknown;
    };
    if (
      a.owner !== 'BPFLoaderUpgradeab1e11111111111111111111111' ||
      a.executable !== false ||
      a.space !== 793869n ||
      !Array.isArray(a.data) ||
      a.data.length !== 2 ||
      a.data[1] !== 'base64+zstd' ||
      typeof a.data[0] !== 'string'
    )
      return fail();
    const encoded = Buffer.from(a.data[0], 'base64');
    if (encoded.toString('base64') !== a.data[0] || encoded.length > 1048576)
      return fail();
    stage = 'bounded-decompression';
    const started = performance.now();
    const decoded = zstdDecompressSync(encoded, {
      maxOutputLength: 524288,
      // Provider frames use a 2 MiB codec window. This caps decoder memory;
      // the independent exact 512 KiB output/slice bound is unchanged.
      params: { [constants.ZSTD_d_windowLogMax]: 21 },
    });
    if (decoded.length !== 524288) return fail();
    const decodedSha256 = createHash('sha256').update(decoded).digest('hex');
    if (decodedSha256 !== PREFIX_SHA256) return fail();
    observations.compression = {
      slot: at,
      encoding: 'base64+zstd',
      compressedBytes: encoded.length,
      decodedBytes: decoded.length,
      decodedSha256,
      matchedControlledArtifactPrefix: true,
      responseBytes: observations.lastResponseBytes,
      requestMs: observations.lastRequestMs,
      decodeMs: performance.now() - started,
      windowLogMax: 21,
      outputLimit: 524288,
    };
    stage = 'final-slot';
    lastSlot = slot(
      await rpc('getSlot', [{ commitment: 'confirmed', minContextSlot: at }]),
    );
    if (lastSlot < at || lastSlot - floor > 32) return fail();
    status = 'bounded-compressed-code-observed';
  } catch {
    process.exitCode = 1;
  }
  const receipt = {
    format: 'jito-cpmm-compression-probe-v1',
    observedAt: new Date().toISOString(),
    runtime: process.version,
    status,
    stage,
    floor,
    lastSlot,
    calls,
    rateLimited,
    observations,
    diagnosticOnly: true,
    fullArtifactVerified: false,
    bankVerified: false,
    fullSwapQualified: false,
    signingAllowed: false,
    executionAllowed: false,
    transactionsBroadcast: 0,
  };
  await mkdir('work', { recursive: true });
  const path = `work/jito-cpmm-compression-${Date.now()}.json`;
  await writeFile(path, JSON.stringify({ receipt, captures }, null, 2) + '\n');
  console.log(JSON.stringify({ ...receipt, savedCapture: path }));
}
main().catch(() => {
  console.error(
    'CPMM compression probe setup refused; no provider details displayed.',
  );
  process.exitCode = 1;
});
