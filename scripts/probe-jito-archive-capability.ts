import { mkdir, writeFile } from 'node:fs/promises';
import bs58 from 'bs58';
import { getSolanaHolderRpcEndpoint } from '../lib/solana-rpc';
import { paceWalletRpc } from '../lib/wallet-rpc-pacing';
import { readJitoSimulationPayload } from '../lib/jito-simulation-json';
import { solanaTransferMessage } from '../lib/solana-transfer-message';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';
const PAYER = '2k5hrzuykwyTbUe8L7UriYAQhr5hijNLgBvEB4B9pP5y',
  RECIPIENT = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  SYSTEM = '11111111111111111111111111111111';
const fail = (): never => {
  throw Error('Archive capability refused.');
};
function integer(v: unknown) {
  if (typeof v !== 'bigint' || v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER))
    return fail();
  return Number(v);
}
async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--live-readonly')
    return fail();
  const endpoint = getSolanaHolderRpcEndpoint(),
    signal = AbortSignal.timeout(45000),
    captures: {
      method: string;
      request: string;
      response: string;
      httpStatus: number;
    }[] = [];
  const url = new URL(endpoint);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'solana-mainnet.g.alchemy.com' ||
    url.username ||
    url.password ||
    url.hash
  )
    return fail();
  let calls = 0,
    bytes = 0,
    stage = 'genesis',
    status = 'refused',
    floor: number | null = null,
    lastSlot: number | null = null,
    rateLimited = false,
    rpcErrorCode: string | null = null;
  const observations: Record<string, unknown> = {};
  async function rpc(method: string, params: unknown[]) {
    if (
      ![
        'getGenesisHash',
        'getLatestBlockhash',
        'simulateTransactionsAtSlot',
        'getSlot',
      ].includes(method) ||
      ++calls > 4
    )
      return fail();
    await paceWalletRpc(endpoint, signal);
    const id = 'archive-capability:' + calls,
      request = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: request,
      signal,
      redirect: 'error',
      cache: 'no-store',
    });
    if (!r.ok) {
      rateLimited = r.status === 429;
      void r.body?.cancel();
      return fail();
    }
    const raw = await readJitoSimulationPayload(r.body, signal, 1048576);
    bytes += raw.byteLength;
    if (bytes > 2097152) return fail();
    captures.push({
      method,
      request,
      response: Buffer.from(raw.rawBody).toString('utf8'),
      httpStatus: r.status,
    });
    const p = raw.value as {
      jsonrpc?: unknown;
      id?: unknown;
      error?: { code?: unknown };
      result?: unknown;
    };
    if (p.jsonrpc !== '2.0' || p.id !== id) return fail();
    if (Object.hasOwn(p, 'error')) {
      rateLimited = p.error?.code === 429n;
      rpcErrorCode =
        typeof p.error?.code === 'bigint' ? p.error.code.toString() : null;
      return fail();
    }
    if (!Object.hasOwn(p, 'result') || Object.keys(p).length !== 3)
      return fail();
    return p.result;
  }
  try {
    if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
      return fail();
    stage = 'captured-blockhash';
    const latest = (await rpc('getLatestBlockhash', [
      { commitment: 'confirmed' },
    ])) as {
      context: { slot: unknown };
      value: { blockhash: unknown; lastValidBlockHeight: unknown };
    };
    floor = integer(latest.context.slot);
    if (floor < 1 || typeof latest.value.blockhash !== 'string') return fail();
    const hash = bs58.decode(latest.value.blockhash);
    if (hash.length !== 32 || bs58.encode(hash) !== latest.value.blockhash)
      return fail();
    integer(latest.value.lastValidBlockHeight);
    const transactions = [1000n, 1001n].map((amount) =>
      Buffer.concat([
        Buffer.from([1]),
        Buffer.alloc(64),
        Buffer.from(
          solanaTransferMessage(
            PAYER,
            RECIPIENT,
            latest.value.blockhash as string,
            amount,
          ),
        ),
      ]).toString('base64'),
    );
    stage = 'single-current-slot-archive-probe';
    // Native-only diagnostics, no caller balance/Clock/account overrides and no
    // replacement hash. Not a full swap or a Jito block-engine send.
    const result = (await rpc('simulateTransactionsAtSlot', [
      {
        simulations: transactions.map((encodedTransaction) => ({
          slot: floor,
          encodedTransaction,
        })),
        postExecutionAccountsConfigs: {
          accounts: [
            PAYER,
            RECIPIENT,
            SYSTEM,
            'SysvarC1ock11111111111111111111111111111111',
            'SysvarRent111111111111111111111111111111111',
          ],
          encoding: 'base64',
        },
        innerInstructions: false,
        sigVerify: false,
        replaceRecentBlockhash: false,
      },
    ])) as {
      context?: Record<string, unknown>;
      value?: { simulationResults?: Record<string, unknown>[] };
    };
    observations.contextFields = result.context
      ? Object.keys(result.context)
      : [];
    if (
      !result.context ||
      integer(result.context.slot) !== floor ||
      !Array.isArray(result.value?.simulationResults) ||
      result.value.simulationResults.length !== 2
    )
      return fail();
    observations.results = result.value.simulationResults.map((r) => ({
      slot: integer(r.slot),
      status: typeof r.status === 'string' ? r.status : 'unknown',
      feeLamports:
        typeof r.feeLamports === 'bigint' ? r.feeLamports.toString() : null,
      hashReplacementPresent:
        r.replacementBlockhash !== null && r.replacementBlockhash !== undefined,
      postAccountCount: Array.isArray(r.postExecutionAccounts)
        ? r.postExecutionAccounts.length
        : null,
    }));
    if (
      result.value.simulationResults.some(
        (r) =>
          integer(r.slot) !== floor ||
          r.status !== 'success' ||
          r.err !== null ||
          (r.replacementBlockhash !== null &&
            r.replacementBlockhash !== undefined),
      )
    )
      return fail();
    stage = 'final-window';
    lastSlot = integer(
      await rpc('getSlot', [
        { commitment: 'confirmed', minContextSlot: floor },
      ]),
    );
    if (lastSlot < floor || lastSlot - floor > 32) return fail();
    status = 'native-archive-diagnostic-observed';
  } catch {
    process.exitCode = 1;
  }
  const receipt = {
    format: 'jito-current-archive-capability-v1',
    observedAt: new Date().toISOString(),
    status,
    stage,
    floor,
    lastSlot,
    calls,
    responseBytes: bytes,
    rateLimited,
    rpcErrorCode,
    observations,
    transactionsBroadcast: 0,
    simulatedTransactionsRequested:
      stage === 'genesis' || stage === 'captured-blockhash' ? 0 : 2,
    overridesUsed: false,
    replaceRecentBlockhash: false,
    ownedWallet: false,
    liveJitoValidatorVerified: false,
    bankIdentityVerified: false,
    independentFeeBankVerified: false,
    fullSwapQualified: false,
    providerQualified: false,
    signingAllowed: false,
    executionAllowed: false,
  };
  await mkdir('work', { recursive: true });
  const path = `work/jito-archive-capability-${Date.now()}.json`;
  await writeFile(path, JSON.stringify({ receipt, captures }, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log(JSON.stringify({ ...receipt, savedCapture: path }, null, 2));
}
main().catch(() => {
  console.error('Read-only archive capability setup refused.');
  process.exitCode = 1;
});
