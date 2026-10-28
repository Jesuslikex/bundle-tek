import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  runNativeJitoCampaign,
  validateEndpoint,
  REFERENCES,
  GENESIS,
  main,
  compileNativeAdapter,
  nativeSourceIdentity,
} from './qualify-jito-native-readonly.mjs';

const endpoint = 'https://solana-mainnet.g.alchemy.com/v2/PRIVATE-TEST-ONLY';
const digest = (v) => createHash('sha256').update(v).digest('hex');
const flags = {
  signingAllowed: false,
  executionAllowed: false,
  automaticExecutionAllowed: false,
  providerQualified: false,
  economicOutputVerified: false,
  runtimePrivilegesVerified: false,
};
const capture = (value) => {
  const rawBody = Buffer.from(JSON.stringify(value));
  return {
    rawBody,
    rawSha256: digest(rawBody),
    byteLength: rawBody.length,
    value,
  };
};
function harness(options = {}) {
  const files = new Map(),
    requests = [];
  const pacing = [];
  let runtime = 0,
    genesis = 0;
  const adapter = {
    async readJitoSimulationPayload(body) {
      const rawBody = new Uint8Array(await new Response(body).arrayBuffer());
      return {
        rawBody,
        byteLength: rawBody.length,
        rawSha256: digest(rawBody),
        value: JSON.parse(Buffer.from(rawBody).toString(), (key, value) =>
          ['slot', 'lamports'].includes(key) && typeof value === 'number'
            ? BigInt(value)
            : value,
        ),
      };
    },
    async collectJitoCoherentSimulationAttempt(input) {
      runtime++;
      assert.equal(input.verifySignatures, false);
      assert.equal(input.minimumSlot, 100);
      assert.equal(input.minimumReadSlot, 101);
      assert.equal(input.packets.length, 2);
      assert.notEqual(
        input.packets[0].transaction,
        input.packets[1].transaction,
      );
      if (options.collect) return options.collect(input, runtime);
      const simulation = {
        jsonrpc: '2.0',
        id: input.simulationRpcId,
        method: 'simulateBundle',
        params: [
          { encodedTransactions: input.packets.map((p) => p.transaction) },
          { skipSigVerify: true, replaceRecentBlockhash: false },
        ],
      };
      const discoveryBody = JSON.stringify(simulation);
      const d = await input.transport({
        phase: 'discovery',
        methodCount: 1,
        body: discoveryBody,
        signal: input.signal,
      });
      await d.body.cancel();
      const batchBody = JSON.stringify([
        { jsonrpc: '2.0', id: 'fee:0', method: 'getFeeForMessage', params: [] },
        { jsonrpc: '2.0', id: 'fee:1', method: 'getFeeForMessage', params: [] },
        simulation,
      ]);
      const b = await input.transport({
        phase: 'batch',
        methodCount: 3,
        body: batchBody,
        signal: input.signal,
      });
      await b.body.cancel();
      const members = [
        { id: 'fee:0', result: 5000 },
        { id: 'fee:1', result: 5000 },
        { id: input.simulationRpcId, result: 'native' },
      ];
      const parent = capture(members);
      let start = 1;
      const ranges = members.map((m) => {
        const rawBody = Buffer.from(JSON.stringify(m));
        const item = {
          id: m.id,
          start,
          end: start + rawBody.length,
          sha256: digest(rawBody),
          rawBody,
        };
        start += rawBody.length + 1;
        return item;
      });
      return {
        status: options.refuse || options.batchRefused ? 'refused' : 'captured',
        reason: 'fees-refused',
        fees: {
          simulationBankSlot: options.bank ?? 102,
          fees: [
            { slot: options.feeSlots?.[0] ?? 102, feeLamports: '5000' },
            { slot: options.feeSlots?.[1] ?? 102, feeLamports: '5000' },
          ],
        },
        simulation: { frames: { slot: options.bank ?? 102, frames: [{}, {}] } },
        discovery: capture({ result: 'hint' }),
        batch: options.batchRefused
          ? { status: 'refused', rawResponse: parent }
          : { status: 'captured', rawResponse: parent, members: ranges },
        sentSimulationBody: discoveryBody,
        ...flags,
      };
    },
  };
  const fetcher = async (url, init) => {
    assert.equal(url, endpoint);
    requests.push(JSON.parse(init.body));
    if (options.fetcher) return options.fetcher(url, init, requests.length);
    if (options.rateAt === requests.length)
      return new Response('secret provider error ' + endpoint, { status: 429 });
    const req = JSON.parse(init.body);
    const result =
      req.method === 'getGenesisHash'
        ? ++genesis === 2 && options.wrongFinal
          ? 'wrong'
          : GENESIS
        : req.method === 'getLatestBlockhash'
          ? {
              context: { slot: 100 },
              value: { blockhash: '11111111111111111111111111111111' },
            }
          : req.method === 'getMultipleAccounts'
            ? {
                context: { slot: 101 },
                value: REFERENCES.map((_, i) => ({
                  owner: '11111111111111111111111111111111',
                  executable: false,
                  data: ['', 'base64'],
                  lamports:
                    options.changePayer && runtime > 0 && i === 0 ? 0 : 2000000,
                })),
              }
            : 'opaque';
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }));
  };
  const run = (extra = {}) =>
    runNativeJitoCampaign({
      endpoint,
      adapter,
      fetcher,
      pace: (...args) => {
        assert.equal(args.length, 2);
        assert.equal(args[0], endpoint);
        assert.ok(args[1] instanceof AbortSignal);
        pacing.push(args);
        return options.pace ? options.pace(...args) : Promise.resolve();
      },
      persist: (name, bytes) => files.set(name, Buffer.from(bytes)),
      ...extra,
    });
  return { run, files, requests, pacing };
}

