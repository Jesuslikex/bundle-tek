import { mkdir, writeFile } from 'node:fs/promises';
import bs58 from 'bs58';
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
  getProgramDerivedAddress,
  type Instruction,
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
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';
import { PAIR_CLOCK, pairClockUnixTimestamp } from '../lib/pair-stock-clock';
import {
  PAIR_RENT,
  inspectPairRentAccount,
  pairRentMinimumRaw,
} from '../lib/pair-rent-evidence';
import { calculateJitoCpmmCurrentQuote } from '../lib/jito-cpmm-current-quote';
import {
  inspectJitoCpmmUnsignedPacket,
  inspectJitoCpmmPacketBalanceTransition,
} from '../lib/jito-cpmm-unsigned-packet';
import { inspectJitoCpmmAtaRentTransition } from '../lib/jito-cpmm-ata-setup';
import { inspectJitoTipReceiver } from '../lib/jito-tip-account-evidence';
import { solanaTransferMessage } from '../lib/solana-transfer-message';
import {
  collectJitoCpmmSetupResearchRuntimeEvidence,
  type JitoRuntimeCapture,
} from '../lib/jito-runtime-evidence';
import { requireJitoCpmmSetupResearchIdentities } from '../lib/jito-cpmm-source-identity';
import { createJitoQualificationTransport } from '../lib/jito-qualification-transport';
import { inspectSwapMintAccount } from '../lib/swap-token-program-evidence';
import {
  captureJitoCpmmLifetime,
  recheckJitoCpmmLifetime,
} from '../lib/jito-cpmm-lifetime';
import { snapshotJitoEvidence } from '../lib/jito-evidence-json';
import { inspectJitoSimulationDecimal } from '../lib/jito-simulation-json';
import type { PumpLaunchRpc } from '../lib/pump-launch-simulation';
import { inspectJitoCpmmSparseSwapState } from '../lib/jito-cpmm-state-replay';
import { observeTokenMarket, type TokenMarket } from '../lib/token-market';
import { readJitoCpmmPriceComparison } from '../lib/jito-cpmm-price-evidence';
import { probeJitoCpmmLiveFrames } from '../lib/jito-cpmm-live-frame-probe';
const PAYER = '2BrxKZyzZ64TgS38ghWHdZU4wSf2C9USuoB6nDkk9Kgo',
  TIP = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5';
const SYSTEM = '11111111111111111111111111111111',
  ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const CPMM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  WSOL = 'So11111111111111111111111111111111111111112',
  USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
// Fixed first retained WSOL/USDC discovery candidate, not a best-route claim.
const POOL = 'fAjTnZ9QqJkUmrr8cXutkYhpVge2qqtSZNt9qKn7YC2',
  CONFIG = 'FMmwToGqT9iwDgsqvzLg65vcKSzKme4szbWqX1kyCBCJ';
const VAULT0 = 'v3YN4d7JRhKFcwtex7qNtyg2r5hKYW96Cayb6GivSvY',
  VAULT1 = 'HG2WgeYsjqQhnjhwHj7QdTVvjyWpFRk6VREAQ8MURv2u';
