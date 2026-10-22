import test from 'node:test';
import assert from 'node:assert/strict';
import {
  requireWarmupAssetProbeArgs,
  requireWarmupAssetProbeRuntime,
  warmupAssetProbeConfiguration,
  createWarmupAssetProbeFetch,
  WARMUP_ASSET_PROBE_ACCOUNTS,
} from './warmup-asset-probe-policy.mjs';
const endpoint =
  'https://rpc.example.invalid/private-key?api-key=fixture-secret';
const init = (method, params = []) => ({
  method: 'POST',
  redirect: 'manual',
  cache: 'no-store',
  signal: new AbortController().signal,
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
});
const multi = () =>
  init('getMultipleAccounts', [
    WARMUP_ASSET_PROBE_ACCOUNTS,
    { encoding: 'base64', commitment: 'confirmed', minContextSlot: 100 },
  ]);
test('requires the production runtime and one explicit read-only mode', () => {
  assert.equal(requireWarmupAssetProbeRuntime('24.19.0').requiredNodeMajor, 24);
  for (const version of ['22.0.0', '26.4.0', '24', null, 24])
    assert.throws(() => requireWarmupAssetProbeRuntime(version));
  requireWarmupAssetProbeArgs(['--live-readonly']);
  for (const args of [
    [],
    ['--send'],
    ['--live-readonly', '--retry'],
    ['--live-readonly', '--live-readonly'],
  ])
    assert.throws(() => requireWarmupAssetProbeArgs(args));
});
test('selects only existing HTTPS config, without public fallback or unsafe credentials', () => {
  assert.equal(
    warmupAssetProbeConfiguration({ SOLANA_MAINNET_RPC_URL: endpoint }).setting,
    'SOLANA_MAINNET_RPC_URL',
  );
  assert.equal(
    warmupAssetProbeConfiguration({
      SOLANA_INDEXER_RPC_URL: endpoint,
      SOLANA_MAINNET_RPC_URL: 'https://other.invalid/',
    }).endpoint,
    endpoint,
  );
  for (const value of [
    undefined,
    'http://rpc.invalid/',
    'https://user:pass@rpc.invalid/',
    'https://rpc.invalid/#x',
    '${RPC_URL}',
  ])
    assert.throws(() =>
      warmupAssetProbeConfiguration({ SOLANA_INDEXER_RPC_URL: value }),
    );
});
test('admits only four ordered public reads and preserves response bytes exactly', async () => {
  let calls = 0;
  const raw =
    '{"jsonrpc":"2.0","id":1,"result":{"rentEpoch":18446744073709551615}}';
  const p = createWarmupAssetProbeFetch(endpoint, async () => {
    calls++;
    return new Response(raw);
  });
  for (const options of [
    init('getGenesisHash'),
    init('getSlot', [{ commitment: 'confirmed' }]),
    multi(),
    multi(),
  ])
    assert.equal(await (await p.fetch(endpoint, options)).text(), raw);
  await assert.rejects(p.fetch(endpoint, multi()));
  assert.equal(calls, 4);
  assert.equal(p.trace.length, 4);
  assert.doesNotMatch(
    JSON.stringify(p.trace),
    /private-key|fixture-secret|api-key/,
  );
});
test('blocks sends, other endpoints, redirects, wallet requests and added parameters before fetch', async () => {
  let calls = 0;
  const make = () =>
    createWarmupAssetProbeFetch(endpoint, async () => {
      calls++;
      return Response.json({ jsonrpc: '2.0', id: 1, result: 100 });
    });
  await assert.rejects(
    make().fetch(endpoint, init('sendTransaction', ['PRIVATE'])),
  );
  await assert.rejects(
    make().fetch('https://other.invalid/', init('getGenesisHash')),
  );
  await assert.rejects(
    make().fetch(endpoint, { ...init('getGenesisHash'), redirect: 'follow' }),
  );
  const p = make();
  await p.fetch(endpoint, init('getGenesisHash'));
  await p.fetch(endpoint, init('getSlot', [{ commitment: 'confirmed' }]));
  const wrong = multi();
  const body = JSON.parse(wrong.body);
  body.params[0][1] = '11111111111111111111111111111111';
  wrong.body = JSON.stringify(body);
  await assert.rejects(p.fetch(endpoint, wrong));
  const extra = multi();
  const value = JSON.parse(extra.body);
  value.params[1].dataSlice = { offset: 0, length: 0 };
  extra.body = JSON.stringify(value);
  await assert.rejects(p.fetch(endpoint, extra));
  assert.equal(calls, 2);
});

test('stops after invalid requests, empty bodies or JSON-RPC errors without a later read', async () => {
  for (const response of [
    () =>
      Response.json({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32000, message: 'PRIVATE' },
      }),
    () => new Response(null),
    () => new Response('invalid'),
  ]) {
    let calls = 0;
    const p = createWarmupAssetProbeFetch(endpoint, async () => {
      calls++;
      return response();
    });
    await assert.rejects(p.fetch(endpoint, init('getGenesisHash')));
    await assert.rejects(
      p.fetch(endpoint, init('getSlot', [{ commitment: 'confirmed' }])),
    );
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(p.trace), /PRIVATE/);
  }
  let calls = 0;
  const p = createWarmupAssetProbeFetch(endpoint, async () => {
    calls++;
    return Response.json({});
  });
  await assert.rejects(p.fetch(endpoint, init('sendTransaction')));
  await assert.rejects(p.fetch(endpoint, init('getGenesisHash')));
  assert.equal(calls, 0);
});
test('stops after the first failed HTTP read with no retry or response-body logging', async () => {
  for (const status of [307, 429, 503]) {
    let calls = 0;
    const p = createWarmupAssetProbeFetch(endpoint, async () => {
      calls++;
      return new Response('PRIVATE RESPONSE', { status });
    });
    assert.equal(
      (await p.fetch(endpoint, init('getGenesisHash'))).status,
      status,
    );
    await assert.rejects(
      p.fetch(endpoint, init('getSlot', [{ commitment: 'confirmed' }])),
    );
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(p.trace), /PRIVATE/);
  }
});
test('bounds response buffering and cancels before starting an already aborted read', async () => {
  let calls = 0;
  const p = createWarmupAssetProbeFetch(endpoint, async () => {
    calls++;
    return new Response(' '.repeat(524289));
  });
  await assert.rejects(p.fetch(endpoint, init('getGenesisHash')));
  assert.equal(calls, 1);
  const c = new AbortController();
  c.abort();
  await assert.rejects(
    createWarmupAssetProbeFetch(endpoint, async () => {
      calls++;
      return Response.json({});
    }).fetch(endpoint, { ...init('getGenesisHash'), signal: c.signal }),
  );
  assert.equal(calls, 1);
});