void test('campaign refuses mixed fee banks including a member beyond the original 32-slot span', async () => {
  const h = harness({ bank: 132, feeSlots: [132, 133] });
  const result = await h.run();
  assert.equal(result.nativeCapturedCount, 0);
  assert.equal(result.providerQualified, false);
  assert.equal(result.attempts.length, 3);
  for (const attempt of result.attempts)
    assert.match(attempt.reason, /^bank-or-fee-refused/);
});
void test('campaign retains a complete original-floor plus 32 sample when every bank matches', async () => {
  const h = harness({ bank: 132, feeSlots: [132, 132] });
  const result = await h.run();
  assert.equal(result.nativeCapturedCount, 3);
  assert.equal(result.providerQualified, true);
  assert.equal(result.executionAllowed, false);
});

void test('three fixed native attempts retain wire parents, member ranges and final genesis without authority', async () => {
  const h = harness();
  const result = await h.run();
  assert.equal(result.attempts.length, 3);
  assert.equal(result.nativeCapturedCount, 3);
  assert.equal(h.requests.length, 18);
  assert.equal(h.pacing.length, 24);
  for (const a of result.attempts) {
    assert.equal(a.httpRequests, 6);
    assert.equal(a.logicalMethods, 8);
    assert.equal(a.bank, 102);
    for (const key of Object.keys(flags)) assert.equal(a[key], false);
  }
  const manifest = JSON.parse(h.files.get('attempt-1/batch-members.json'));
  const parent = h.files.get('attempt-1/4.response.bin');
  assert.equal(digest(parent), manifest.parentSha256);
  for (const m of manifest.members)
    assert.equal(digest(parent.subarray(m.start, m.end)), m.sha256);
  assert.equal(
    JSON.parse(h.files.get('campaign.json')).completedPlannedAttempts,
    true,
  );
});
void test('semantic refusals keep every fixed attempt, without looping for a pass', async () => {
  const h = harness({ refuse: true });
  const r = await h.run();
  assert.equal(r.attempts.length, 3);
  assert.equal(r.nativeCapturedCount, 0);
  assert.deepEqual(
    r.attempts.map((a) => a.reason),
    ['fees-refused', 'fees-refused', 'fees-refused'],
  );
  assert.equal(h.requests.length, 15);
});
void test('first HTTP 429 stops and retains preceding attempts, no URL or error body in summaries', async () => {
  const h = harness({ rateAt: 10 });
  const r = await h.run();
  assert.equal(r.attempts.length, 2);
  assert.equal(r.attempts[0].nativeCaptured, true);
  assert.equal(r.attempts[1].reason, 'rate-limited');
  assert.equal(h.requests.length, 10);
  for (const [name, bytes] of h.files)
    if (name.endsWith('outcome.json') || name === 'campaign.json') {
      assert.ok(!bytes.includes('PRIVATE-TEST'));
      assert.ok(!bytes.includes('https:'));
    }
});
void test('setup transport errors are sanitized and terminal', async () => {
  const h = harness({
    fetcher: () => {
      throw Error(endpoint);
    },
  });
  const r = await h.run();
  assert.equal(r.attempts.length, 1);
  assert.equal(r.attempts[0].reason, 'setup-or-transport-failed');
  assert.ok(!h.files.get('campaign.json').includes('PRIVATE-TEST'));
});
void test('a pinned public payer becoming unavailable is terminal, without selecting another payer', async () => {
  const h = harness({ changePayer: true });
  const r = await h.run();
  assert.equal(r.attempts.length, 2);
  assert.equal(r.attempts[1].reason, 'reference-refused');
});
void test('pre-cancelled campaigns issue no requests and retain a cancellation outcome', async () => {
  const h = harness();
  const r = await h.run({ signal: AbortSignal.abort() });
  assert.equal(h.requests.length, 0);
  assert.equal(r.attempts.length, 1);
  assert.equal(r.attempts[0].reason, 'interrupted');
});
void test('cancellation owns a late fetch response and cancels its body', async () => {
  const abort = new AbortController();
  let release,
    cancelled = false;
  const h = harness({
    fetcher: () =>
      new Promise((r) => {
        release = r;
      }),
  });
  const run = h.run({ signal: abort.signal });
  await new Promise(setImmediate);
  abort.abort();
  await run;
  release(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  await new Promise(setImmediate);
  assert.equal(cancelled, true);
});
void test('extra requests exhaust the fixed HTTP budget rather than extending the campaign', async () => {
  const h = harness({
    collect: async (input) => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 'x',
        method: 'simulateBundle',
        params: [
          { encodedTransactions: input.packets.map((p) => p.transaction) },
          { skipSigVerify: true, replaceRecentBlockhash: false },
        ],
      });
      for (let i = 0; i < 4; i++) {
        const r = await input.transport({
          phase: 'discovery',
          methodCount: 1,
          body,
          signal: input.signal,
        });
        await r.body.cancel();
      }
    },
  });
  const r = await h.run();
  assert.equal(r.attempts.length, 1);
  assert.equal(r.attempts[0].reason, 'budget-exhausted');
  assert.equal(h.requests.length, 6);
});
void test('a changed final genesis cannot become a native pass', async () => {
  const h = harness({ wrongFinal: true });
  const r = await h.run();
  assert.equal(r.attempts[0].nativeCaptured, false);
  assert.equal(r.attempts[0].reason, 'network-refused');
});
void test('HTTP endpoint, unexpected host and URL userinfo are refused before any fetch', () => {
  for (const url of [
    'http://solana-mainnet.g.alchemy.com/key',
    'https://elsewhere.invalid/key',
    'https://name:secret@solana-mainnet.g.alchemy.com/key',
  ])
    assert.throws(() => validateEndpoint(url), /configuration-refused/);
});
void test('CLI refuses missing explicit live flag and output path without reading settings', async () => {
  await assert.rejects(main([]), /arguments-refused/);
  await assert.rejects(
    main(['--live-readonly', '--output-dir=.']),
    /output-refused/,
  );
});
void test('attempt deadline cannot be relaxed through injected options', async () => {
  const h = harness();
  await assert.rejects(
    h.run({ attemptTimeoutMs: 90000 }),
    /configuration-refused/,
  );
  assert.equal(h.requests.length, 0);
});

