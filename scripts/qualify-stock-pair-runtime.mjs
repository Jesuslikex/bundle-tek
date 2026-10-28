// One bounded unsigned mainnet observation. Never unlocks, signs, sends or retries.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { requireStockQualificationRuntime } from './stock-qualification-runtime.mjs';
import {
  markStockRpcRateLimit,
  auditStockReferenceRpc,
} from './stock-rpc-rate-limit.mjs';
import {
  referenceActivity,
  unchangedQuietReference,
} from './stock-reference-activity.mjs';
import { stockReferencePool } from './stock-reference-fixture.mjs';
import {
  hasStockClockRequest,
  captureStockClockWire,
} from './stock-clock-wire.mjs';
import {
  measureStockProvider,
  stockQuoteGaps,
} from './stock-provider-timing.mjs';

const runtime = requireStockQualificationRuntime();
const args = new Set(process.argv.slice(2));
const referenceArg = [...args].filter((a) => a.startsWith('--reference-file='));
if (
  referenceArg.length > 1 ||
  (referenceArg.length && !args.has('--idle-reference'))
)
  throw Error('A pinned fixture requires idle-before-and-after checks.');
const referenceText = referenceArg.length
  ? readFileSync(referenceArg[0].slice('--reference-file='.length), 'utf8')
  : null;
if (
  !args.has('--live-readonly') ||
  [
    '--known-public-reference',
    '--reserve-reference',
    '--idle-reference',
  ].filter((a) => args.has(a)).length > 1 ||
  [...args].some(
    (a) =>
      ![
        '--live-readonly',
        '--known-public-reference',
        '--quote-usdc',
        '--one-unit',
        '--reserve-reference',
        '--idle-reference',
      ].includes(a) && !a.startsWith('--reference-file='),
  )
)
  throw Error(
    'Use --live-readonly; optional --idle-reference, --quote-usdc, --one-unit. Reference selection modes are exclusive. No signing or send mode exists.',
  );
