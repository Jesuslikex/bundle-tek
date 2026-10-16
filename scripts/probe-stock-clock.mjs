// Fixed diagnostic observations, never qualification or a retry of a trade.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureStockClockWire } from './stock-clock-wire.mjs';
const validatorRpc = process.argv[3] === '--validator-rpc';
if (
  process.argv[2] !== '--live-readonly' ||
  (validatorRpc ? process.argv.length !== 4 : process.argv.length !== 3)
)
  throw Error(
    'Use --live-readonly [--validator-rpc]. No quote, signing or retry mode.',
  );
const hash = (v) => createHash('sha256').update(v).digest('hex');
const files = [
  'scripts/probe-stock-clock.mjs',
  'scripts/stock-clock-wire.mjs',
  'lib/wallet-balances.ts',
  'lib/wallet-rpc-pacing.ts',
  'lib/solana-rpc.ts',
];
const sourceFiles = Object.fromEntries(
  files.map((p) => [p, hash(readFileSync(p))]),
);
const folder = resolve(
  'work/stock-clock-probe-' + new Date().toISOString().replaceAll(/[:.]/g, '-'),
);
mkdirSync(folder, { recursive: true });
const bundle = join(folder, 'reader.mjs');
await build({
  stdin: {
    contents: `export {balanceRpc,SOLANA_MAINNET_GENESIS} from './lib/wallet-balances'; export {getSolanaIndexerRpcEndpoint} from './lib/solana-rpc'; export {paceWalletRpc} from './lib/wallet-rpc-pacing';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  outfile: bundle,
  logLevel: 'silent',
});
const lib = await import(pathToFileURL(bundle).href);
const endpoint = validatorRpc
    ? 'https://api.mainnet-beta.solana.com'
    : lib.getSolanaIndexerRpcEndpoint(),
  stop = new AbortController();
const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(40000)]);
const evidence = {
  format: 'stock-clock-fixed-wire-probe-v1',
  readOnly: true,
  rpcRole: validatorRpc
    ? 'solana-public-validator-rpc'
    : 'configured-indexer-rpc',
  providerHost: new URL(endpoint).hostname,
  sourceFiles,
  sourceUnchanged: false,
  requests: [],
  observations: [],
  complete: false,
  qualification: false,
  signatures: 0,
  broadcasts: 0,
  signingAllowed: false,
  executionAllowed: false,
};
const fetcher = async (url, init) => {
  const body = JSON.parse(init.body);
  if (
    new URL(url).href !== new URL(endpoint).href ||
    !['getGenesisHash', 'getSlot', 'getMultipleAccounts'].includes(
      body.method,
    ) ||
    evidence.requests.length >= 20
  )
    throw Error('Diagnostic method/budget refused.');
  await lib.paceWalletRpc(endpoint, signal, validatorRpc ? undefined : 1);
  const row = { method: body.method, startMs: performance.now() };
  evidence.requests.push(row);
  const response = await fetch(url, { ...init, redirect: 'manual' });
  row.status = response.status;
  if (response.status === 429) {
    stop.abort(Error('Provider rate limit; no retry.'));
    return response;
  }
  try {
    row.clockWire = await captureStockClockWire(response, body);
  } catch {
    row.clockWireUnavailable = true;
  }
  return response;
};
const rpc = (method, params) =>
  lib.balanceRpc(endpoint, method, params, signal, fetcher);
try {
  if ((await rpc('getGenesisHash', [])) !== lib.SOLANA_MAINNET_GENESIS)
    throw Error('Wrong network.');
  const floors = {};
  for (const commitment of ['confirmed', 'finalized']) {
    const slot = Number(await rpc('getSlot', [{ commitment }]));
    if (!Number.isSafeInteger(slot) || slot < 1)
      throw Error('Diagnostic anchor unavailable.');
    floors[commitment] = slot;
  }
  for (let round = 1; round <= 6; round++)
    for (const commitment of ['confirmed', 'finalized']) {
      const result = await rpc('getMultipleAccounts', [
        [
          'SysvarC1ock11111111111111111111111111111111',
          'SysvarC1ock11111111111111111111111111111111',
        ],
        { encoding: 'base64', commitment, minContextSlot: floors[commitment] },
      ]);
      const observed = Number(result.context?.slot);
      if (!Number.isSafeInteger(observed) || observed < floors[commitment])
        throw Error('Diagnostic context moved backwards.');
      floors[commitment] = observed;
      evidence.observations.push({
        round,
        commitment,
        wire: evidence.requests.at(-1).clockWire ?? null,
      });
    }
  if ((await rpc('getGenesisHash', [])) !== lib.SOLANA_MAINNET_GENESIS)
    throw Error('Network changed.');
  evidence.complete = true;
} catch {
  evidence.reason = signal.aborted
    ? 'Clock probe aborted/rate limited; no retry.'
    : 'Clock probe evidence unavailable; no retry.';
} finally {
  stop.abort();
  evidence.sourceUnchanged = files.every(
    (p) => hash(readFileSync(p)) === sourceFiles[p],
  );
  evidence.http429 = evidence.requests.filter((r) => r.status === 429).length;
  const output = join(folder, 'probe.json');
  writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log(
    JSON.stringify({
      output,
      complete: evidence.complete,
      observations: evidence.observations.length,
      http429: evidence.http429,
      qualification: false,
    }),
  );
}
