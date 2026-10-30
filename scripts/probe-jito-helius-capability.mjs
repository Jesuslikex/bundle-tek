import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Diagnostic only: no signature material, submission method or environment write.
async function main() {
  const simulatorBank = process.argv[3] === '--simulator-bank';
  if (
    process.versions.node.split('.')[0] !== '24' ||
    process.argv[2] !== '--live-readonly' ||
    (process.argv.length !== 3 && !(simulatorBank && process.argv.length === 4))
  )
    throw Error('Startup scope refused');
  const endpoint = process.env.SOLANA_MAINNET_RPC_URL;
  const url = new URL(endpoint);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'mainnet.helius-rpc.com' ||
    url.username ||
    url.password ||
    url.hash
  )
    throw Error('Endpoint scope refused');
  await mkdir('work', { recursive: true });
  const stamp = Date.now();
  const compiled = `work/helius-capability-deps-${stamp}.mjs`;
  const built = await build({
    stdin: {
      contents: `export { solanaTransferMessage } from './lib/solana-transfer-message'; export { readJitoSimulationPayload } from './lib/jito-simulation-json'; export { paceWalletRpc } from './lib/wallet-rpc-pacing';`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outfile: compiled,
    write: false,
    logLevel: 'silent',
  });
  await writeFile(compiled, built.outputFiles[0].contents);
  const { solanaTransferMessage, readJitoSimulationPayload, paceWalletRpc } =
    await import(pathToFileURL(`${process.cwd()}/${compiled}`).href);
  const signal = AbortSignal.timeout(45000),
    captures = [];
  const summary = {
    provider: 'Helius',
    mode: simulatorBank
      ? 'simulator-selected-then-exact'
      : 'ordinary-rpc-exact',
    node: process.versions.node,
    status: 'refused',
    stage: 'genesis',
    calls: 0,
    rateLimited: false,
    diagnosticOnly: true,
    bankVerified: false,
    feeBankVerified: false,
    fullSwapQualified: false,
    signingAllowed: false,
    executionAllowed: false,
  };
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  const fail = () => {
    throw Error('Capability refused');
  };
  const integer = (n) => {
    if (typeof n !== 'bigint' || n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER))
      fail();
    return Number(n);
  };
  async function rpc(method, params) {
    if (
      ![
        'getGenesisHash',
        'getLatestBlockhash',
        'simulateBundle',
        'getFeeForMessage',
        'getSlot',
      ].includes(method) ||
      ++summary.calls > (simulatorBank ? 7 : 6)
    )
      fail();
    await paceWalletRpc(endpoint, signal);
    const id = `helius-capability:${summary.calls}`;
    const request = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: request,
      signal,
      redirect: 'error',
      cache: 'no-store',
    });
    summary.lastHttpStatus = response.status;
    if (response.status === 429) {
      summary.rateLimited = true;
      await response.body?.cancel();
      fail();
    }
    const raw = await readJitoSimulationPayload(response.body, signal, 1048576);
    const body = Buffer.from(raw.rawBody).toString('utf8');
    captures.push({
      method,
      request,
      response: body,
      httpStatus: response.status,
      requestSha256: sha(request),
      responseSha256: sha(body),
    });
    const p = raw.value;
    if (!response.ok || p.jsonrpc !== '2.0' || p.id !== id) fail();
    if (Object.hasOwn(p, 'error')) {
      summary.rpcErrorCode =
        typeof p.error?.code === 'bigint' ? p.error.code.toString() : null;
      summary.rateLimited = p.error?.code === 429n;
      summary.refusal =
        p.error?.code === -32601n
          ? 'method-not-found'
          : p.error?.code === -32602n &&
              p.error?.message ===
                `bank not found for the provided slot: ${summary.requestedBankSlot ?? summary.floor}`
            ? 'bank-unavailable'
            : 'rpc-refusal';
      fail();
    }
    if (!Object.hasOwn(p, 'result') || Object.keys(p).length !== 3) fail();
    return p.result;
  }
  try {
    const genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
    if ((await rpc('getGenesisHash', [])) !== genesis) fail();
    summary.stage = 'blockhash';
    const latest = await rpc('getLatestBlockhash', [
      { commitment: 'confirmed' },
    ]);
    summary.floor = integer(latest.context.slot);
    integer(latest.value.lastValidBlockHeight);
    const payer = '2BrxKZyzZ64TgS38ghWHdZU4wSf2C9USuoB6nDkk9Kgo';
    const tip = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5';
    const addresses = [
      payer,
      tip,
      '11111111111111111111111111111111',
      'SysvarC1ock11111111111111111111111111111111',
      'SysvarRent111111111111111111111111111111111',
    ];
    const messages = [1000n, 1001n].map((amount) =>
      Buffer.from(
        solanaTransferMessage(payer, tip, latest.value.blockhash, amount),
      ),
    );
    const packets = messages.map((message) =>
      Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]).toString(
        'base64',
      ),
    );
    const bundleParams = (bank) => [
      { encodedTransactions: packets },
      {
        transactionEncoding: 'base64',
        simulationBank: bank,
        skipSigVerify: true,
        replaceRecentBlockhash: false,
        preExecutionAccountsConfigs: packets.map(() => ({
          addresses,
          encoding: 'base64',
        })),
        postExecutionAccountsConfigs: packets.map(() => ({
          addresses,
          encoding: 'base64',
        })),
      },
    ];
    summary.requestedBankSlot = summary.floor;
    if (simulatorBank) {
      // Separate capability experiment, never a fallback or qualification input.
      summary.stage = 'simulator-bank-discovery';
      const discovery = await rpc(
        'simulateBundle',
        bundleParams({ commitment: { commitment: 'confirmed' } }),
      );
      summary.discoveryContextFields = Object.keys(discovery.context ?? {});
      summary.discoverySlot = integer(discovery.context?.slot);
      summary.discoverySucceeded = discovery.value?.summary === 'succeeded';
      summary.discoveryFrames = Array.isArray(
        discovery.value?.transactionResults,
      )
        ? discovery.value.transactionResults.map((row) => ({
            preCount: row.preExecutionAccounts?.length ?? null,
            postCount: row.postExecutionAccounts?.length ?? null,
            error: row.err === null ? null : 'simulation-error',
          }))
        : null;
      if (
        summary.discoverySlot < summary.floor ||
        summary.discoverySlot - summary.floor > 32 ||
        !summary.discoverySucceeded ||
        summary.discoveryFrames?.length !== 2 ||
        summary.discoveryFrames.some(
          (row) =>
            row.error !== null ||
            row.preCount !== addresses.length ||
            row.postCount !== addresses.length,
        )
      )
        fail();
      summary.requestedBankSlot = summary.discoverySlot;
    }
    summary.stage = 'exact-bank-bundle';
    const result = await rpc(
      'simulateBundle',
      bundleParams({ slot: summary.requestedBankSlot }),
    );
    summary.contextFields = Object.keys(result.context ?? {});
    summary.simulationSlot = integer(result.context?.slot);
    if (summary.simulationSlot !== summary.requestedBankSlot) fail();
    const rows = result.value?.transactionResults;
    summary.bundleSucceeded = result.value?.summary === 'succeeded';
    if (!Array.isArray(rows) || rows.length !== 2) fail();
    summary.frames = rows.map((row) => ({
      preCount: row.preExecutionAccounts?.length ?? null,
      postCount: row.postExecutionAccounts?.length ?? null,
      feePresent: typeof row.fee === 'bigint',
      error: row.err === null ? null : 'simulation-error',
      fields: Object.keys(row),
    }));
    if (
      !summary.bundleSucceeded ||
      rows.some(
        (row) =>
          row.err !== null ||
          row.preExecutionAccounts?.length !== addresses.length ||
          row.postExecutionAccounts?.length !== addresses.length,
      )
    )
      fail();
    summary.stage = 'separate-fee-observation';
    const fee = await rpc('getFeeForMessage', [
      messages[0].toString('base64'),
      { commitment: 'confirmed', minContextSlot: summary.requestedBankSlot },
    ]);
    summary.feeSlot = integer(fee.context?.slot);
    summary.feeLamports = integer(fee.value);
    if (
      summary.feeSlot < summary.requestedBankSlot ||
      summary.feeSlot - summary.floor > 32
    )
      fail();
    summary.stage = 'final-slot';
    summary.finalSlot = integer(
      await rpc('getSlot', [
        { commitment: 'confirmed', minContextSlot: summary.requestedBankSlot },
      ]),
    );
    if (
      summary.finalSlot < summary.floor ||
      summary.finalSlot - summary.floor > 32
    )
      fail();
    summary.stage = 'final-genesis';
    if ((await rpc('getGenesisHash', [])) !== genesis) fail();
    summary.status = 'requested-native-vectors-observed-not-qualified';
  } catch {
    summary.refusal ??= 'shape-state-or-transport-refusal';
  }
  const receipt = `work/jito-helius-capability-${stamp}.json`;
  await writeFile(receipt, JSON.stringify({ summary, captures }, null, 2));
  console.log(JSON.stringify({ ...summary, receipt }, null, 2));
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
