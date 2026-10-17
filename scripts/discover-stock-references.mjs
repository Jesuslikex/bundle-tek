// Bounded public-history fixture discovery only. No quote, simulation or wallet action.
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { referenceActivity } from './stock-reference-activity.mjs';
import {
  STOCK_REFERENCE_POOL_MAX,
  stockReferenceHash,
} from './stock-reference-fixture.mjs';

if (process.argv.length !== 3 || process.argv[2] !== '--live-readonly')
  throw Error('Use --live-readonly. No transaction or retry mode exists.');
const folder = resolve(
  'work/stock-reference-discovery-' +
    new Date().toISOString().replaceAll(/[:.]/g, '-'),
);
mkdirSync(folder, { recursive: true });
const bundle = join(folder, 'reader.mjs');
await build({
  stdin: {
    contents: `export {balanceRpc,SOLANA_MAINNET_GENESIS} from './lib/wallet-balances'; export {getSolanaIndexerRpcEndpoint} from './lib/solana-rpc'; export {pairAssociatedAddress} from './lib/pair-wallet-evidence'; export {paceWalletRpc} from './lib/wallet-rpc-pacing';`,
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
const endpoint = lib.getSolanaIndexerRpcEndpoint();
const stop = new AbortController();
const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(180000)]);
const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const mint = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';
const requests = [];
const allowed = new Set([
  'getGenesisHash',
  'getSignaturesForAddress',
  'getTransaction',
  'getMultipleAccounts',
  'getSlot',
]);
const fetcher = async (url, init) => {
  const body = JSON.parse(init.body);
  if (
    new URL(url).href !== new URL(endpoint).href ||
    !allowed.has(body.method) ||
    requests.length >= 100
  )
    throw Error('Discovery read budget/method refused.');
  // Explicit scope so a non-Helius indexer is paced by the same budget.
  await lib.paceWalletRpc(endpoint, signal, 1, 'stock-runtime-evidence');
  const row = { method: body.method, startMs: performance.now() };
  requests.push(row);
  const response = await fetch(url, { ...init, redirect: 'manual' });
  row.status = response.status;
  if (response.status === 429)
    stop.abort(Error('Provider rate limit; no retry.'));
  return response;
};
const rpc = (method, params, bytes = 2097152) =>
  lib.balanceRpc(endpoint, method, params, signal, fetcher, bytes);
const evidence = {
  format: 'stock-public-reference-discovery-v1',
  readOnly: true,
  requests,
  candidates: [],
  unavailableTransactions: 0,
  passed: false,
};
try {
  if ((await rpc('getGenesisHash', [])) !== lib.SOLANA_MAINNET_GENESIS)
    throw Error('Wrong network.');
  const recent = await rpc('getSignaturesForAddress', [
    mint,
    { commitment: 'confirmed', limit: 1000 },
  ]);
  if (!recent.at(-1)?.signature) throw Error('No historical cursor.');
  let cursor = recent.at(-1).signature;
  const chosen = [];
  evidence.historyPages = [];
  for (let page = 0; page < 16; page++) {
    const older = await rpc('getSignaturesForAddress', [
      mint,
      { commitment: 'confirmed', limit: 1000, before: cursor },
    ]);
    if (!older.length) break;
    evidence.historyPages.push({
      count: older.length,
      firstSlot: older[0].slot,
      lastSlot: older.at(-1).slot,
    });
    const good = older.filter((r) => r.err === null);
    if (good.length) chosen.push(good[Math.floor(good.length / 2)]);
    if (!older.at(-1)?.signature || older.at(-1).signature === cursor)
      throw Error('Invalid historical cursor.');
    cursor = older.at(-1).signature;
  }
  const keys = new Set();
  // One middle transaction from each of sixteen fixed older pages.
  for (const selected of chosen) {
    let tx;
    try {
      tx = await rpc('getTransaction', [
        selected.signature,
        {
          encoding: 'json',
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 1,
        },
      ]);
    } catch {
      signal.throwIfAborted();
      evidence.unavailableTransactions++;
      continue;
    }
    const payer = tx?.transaction?.message?.accountKeys?.[0];
    if (typeof payer === 'string') keys.add(payer);
    // Token owners can differ from a routing service's fee payer. Screen all
    // public owners below; pool/program accounts are never eligible fixtures.
    for (const token of tx?.meta?.postTokenBalances ?? []) {
      if (typeof token.owner === 'string') keys.add(token.owner);
    }
  }
  const candidates = [...keys].slice(0, 32);
  const atas = await Promise.all(
    candidates.map((key) =>
      lib.pairAssociatedAddress(
        {
          address: usdc,
          program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        },
        key,
      ),
    ),
  );
  const wrappedSolAtas = await Promise.all(
    candidates.map((key) =>
      lib.pairAssociatedAddress(
        {
          address: 'So11111111111111111111111111111111111111112',
          program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        },
        key,
      ),
    ),
  );
  const requested = [...candidates, ...atas, ...wrappedSolAtas];
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
  const eligible = [];
  for (let i = 0; i < candidates.length; i++) {
    const account = before.value[i];
    if (
      !account ||
      account.owner !== '11111111111111111111111111111111' ||
      account.executable ||
      account.data?.[0] !== '' ||
      !/^\d+$/.test(account.lamports ?? '') ||
      BigInt(account.lamports) < 12000000n ||
      JSON.stringify(account) !== JSON.stringify(after.value[i])
    )
      continue;
    const rows = await rpc('getSignaturesForAddress', [
      candidates[i],
      {
        commitment: 'confirmed',
        limit: 1,
        minContextSlot: Number(after.context.slot),
      },
    ]);
    const observed = Number(
      await rpc('getSlot', [
        { commitment: 'confirmed', minContextSlot: Number(after.context.slot) },
      ]),
    );
    let activity;
    try {
      activity = referenceActivity(rows, observed);
    } catch {
      continue;
    }
    const token = before.value[candidates.length + i];
    const data = Buffer.from(token?.data?.[0] ?? '', 'base64');
    const usdcFunded =
      data.length >= 165 &&
      data.readBigUInt64LE(64) >= 1000000n &&
      JSON.stringify(token) ===
        JSON.stringify(after.value[candidates.length + i]);
    const wrappedSolAbsent =
      before.value[2 * candidates.length + i] === null &&
      after.value[2 * candidates.length + i] === null;
    evidence.candidates.push({
      sha256: stockReferenceHash(candidates[i]),
      activity,
      usdcFunded,
      usdcAmountRaw:
        data.length >= 165 ? String(data.readBigUInt64LE(64)) : null,
      wrappedSolAbsent,
    });
    if (activity.idleSlots >= 4096)
      eligible.push({
        key: candidates[i],
        activity,
        usdcFunded,
        wrappedSolAbsent,
      });
  }
  eligible.sort(
    (a, b) =>
      b.activity.idleSlots - a.activity.idleSlots || a.key.localeCompare(b.key),
  );
  // Pin every long-idle candidate (up to the pool limit), so one reference that
  // later becomes active does not refuse the whole attempt.
  const references = {
    SOL: eligible.slice(0, STOCK_REFERENCE_POOL_MAX).map((r) => r.key),
    USDC: eligible
      .filter((r) => r.usdcFunded && r.wrappedSolAbsent)
      .slice(0, STOCK_REFERENCE_POOL_MAX)
      .map((r) => r.key),
  };
  if (!references.SOL.length || !references.USDC.length)
    throw Error(
      'Bounded discovery found no long-idle funded references for both assets.',
    );
  const fixture = {
    format: 'stock-public-reference-pool-v1',
    readOnly: true,
    references,
    referenceHashes: Object.fromEntries(
      Object.entries(references).map(([k, v]) => [
        k,
        v.map((key) => stockReferenceHash(key)),
      ]),
    ),
  };
  const path = join(folder, 'references.json');
  writeFileSync(path, JSON.stringify(fixture, null, 2) + '\n', { flag: 'wx' });
  evidence.fixture = path;
  evidence.referenceHashes = fixture.referenceHashes;
  evidence.passed = true;
} catch (error) {
  evidence.reason = signal.aborted
    ? 'Discovery aborted or rate limited; no retry.'
    : String(error.message).slice(0, 250);
} finally {
  stop.abort();
  const output = join(folder, 'discovery.json');
  writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log(
    JSON.stringify({
      output,
      fixture: evidence.fixture ?? null,
      passed: evidence.passed,
      reason: evidence.reason ?? null,
      requests: requests.length,
    }),
  );
}