void test('refused batch retains its whole parent without inventing member ranges or masking the refusal', async () => {
  const h = harness({ batchRefused: true });
  const r = await h.run();
  assert.equal(r.attempts.length, 3);
  assert.equal(r.attempts[0].reason, 'fees-refused');
  const parent = h.files.get('attempt-1/4.response.bin');
  const manifest = JSON.parse(h.files.get('attempt-1/batch-members.json'));
  assert.equal(digest(parent), manifest.parentSha256);
  assert.deepEqual(manifest.members, []);
});

void test('provider-thrown safeReason fields cannot inject secrets into summaries', async () => {
  const h = harness({
    fetcher: () => {
      throw { safeReason: endpoint };
    },
  });
  const r = await h.run();
  assert.equal(r.attempts[0].reason, 'setup-or-transport-failed');
  assert.ok(!h.files.get('campaign.json').includes('PRIVATE-TEST'));
});

void test('real production adapter build records the explicit virtual entry and imports without environment or provider access', async () => {
  const base = resolve('work/release-qa');
  mkdirSync(base, { recursive: true });
  const folder = mkdtempSync(resolve(base, 'native-adapter-offline-test-'));
  const records = new Map();
  const { adapter, identity } = await compileNativeAdapter({
    folder,
    persist: (name, bytes) => records.set(name, bytes),
  });
  assert.equal(typeof adapter.collectJitoCoherentSimulationAttempt, 'function');
  assert.equal(typeof adapter.readJitoSimulationPayload, 'function');
  assert.equal(typeof adapter.paceWalletRpc, 'function');
  assert.equal(
    identity.artifactSha256,
    digest(readFileSync(resolve(folder, 'production-adapter.mjs'))),
  );
  assert.equal(
    identity.inputs.filter((input) => input.kind === 'explicit-virtual-entry')
      .length,
    1,
  );
  assert.ok(
    identity.inputs.some(
      (input) => input.path === 'lib/jito-coherent-simulation-attempt.ts',
    ),
  );
  assert.deepEqual(JSON.parse(records.get('source-identity.json')), identity);
  for (const input of identity.inputs.filter(
    (item) => item.kind === 'source-file',
  )) {
    const snapshot = records.get(`source-snapshot/${input.path}`);
    assert.ok(snapshot instanceof Uint8Array);
    assert.equal(digest(snapshot), input.sha256);
  }
});