const ORACLE = 'BeMRiScNtZrU1Ce4D6Kv5FYKLyhGTRbmMq2KPVxupuDv';
const fail = (): never => {
  throw Error('CPMM sequence diagnostic refused.');
};
const REQUIRED_NODE_MAJOR = 24;
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
  const b = Buffer.from(a.data[0], 'base64');
  if (b.toString('base64') !== a.data[0]) return fail();
  return {
    owner: a.owner,
    executable: a.executable,
    lamports: a.lamports.toString(),
    data: [a.data[0], 'base64'],
  };
}
type Raw = NonNullable<ReturnType<typeof account>>;
function image(v: unknown, expected: string[]) {
  if (!Array.isArray(v) || v.length !== expected.length) return fail();
  const out = new Map<string, ReturnType<typeof account>>();
  for (const row of v) {
    if (
      !row ||
      typeof row !== 'object' ||
      typeof row.address !== 'string' ||
      !expected.includes(row.address) ||
      out.has(row.address)
    )
      return fail();
    out.set(row.address, account(row.account));
  }
  return out;
}
function bytes(a: Raw | null | undefined, owner: string, size: number) {
  if (!a || a.owner !== owner || a.executable) return fail();
  const b = Buffer.from(a.data[0], 'base64');
  if (b.length !== size) return fail();
  return b;
}
function exactWrites(v: unknown, keys: string[]) {
  if (
    !Array.isArray(v) ||
    v.length !== keys.length ||
    new Set(v).size !== keys.length ||
    v.some((k) => typeof k !== 'string' || !keys.includes(k))
  )
    return fail();
}
function noLookups(value: unknown, legacy: boolean) {
  if (legacy && value === null) return true;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2
  )
    return false;
  const v = value as { readonly?: unknown; writable?: unknown };
  return (
    Array.isArray(v.readonly) &&
    v.readonly.length === 0 &&
    Array.isArray(v.writable) &&
    v.writable.length === 0
  );
}
async function main() {
  const timingOriginMs = performance.now();
  const elapsed = () => Math.max(0, performance.now() - timingOriginMs);
  const stageTimings: {
    stage: string;
    enteredAtMs: number;
    finishedAtMs: number | null;
  }[] = [{ stage: 'genesis', enteredAtMs: 0, finishedAtMs: null }];
  const rpcTimings: {
    id: number;
    method: string;
    stage: string;
    queuedAtMs: number;
    pacedAtMs: number | null;
    sentAtMs: number | null;
    headersAtMs: number | null;
    capturedAtMs: number | null;
    finishedAtMs: number | null;
    contextSlot: string | null;
    httpStatus: number | null;
  }[] = [];
  const withFrameProbe =
    process.argv.length === 7 && process.argv[6] === '--with-jito-frame-probe';
  const withCompression =
    (process.argv.length === 6 || withFrameProbe) &&
    process.argv[5] === '--with-code-compression';
  const withMarket =
    (process.argv.length === 5 || withCompression) &&
    process.argv[4] === '--with-market-comparison';
  const withCode =
    (process.argv.length === 4 || withMarket) &&
    process.argv[3] === '--with-code-bracket';
  if (Number(process.versions.node.split('.')[0]) !== REQUIRED_NODE_MAJOR) {
    console.log(
      JSON.stringify({
        format: 'jito-cpmm-sequence-startup-refusal-v1',
        status: 'refused',
        reason: 'unsupported-node-major',
        runtime: {
          nodeVersion: process.version,
          requiredNodeMajor: REQUIRED_NODE_MAJOR,
        },
        providerReads: 0,
        signingAllowed: false,
        executionAllowed: false,
        transactionsBroadcast: 0,
      }),
    );
    process.exitCode = 1;
    return;
  }
  if (
    (!withCode && process.argv.length !== 3) ||
    process.argv[2] !== '--live-readonly'
  )
    return fail();
  const endpoint = getSolanaHolderRpcEndpoint(),
    url = new URL(endpoint),
    signal = AbortSignal.timeout(45000);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'solana-mainnet.g.alchemy.com' ||
    url.username ||
    url.password ||
    url.hash
  )
    return fail();
  const captures: { method: string; request: string; response: string }[] = [],
    observations: Record<string, unknown> = {};
  let calls = 0,
    totalBytes = 0,
    stage = 'genesis',
    status = 'refused',
    rateLimited = false,
    lastHttpStatus: number | null = null,
    responseDecodeCompleted = false,
    responseDecodeReason: string | null = null,
    rpcErrorCode: string | null = null,
    floor: number | null = null,
    simulationSlot: number | null = null,
    lastSlot: number | null = null;
  function enterStage(name: string) {
    const now = elapsed();
    stageTimings.at(-1)!.finishedAtMs = now;
    stage = name;
    stageTimings.push({ stage: name, enteredAtMs: now, finishedAtMs: null });
  }
  let codeTransport: ReturnType<
    typeof createJitoQualificationTransport
  > | null = null;
  let firstCode: JitoRuntimeCapture | null = null,
    lastCode: JitoRuntimeCapture | null = null;
  let lifetime: Awaited<ReturnType<typeof captureJitoCpmmLifetime>> | null =
    null;
  let lifetimeFloor = 0;
  let firstCodeReady: Promise<JitoRuntimeCapture> | null = null;
  let markets: Promise<PromiseSettledResult<TokenMarket>[]> | null = null;
  let frameProbe: ReturnType<typeof probeJitoCpmmLiveFrames> | null = null;
  async function rpc(method: string, params: unknown[], readSignal = signal) {
    const requestSignal = AbortSignal.any([signal, readSignal]);
    const callId = ++calls;
    if (
      ![
        'getGenesisHash',
        'getLatestBlockhash',
        'simulateTransactionsAtSlot',
        'getSlot',
        'getMultipleAccounts',
        ...(withCode ? ['isBlockhashValid', 'getBlockHeight'] : []),
      ].includes(method) ||
      callId > (withCode ? 11 : 5)
    )
      return fail();
    const timing = {
      id: callId,
      method,
      stage,
      queuedAtMs: elapsed(),
      pacedAtMs: null as number | null,
      sentAtMs: null as number | null,
      headersAtMs: null as number | null,
      capturedAtMs: null as number | null,
      finishedAtMs: null as number | null,
      contextSlot: null as string | null,
      httpStatus: null as number | null,
    };
    rpcTimings.push(timing);
    try {
      await paceWalletRpc(endpoint, requestSignal);
      timing.pacedAtMs = elapsed();
      const id = 'cpmm-sequence:' + callId,
        request = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      timing.sentAtMs = elapsed();
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: request,
        signal: requestSignal,
        redirect: 'error',
        cache: 'no-store',
      });
      timing.headersAtMs = elapsed();
      timing.httpStatus = r.status;
      lastHttpStatus = r.status;
      responseDecodeCompleted = false;
      if (!r.ok) {
        rateLimited = r.status === 429;
        void r.body?.cancel();
        return fail();
      }
      // Preserve optional display decimals as opaque lexemes, never JS numbers.
      // Every slot, fee and account lamport below still requires exact bigint.
      let body;
      try {
        body = await readJitoSimulationPayload(r.body, requestSignal, 1048576, {
          allowDecimalTokens: true,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          /^Jito simulation JSON: [a-z -]+\.$/.test(error.message)
        )
          responseDecodeReason = error.message;
        return fail();
      }
      responseDecodeCompleted = true;
      timing.capturedAtMs = elapsed();
      totalBytes += body.byteLength;
      if (totalBytes > 2097152) return fail();
      captures.push({
        method,
        request,
        response: Buffer.from(body.rawBody).toString('utf8'),
      });
      const p = body.value as Record<string, unknown>;
      if (p.jsonrpc !== '2.0' || p.id !== id || Object.keys(p).length !== 3)
        return fail();
      if (Object.hasOwn(p, 'error')) {
        const code = (p.error as { code?: unknown })?.code;
        rpcErrorCode = typeof code === 'bigint' ? code.toString() : null;
        rateLimited = code === 429n;
        return fail();
      }
      if (!Object.hasOwn(p, 'result')) return fail();
      const result = p.result as {
        context?: { slot?: unknown };
        value?: unknown;
      } | null;
      const trace = (observations.rpcEvidence ??= []) as unknown[];
      timing.contextSlot =
        typeof result?.context?.slot === 'bigint'
          ? result.context.slot.toString()
          : method === 'getSlot' && typeof p.result === 'bigint'
            ? p.result.toString()
            : null;
      trace.push({
        method,
        slot:
          typeof result?.context?.slot === 'bigint'
            ? result.context.slot.toString()
            : null,
        ...(method === 'isBlockhashValid'
          ? { valid: result?.value === true }
          : {}),
        ...(method === 'getBlockHeight'
          ? {
              blockHeight:
                typeof p.result === 'bigint' ? p.result.toString() : 'invalid',
            }
          : {}),
      });
      return p.result;
    } finally {
      timing.finishedAtMs = elapsed();
    }
  }
  function lifetimeValue(v: unknown): unknown {
    if (typeof v === 'bigint') return v.toString();
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (inspectJitoSimulationDecimal(v) !== null) return fail();
    if (Array.isArray(v)) return v.map(lifetimeValue);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v).map(([k, value]) => [k, lifetimeValue(value)]),
      );
    return fail();
  }
  const lifetimeRpc: PumpLaunchRpc = async (method, params, readSignal) => {
    if (
      ![
        'getGenesisHash',
        'getLatestBlockhash',
        'isBlockhashValid',
        'getBlockHeight',
      ].includes(method)
    )
      return fail();
    if (method === 'getLatestBlockhash' && firstCodeReady) {
      const completed = await firstCodeReady;
      lifetimeFloor = Math.max(lifetimeFloor, completed.maximumSlot);
    }
    const copy = snapshotJitoEvidence(params, 4096);
    if (method !== 'getGenesisHash') {
      const i = method === 'isBlockhashValid' ? 1 : 0;
      const config = copy[i] as Record<string, unknown>;
      if (
        !config ||
        typeof config.minContextSlot !== 'number' ||
        !Number.isSafeInteger(config.minContextSlot)
      )
        return fail();
      copy[i] = {
        ...config,
        minContextSlot: Math.max(config.minContextSlot, lifetimeFloor),
      };
    }
    return lifetimeValue(await rpc(method, copy, readSignal));
  };
  try {
    if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
      return fail();
    enterStage('blockhash');
    let latest = (await rpc('getLatestBlockhash', [
      { commitment: 'confirmed' },
    ])) as {
      context: { slot: unknown };
      value: { blockhash: string; lastValidBlockHeight: unknown };
    };
    floor = integer(latest.context.slot);
    if (floor < 1) return fail();
    simulationSlot = floor;
    if (withMarket)
      markets = Promise.allSettled(
        [WSOL, USDC].map((mint) =>
          observeTokenMarket({ chain: 'Solana', address: mint }, signal),
        ),
      );
    const payer = createNoopSigner(address(PAYER));
    const [source] = await findAssociatedTokenPda({
      owner: payer.address,
      mint: address(WSOL),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const [destination] = await findAssociatedTokenPda({
      owner: payer.address,
      mint: address(USDC),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const [authority] = await getProgramDerivedAddress({
      programAddress: address(CPMM),
      seeds: [new TextEncoder().encode('vault_and_lp_mint_auth_seed')],
    });
    const keys = [
      PAYER,
      destination as string,
      source as string,
      POOL,
      CONFIG,
      VAULT0,
      VAULT1,
      ORACLE,
      WSOL,
      USDC,
      PAIR_CLOCK,
      PAIR_RENT,
      TIP,
      SYSTEM,
      TOKEN_PROGRAM_ADDRESS,
      ATA,
      CPMM,
      authority as string,
    ];
    if (new Set(keys).size !== keys.length) return fail();
    if (withCode) {
      enterStage('first-four-program-code-scan');
      codeTransport = createJitoQualificationTransport(
        'runtime',
        floor,
        signal,
        withCompression ? { runtimeAccountEncoding: 'base64+zstd' } : {},
      );
      firstCodeReady = collectJitoCpmmSetupResearchRuntimeEvidence(
        keys.slice(),
        floor,
        floor,
        signal,
        codeTransport.rpc,
      );
      enterStage('first-code-and-issued-lifetime');
      const initial = await Promise.allSettled([
        firstCodeReady,
        captureJitoCpmmLifetime(floor, lifetimeRpc, signal),
      ]);
      if (initial[0].status === 'fulfilled') {
        firstCode = initial[0].value;
        observations.firstCode = firstCode;
      }
      if (initial[1].status === 'fulfilled') lifetime = initial[1].value;
      if (
        !firstCode ||
        !lifetime ||
        initial.some((result) => result.status !== 'fulfilled')
      )
        return fail();
      observations.lifetimeCapture = lifetime;
      latest = {
        context: { slot: BigInt(lifetime.slot) },
        value: {
          blockhash: lifetime.blockhash,
          lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight),
        },
      };
      simulationSlot = integer(latest.context.slot);
      if (simulationSlot < firstCode.maximumSlot || simulationSlot - floor > 32)
        return fail();
    }
    const native = (amount: bigint) =>
      Buffer.concat([
        Buffer.from([1]),
        Buffer.alloc(64),
        Buffer.from(
          solanaTransferMessage(PAYER, TIP, latest.value.blockhash, amount),
        ),
      ]).toString('base64');
    const config = { accounts: keys, encoding: 'base64' };
    enterStage('archive-base-prestate');
    observations.prestateProbe = {
      purpose: 'read-only-base-state',
      amountRaw: '1000',
      independentFromFinalBundle: true,
    };
    const initial = (await rpc('simulateTransactionsAtSlot', [
      {
        simulations: [
          { slot: simulationSlot, encodedTransaction: native(1000n) },
        ],
        preExecutionAccountsConfigs: config,
        postExecutionAccountsConfigs: config,
        innerInstructions: false,
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
      integer(initial.context.slot) !== simulationSlot ||
      !Array.isArray(initial.value.simulationResults) ||
      initial.value.simulationResults.length !== 1
    )
      return fail();
    const ir = initial.value.simulationResults[0];
    if (
      ir.status !== 'success' ||
      ir.err !== null ||
      integer(ir.slot) !== simulationSlot ||
      ir.replacementBlockhash !== null
    )
      return fail();
    const pre = image(initial.value.preExecutionAccounts, keys);
    if (pre.get(destination as string) !== null) return fail();
    pairClockUnixTimestamp(pre.get(PAIR_CLOCK), simulationSlot);
    const rentRaw = pre.get(PAIR_RENT),
      rent = inspectPairRentAccount(rentRaw);
    const b = bytes(pre.get(POOL), CPMM, 637),
      c = bytes(pre.get(CONFIG), CPMM, 236),
      v0 = bytes(pre.get(VAULT0), TOKEN_PROGRAM_ADDRESS, 165),
      v1 = bytes(pre.get(VAULT1), TOKEN_PROGRAM_ADDRESS, 165);
    if (
      b.subarray(0, 8).toString('hex') !== 'f7ede3f5d7c3de46' ||
      c.subarray(0, 8).toString('hex') !== 'daf42168cbcb2b6f' ||
      bs58.encode(b.subarray(8, 40)) !== CONFIG ||
      bs58.encode(b.subarray(72, 104)) !== VAULT0 ||
      bs58.encode(b.subarray(104, 136)) !== VAULT1 ||
      bs58.encode(b.subarray(168, 200)) !== WSOL ||
      bs58.encode(b.subarray(200, 232)) !== USDC ||
      bs58.encode(b.subarray(296, 328)) !== ORACLE ||
      b[389] > 2 ||
      b[390] > 1
    )
      return fail();
    enterStage('strict-source-quote-candidate');
    const quoteInput = {
      inputRaw: '1000000',
      minimumOutputRaw: '1',
      inputReserveRaw: (
        v0.readBigUInt64LE(64) -
        b.readBigUInt64LE(341) -
        b.readBigUInt64LE(357) -
        b.readBigUInt64LE(397)
      ).toString(),
      outputReserveRaw: (
        v1.readBigUInt64LE(64) -
        b.readBigUInt64LE(349) -
        b.readBigUInt64LE(365) -
        b.readBigUInt64LE(405)
      ).toString(),
      tradeFeeMillionths: c.readBigUInt64LE(12).toString(),
      creatorFeeMillionths: (b[390] === 1
        ? c.readBigUInt64LE(108)
        : 0n
      ).toString(),
      protocolFeeMillionths: c.readBigUInt64LE(20).toString(),
      fundFeeMillionths: c.readBigUInt64LE(28).toString(),
      creatorFeeOnInput: b[389] !== 2,
    };
    const estimate = calculateJitoCpmmCurrentQuote(quoteInput);
    const quote = calculateJitoCpmmCurrentQuote({
      ...quoteInput,
      minimumOutputRaw: estimate.expectedOutputRaw,
    });
    // The temporary 1-unit arithmetic input is never encoded. The diagnostic
    // swap minimum is the entire expected output, with zero slippage tolerance.
    const minimum = quote.expectedOutputRaw;
    observations.quote = {
      ...quote,
      minimumOutputRaw: minimum,
      minimumPolicy: 'exact-source-expected-output',
      pool: POOL,
    };
    const compile = (instructions: Instruction[]) => {
      const m = compileTransactionMessage(
        appendTransactionMessageInstructions(
          instructions,
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
        m,
      ) as TransactionMessageBytes;
      return {
        transaction: Buffer.from(
          getTransactionEncoder().encode({
            messageBytes,
            signatures: Object.fromEntries([[payer.address, null]]),
          }),
        ).toString('base64'),
        keys: m.staticAccounts.map(String),
      };
    };
    const setup = compile([
      getCreateAssociatedTokenIdempotentInstruction({
        payer,
        ata: destination,
        owner: payer.address,
        mint: address(USDC),
      }),
    ]);
    const accountKeys = [
      PAYER,
      authority as string,
      CONFIG,
      POOL,
      source as string,
      destination as string,
      VAULT0,
      VAULT1,
      TOKEN_PROGRAM_ADDRESS,
      TOKEN_PROGRAM_ADDRESS,
      WSOL,
      USDC,
      ORACLE,
    ];
    const data = Buffer.alloc(24);
    Buffer.from('8fbe5adac41e33de', 'hex').copy(data);
    data.writeBigUInt64LE(1000000n, 8);
    data.writeBigUInt64LE(BigInt(minimum), 16);
    const swap = compile([
      {
        programAddress: address(CPMM),
        data,
        accounts: accountKeys.map((key, i) => ({
          address: address(key),
          role: i === 0 ? 3 : [3, 4, 5, 6, 7, 12].includes(i) ? 1 : 0,
        })),
      },
    ]);
    const packet = {
      transaction: swap.transaction,
      expected: {
        payer: PAYER,
        inputMint: WSOL,
        outputMint: USDC,
        inputRaw: '1000000',
        minimumOutputRaw: minimum,
      },
    };
    const bound = await inspectJitoCpmmUnsignedPacket(packet);
    observations.swapPacket = bound;
    const transactions = [setup.transaction, swap.transaction, native(1000n)];
    if (withFrameProbe)
      frameProbe = probeJitoCpmmLiveFrames(
        {
          transactions: transactions.slice(),
          addresses: keys.slice(),
          minimumSlot: floor,
          simulationSlot,
        },
        signal,
      );
    enterStage('full-setup-swap-tip-simulation');
    const result = (await rpc('simulateTransactionsAtSlot', [
      {
        simulations: transactions.map((encodedTransaction) => ({
          slot: simulationSlot,
          encodedTransaction,
        })),
        preExecutionAccountsConfigs: config,
        postExecutionAccountsConfigs: config,
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
      integer(result.context.slot) !== simulationSlot ||
      !Array.isArray(result.value.simulationResults) ||
      result.value.simulationResults.length !== 3
    )
      return fail();
    const rows = result.value.simulationResults;
    if (frameProbe) {
      const value = await frameProbe;
      observations.jitoFrameProbe = value.summary;
      if (value.summary.transport?.rateLimited) return fail();
    }
    observations.results = rows.map((row) => ({
      slot: integer(row.slot),
      status: typeof row.status === 'string' ? row.status : 'invalid',
      feeLamports:
        typeof row.feeLamports === 'bigint' ? row.feeLamports.toString() : null,
      err: row.err === null ? null : 'simulation-error',
      postAccountCount: Array.isArray(row.postExecutionAccounts)
        ? row.postExecutionAccounts.length
        : null,
    }));
    observations.lookupCounts = rows.map((row) => {
      const v = row.loadedAddresses as {
        readonly?: unknown;
        writable?: unknown;
      } | null;
      return {
        readonly: Array.isArray(v?.readonly) ? v.readonly.length : null,
        writable: Array.isArray(v?.writable) ? v.writable.length : null,
      };
    });
    if (
      rows.some(
        (row, i) =>
          row.status !== 'success' ||
          row.err !== null ||
          integer(row.slot) !== simulationSlot ||
          row.replacementBlockhash !== null ||
          !noLookups(row.loadedAddresses, i === 2) ||
          typeof row.feeLamports !== 'bigint',
      )
    )
      return fail();
    enterStage('observed-mutable-effects');
    const base = image(result.value.preExecutionAccounts, keys);
    const prestateDifferences = keys
      .filter(
        (key) => JSON.stringify(base.get(key)) !== JSON.stringify(pre.get(key)),
      )
      .map((key) => ({
        address: key,
        fields: ['owner', 'executable', 'lamports', 'data'].filter(
          (field) =>
            JSON.stringify(
              (base.get(key) as unknown as Record<string, unknown> | null)?.[
                field
              ],
            ) !==
            JSON.stringify(
              (pre.get(key) as unknown as Record<string, unknown> | null)?.[
                field
              ],
            ),
        ),
      }));
    observations.prestateDifferences = prestateDifferences;
    if (prestateDifferences.length) return fail();
    const expectedWrites = [
      [PAYER, destination as string],
      [
        PAYER,
        POOL,
        source as string,
        destination as string,
        VAULT0,
        VAULT1,
        ORACLE,
      ],
      [PAYER, TIP],
    ];
    const posts = rows.map((row, i) => {
      exactWrites(row.changedWritableAccounts, expectedWrites[i]);
      return image(row.postExecutionAccounts, expectedWrites[i]);
    });
    observations.setup = await inspectJitoCpmmAtaRentTransition({
      packet: {
        transaction: setup.transaction,
        expected: {
          payer: PAYER,
          mint: USDC,
          destination: destination as string,
          blockhash: latest.value.blockhash,
        },
      },
      minimumSlot: floor,
      slot: simulationSlot,
      before: {
        payer: base.get(PAYER),
        destination: base.get(destination as string),
      },
      after: {
        payer: posts[0].get(PAYER),
        destination: posts[0].get(destination as string),
      },
      mintAccount: base.get(USDC),
      rentAccount: rentRaw,
      feeLamports: (rows[0].feeLamports as bigint).toString(),
      maximumFeeLamports: '10000',
      reserveLamports: '0',
    });
    const tokenKeys = [source as string, destination as string, VAULT0, VAULT1];
    const raw = (key: string, a: Raw | null | undefined) => {
      if (!a) return fail();
      return {
        address: key,
        owner: a.owner,
        executable: a.executable,
        lamports: a.lamports,
        dataBase64: a.data[0],
      };
    };
    observations.tokenTransition = await inspectJitoCpmmPacketBalanceTransition(
      {
        packet,
        before: tokenKeys.map((key) =>
          raw(key, key === destination ? posts[0].get(key) : base.get(key)),
        ),
        after: tokenKeys.map((key) => raw(key, posts[1].get(key))),
      },
    );
    enterStage('actual-pool-oracle-and-rent-replay');
    const replayKeys = [
      POOL,
      source as string,
      destination as string,
      VAULT0,
      VAULT1,
      CONFIG,
      ORACLE,
      PAIR_CLOCK,
      WSOL,
      USDC,
      PAIR_RENT,
    ];
    observations.writableReplay = await inspectJitoCpmmSparseSwapState(
      {
        packet,
        minimumSlot: floor,
        slot: simulationSlot,
        before: replayKeys.map((key) =>
          raw(key, key === destination ? posts[0].get(key) : base.get(key)),
        ),
        after: replayKeys
          .filter((key) => posts[1].has(key))
          .map((key) => raw(key, posts[1].get(key))),
      },
      signal,
    );
    enterStage('native-fee-rent-and-tip-conservation');
    for (const [i, post] of posts.entries()) {
      const fee = rows[i].feeLamports as bigint;
      if (fee < 1n || fee > 10000n) return fail();
      const payerBefore = i === 0 ? base.get(PAYER) : posts[i - 1].get(PAYER),
        payerAfter = post.get(PAYER);
      if (!payerBefore || !payerAfter) return fail();
      const cost =
        fee +
        (i === 0
          ? BigInt(pairRentMinimumRaw(rent, 165))
          : i === 2
            ? 1000n
            : 0n);
      if (
        BigInt(payerBefore.lamports) - BigInt(payerAfter.lamports) !== cost ||
        BigInt(payerAfter.lamports) < BigInt(pairRentMinimumRaw(rent, 0))
      )
        return fail();
    }
    for (const tipAccount of [base.get(TIP), posts[2].get(TIP)])
      await inspectJitoTipReceiver({
        address: TIP,
        account: tipAccount,
        rentAccount: rentRaw,
      });
    if (
      BigInt(posts[2].get(TIP)!.lamports) - BigInt(base.get(TIP)!.lamports) !==
      1000n
    )
      return fail();
    observations.readonlyPostCoverage = false;
    observations.poolAndOracleReplayComplete = false;
    observations.allThreeStatusesSuccessful = true;
    if (withMarket) {
      enterStage('independent-market-comparison');
      if (!markets) return fail();
      const prices = await markets;
      observations.marketReadStatuses = prices.map((value) => value.status);
      if (prices.some((value) => value.status !== 'fulfilled')) return fail();
      const observed = prices.map(
        (value) => (value as PromiseFulfilledResult<TokenMarket>).value,
      );
      const selections = observed.map(
        (value) =>
          value.pairs.find(
            (pair) => pair.address !== POOL && pair.priceUsd !== null,
          )?.address,
      );
      if (selections.some((value) => !value)) return fail();
      const originalFloor = floor,
        originalSlot = simulationSlot;
      // Explicit supplied-state adapter, not another live mint bracket. Mint
      // policy is rechecked on chain after the final code scan below.
      const suppliedMints: PumpLaunchRpc = async (method, params, s) => {
        s.throwIfAborted();
        const requested = params[0] as string[],
          cfg = params[1] as { minContextSlot: number };
        if (
          method !== 'getMultipleAccounts' ||
          JSON.stringify(requested) !==
            JSON.stringify([WSOL, USDC, PAIR_RENT]) ||
          !cfg ||
          !Number.isSafeInteger(cfg.minContextSlot) ||
          cfg.minContextSlot < originalFloor ||
          cfg.minContextSlot > originalSlot
        )
          return fail();
        return {
          context: { slot: String(originalSlot) },
          value: requested.map((key) => base.get(key)),
        };
      };
      observations.marketComparison = await readJitoCpmmPriceComparison(
        packet,
        { inputPair: selections[0]!, outputPair: selections[1]! },
        floor,
        suppliedMints,
        signal,
        {
          observe: async (source) => {
            const value = observed.find(
              (value) => value.address === source.address,
            );
            if (!value) return fail();
            return value;
          },
        },
      );
      observations.marketComparisonMintEvidence =
        'supplied-archive-prestate-with-later-live-policy-recheck';
      observations.marketSelectionPolicy =
        'first-priced-base-token-pair-by-existing-liquidity-sort-excluding-execution-pool';
      if (!(observations.marketComparison as { available: boolean }).available)
        return fail();
    }
    if (withCode) {
      if (!firstCode || !codeTransport) return fail();
      enterStage('final-four-program-code-scan');
      lastCode = await collectJitoCpmmSetupResearchRuntimeEvidence(
        keys.slice(),
        floor,
        simulationSlot,
        signal,
        codeTransport.rpc,
      );
      observations.lastCode = lastCode;
      requireJitoCpmmSetupResearchIdentities(
        firstCode.programs,
        lastCode.programs,
      );
      if (
        firstCode.maximumSlot > simulationSlot ||
        lastCode.minimumReadSlot < simulationSlot ||
        lastCode.maximumSlot - floor > 32
      )
        return fail();
      observations.fourProgramArtifactBracketObserved = true;
      enterStage('post-code-custody-mint-and-lifetime');
      if (!lifetime) return fail();
      lifetimeFloor = lastCode.maximumSlot;
      const custodyKeys = [
        PAYER,
        source as string,
        destination as string,
        WSOL,
        USDC,
        PAIR_RENT,
        PAIR_CLOCK,
      ];
      const settled = await Promise.allSettled([
        rpc('getMultipleAccounts', [
          custodyKeys,
          {
            commitment: 'confirmed',
            encoding: 'base64',
            minContextSlot: lastCode.maximumSlot,
          },
        ]),
        recheckJitoCpmmLifetime(packet, lifetime, lastCode.maximumSlot, signal),
      ]);
      observations.lifetimeRecheckStatus = settled[1].status;
      if (settled[1].status === 'fulfilled')
        observations.lifetime = settled[1].value;
      if (
        settled[0].status !== 'fulfilled' ||
        settled[1].status !== 'fulfilled'
      )
        return fail();
      const custody = settled[0].value as {
        context: { slot: unknown };
        value: unknown[];
      };
      const custodySlot = integer(custody.context.slot);
      if (
        custodySlot < lastCode.maximumSlot ||
        custodySlot - floor > 32 ||
        !Array.isArray(custody.value) ||
        custody.value.length !== custodyKeys.length
      )
        return fail();
      const after = new Map(
        custodyKeys.map((key, i) => [key, account(custody.value[i])]),
      );
      pairClockUnixTimestamp(after.get(PAIR_CLOCK), custodySlot);
      if (
        JSON.stringify(inspectPairRentAccount(after.get(PAIR_RENT))) !==
        JSON.stringify(rent)
      )
        return fail();
      const comparisons = [PAYER, source as string, destination as string].map(
        (key) => ({
          address: key,
          beforeLamports: base.get(key)?.lamports ?? null,
          afterLamports: after.get(key)?.lamports ?? null,
          same:
            JSON.stringify(base.get(key)) === JSON.stringify(after.get(key)),
        }),
      );
      observations.postCodeCustody = { slot: custodySlot, comparisons };
      if (comparisons.some((c) => !c.same)) return fail();
      for (const mint of [WSOL, USDC]) {
        const a = await inspectSwapMintAccount(base.get(mint), mint),
          b = await inspectSwapMintAccount(after.get(mint), mint);
        if (JSON.stringify(a) !== JSON.stringify(b)) return fail();
      }
      observations.custodyCheckedFromSimulationBase = true;
      observations.postCodeMintPoliciesMatched = true;
      observations.finalReadFloor = Math.max(
        custodySlot,
        settled[1].value.validitySlot,
      );
    }
    enterStage('final-window');
    lastSlot = integer(
      await rpc('getSlot', [
        {
          commitment: 'confirmed',
          minContextSlot: withCode
            ? observations.finalReadFloor
            : simulationSlot,
        },
      ]),
    );
    if (
      lastSlot <
        (withCode ? Number(observations.finalReadFloor) : simulationSlot) ||
      lastSlot - floor > 32
    )
      return fail();
    status = 'unsigned-setup-swap-tip-mutable-effects-observed';
  } catch {
    process.exitCode = 1;
  }
  stageTimings.at(-1)!.finishedAtMs = elapsed();
  const qualificationFinishedAtMs = elapsed();
  codeTransport?.close();
  if (markets) await markets;
  const codeCaptures = codeTransport?.captures() ?? [];
  const frameProbeResult = frameProbe ? await frameProbe : null;
  if (frameProbeResult) observations.jitoFrameProbe = frameProbeResult.summary;
  const receipt = {
    format: 'jito-cpmm-sequence-diagnostic-v1',
    runtime: {
      nodeVersion: process.version,
      requiredNodeMajor: REQUIRED_NODE_MAJOR,
    },
    observedAt: new Date().toISOString(),
    status,
    stage,
    floor,
    simulationSlot,
    lastSlot,
    calls,
    responseBytes: totalBytes,
    rateLimited,
    lastHttpStatus,
    responseDecodeCompleted,
    responseDecodeReason,
    rpcErrorCode,
    observations,
    // Monotonic diagnostics only. No timing value participates in admission.
    timing: {
      clock: 'process-monotonic',
      originMs: timingOriginMs,
      qualificationFinishedAtMs,
      stages: stageTimings,
      ordinaryRpc: rpcTimings,
      codeOriginMs: codeTransport?.summary().timing.originMs ?? null,
      codeRpc: codeCaptures.map((c) => ({
        requestSha256: c.requestSha256,
        rawSha256: c.rawSha256,
        httpStatus: c.httpStatus,
        captureStatus: c.captureStatus,
        timing: c.timing,
      })),
      diagnosticOnly: true,
    },
    codeTransport: codeTransport?.summary() ?? null,
    lifetimeRecheckedAfterFinalCode:
      observations.lifetimeRecheckStatus === 'fulfilled',
    marketComparisonRequested: withMarket,
    codeCompressionRequested: withCompression,
    jitoFrameProbeRequested: withFrameProbe,
    overridesUsed: false,
    replaceRecentBlockhash: false,
    referenceQuietnessVerified: false,
    ownershipClaimed: false,
    independentPriceVerified: false,
    sourceAuthenticated: false,
    programApproved: false,
    bankVerified: false,
    independentFeeBankVerified: false,
    fullSwapQualified: false,
    providerQualified: false,
    signingAllowed: false,
    executionAllowed: false,
    transactionsBroadcast: 0,
  };
  await mkdir('work', { recursive: true });
  const path = `work/jito-cpmm-sequence-${Date.now()}.json`;
  await writeFile(
    path,
    JSON.stringify(
      {
        receipt,
        captures,
        frameProbe: frameProbeResult,
        codeCaptures: codeCaptures.map(({ rawBody, ...capture }) => ({
          ...capture,
          rawBodyBase64: Buffer.from(rawBody).toString('base64'),
        })),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify({ ...receipt, savedCapture: path }));
}
main().catch(() => {
  console.error(
    'CPMM sequence diagnostic setup refused; provider details suppressed.',
  );
  process.exitCode = 1;
});
