// Four fixed public unsigned packet/account observations. This is NOT a review
// or qualification: no simulation, consent, signing, submission or lower-bound approval.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stockReferenceFixture } from './stock-reference-fixture.mjs';
import {
  referenceActivity,
  unchangedQuietReference,
} from './stock-reference-activity.mjs';
if (
  process.argv.length !== 4 ||
  process.argv[2] !== '--live-readonly' ||
  !process.argv[3].startsWith('--reference-file=')
)
  throw Error(
    'Use --live-readonly --reference-file=path. Scope diagnosis only.',
  );
const fixtureText = readFileSync(
  process.argv[3].slice('--reference-file='.length),
  'utf8',
);
const hash = (v) => createHash('sha256').update(v).digest('hex');
const sourcePaths = [
  'scripts/probe-stock-writable-scope.mjs',
  'scripts/stock-reference-fixture.mjs',
  'scripts/stock-reference-activity.mjs',
  'lib/pair-runtime-exposure.ts',
  'lib/unsigned-swap-order.ts',
  'lib/swap-lookup-accounts.ts',
  'lib/warmup-swap-quote.ts',
  'lib/wallet-balances.ts',
  'lib/wallet-rpc-pacing.ts',
];
const sourceFiles = Object.fromEntries(
  sourcePaths.map((p) => [p, hash(readFileSync(p))]),
);
const folder = resolve(
  'work/stock-writable-scope-' +
    new Date().toISOString().replaceAll(/[:.]/g, '-'),
);
mkdirSync(folder, { recursive: true });
const bundle = join(folder, 'reader.mjs');
await build({
  stdin: {
    contents: `export {balanceRpc,SOLANA_MAINNET_GENESIS} from './lib/wallet-balances'; export {getSolanaIndexerRpcEndpoint} from './lib/solana-rpc'; export {paceWalletRpc} from './lib/wallet-rpc-pacing'; export {prepareSolanaPair} from './lib/warmup-swap-quote'; export {reviewUnsignedSwapEnvelope} from './lib/unsigned-swap-order'; export {readSwapLookupAccounts} from './lib/swap-lookup-accounts'; export {assertPairRuntimeWritableAccount} from './lib/pair-runtime-exposure'; export {getBase64Encoder,getTransactionDecoder,getCompiledTransactionMessageDecoder} from '@solana/kit';`,
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
const endpoint = lib.getSolanaIndexerRpcEndpoint(),
  stop = new AbortController(),
  signal = AbortSignal.any([stop.signal, AbortSignal.timeout(90000)]);
const evidence = {
  format: 'stock-four-order-writable-scope-v1',
  readOnly: true,
  qualification: false,
  sourceFiles,
  sourceUnchanged: false,
  fixtureSha256: hash(fixtureText),
  requests: [],
  attempts: [],
  complete: false,
  signatures: 0,
  broadcasts: 0,
  signingAllowed: false,
  executionAllowed: false,
};
let publicKey;
const fetcher = async (url, init) => {
  const u = new URL(url);
  let method;
  if (u.href === new URL(endpoint).href) {
    const body = JSON.parse(init.body);
    method = body.method;
    if (
      ![
        'getGenesisHash',
        'getSlot',
        'getMultipleAccounts',
        'getSignaturesForAddress',
      ].includes(method)
    )
      throw Error('Scope method refused.');
    await lib.paceWalletRpc(endpoint, signal, 1);
  } else {
    if (
      u.origin !== 'https://api.jup.ag' ||
      u.pathname !== '/swap/v2/order' ||
      (init?.method ?? 'GET') !== 'GET' ||
      u.searchParams.get('taker') !== publicKey
    )
      throw Error('Scope provider request refused.');
    method = 'unsigned-order';
  }
  if (evidence.requests.length >= 70)
    throw Error('Scope read budget exhausted.');
  const row = { method, startMs: performance.now() };
  evidence.requests.push(row);
  const response = await fetch(url, { ...init, redirect: 'manual' });
  row.status = response.status;
  if (response.status === 429) stop.abort(Error('Rate limit; no retry.'));
  return response;
};
const rpc = (method, params) =>
  lib.balanceRpc(endpoint, method, params, signal, fetcher, 2097152);
try {
  if ((await rpc('getGenesisHash', [])) !== lib.SOLANA_MAINNET_GENESIS)
    throw Error('Wrong network.');
  for (let round = 1; round <= 2; round++)
    for (const asset of ['SOL', 'USDC']) {
      signal.throwIfAborted();
      const row = { round, asset, qualification: false };
      evidence.attempts.push(row);
      try {
        publicKey = stockReferenceFixture(fixtureText, asset);
        row.publicReferenceSha256 = hash(publicKey);
        const anchor = Number(
          await rpc('getSlot', [{ commitment: 'confirmed' }]),
        );
        const signatures = await rpc('getSignaturesForAddress', [
          publicKey,
          { commitment: 'confirmed', limit: 1, minContextSlot: anchor },
        ]);
        const selection = Number(
          await rpc('getSlot', [
            { commitment: 'confirmed', minContextSlot: anchor },
          ]),
        );
        const before = referenceActivity(signatures, selection);
        row.beforeActivity = before;
        if (before.idleSlots < 256)
          throw Error('Public reference is not quiet.');
        const order = await lib.prepareSolanaPair(
          {
            baseMint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB',
            quoteMint:
              asset === 'SOL'
                ? 'So11111111111111111111111111111111111111112'
                : 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            side: 'Buy',
            amountRaw: '1000000',
            wallet: publicKey,
          },
          process.env.JUPITER_API_KEY,
          signal,
          fetcher,
        );
        const envelope = await lib.reviewUnsignedSwapEnvelope(
          order.preparation.transaction,
          publicKey,
        );
        row.packetSha256 = envelope.sha256;
        const message = lib
          .getCompiledTransactionMessageDecoder()
          .decode(
            lib
              .getTransactionDecoder()
              .decode(
                lib.getBase64Encoder().encode(order.preparation.transaction),
              ).messageBytes,
          );
        const lookup = await lib.readSwapLookupAccounts(
          message,
          selection,
          rpc,
        );
        const keys = [
          ...message.staticAccounts.map(String),
          ...(lookup?.writable ?? []),
          ...(lookup?.readonly ?? []),
        ];
        if (
          message.version !== 0 ||
          new Set(keys).size !== keys.length ||
          keys.length !== envelope.accountCount
        )
          throw Error('Packet account scope differs.');
        // Same compiled-message privilege formula as the production runtime;
        // these keys are inspected only and can never grant transaction approval.
        const writable = keys.filter((_key, i) =>
          i < message.staticAccounts.length
            ? i < message.header.numSignerAccounts
              ? i <
                message.header.numSignerAccounts -
                  message.header.numReadonlySignerAccounts
              : i <
                message.staticAccounts.length -
                  message.header.numReadonlyNonSignerAccounts
            : i <
              message.staticAccounts.length + (lookup?.writable.length ?? 0),
        );
        if (
          !writable.length ||
          writable.length > 100 ||
          !writable.includes(publicKey)
        )
          throw Error('Packet writable scope differs.');
        const result = await rpc('getMultipleAccounts', [
          writable,
          {
            encoding: 'base64',
            commitment: 'confirmed',
            minContextSlot: lookup?.observedSlot ?? selection,
            dataSlice: { offset: 0, length: 166 },
          },
        ]);
        const slot = Number(result.context?.slot);
        if (
          !Number.isSafeInteger(slot) ||
          slot < (lookup?.observedSlot ?? selection) ||
          result.value?.length !== writable.length
        )
          throw Error('Scope account context differs.');
        row.observedSlot = slot;
        row.writableCount = writable.length;
        row.refusals = [];
        for (const [i, raw] of result.value.entries()) {
          try {
            lib.assertPairRuntimeWritableAccount(raw, {
              address: writable[i],
              phase: 'before-inventory',
              slot,
            });
          } catch (error) {
            if (error.pairDiagnostic?.check !== 'writable-runtime-state')
              throw Error('Scope account bytes unavailable.');
            row.refusals.push(error.pairDiagnostic);
          }
        }
        const afterRows = await rpc('getSignaturesForAddress', [
          publicKey,
          { commitment: 'confirmed', limit: 1, minContextSlot: slot },
        ]);
        const observed = Number(
          await rpc('getSlot', [
            { commitment: 'confirmed', minContextSlot: slot },
          ]),
        );
        row.afterActivity = referenceActivity(afterRows, observed);
        row.quiet = unchangedQuietReference(before, row.afterActivity);
        row.observed = true;
      } catch {
        row.reason = signal.aborted
          ? 'Scope probe aborted/rate limited; no retry.'
          : 'Scope observation unavailable or reference no longer quiet.';
      }
    }
  if ((await rpc('getGenesisHash', [])) !== lib.SOLANA_MAINNET_GENESIS)
    throw Error('Network changed.');
  evidence.complete = true;
} catch {
  evidence.reason = 'Scope probe stopped; no retry.';
} finally {
  stop.abort();
  evidence.sourceUnchanged = sourcePaths.every(
    (p) => hash(readFileSync(p)) === sourceFiles[p],
  );
  evidence.http429 = evidence.requests.filter((r) => r.status === 429).length;
  const output = join(folder, 'scope.json');
  writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log(
    JSON.stringify({
      output,
      attempts: evidence.attempts.length,
      complete: evidence.complete,
      http429: evidence.http429,
      qualification: false,
    }),
  );
}
