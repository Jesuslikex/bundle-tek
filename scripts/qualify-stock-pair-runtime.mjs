// One bounded unsigned mainnet observation. Never unlocks, signs, sends or retries.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = new Set(process.argv.slice(2));
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
      ].includes(a),
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
  'lib/imported-pair-wallet-preflight.ts',
  'lib/pair-order-first-review.ts',
  'lib/pair-order-market-bound.ts',
  'lib/token-market.ts',
  'lib/imported-pair-order-candidate.ts',
  'lib/imported-pair-wallet-preflight.ts',
  'lib/imported-pair-quote-service.ts',
  'lib/pair-runtime-preview.ts',
  'lib/pair-order-collector.ts',
  'lib/pair-read-rpc.ts',
  'lib/wallet-rpc-pacing.ts',
  'lib/pair-order-state.ts',
  'lib/pair-rent-evidence.ts',
  'lib/pair-runtime-trace.ts',
  'lib/pump-group-code-identity.ts',
  'lib/pair-stock-signing-policy.ts',
  'lib/warmup-swap-quote.ts',
  'lib/pair-order-quote-bounds.ts',
  'scripts/qualify-stock-pair-runtime.mjs',
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
await build({
  stdin: {
    contents: `export {qualifyOwnedPairOrderFirstRuntime} from './lib/pair-order-first-service'; export {createPairReadRpc} from './lib/pair-read-rpc'; export {prepareSolanaPair,quoteSolanaPair} from './lib/warmup-swap-quote'; export {balanceRpc,SOLANA_MAINNET_GENESIS} from './lib/wallet-balances'; export {getSolanaIndexerRpcEndpoint} from './lib/solana-rpc'; export {pairAssociatedAddress} from './lib/pair-wallet-evidence'; export {readPairMintEvidence} from './lib/pair-mint-evidence'; export {importedTokenDocument} from './lib/imported-token-project'; export {pairStockSigningPolicy} from './lib/pair-stock-signing-policy';`,
    resolveDir: process.cwd(),
    sourcefile: 'unsigned-stock-qualification.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  outfile: bundle,
  logLevel: 'silent',
});
const lib = await import(pathToFileURL(bundle).href);
const stop = new AbortController(),
  signal = AbortSignal.any([stop.signal, AbortSignal.timeout(90000)]);
const receipt = {
  format: 'stock-pair-live-qualification-v1',
  checkedAt: new Date().toISOString(),
  readOnly: true,
  sourceFiles,
  sourceUnchanged: false,
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
  signingAllowed: false,
  executionAllowed: false,
  stage: 'configuration',
  passed: false,
  requests: [],
  logicalReads: [],
  quotes: [],
  quoteAsset: args.has('--quote-usdc') ? 'USDC' : 'SOL',
  inputUiAmount: args.has('--one-unit') ? '1' : '0.001',
  qualificationPacing: 'unsigned-helius-qualification-nine-methods-per-second',
  rpcPacingMs: /^\d{1,4}$/.test(process.env.SOLANA_RPC_MIN_INTERVAL_MS ?? '')
    ? Number(process.env.SOLANA_RPC_MIN_INTERVAL_MS)
    : null,
};
const sqlite = new DatabaseSync(':memory:');
let reader,
  publicKey,
  pipelineStart,
  simulated = false;
const clock = () => performance.now();
const methodsForReceipt = new Set([
  'getGenesisHash',
  'getSlot',
  'getBlockHeight',
  'getMultipleAccounts',
  'getFeeForMessage',
  'isBlockhashValid',
  'simulateTransaction',
]);
try {
  if (lib.pairStockSigningPolicy().qualified !== false)
    throw Error('Signing gate must remain disabled.');
  const endpoint = lib.getSolanaIndexerRpcEndpoint();
  if (new URL(endpoint).protocol !== 'https:' || !process.env.JUPITER_API_KEY)
    throw Error('Configured provider settings unavailable.');
  const methods = new Set([
    'getGenesisHash',
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
  const fetcher = async (url, init) => {
    signal.throwIfAborted();
    const u = new URL(url),
      row = { startMs: clock(), pipeline: pipelineStart !== undefined };
    if (u.href === new URL(endpoint).href) {
      const body = JSON.parse(init?.body ?? '{}'),
        batch = Array.isArray(body) ? body : [body];
      if (
        init?.method !== 'POST' ||
        !batch.length ||
        batch.length > 2 ||
        batch.some((r) => !methods.has(r.method))
      )
        throw Error('Non-read-only RPC method rejected.');
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
    receipt.requests.push(row);
    if (receipt.requests.length > 160)
      throw Error('Read-only request budget exhausted.');
    const response = await fetch(url, { ...init, redirect: 'manual' });
    row.status = response.status;
    row.headerMs = clock() - row.startMs;
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
            endpoint,
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
          row.chainUnix = bytes.readBigInt64LE(32).toString();
          row.clockSkewMs = Date.now() - Number(row.chainUnix) * 1000;
        }
      }
      row.returned = true;
      if (method === 'simulateTransaction' && reader) simulated = true;
      return result;
    } catch (error) {
      row.returned = false;
      row.status = typeof error.status === 'number' ? error.status : null;
      if (error.status === 429) {
        receipt.rateLimited = true;
        stop.abort(Error('RPC rate limit; no retry.'));
      }
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
  if (args.has('--reserve-reference')) {
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
          { commitment: 'confirmed', limit: 1 },
        ]),
      ),
    );
    const eligible = keys.filter((_, i) => {
      const slot = activity[i]?.[0]?.slot;
      return (
        typeof slot === 'string' &&
        /^[1-9]\d{0,15}$/.test(slot) &&
        Number.isSafeInteger(Number(slot)) &&
        Number(slot) <= currentSlot - 256
      );
    });
    receipt.referenceSelection = {
      minimumIdleSlots: 256,
      checked: keys.length,
      eligible: eligible.length,
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
  receipt.stage = 'mint-identity';
  const slot = Number(await rpc('getSlot', [{ commitment: 'confirmed' }]));
  const mints = await lib.readPairMintEvidence(
    { inputMint: baseMint, outputMint: quoteMint },
    slot,
    rpc,
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
    endpoint,
    signal,
    fetcher,
    'unsigned-helius-qualification',
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
      rpc,
      programRpc,
      quote: async (input, s) => {
        const quote = await lib.quoteSolanaPair(
          input,
          process.env.JUPITER_API_KEY,
          s,
          fetcher,
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
        const order = await lib.prepareSolanaPair(
          input,
          process.env.JUPITER_API_KEY,
          s,
          fetcher,
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
    ])
      if (Number.isSafeInteger(d[key])) receipt.diagnostic[key] = d[key];
    if (typeof d.nativeBalanceChanged === 'boolean')
      receipt.diagnostic.nativeBalanceChanged = d.nativeBalanceChanged;
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
} finally {
  receipt.pipelineMs =
    pipelineStart === undefined ? null : clock() - pipelineStart;
  stop.abort();
  reader?.close();
  sqlite.close();
  receipt.sourceUnchanged = files.every(
    (p) => sourceFiles[p] === hash(readFileSync(p)),
  );
  if (!receipt.sourceUnchanged) receipt.passed = false;
  receipt.elapsedSlots = receipt.runtime
    ? receipt.runtime.maximumSlot - receipt.runtime.minimumSlot
    : null;
  receipt.simulationCount = receipt.logicalReads.filter(
    (r) => r.method === 'simulateTransaction',
  ).length;
  receipt.http429 = receipt.requests.filter((r) => r.status === 429).length;
  const pipelineRpc = receipt.requests.filter(
    (r) =>
      pipelineStart !== undefined &&
      r.startMs >= pipelineStart &&
      r.methods.every((method) => methodsForReceipt.has(method)),
  );
  receipt.maximumRollingRpcMethods = pipelineRpc.length
    ? Math.max(
        ...pipelineRpc.map((r) =>
          pipelineRpc
            .filter(
              (other) =>
                other.startMs <= r.startMs && other.startMs > r.startMs - 1000,
            )
            .reduce((sum, other) => sum + other.methods.length, 0),
        ),
      )
    : 0;
  if (receipt.maximumRollingRpcMethods > 9) {
    receipt.passed = false;
    receipt.reason =
      'Qualification pacing exceeded nine RPC methods in a rolling second.';
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
