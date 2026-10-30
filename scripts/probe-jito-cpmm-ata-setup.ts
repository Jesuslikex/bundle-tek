import { mkdir, writeFile } from 'node:fs/promises';
import {
  address,
  blockhash,
  createNoopSigner,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransactionMessage,
  getCompiledTransactionMessageEncoder,
  getTransactionEncoder,
  type TransactionMessageBytes,
} from '@solana/kit';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { getSolanaHolderRpcEndpoint } from '../lib/solana-rpc';
import { paceWalletRpc } from '../lib/wallet-rpc-pacing';
import { readJitoSimulationPayload } from '../lib/jito-simulation-json';
import {
  inspectJitoCpmmAtaSetupPacket,
  inspectJitoCpmmAtaRentTransition,
} from '../lib/jito-cpmm-ata-setup';
import { PAIR_RENT } from '../lib/pair-rent-evidence';
import { PAIR_CLOCK, pairClockUnixTimestamp } from '../lib/pair-stock-clock';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';
const PAYER = '2BrxKZyzZ64TgS38ghWHdZU4wSf2C9USuoB6nDkk9Kgo';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const fail = (): never => {
  throw Error('ATA simulation diagnostic refused.');
};
function integer(v: unknown) {
  if (typeof v !== 'bigint' || v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER))
    return fail();
  return Number(v);
}
function account(v: unknown) {
  if (v === null) return null;
  const a = v as Record<string, unknown>;
  if (
    !a ||
    typeof a.owner !== 'string' ||
    typeof a.executable !== 'boolean' ||
    typeof a.lamports !== 'bigint' ||
    a.lamports < 0n ||
    a.lamports > (1n << 64n) - 1n ||
    !Array.isArray(a.data) ||
    a.data.length !== 2 ||
    a.data[1] !== 'base64' ||
    typeof a.data[0] !== 'string'
  )
    return fail();
  return {
    owner: a.owner,
    executable: a.executable,
    lamports: a.lamports.toString(),
    data: a.data,
    ...(a.space === undefined ? {} : { space: integer(a.space).toString() }),
  };
}
function vector(v: unknown, keys: readonly string[]) {
  if (!Array.isArray(v) || v.length !== keys.length) return fail();
  return v.map((entry, i) => {
    if (!entry || typeof entry !== 'object' || entry.address !== keys[i])
      return fail();
    return account(entry.account);
  });
}
async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--live-readonly')
    return fail();
  const endpoint = getSolanaHolderRpcEndpoint(),
    url = new URL(endpoint);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'solana-mainnet.g.alchemy.com' ||
    url.username ||
    url.password ||
    url.hash
  )
    return fail();
  const signal = AbortSignal.timeout(45000);
  const captures: { method: string; request: string; response: string }[] = [];
  const observations: Record<string, unknown> = {};
  let calls = 0,
    bytes = 0,
    status = 'refused',
    stage = 'genesis',
    rateLimited = false;
  let floor: number | null = null,
    lastSlot: number | null = null,
    rpcErrorCode: string | null = null;
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
    const id = 'ata-setup:' + calls,
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
    const payload = await readJitoSimulationPayload(r.body, signal, 1048576);
    bytes += payload.byteLength;
    if (bytes > 2097152) return fail();
    captures.push({
      method,
      request,
      response: Buffer.from(payload.rawBody).toString('utf8'),
    });
    const p = payload.value as Record<string, unknown>;
    if (p.jsonrpc !== '2.0' || p.id !== id || Object.keys(p).length !== 3)
      return fail();
    if (Object.hasOwn(p, 'error')) {
      const code = (p.error as { code?: unknown })?.code;
      rpcErrorCode = typeof code === 'bigint' ? code.toString() : null;
      rateLimited = code === 429n;
      return fail();
    }
    if (!Object.hasOwn(p, 'result')) return fail();
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
      value: { blockhash: string; lastValidBlockHeight: unknown };
    };
    floor = integer(latest.context.slot);
    if (floor < 1) return fail();
    const payer = createNoopSigner(address(PAYER));
    const [destination] = await findAssociatedTokenPda({
      owner: payer.address,
      mint: address(MINT),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const compiled = compileTransactionMessage(
      appendTransactionMessageInstructions(
        [
          getCreateAssociatedTokenIdempotentInstruction({
            payer,
            ata: destination,
            owner: payer.address,
            mint: address(MINT),
          }),
        ],
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: blockhash(latest.value.blockhash),
            lastValidBlockHeight: BigInt(
              integer(latest.value.lastValidBlockHeight),
            ),
          },
          setTransactionMessageFeePayer(
            payer.address,
            createTransactionMessage({ version: 0 }),
          ),
        ),
      ),
    );
    const messageBytes = getCompiledTransactionMessageEncoder().encode(
      compiled,
    ) as TransactionMessageBytes;
    const transaction = Buffer.from(
      getTransactionEncoder().encode({
        messageBytes,
        signatures: Object.fromEntries([[payer.address, null]]),
      }),
    ).toString('base64');
    const packet = {
      transaction,
      expected: {
        payer: PAYER,
        mint: MINT,
        destination: destination as string,
        blockhash: latest.value.blockhash,
      },
    };
    observations.packet = await inspectJitoCpmmAtaSetupPacket(packet);
    stage = 'same-response-setup-simulation';
    const keys = [
      ...compiled.staticAccounts.map(String),
      PAIR_CLOCK,
      PAIR_RENT,
    ];
    const result = (await rpc('simulateTransactionsAtSlot', [
      {
        simulations: [{ slot: floor, encodedTransaction: transaction }],
        preExecutionAccountsConfigs: { accounts: keys, encoding: 'base64' },
        postExecutionAccountsConfigs: { accounts: keys, encoding: 'base64' },
        innerInstructions: true,
        sigVerify: false,
        replaceRecentBlockhash: false,
      },
    ])) as {
      context: { slot: unknown };
      value: {
        preExecutionAccounts: unknown;
        simulationResults: Record<string, unknown>[];
      };
    };
    if (
      integer(result.context.slot) !== floor ||
      !Array.isArray(result.value.simulationResults) ||
      result.value.simulationResults.length !== 1
    )
      return fail();
    const row = result.value.simulationResults[0];
    observations.result = {
      status:
        typeof row.status === 'string' && row.status.length < 32
          ? row.status
          : 'invalid',
      slot: integer(row.slot),
      feeLamports:
        typeof row.feeLamports === 'bigint' ? row.feeLamports.toString() : null,
      changedWritableAccounts:
        Array.isArray(row.changedWritableAccounts) &&
        row.changedWritableAccounts.every(
          (k) => typeof k === 'string' && k.length <= 44,
        )
          ? row.changedWritableAccounts
          : 'invalid',
      err: row.err === null ? null : 'simulation-error',
      preAccountCount: Array.isArray(result.value.preExecutionAccounts)
        ? result.value.preExecutionAccounts.length
        : null,
      postAccountCount: Array.isArray(row.postExecutionAccounts)
        ? row.postExecutionAccounts.length
        : null,
    };
    const loaded = row.loadedAddresses as {
      readonly?: unknown;
      writable?: unknown;
    } | null;
    observations.lookupCounts = {
      readonly: Array.isArray(loaded?.readonly) ? loaded.readonly.length : null,
      writable: Array.isArray(loaded?.writable) ? loaded.writable.length : null,
    };
    if (
      integer(row.slot) !== floor ||
      row.status !== 'success' ||
      row.err !== null ||
      !loaded ||
      Object.keys(loaded).length !== 2 ||
      !Array.isArray(loaded.readonly) ||
      loaded.readonly.length !== 0 ||
      !Array.isArray(loaded.writable) ||
      loaded.writable.length !== 0 ||
      (row.replacementBlockhash !== null &&
        row.replacementBlockhash !== undefined) ||
      typeof row.feeLamports !== 'bigint'
    )
      return fail();
    if (
      !Array.isArray(row.changedWritableAccounts) ||
      JSON.stringify(row.changedWritableAccounts) !==
        JSON.stringify([PAYER, destination])
    )
      return fail();
    stage = 'exact-setup-rent';
    const pre = vector(result.value.preExecutionAccounts, keys),
      post = vector(row.postExecutionAccounts, [PAYER, destination]);
    const clock = pre[keys.indexOf(PAIR_CLOCK)],
      rentAccount = pre[keys.indexOf(PAIR_RENT)];
    observations.clockTimestamp = pairClockUnixTimestamp(clock, floor);
    observations.transition = await inspectJitoCpmmAtaRentTransition({
      packet,
      minimumSlot: floor,
      slot: floor,
      before: { payer: pre[0], destination: pre[1] },
      after: { payer: post[0], destination: post[1] },
      mintAccount: pre[keys.indexOf(MINT)],
      rentAccount,
      feeLamports: row.feeLamports.toString(),
      maximumFeeLamports: '10000',
      reserveLamports: '0',
    });
    stage = 'final-window';
    lastSlot = integer(
      await rpc('getSlot', [
        { commitment: 'confirmed', minContextSlot: floor },
      ]),
    );
    if (lastSlot < floor || lastSlot - floor > 32) return fail();
    status = 'unsigned-ata-setup-observed';
  } catch {
    process.exitCode = 1;
  }
  const receipt = {
    format: 'jito-cpmm-ata-setup-diagnostic-v1',
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
    overridesUsed: false,
    replaceRecentBlockhash: false,
    ownershipClaimed: false,
    fullSwapQualified: false,
    bankVerified: false,
    independentFeeBankVerified: false,
    providerQualified: false,
    signingAllowed: false,
    executionAllowed: false,
    transactionsBroadcast: 0,
  };
  await mkdir('work', { recursive: true });
  const path = `work/jito-cpmm-ata-setup-${Date.now()}.json`;
  await writeFile(path, JSON.stringify({ receipt, captures }, null, 2) + '\n');
  console.log(JSON.stringify({ ...receipt, savedCapture: path }));
}
main().catch(() => {
  console.error('ATA diagnostic setup refused; provider details suppressed.');
  process.exitCode = 1;
});