void test('unknown virtual entries, a missing explicit entry and changed entry bytes are refused', () => {
  assert.throws(
    () => nativeSourceIdentity({ '<stdin>': { bytes: 1 } }, process.cwd()),
    /source-identity-refused/,
  );
  assert.throws(
    () =>
      nativeSourceIdentity(
        { 'not-a-real-virtual-entry.ts': { bytes: 1 } },
        process.cwd(),
      ),
    /source-identity-refused/,
  );
  assert.throws(
    () =>
      nativeSourceIdentity(
        { 'native-qualification-entry.ts': { bytes: 1 } },
        process.cwd(),
      ),
    /source-identity-refused/,
  );
});

void test('source identity binds compiled snapshot bytes and refuses same-size post-build edits without editing the checkout', () => {
  const entry =
    "export {collectJitoCoherentSimulationAttempt} from './lib/jito-coherent-simulation-attempt';export {readJitoSimulationPayload} from './lib/jito-simulation-json';export {paceWalletRpc} from './lib/wallet-rpc-pacing';";
  const path = 'lib/jito-coherent-simulation-attempt.ts';
  const absolute = resolve(path);
  const bytes = Uint8Array.from(readFileSync(absolute));
  const frozen = new Map([[absolute, { bytes, sha256: digest(bytes) }]]);
  const inputs = {
    'native-qualification-entry.ts': { bytes: Buffer.byteLength(entry) },
    [path]: { bytes: bytes.byteLength },
  };
  const identity = nativeSourceIdentity(
    inputs,
    process.cwd(),
    frozen,
    () => bytes,
  );
  assert.equal(
    identity.find((source) => source.path === path).sha256,
    digest(bytes),
  );
  const changed = Uint8Array.from(bytes);
  changed[0] ^= 1;
  assert.throws(
    () => nativeSourceIdentity(inputs, process.cwd(), frozen, () => changed),
    /source-identity-refused/,
  );
  const corruptSnapshot = new Map([
    [absolute, { bytes: changed, sha256: digest(bytes) }],
  ]);
  assert.throws(
    () =>
      nativeSourceIdentity(inputs, process.cwd(), corruptSnapshot, () => bytes),
    /source-identity-refused/,
  );
  assert.throws(
    () => nativeSourceIdentity(inputs, process.cwd(), new Map(), () => bytes),
    /source-identity-refused/,
  );
  const unused = new Map(frozen);
  unused.set(resolve('lib/unexpected.ts'), { bytes, sha256: digest(bytes) });
  assert.throws(
    () => nativeSourceIdentity(inputs, process.cwd(), unused, () => bytes),
    /source-identity-refused/,
  );
});

void test('cancelled pacing never issues the pending or subsequent fetch', async () => {
  const abort = new AbortController();
  const h = harness({
    pace: async (_endpoint, signal) => {
      assert.equal(signal.aborted, false);
      abort.abort();
      await new Promise(setImmediate);
    },
  });
  const result = await h.run({ signal: abort.signal });
  assert.equal(h.pacing.length, 1);
  assert.equal(h.requests.length, 0);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].reason, 'interrupted');
});

void test('an absent pacing implementation fails before network use', async () => {
  const h = harness();
  await assert.rejects(h.run({ pace: undefined }), /configuration-refused/);
  assert.equal(h.requests.length, 0);
});
