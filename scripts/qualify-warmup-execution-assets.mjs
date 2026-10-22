// One fixed public read. No provider fallback, retries, wallet, signing or send mode.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  requireWarmupAssetProbeRuntime,
  requireWarmupAssetProbeArgs,
  warmupAssetProbeConfiguration,
  createWarmupAssetProbeFetch,
  WARMUP_ASSET_PROBE_MINT,
} from './warmup-asset-probe-policy.mjs';
import {
  snapshotWarmupAssetProbe,
  verifyWarmupAssetProbeSnapshot,
} from './warmup-asset-probe-snapshot.mjs';
const root = resolve(process.cwd());

if (
  resolve(process.cwd()) !==
  resolve(fileURLToPath(new URL('../', import.meta.url)))
)
  throw Error(
    'Run this qualifier from the Bundle repository root. No provider read started.',
  );
const folder = resolve(
  'work',
  'warmup-public-assets-' +
    new Date().toISOString().replaceAll(/[:.]/g, '-') +
    '-' +
    randomUUID().slice(0, 8),
);
mkdirSync(folder, { recursive: true });
const receipt = {
  format: 'warmup-public-asset-probe-v1',
  startedAt: new Date().toISOString(),
  targetMint: WARMUP_ASSET_PROBE_MINT,
  readOnly: true,
  maximumRequests: 4,
  phase: 'startup',
  outcome: 'setup-refused',
  trace: [],
  sourceFiles: {},
  sourceUnchanged: false,
  signingAllowed: false,
  executionAllowed: false,
  automaticExecutionAllowed: false,
};
let fixture, snapshot;
const originalFetch = globalThis.fetch;
try {
  requireWarmupAssetProbeArgs(process.argv.slice(2));
  receipt.phase = 'runtime';
  receipt.runtime = requireWarmupAssetProbeRuntime();
  receipt.sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  receipt.phase = 'configuration';
  const config = warmupAssetProbeConfiguration(
    parseEnv(readFileSync('.env.local', 'utf8')),
  );
  receipt.configuredSetting = config.setting;
  // Ephemeral qualifier process only. No file, application or hosted setting changes.
  process.env.SOLANA_INDEXER_RPC_URL = config.endpoint;
  if (config.pacing === undefined)
    delete process.env.SOLANA_RPC_MIN_INTERVAL_MS;
  else process.env.SOLANA_RPC_MIN_INTERVAL_MS = config.pacing;
  receipt.phase = 'local-build';
  snapshot = await snapshotWarmupAssetProbe(root, folder);
  receipt.sourceFiles = snapshot.sourceFiles;
  receipt.frozenFiles = snapshot.frozenFiles;
  receipt.migrations = snapshot.migrations;
  if (!Object.values(verifyWarmupAssetProbeSnapshot(snapshot)).every(Boolean))
    throw Error('Source changed before provider reads.');
  process.chdir(folder);
  globalThis.fetch = async () => {
    throw Error('Unscoped qualifier network read refused.');
  };
  const lib = await import(pathToFileURL(snapshot.bundle).href);
  receipt.phase = 'local-review';
  fixture = await lib.warmupPublicAssetReviewFixture();
  const guarded = createWarmupAssetProbeFetch(config.endpoint, originalFetch);
  receipt.trace = guarded.trace;
  receipt.phase = 'asset-observation';
  const result = await lib.inspectWarmupExecutionAssets(
    fixture.db,
    fixture.owner,
    fixture.input,
    AbortSignal.timeout(30000),
    { fetcher: guarded.fetch },
  );
  writeFileSync(
    join(folder, 'private-public-asset-evidence.json'),
    JSON.stringify(result, null, 2),
  );
  receipt.evidenceSha256 = result.evidenceSha256;
  receipt.observedSlots = [
    result.evidence.floorSlot,
    result.evidence.before.slot,
    result.evidence.after.slot,
  ];
  receipt.tokenFacts = result.evidence.tokenAccountRents;
  receipt.outcome = 'observed';
  receipt.phase = 'finished';
} catch {
  if (receipt.phase === 'asset-observation')
    receipt.outcome = 'evidence-refused';
  // No raw exception, endpoint, query string, response text or environment value.
} finally {
  try {
    fixture?.dispose();
  } catch {
    receipt.disposalFailed = true;
  }
  globalThis.fetch = originalFetch;
  receipt.finishedAt = new Date().toISOString();
  process.chdir(root);
  if (snapshot)
    Object.assign(receipt, verifyWarmupAssetProbeSnapshot(snapshot));
  if (
    receipt.outcome === 'observed' &&
    (!receipt.sourceUnchanged || !receipt.snapshotUnchanged)
  )
    receipt.outcome = 'source-changed';
  if (receipt.outcome === 'observed' && receipt.disposalFailed)
    receipt.outcome = 'cleanup-refused';
  try {
    writeFileSync(
      join(folder, 'receipt.json'),
      JSON.stringify(receipt, null, 2),
    );
  } catch {
    receipt.outcome = 'receipt-write-failed';
    // Fixed minimal fallback contains neither provider data nor exception text.
    try {
      writeFileSync(
        join(folder, 'receipt-write-failed.json'),
        JSON.stringify({
          outcome: receipt.outcome,
          signingAllowed: false,
          executionAllowed: false,
        }),
      );
    } catch {
      /* Console still reports the fixed outcome below. */
    }
  }
  console.log(
    JSON.stringify({
      outcome: receipt.outcome,
      phase: receipt.phase,
      requests: receipt.trace.length,
      sourceUnchanged: receipt.sourceUnchanged,
      report: join(folder, 'receipt.json'),
    }),
  );
  process.exitCode = receipt.outcome === 'observed' ? 0 : 1;
}