const baseMint = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB',
  quoteMint = args.has('--quote-usdc')
    ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    : 'So11111111111111111111111111111111111111112';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const files = [
  'lib/pair-order-first-service.ts',
  'lib/pair-order-review.ts',
  'lib/pair-review-diagnostic.ts',
  'lib/pair-wallet-evidence.ts',
  'lib/pair-mint-evidence.ts',
  'lib/pair-stock-clock.ts',
  'lib/solana-rpc.ts',
  'lib/imported-pair-wallet-preflight.ts',
  'lib/pair-order-first-review.ts',
  'lib/pair-order-market-bound.ts',
  'lib/token-market.ts',
  'lib/imported-pair-order-candidate.ts',
  'lib/imported-pair-wallet-preflight.ts',
  'lib/imported-pair-quote-service.ts',
  'lib/pair-runtime-preview.ts',
  'lib/pair-runtime-exposure.ts',
  'lib/pair-account-provenance.ts',
  'lib/pair-order-simulation.ts',
  'lib/pair-order-collector.ts',
  'lib/pair-read-rpc.ts',
  'lib/pair-account-partitions.ts',
  'lib/pair-partition-observation.ts',
  'lib/wallet-balances.ts',
  'lib/wallet-rpc-pacing.ts',
  'lib/pair-order-state.ts',
  'lib/pair-rent-evidence.ts',
  'lib/pair-runtime-trace.ts',
  'lib/pump-group-code-identity.ts',
  'lib/pair-stock-signing-policy.ts',
  'lib/warmup-swap-quote.ts',
  'lib/pair-order-quote-bounds.ts',
  'scripts/qualify-stock-pair-runtime.mjs',
  'scripts/run-stock-repeatability.mjs',
  'scripts/summarize-stock-repeatability.mjs',
  'scripts/stock-reference-activity.mjs',
  'scripts/stock-reference-fixture.mjs',
  'scripts/stock-provider-timing.mjs',
  'scripts/stock-clock-wire.mjs',
  'scripts/stock-rpc-rate-limit.mjs',
  'scripts/stock-qualification-runtime.mjs',
];
const sourceFiles = Object.fromEntries(
  files.map((p) => [p, hash(readFileSync(p))]),
);
const folder = resolve(
  'work/stock-qualification-' +
    new Date().toISOString().replaceAll(/[:.]/g, '-'),
);
mkdirSync(folder, { recursive: true });
const bundle = join(folder, 'reader.mjs');
const compiled = await build({
  stdin: {
    contents: `export {qualifyOwnedPairOrderFirstRuntime} from './lib/pair-order-first-service'; export {createPairReadRpc} from './lib/pair-read-rpc'; export {prepareSolanaPair,quoteSolanaPair} from './lib/warmup-swap-quote'; export {balanceRpc,SOLANA_MAINNET_GENESIS} from './lib/wallet-balances'; export {getSolanaIndexerRpcEndpoint,getSolanaStockRuntimeRpcEndpoint} from './lib/solana-rpc'; export {pairAssociatedAddress} from './lib/pair-wallet-evidence'; export {readPairMintEvidence} from './lib/pair-mint-evidence'; export {createStockPairEvidenceRpc,stockPairAccountLimit} from './lib/pair-stock-clock'; export {importedTokenDocument} from './lib/imported-token-project'; export {pairStockSigningPolicy} from './lib/pair-stock-signing-policy'; export {paceWalletRpc,stockQualificationMethodBudget} from './lib/wallet-rpc-pacing';`,
    resolveDir: process.cwd(),
    sourcefile: 'unsigned-stock-qualification.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  outfile: bundle,
  write: false,
  logLevel: 'silent',
});
if (
  compiled.outputFiles.length !== 1 ||
  resolve(compiled.outputFiles[0].path) !== bundle
)
  throw Error('Unsigned qualification reader output is unavailable.');
// Some Windows environments deny writes by the esbuild subprocess even when
// the caller can write in the same folder. Persist only the compiled bytes.
writeFileSync(bundle, compiled.outputFiles[0].contents, { flag: 'wx' });
const lib = await import(pathToFileURL(bundle).href);
const stop = new AbortController(),
  signal = AbortSignal.any([stop.signal, AbortSignal.timeout(90000)]);
const receipt = {
  format: 'stock-pair-live-qualification-v1',
  checkedAt: new Date().toISOString(),
  readOnly: true,
  harnessRuntime: runtime,
  sourceFiles,
  sourceUnchanged: false,
  referenceFixtureSha256: referenceText === null ? null : hash(referenceText),
  publicReferenceKind: args.has('--reserve-reference')
    ? 'public-largest-system-accounts'
    : args.has('--known-public-reference')
      ? 'retained-public-transaction-reference'
      : args.has('--idle-reference')
        ? 'idle-public-transaction-reference'
        : 'fresh-public-transaction-reference',
  userWallets: 0,
  privateKeys: 0,
  signatures: 0,
  broadcasts: 0,
  rateLimited: false,
  rpcRateLimited: false,
  signingAllowed: false,
  executionAllowed: false,
  signingGate: false,
  stage: 'configuration',
  passed: false,
  requests: [],
  logicalReads: [],
  quotes: [],
  providerTimings: [],
  quoteAsset: args.has('--quote-usdc') ? 'USDC' : 'SOL',
  inputUiAmount: args.has('--one-unit') ? '1' : '0.001',
  qualificationPacing:
    'unsigned-stock-qualification-per-endpoint-method-budget',
  rpcPacingScope: 'setup-and-runtime',
  rpcPacingMs: /^\d{1,4}$/.test(process.env.SOLANA_RPC_MIN_INTERVAL_MS ?? '')
    ? Number(process.env.SOLANA_RPC_MIN_INTERVAL_MS)
    : null,
};
const sqlite = new DatabaseSync(':memory:');
let reader,
  auditReference,
  publicKey,
  runtimeEndpoint = null,
  qualificationMethodBudget = null,
  pipelineStart,
  simulated = false;
const clock = () => performance.now();
try {
  // The gate may be either way; the receipt records which and the assertion
  // below keeps them consistent.
  const signingGate = lib.pairStockSigningPolicy().qualified;
  // signingAllowed stays false: the runtime preview is pre-authorization. The
  // gate is recorded separately because it governs authorization.
  receipt.signingGate = signingGate;
  const endpoint = lib.getSolanaIndexerRpcEndpoint();
  runtimeEndpoint = lib.getSolanaStockRuntimeRpcEndpoint();
  qualificationMethodBudget =
    lib.stockQualificationMethodBudget(runtimeEndpoint);
  let useRuntimeEndpoint = false;
  receipt.qualificationMethodBudget = qualificationMethodBudget;
  receipt.runtimeProviderRole = process.env.SOLANA_STOCK_RUNTIME_RPC_URL
    ? 'configured-standard-validator'
    : 'existing-indexer-fallback';
  receipt.runtimeProviderHost = new URL(runtimeEndpoint).hostname;
  if (new URL(endpoint).protocol !== 'https:' || !process.env.JUPITER_API_KEY)
    throw Error('Configured provider settings unavailable.');
  const methods = new Set([
    'getGenesisHash',
    'getLatestBlockhash',
    'getSlot',
    'getMultipleAccounts',
    'getBlockHeight',
    'getFeeForMessage',
    'isBlockhashValid',
    'simulateTransaction',
    'getSignaturesForAddress',
    'getLargestAccounts',
    'getTransaction',
  ]);
  const fetcher = async (url, init, admit = !reader) => {
    signal.throwIfAborted();
    const u = new URL(url),
      row = { startMs: clock(), pipeline: pipelineStart !== undefined };
    if (
      [new URL(endpoint).href, new URL(runtimeEndpoint).href].includes(u.href)
    ) {
      row.providerRole =
        u.href === new URL(runtimeEndpoint).href &&
        (runtimeEndpoint !== endpoint ||
          Boolean(process.env.SOLANA_STOCK_RUNTIME_RPC_URL))
          ? 'stock-runtime'
          : 'indexer-fallback';
      const body = JSON.parse(init?.body ?? '{}'),
        batch = Array.isArray(body) ? body : [body];
      if (
        init?.method !== 'POST' ||
        !batch.length ||
        batch.length > 2 ||
        batch.some((r) => !methods.has(r.method))
      )
        throw Error(
          'Non-read-only RPC method rejected: ' +
            JSON.stringify(batch.map((r) => r.method)),
        );
      if (
        batch.some(
          (r) =>
            r.method === 'simulateTransaction' &&
            (r.params?.[1]?.sigVerify !== false ||
              r.params?.[1]?.replaceRecentBlockhash !== false),
        )
      )
        throw Error(
          'Simulation must retain original unsigned packet and lifetime.',
        );
      row.methods = batch.map((r) => r.method);
      // Runtime dispatch already admits the exact batch size to this profile.
      // Setup balanceRpc calls do not, so admit them here after ordinary pacing.
      // Both phases share one budget without enrolling other wallet callers.
      if (admit)
        await lib.paceWalletRpc(
          u.href,
          signal,
          batch.length,
          'stock-runtime-evidence',
        );
      row.rpcUnits = batch.length;
    } else {
      if (
        u.origin !== 'https://api.jup.ag' ||
        u.pathname !== '/swap/v2/order' ||
        (init?.method ?? 'GET') !== 'GET' ||
        (u.searchParams.has('taker') &&
          u.searchParams.get('taker') !== publicKey)
      )
        throw Error('Non-quote provider request rejected.');
      row.methods = [u.searchParams.has('taker') ? 'unsigned-order' : 'quote'];
    }
    signal.throwIfAborted();
    row.startMs = clock();
    receipt.requests.push(row);
    if (receipt.requests.length > 160)
      throw Error('Read-only request budget exhausted.');
    const response = await fetch(url, { ...init, redirect: 'manual' });
    row.status = response.status;
    row.headerMs = clock() - row.startMs;
    if (
      [new URL(endpoint).href, new URL(runtimeEndpoint).href].includes(u.href)
    ) {
      const request = JSON.parse(init.body);
      if (hasStockClockRequest(request)) {
        const observationStart = clock();
        try {
          row.clockWire = await captureStockClockWire(response, request);
        } catch {
          row.clockWireUnavailable = true;
        }
        row.clockWireObservationMs = clock() - observationStart;
      }
    }
    if (
      u.pathname === '/swap/v2/order' &&
      u.searchParams.has('taker') &&
      response.ok
    ) {
      // Public route split only, to explain exact-input mismatches.
      try {
        const order = await response.clone().json();
        row.routePlan = (order.routePlan ?? []).slice(0, 16).map((leg) => ({
          label: String(leg.swapInfo?.label ?? '').slice(0, 64),
          ammKey: String(leg.swapInfo?.ammKey ?? '').slice(0, 64),
          inputMint: String(leg.swapInfo?.inputMint ?? '').slice(0, 64),
          outputMint: String(leg.swapInfo?.outputMint ?? '').slice(0, 64),
          inAmount: String(leg.swapInfo?.inAmount ?? ''),
          outAmount: String(leg.swapInfo?.outAmount ?? ''),
          percent: leg.percent ?? null,
          bps: leg.bps ?? null,
        }));
        row.orderInAmount = String(order.inAmount ?? '');
      } catch {
        row.routePlanUnavailable = true;
      }
    }
    if (response.status === 429) {
      receipt.rateLimited = true;
      stop.abort(Error('Provider rate limit; no retry.'));
    }
    return response;
  };
  async function read(method, params, code = false) {
    signal.throwIfAborted();
    const config =
      (['getSlot', 'getBlockHeight'].includes(method)
        ? params[0]
        : params[1]) ?? {};
    const row = {
      method,
      profile: code ? 'code' : 'ordinary',
      phase: simulated ? 'after-simulation' : 'before-simulation',
      startMs: clock(),
      minContextSlot: config.minContextSlot ?? null,
      accountCount: method === 'getMultipleAccounts' ? params[0].length : null,
      slice: config.dataSlice ?? null,
    };
    if (reader) receipt.logicalReads.push(row);
    try {
      const result = await (reader
        ? (code ? reader.programRpc : reader.rpc)(method, params)
        : lib.balanceRpc(
            useRuntimeEndpoint ? runtimeEndpoint : endpoint,
            method,
            params,
            signal,
            fetcher,
            code ? 2097152 : 524288,
          ));
      row.slot =
        method === 'getSlot' ? String(result) : (result?.context?.slot ?? null);
      if (
        method === 'getMultipleAccounts' &&
        params[0].includes('SysvarC1ock11111111111111111111111111111111')
      ) {
        const raw =
          result.value[
            params[0].indexOf('SysvarC1ock11111111111111111111111111111111')
          ];
        const bytes = Buffer.from(raw?.data?.[0] ?? '', 'base64');
        if (bytes.length === 40) {
          row.clockSlot = bytes.readBigUInt64LE(0).toString();
          row.clockRelation =
            BigInt(row.clockSlot) === BigInt(row.slot)
              ? 'equal'
              : BigInt(row.clockSlot) === BigInt(row.slot) + 1n
                ? '+1'
                : 'refused';
          row.effectiveClockSlot =
            row.clockRelation === 'refused' ? null : row.clockSlot;
          row.clockDataSha256 = hash(bytes);
          row.chainUnix = bytes.readBigInt64LE(32).toString();
          row.clockSkewMs = Date.now() - Number(row.chainUnix) * 1000;
          row.receivedServerTimeMs = Date.now();
        }
      }
      row.returned = true;
      if (method === 'simulateTransaction' && reader) simulated = true;
      return result;
    } catch (error) {
      row.returned = false;
      row.status = typeof error.status === 'number' ? error.status : null;
      if (
        [
          'transport',
          'body-invalid',
          'byte-limit',
          'mapping',
          'rpc-error',
          'context',
        ].includes(error.rpcDiagnostic)
      )
        row.rpcDiagnostic = error.rpcDiagnostic;
      markStockRpcRateLimit(error, receipt, stop);
      throw error;
    } finally {
      row.elapsedMs = clock() - row.startMs;
    }
  }
  const rpc = (method, params) => read(method, params),
    programRpc = (method, params) => read(method, params, true);
  receipt.stage = 'public-reference';
  if ((await rpc('getGenesisHash', [])) !== lib.SOLANA_MAINNET_GENESIS)
    throw Error('Provider network differs.');
  let keys;
  if (referenceText !== null) {
    keys = stockReferencePool(referenceText, receipt.quoteAsset);
  } else if (args.has('--reserve-reference')) {
    const accounts = await rpc('getLargestAccounts', [
      { commitment: 'confirmed', filter: 'circulating' },
    ]);
    keys = accounts.value.slice(0, 20).map((a) => a.address);
  } else if (args.has('--known-public-reference'))
    keys = ['2k5hrzuykwyTbUe8L7UriYAQhr5hijNLgBvEB4B9pP5y'];
  else {
    const signatures = await rpc('getSignaturesForAddress', [
      baseMint,
      { commitment: 'confirmed', limit: 1000 },
    ]);
    const good = signatures.filter((s) => s.err === null);
    const chosen = [
      ...new Set(
        Array.from({ length: 8 }, (_, i) =>
          Math.min(good.length - 1, Math.floor((good.length * (i + 1)) / 9)),
        ),
      ),
    ]
      .map((i) => good[i])
      .filter(Boolean);
    const txs = await Promise.allSettled(
      chosen.map((s) =>
        programRpc('getTransaction', [
          s.signature,
          {
            encoding: 'json',
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 1,
          },
        ]),
      ),
    );
    keys = [
      ...new Set(
        txs
          .filter((t) => t.status === 'fulfilled')
          .map((t) => t.value?.transaction?.message?.accountKeys?.[0])
          .filter((k) => typeof k === 'string'),
      ),
    ];
  }
  if (!keys.length) throw Error('No public reference candidates.');
  const activityByKey = new Map();
  if (args.has('--idle-reference')) {
    const currentSlot = Number(
      await rpc('getSlot', [{ commitment: 'confirmed' }]),
    );
    // Bounded reference selection, not a retry of a refused trade. Never use a
    // live user wallet or relax custody checks to accommodate a busy reference.
    const activity = await Promise.all(
      keys.map((key) =>
        rpc('getSignaturesForAddress', [
          key,
          { commitment: 'confirmed', limit: 1, minContextSlot: currentSlot },
        ]),
      ),
    );
    const selectionSlot = Number(
      await rpc('getSlot', [
        { commitment: 'confirmed', minContextSlot: currentSlot },
      ]),
    );
    let unavailable = 0;
    const eligible = keys.filter((_, i) => {
      try {
        const snapshot = referenceActivity(activity[i], selectionSlot);
        activityByKey.set(keys[i], snapshot);
        return snapshot.idleSlots >= 256;
      } catch {
        unavailable++;
        return false;
      }
    });
    receipt.referenceSelection = {
      minimumIdleSlots: 256,
      checked: keys.length,
      eligible: eligible.length,
      unavailable,
    };
    keys = eligible;
    if (!keys.length)
      throw Error('No idle public reference; no custody check was relaxed.');
  }
  const atas = args.has('--quote-usdc')
    ? await Promise.all(
        keys.map((key) =>
          lib.pairAssociatedAddress(
            {
              address: quoteMint,
              program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            },
            key,
          ),
        ),
      )
    : [];
  const requested = [...keys, ...atas];
  const before = await rpc('getMultipleAccounts', [
    requested,
    { encoding: 'base64', commitment: 'confirmed' },
  ]);
  const after = await rpc('getMultipleAccounts', [
    requested,
    {
      encoding: 'base64',
      commitment: 'confirmed',
      minContextSlot: Number(before.context.slot),
    },
  ]);
  const index = before.value.slice(0, keys.length).findLastIndex(
    (a, i) =>
      a &&
      a.owner === '11111111111111111111111111111111' &&
      !a.executable &&
      a.data?.[0] === '' &&
      typeof a.lamports === 'string' &&
      BigInt(a.lamports) >= 12000000n &&
      (!atas.length ||
        (() => {
          const t = before.value[keys.length + i],
            data = Buffer.from(t?.data?.[0] ?? '', 'base64');
          return (
            data.length >= 165 &&
            data.readBigUInt64LE(64) >=
              (args.has('--one-unit') ? 1000000n : 1000n) &&
            JSON.stringify(t) === JSON.stringify(after.value[keys.length + i])
          );
        })()) &&
      JSON.stringify(a) === JSON.stringify(after.value[i]),
  );
  if (index < 0)
    throw Error(
      'No stable funded public system reference; no user wallet used.',
    );
  publicKey = keys[index];
  receipt.publicReferenceSha256 = hash(publicKey);
  if (args.has('--idle-reference')) {
    const beforeActivity = activityByKey.get(publicKey);
    receipt.referenceActivity = {
      before: beforeActivity,
      after: null,
      outcome: 'pending',
    };
    auditReference = async () => {
      const floor = Math.max(
        beforeActivity.observedSlot,
        ...receipt.logicalReads
          .flatMap((r) => [Number(r.slot), Number(r.effectiveClockSlot)])
          .filter(Number.isSafeInteger),
      );
      const audit = (method, params) =>
        auditStockReferenceRpc(
          lib.balanceRpc,
          endpoint,
          method,
          params,
          signal,
          (url, init) => fetcher(url, init, true),
          receipt,
          stop,
        );
      const signatures = await audit('getSignaturesForAddress', [
        publicKey,
        { commitment: 'confirmed', minContextSlot: floor, limit: 1 },
      ]);
      const observedSlot = Number(
        await audit('getSlot', [
          { commitment: 'confirmed', minContextSlot: floor },
        ]),
      );
      const afterActivity = referenceActivity(signatures, observedSlot);
      const quiet = unchangedQuietReference(beforeActivity, afterActivity);
      receipt.referenceActivity.after = afterActivity;
      receipt.referenceActivity.outcome = quiet
        ? 'no-new-observed-activity'
        : 'activity-changed';
      receipt.quietReferenceObserved = quiet;
      if (!quiet) {
        if (receipt.passed)
          receipt.diagnosis = {
            check: 'reference-activity',
            classification: 'reference-activity-changed',
            valuesAvailable: true,
            comparisons: ['latestActivitySlot', 'latestSignatureSha256'].map(
              (field) => ({
                field,
                before: String(beforeActivity[field]),
                after: String(afterActivity[field]),
              }),
            ),
          };
        receipt.passed = false;
        receipt.reason ??=
          'Public reference activity changed; qualification refused.';
      }
      if (receipt.runtime) {
        // The bound is on the pipeline. The post-attempt audit necessarily lands
        // later, so it is recorded separately rather than charged to the same
        // window.
        receipt.qualificationElapsedSlots =
          receipt.runtime.maximumSlot - receipt.runtime.minimumSlot;
        receipt.auditElapsedSlots = observedSlot - receipt.runtime.minimumSlot;
        if (receipt.qualificationElapsedSlots > 32) {
          if (receipt.passed)
            receipt.diagnosis = {
              check: 'reference-audit-slot-window',
              classification: 'freshness-window',
              valuesAvailable: true,
              comparisons: [
                {
                  field: 'maximumSlots',
                  before: '32',
                  after: String(receipt.qualificationElapsedSlots),
                },
              ],
            };
          receipt.passed = false;
          receipt.reason ??=
            'Post-attempt activity audit crossed the unchanged 32-slot limit.';
        }
      }
    };
  }
  useRuntimeEndpoint = true;
  if ((await rpc('getGenesisHash', [])) !== lib.SOLANA_MAINNET_GENESIS)
    throw Error('Runtime evidence provider network differs.');
  const stockReads = lib.createStockPairEvidenceRpc(rpc, programRpc, Date.now, {
    endpoint: runtimeEndpoint,
    signal,
  });
  receipt.clockObservations = stockReads.observations;
  receipt.partitionCollections = stockReads.partitions;
  receipt.runtimeAccountLimit = stockReads.accountLimit;
  receipt.stage = 'mint-identity';
  const slot = Number(await rpc('getSlot', [{ commitment: 'confirmed' }]));
  const mints = await lib.readPairMintEvidence(
    { inputMint: baseMint, outputMint: quoteMint },
    slot,
    stockReads.rpc,
  );
  const mint = (
    await rpc('getMultipleAccounts', [
      [baseMint],
      {
        encoding: 'base64',
        commitment: 'confirmed',
        minContextSlot: mints.slot,
      },
    ])
  ).value[0];
  const token = lib.importedTokenDocument(
    { chain: 'Solana', address: baseMint },
    {
      chain: 'Solana',
      address: baseMint,
      name: 'Public stock qualification reference',
      symbol: 'TSLAX',
      decimals: mints.mints[0].decimals,
      totalSupplyRaw: Buffer.from(mint.data[0], 'base64')
        .readBigUInt64LE(36)
        .toString(),
      observedAt: new Date().toISOString(),
      source: 'https://solana.com',
      contextSlot: mints.slot,
      tokenProgram: mints.mints[0].program,
    },
  );
  for (const p of [
    'drizzle/0024_imported_token_projects.sql',
    'drizzle/0011_huge_donald_blake.sql',
    'drizzle/0089_pair_order_first_reviews.sql',
  ])
    sqlite.exec(readFileSync(p, 'utf8'));
  sqlite.exec(
    'CREATE TABLE imported_market_observations(owner_id TEXT,project_id TEXT,document TEXT,observed_at TEXT)',
  );
  const id = crypto.randomUUID(),
    owner = 'isolated-unsigned-stock-qualification',
    stamp = new Date().toISOString();
  sqlite
    .prepare(
      'INSERT INTO imported_token_projects(owner_id,id,chain,address,document,mutation_id,updated_at) VALUES(?,?,?,?,?,?,?)',
    )
    .run(
      owner,
      id,
      'Solana',
      baseMint,
      JSON.stringify(token),
      crypto.randomUUID(),
      stamp,
    );
  sqlite
    .prepare(
      'INSERT INTO workspace_wallets(owner_id,chain,address,folder_id,label,role,archived,revision,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
    )
    .run(
      owner,
      'Solana',
      publicKey,
      crypto.randomUUID(),
      'Public reference, not owned or signable',
      'Recipient',
      0,
      1,
      stamp,
    );
  const db = {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) {
          values = args;
          return this;
        },
        async first() {
          return sqlite.prepare(sql).get(...values) ?? null;
        },
        async run() {
          return {
            meta: {
              changes: Number(sqlite.prepare(sql).run(...values).changes),
            },
          };
        },
      };
    },
  };
  receipt.stage = 'order-first-runtime';
  pipelineStart = clock();
  reader = lib.createPairReadRpc(
    runtimeEndpoint,
    signal,
    fetcher,
    'unsigned-stock-qualification',
    lib.stockPairAccountLimit(runtimeEndpoint),
  );
  const result = await lib.qualifyOwnedPairOrderFirstRuntime(
    db,
    owner,
    {
      id,
      revision: 1,
      quoteMint,
      side: 'Buy',
      amount: receipt.inputUiAmount,
      wallet: publicKey,
      walletRevision: 1,
      feeAndRentLimitRaw: '10000000',
      absoluteMinimumRaw: null,
      prepareUnsigned: true,
    },
    signal,
    {
      rpc: stockReads.rpc,
      programRpc: stockReads.programRpc,
      quote: async (input, s) => {
        const quote = await measureStockProvider(
          receipt.providerTimings,
          receipt.providerTimings.length === 0
            ? 'initial-quote'
            : 'fresh-quote',
          () =>
            lib.quoteSolanaPair(input, process.env.JUPITER_API_KEY, s, fetcher),
        );
        receipt.quotes.push({
          router: quote.router,
          expectedOutputRaw: quote.outAmount,
          minimumOutputRaw: quote.minimumOutAmount,
          observedAt: quote.observedAt,
        });
        return quote;
      },
      prepare: async (input, s) => {
        const order = await measureStockProvider(
          receipt.providerTimings,
          'wallet-bound-order',
          () =>
            lib.prepareSolanaPair(
              input,
              process.env.JUPITER_API_KEY,
              s,
              fetcher,
            ),
        );
        receipt.unsignedOrder = {
          router: order.router,
          expectedOutputRaw: order.outAmount,
          minimumOutputRaw: order.minimumOutAmount,
          observedAt: order.observedAt,
        };
        return order;
      },
    },
  );
  if (
    // The runtime preview is pre-authorization, so it stays false either way;
    // the gate is recorded separately and gates authorization, not this result.
    result.signingAllowed !== false ||
    result.executionAllowed !== false ||
    result.runtime.signingAllowed !== false ||
    result.runtime.maximumSlot - result.runtime.minimumSlot > 32
  )
    throw Error(
      'Qualification must not permit signing or change the slot bound.',
    );
  receipt.runtime = result.runtime;
  receipt.review = {
    packetSha256: result.review.packetSha256,
    minimumOutputRaw: result.review.minimumOutputRaw,
    expectedOutputRaw: result.review.expectedOutputRaw,
    route: result.review.route,
    priceImpactPct: result.review.priceImpactPct,
    marketComparison: result.review.marketComparison,
  };
  receipt.stage = 'complete';
  receipt.passed = true;
} catch (error) {
  for (
    let current = error, depth = 0;
    current && depth < 8;
    current = current.cause, depth++
  ) {
    const d = current.pairDiagnostic;
    if (!d || !/^[a-z-]{1,64}$/.test(d.check)) continue;
    receipt.diagnostic = { check: d.check };
    for (const key of [
      'contextSlot',
      'clockSlot',
      'wallSkewMs',
      'slotDelta',
      'unixDelta',
      'evaluatedServerTimeMs',
      'instructionIndex',
      'accountDataBytes',
      'compiledAccountIndex',
      'staticAccountCount',
      'loadedWritableCount',
      'loadedReadonlyCount',
      'lookupEntryIndex',
      'lookupObservedSlot',
      'rpcAccountPosition',
      'rpcAccountCount',
    ])
      if (Number.isSafeInteger(d[key])) receipt.diagnostic[key] = d[key];
    for (const key of [
      'nativeBalanceRaw',
      'nativeTokenAmountRaw',
      'instructionProgram',
      'instructionDataHex',
      'instructionAccounts',
      'accountAddress',
      'accountOwner',
      'observationPhase',
      'packetScopeEvidence',
      'packetSha256',
      'compiledAccountSource',
      'lookupTableAddress',
      'lookupTableSha256',
      'instructionReferences',
    ])
      if (
        typeof d[key] === 'string' &&
        d[key].length <= 32768 &&
        !/https?:|secret|api.key|bearer /i.test(d[key])
      )
        receipt.diagnostic[key] = d[key];
    if (
      Array.isArray(d.comparisons) &&
      d.comparisons.length <= 128 &&
      d.comparisons.every(
        (c) =>
          c &&
          typeof c.field === 'string' &&
          /^[a-zA-Z][a-zA-Z0-9.[\]]{0,95}$/.test(c.field) &&
          ['before', 'after'].every(
            (k) =>
              typeof c[k] === 'string' &&
              c[k].length <= 8192 &&
              !/https?:|secret|api.key|bearer /i.test(c[k]),
          ),
      )
    )
      receipt.diagnostic.comparisons = d.comparisons;
    for (const key of [
      'nativeBalanceChanged',
      'systemOwnerChanged',
      'systemExecutable',
      'systemDataChanged',
      'declaredWritable',
      'declaredSigner',
    ])
      if (typeof d[key] === 'boolean') receipt.diagnostic[key] = d[key];
    if (
      Array.isArray(d.changedAccountFields) &&
      d.changedAccountFields.length <= 32 &&
      d.changedAccountFields.every(
        (k) => typeof k === 'string' && /^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(k),
      )
    )
      receipt.diagnostic.changedAccountFields = d.changedAccountFields;
    break;
  }
  receipt.errorName = error.name;
  receipt.status = typeof error.status === 'number' ? error.status : null;
  const message = String(error.cause?.message ?? error.message ?? '');
  receipt.reason =
    message.length <= 300 &&
    !/https?:|api.key|secret|token=|[A-Za-z0-9_-]{70,}/i.test(message)
      ? message
      : 'Unsigned qualification failed; provider details withheld.';
  const d = receipt.diagnostic;
  receipt.diagnosis = {
    check: d?.check ?? 'unclassified-refusal',
    valuesAvailable: Boolean(d?.comparisons?.length),
    ...(d?.comparisons?.length ? { comparisons: d.comparisons } : {}),
    classification: !d
      ? 'evidence-unavailable'
      : d.check === 'chain-clock'
        ? d.contextSlot !== d.clockSlot
          ? 'clock-bank-mismatch'
          : 'clock-age-or-invalid-time'
        : ['wallet-stability', 'system-wallet-state'].includes(d.check)
          ? d.comparisons?.some(
              (c) => c.field === 'nativeBalanceRaw' && c.before !== c.after,
            )
            ? 'custody-native-balance-changed'
            : 'custody-other-state-or-window'
          : d.check === 'selected-token-state'
            ? 'custody-token-state-changed'
            : d.check === 'native-existing-rent'
              ? 'account-wsol-reserve-or-rent'
              : d.check === 'minimum-output'
                ? 'economic-minimum-output'
                : 'instruction-or-account-review',
  };
  const rpcDiagnostic = receipt.logicalReads.find(
    (row) => row.rpcDiagnostic,
  )?.rpcDiagnostic;
  if (!d && rpcDiagnostic)
    receipt.diagnosis = {
      check: 'pair-rpc-' + rpcDiagnostic,
      valuesAvailable: false,
      classification: 'provider-read-refused',
    };
} finally {
  receipt.pipelineMs =
    pipelineStart === undefined ? null : clock() - pipelineStart;
  reader?.close();
  if (auditReference) {
    if (!signal.aborted) {
      try {
        await auditReference();
      } catch {
        receipt.referenceActivity.outcome = 'unavailable';
        receipt.quietReferenceObserved = false;
        receipt.passed = false;
        receipt.reason ??= 'Public reference activity could not be rechecked.';
      }
    } else {
      receipt.referenceActivity.outcome = 'unavailable';
      receipt.quietReferenceObserved = false;
      receipt.passed = false;
    }
  }
  stop.abort();
  sqlite.close();
  receipt.sourceUnchanged = files.every(
    (p) => sourceFiles[p] === hash(readFileSync(p)),
  );
  receipt.quoteTiming = stockQuoteGaps(receipt.providerTimings);
  if (!receipt.sourceUnchanged) receipt.passed = false;
  receipt.elapsedSlots = receipt.runtime
    ? receipt.runtime.maximumSlot - receipt.runtime.minimumSlot
    : null;
  receipt.simulationCount = receipt.logicalReads.filter(
    (r) => r.method === 'simulateTransaction',
  ).length;
  receipt.http429 = receipt.requests.filter((r) => r.status === 429).length;
  if (receipt.http429 > 0 || receipt.rpcRateLimited)
    receipt.diagnosis = {
      check: 'provider-rate-limit',
      classification: 'provider-rate-limit',
      valuesAvailable: false,
    };
  // Each endpoint has its own pacing budget, so measure each endpoint alone.
  const rolling = (rows) =>
    rows.length
      ? Math.max(
          ...rows.map((r) =>
            rows
              .filter(
                (other) =>
                  other.startMs <= r.startMs &&
                  other.startMs > r.startMs - 1000,
              )
              .reduce((sum, other) => sum + other.rpcUnits, 0),
          ),
        )
      : 0;
  const allRpc = receipt.requests.filter((r) => r.rpcUnits !== undefined);
  receipt.qualificationMethodBudget = qualificationMethodBudget;
  receipt.maximumRollingRpcMethodsByRole = {
    'indexer-fallback': rolling(
      allRpc.filter((r) => r.providerRole === 'indexer-fallback'),
    ),
    'stock-runtime': rolling(
      allRpc.filter((r) => r.providerRole === 'stock-runtime'),
    ),
  };
  receipt.maximumRollingRpcMethods = Math.max(
    ...Object.values(receipt.maximumRollingRpcMethodsByRole),
  );
  if (
    receipt.maximumRollingRpcMethodsByRole['indexer-fallback'] > 9 ||
    (qualificationMethodBudget !== null &&
      receipt.maximumRollingRpcMethodsByRole['stock-runtime'] >
        qualificationMethodBudget)
  ) {
    receipt.passed = false;
    receipt.runtimeRefusalBeforePacing = receipt.reason ?? null;
    receipt.reason =
      'Qualification pacing exceeded the RPC method budget in a rolling second.';
  }
  receipt.firstCodeReads = receipt.logicalReads.filter(
    (r) => r.profile === 'code' && r.phase === 'before-simulation',
  ).length;
  receipt.finalCodeReads = receipt.logicalReads.filter(
    (r) => r.profile === 'code' && r.phase === 'after-simulation',
  ).length;
  writeFileSync(
    join(folder, 'receipt.json'),
    JSON.stringify(receipt, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      receipt: join(folder, 'receipt.json'),
      passed: receipt.passed,
      stage: receipt.stage,
      reason: receipt.reason ?? null,
      elapsedSlots: receipt.elapsedSlots,
      pipelineMs: receipt.pipelineMs,
      quoteAsset: receipt.quoteAsset,
      inputUiAmount: receipt.inputUiAmount,
      httpRequests: receipt.requests.length,
      http429: receipt.http429,
      rpcRateLimited: receipt.rpcRateLimited,
      maximumRollingRpcMethods: receipt.maximumRollingRpcMethods,
      simulationCount: receipt.simulationCount,
      firstCodeReads: receipt.firstCodeReads,
      finalCodeReads: receipt.finalCodeReads,
      sourceUnchanged: receipt.sourceUnchanged,
      signingAllowed: false,
      broadcasts: 0,
    }),
  );
}
if (!receipt.passed) process.exitCode = 1;
