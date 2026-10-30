import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

async function main() {
  if (
    process.versions.node.split('.')[0] !== '24' ||
    process.argv.length !== 3 ||
    process.argv[2] !== '--live-readonly'
  )
    throw Error('Scope refused');
  const endpoint = process.env.SOLANA_MAINNET_RPC_URL,
    url = new URL(endpoint);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'mainnet.helius-rpc.com' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  )
    throw Error('Endpoint refused');
  await mkdir('work', { recursive: true });
  const stamp = Date.now(),
    file = `work/jito-provider-observed-${stamp}.mjs`;
  const built = await build({
    stdin: {
      contents: `export {inspectPairRentAccount,pairRentMinimumRaw} from './lib/pair-rent-evidence';export {collectJitoProviderObservedAttempt} from './lib/jito-coherent-prefee-attempt';export {collectJitoRuntimeEvidence,verifyJitoRuntimeBracket} from './lib/jito-runtime-evidence';export {captureJitoCpmmLifetime,recheckJitoCpmmLifetime} from './lib/jito-cpmm-lifetime';export {solanaTransferMessage} from './lib/solana-transfer-message';export {paceWalletRpc} from './lib/wallet-rpc-pacing';export {readJitoSimulationPayload} from './lib/jito-simulation-json';`,
      resolveDir: process.cwd(),
    },
    platform: 'node',
    format: 'esm',
    packages: 'external',
    bundle: true,
    write: false,
    outfile: file,
    logLevel: 'silent',
  });
  await writeFile(file, built.outputFiles[0].contents);
  const api = await import(pathToFileURL(`${process.cwd()}/${file}`).href);
  const signal = AbortSignal.timeout(45000),
    captures = [],
    summary = {
      profile: 'provider-observed-native-runtime-v1',
      status: 'refused',
      stage: 'genesis',
      requests: 0,
      methods: 0,
      rateLimited: false,
      signingAllowed: false,
      executionAllowed: false,
      fullSwapQualified: false,
      bankIdentityVerified: false,
      feeBankIdentityVerified: false,
    };
  const hash = (b) => createHash('sha256').update(b).digest('hex');
  const fail = () => {
    throw Error('Evidence refused');
  };
  const strings = (v) =>
    typeof v === 'bigint'
      ? v.toString()
      : Array.isArray(v)
        ? v.map(strings)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v).map(([k, x]) => [k, strings(x)]),
            )
          : v;
  async function wire(body) {
    const rows = JSON.parse(body),
      list = Array.isArray(rows) ? rows : [rows];
    if (
      ++summary.requests > 48 ||
      (summary.methods += list.length) > 64 ||
      list.some(
        (r) =>
          ![
            'getGenesisHash',
            'getLatestBlockhash',
            'getMultipleAccounts',
            'getFeeForMessage',
            'getBlockHeight',
            'isBlockhashValid',
            'getSlot',
            'simulateBundle',
          ].includes(r.method),
      )
    )
      fail();
    for (const row of list) {
      void row;
      await api.paceWalletRpc(endpoint, signal);
    }
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal,
      redirect: 'error',
      cache: 'no-store',
    });
    if (response.status === 429) {
      summary.rateLimited = true;
      await response.body?.cancel();
      fail();
    }
    const raw = await api.readJitoSimulationPayload(
      response.body,
      signal,
      4194304,
      { allowDecimalTokens: true },
    );
    captures.push({
      request: body,
      responseBase64: Buffer.from(raw.rawBody).toString('base64'),
      requestSha256: hash(body),
      responseSha256: hash(raw.rawBody),
      httpStatus: response.status,
    });
    if (!response.ok) fail();
    const members = Array.isArray(raw.value) ? raw.value : [raw.value];
    if (members.some((x) => x.error?.code === 429n)) {
      summary.rateLimited = true;
      fail();
    }
    return {
      raw,
      response: new Response(raw.rawBody, { status: response.status }),
    };
  }
  async function rpc(method, params, readSignal = signal) {
    readSignal.throwIfAborted();
    const id = `runtime:${summary.requests + 1}`,
      { raw } = await wire(
        JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      );
    readSignal.throwIfAborted();
    if (
      raw.value.id !== id ||
      raw.value.jsonrpc !== '2.0' ||
      raw.value.error ||
      !Object.hasOwn(raw.value, 'result')
    )
      fail();
    return strings(raw.value.result);
  }
  let attempt = null,
    first = null,
    last = null;
  try {
    if (
      (await rpc('getGenesisHash', [])) !==
      '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
    )
      fail();
    const latest = await rpc('getLatestBlockhash', [
      { commitment: 'confirmed' },
    ]);
    const floor = Number(latest.context.slot);
    if (!Number.isSafeInteger(floor) || floor < 1) fail();
    summary.floor = floor;
    const payer = '2BrxKZyzZ64TgS38ghWHdZU4wSf2C9USuoB6nDkk9Kgo',
      tip = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
      keys = [payer, tip, '11111111111111111111111111111111'];
    const stateKeys = [
      payer,
      tip,
      'SysvarC1ock11111111111111111111111111111111',
      'SysvarRent111111111111111111111111111111111',
    ];
    async function state(at) {
      const r = await rpc('getMultipleAccounts', [
        stateKeys,
        { encoding: 'base64', commitment: 'confirmed', minContextSlot: at },
      ]);
      const slot = Number(r.context?.slot),
        clock = r.value?.[2];
      if (
        !Number.isSafeInteger(slot) ||
        slot < at ||
        slot - floor > 32 ||
        !Array.isArray(r.value) ||
        r.value.length !== 4 ||
        !clock ||
        clock.owner !== 'Sysvar1111111111111111111111111111111111111' ||
        clock.executable
      )
        fail();
      const b = Buffer.from(clock.data[0], 'base64');
      if (
        b.length !== 40 ||
        b.toString('base64') !== clock.data[0] ||
        b.readBigUInt64LE(0) !== BigInt(slot) ||
        Math.abs(Number(b.readBigInt64LE(32)) * 1000 - Date.now()) > 30000
      )
        fail();
      const rent = api.inspectPairRentAccount(r.value[3]);
      for (const a of r.value.slice(0, 2))
        if (
          !a ||
          BigInt(a.lamports) <
            BigInt(
              api.pairRentMinimumRaw(
                rent,
                Buffer.from(a.data[0], 'base64').length,
              ),
            )
        )
          fail();
      return { slot, value: r.value };
    }
    summary.stage = 'custody-before';
    const beforeState = await state(floor);
    summary.stage = 'first-code-scan';
    first = await api.collectJitoRuntimeEvidence(
      keys,
      floor,
      floor,
      signal,
      rpc,
    );
    summary.stage = 'lifetime-before';
    const lifetime = await api.captureJitoCpmmLifetime(floor, rpc, signal);
    if (lifetime.slot < first.maximumSlot) fail();
    const packets = [1000n, 1001n].map((amount) => ({
      transaction: Buffer.concat([
        Buffer.from([1]),
        Buffer.alloc(64),
        Buffer.from(
          api.solanaTransferMessage(payer, tip, lifetime.blockhash, amount),
        ),
      ]).toString('base64'),
      loadedAddresses: null,
      maximumFeeLamports: '20000',
      expectedFeeLamports: '1',
    }));
    summary.stage = 'provider-observed-bundle';
    attempt = await api.collectJitoProviderObservedAttempt({
      packets,
      minimumSlot: floor,
      minimumReadSlot: first.maximumSlot,
      feeIdPrefix: 'native-fees',
      simulationRpcId: 'native-sim',
      verifySignatures: false,
      signal,
      transport: async ({ body }) => (await wire(body)).response,
    });
    summary.attemptStatus = attempt.status;
    if (attempt.status !== 'captured') {
      summary.attemptReason = attempt.reason;
      summary.rawReason = attempt.simulation?.reason;
      fail();
    }
    const bank = attempt.simulation.frames.slot,
      feeSlots = attempt.fees.fees.map((f) => f.slot),
      afterFloor = Math.max(bank, ...feeSlots, first.maximumSlot);
    summary.simulationSlot = bank;
    summary.feeSlots = feeSlots;
    summary.stage = 'second-code-scan';
    last = await api.collectJitoRuntimeEvidence(
      keys,
      floor,
      afterFloor,
      signal,
      rpc,
    );
    summary.stage = 'runtime-replay';
    const proof = await api.verifyJitoRuntimeBracket(
      first,
      last,
      attempt.simulation.frames,
      signal,
    );
    summary.runtimeProof = proof;
    summary.stage = 'custody-after';
    const afterState = await state(last.maximumSlot);
    if (
      JSON.stringify(beforeState.value.slice(0, 2)) !==
        JSON.stringify(afterState.value.slice(0, 2)) ||
      JSON.stringify(beforeState.value[3]) !==
        JSON.stringify(afterState.value[3])
    )
      fail();
    summary.custodyClockRent = {
      beforeSlot: beforeState.slot,
      afterSlot: afterState.slot,
      unchangedCustody: true,
      unchangedRent: true,
      clockExact: true,
    };
    summary.stage = 'lifetime-after';
    const validity = await rpc('isBlockhashValid', [
      lifetime.blockhash,
      { commitment: 'confirmed', minContextSlot: last.maximumSlot },
    ]);
    const validitySlot = Number(validity.context?.slot);
    if (
      validity.value !== true ||
      !Number.isSafeInteger(validitySlot) ||
      validitySlot < last.maximumSlot ||
      validitySlot - floor > 32
    )
      fail();
    const height = await rpc('getBlockHeight', [
      { commitment: 'confirmed', minContextSlot: validitySlot },
    ]);
    if (
      typeof height !== 'string' ||
      !/^\d+$/.test(height) ||
      BigInt(lifetime.lastValidBlockHeight) - BigInt(height) < 10n
    )
      fail();
    summary.lifetime = {
      validitySlot,
      height,
      lastValidBlockHeight: lifetime.lastValidBlockHeight,
    };
    summary.maximumSlot = Number(
      await rpc('getSlot', [
        { commitment: 'confirmed', minContextSlot: validitySlot },
      ]),
    );
    if (
      !Number.isSafeInteger(summary.maximumSlot) ||
      summary.maximumSlot < last.maximumSlot ||
      summary.maximumSlot - floor > 32
    )
      fail();
    if (
      (await rpc('getGenesisHash', [])) !==
      '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
    )
      fail();
    summary.status = 'native-runtime-checks-passed-not-full-swap';
  } catch {
    summary.refusal = 'guard-or-transport-refusal';
  }
  const receipt = `work/jito-provider-observed-${stamp}.json`;
  await writeFile(
    receipt,
    JSON.stringify(
      { summary, attempt, first, last, captures },
      (_, v) => (typeof v === 'bigint' ? v.toString() : v),
      2,
    ),
  );
  console.log(JSON.stringify({ summary, receipt }, null, 2));
}
main().catch(() => {
  console.log(
    JSON.stringify({
      status: 'startup-refused',
      signingAllowed: false,
      executionAllowed: false,
    }),
  );
  process.exitCode = 1;
});
