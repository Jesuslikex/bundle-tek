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
  type Instruction,
  type TransactionMessageBytes,
  getProgramDerivedAddress,
} from '@solana/kit';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import {
  buildJitoCpmmBankAnchor,
  inspectJitoCpmmBankAnchor,
} from '../lib/jito-cpmm-bank-anchor';
import { calculateJitoCpmmCurrentQuote } from '../lib/jito-cpmm-current-quote';
import { inspectJitoCpmmUnsignedPacket } from '../lib/jito-cpmm-unsigned-packet';
import { replayJitoCpmmSetupBundleWithMissingImage as replayJitoCpmmSetupBundle } from '../lib/jito-cpmm-setup-bundle-replay';
import {
  collectJitoCpmmV2SetupResearchRuntimeEvidence as collectJitoCpmmSetupResearchRuntimeEvidence,
  verifyJitoCpmmV2SetupResearchRuntimeBracket as verifyJitoCpmmSetupResearchRuntimeBracket,
  jitoRuntimePolicyRefusal,
} from '../lib/jito-runtime-evidence';
import {
  captureJitoCpmmLifetime,
  recheckJitoCpmmLifetime,
} from '../lib/jito-cpmm-lifetime';
import { collectJitoProviderObservedAttempt } from '../lib/jito-coherent-prefee-attempt';
import { buildJitoBundleSimulationRequest } from '../lib/jito-bundle-simulation-frames';
import { inspectPairRentAccount, PAIR_RENT } from '../lib/pair-rent-evidence';
import { PAIR_CLOCK, pairClockUnixTimestamp } from '../lib/pair-stock-clock';
import { inspectJitoNativeTipCustody } from '../lib/jito-native-tip-custody';
import {
  inspectSwapMintAccount,
  assertSameSwapMintEvidence,
} from '../lib/swap-token-program-evidence';
import { observeTokenMarket } from '../lib/token-market';
import { readJitoCpmmPriceComparison } from '../lib/jito-cpmm-price-evidence';
import { solanaTransferMessage } from '../lib/solana-transfer-message';
import type { PumpLaunchRpc } from '../lib/pump-launch-simulation';
import { decodeJitoCpmmCompressedAccounts } from '../lib/jito-cpmm-code-compression';
const PAYER = '2BrxKZyzZ64TgS38ghWHdZU4wSf2C9USuoB6nDkk9Kgo',
  TIP = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5';
const CPMM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const WSOL = 'So11111111111111111111111111111111111111112',
  USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const POOL = 'fAjTnZ9QqJkUmrr8cXutkYhpVge2qqtSZNt9qKn7YC2',
  CONFIG = 'FMmwToGqT9iwDgsqvzLg65vcKSzKme4szbWqX1kyCBCJ';
const VAULT0 = 'v3YN4d7JRhKFcwtex7qNtyg2r5hKYW96Cayb6GivSvY',
  VAULT1 = 'HG2WgeYsjqQhnjhwHj7QdTVvjyWpFRk6VREAQ8MURv2u',
  ORACLE = 'BeMRiScNtZrU1Ce4D6Kv5FYKLyhGTRbmMq2KPVxupuDv';
type Account = {
  owner: string;
  executable: boolean;
  lamports: string;
  data: [string, 'base64'];
};
const fail = (): never => {
  throw Error('CPMM unsigned qualification refused.');
};
/** Called only by the explicit local --raydium-cpmm research mode. No signer,
 * sender, application route, provider configuration or persistence authority. */
export async function qualifyJitoCpmmProviderObserved(
  rpc: PumpLaunchRpc,
  wire: (body: string) => Promise<{ response: Response }>,
  summary: Record<string, unknown>,
  signal: AbortSignal,
) {
  const retained: Record<string, unknown> = {},
    timings: unknown[] = [];
  const start = performance.now();
  const stage = (name: string) => {
    summary.stage = name;
    timings.push({
      stage: name,
      elapsedMs: Math.round(performance.now() - start),
    });
  };
  summary.profile = 'provider-observed-raydium-cpmm-runtime-v1';
  let first: Awaited<
    ReturnType<typeof collectJitoCpmmSetupResearchRuntimeEvidence>
  > | null = null;
  try {
    stage('genesis');
    if (
      (await rpc('getGenesisHash', [], signal)) !==
      '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
    )
      fail();
    const latest = (await rpc(
      'getLatestBlockhash',
      [{ commitment: 'confirmed' }],
      signal,
    )) as {
      context: { slot: string };
      value: { blockhash: string; lastValidBlockHeight: string };
    };
    const floor = Number(latest.context.slot);
    if (!Number.isSafeInteger(floor) || floor < 1) fail();
    summary.floor = floor;
    // Explicit research codec, preserving order, floors, pacing and full scans.
    // No fallback; complete decoded sliced lengths and byte bounds enforced.
    const runtimeRpc: PumpLaunchRpc = async (method, params, s) => {
      if (method !== 'getMultipleAccounts') return rpc(method, params, s);
      const cfg = params[1] as {
        encoding: string;
        dataSlice: { offset: number; length: number };
      };
      if (cfg.encoding !== 'base64' || !cfg.dataSlice) fail();
      const result = await rpc(
        method,
        [params[0], { ...cfg, encoding: 'base64+zstd' }],
        s,
      );
      return decodeJitoCpmmCompressedAccounts(
        result,
        (params[0] as string[]).length,
        cfg.dataSlice,
      );
    };
    summary.runtimeAccountEncoding = 'base64+zstd';
    // Markets start alongside RPC work. All outcomes awaited below; unavailable
    // or >2% adverse independent comparison refuses, never silently waived.
    const markets = Promise.allSettled(
      [WSOL, USDC].map((address) =>
        observeTokenMarket({ chain: 'Solana', address }, signal),
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
    const stateKeys = [
      PAYER,
      TIP,
      PAIR_CLOCK,
      PAIR_RENT,
      source,
      destination,
      WSOL,
      USDC,
      POOL,
      CONFIG,
      VAULT0,
      VAULT1,
      ORACLE,
    ];
    async function state(at: number) {
      const r = (await rpc(
        'getMultipleAccounts',
        [
          stateKeys,
          { encoding: 'base64', commitment: 'confirmed', minContextSlot: at },
        ],
        signal,
      )) as { context: { slot: string }; value: (Account | null)[] };
      const slot = Number(r.context.slot);
      if (
        !Number.isSafeInteger(slot) ||
        slot < at ||
        slot - floor > 32 ||
        r.value.length !== stateKeys.length
      )
        fail();
      pairClockUnixTimestamp(r.value[2], slot);
      inspectPairRentAccount(r.value[3]);
      return { slot, rows: r.value };
    }
    const quoteInput = {
      inputRaw: '1000000',
      minimumOutputRaw: '1',
    };
    // No candidate amount encoded yet. Final quote is refreshed after scan.
    function quote(rows: (Account | null)[]) {
      const pool = Buffer.from(rows[8]!.data[0], 'base64'),
        cfg = Buffer.from(rows[9]!.data[0], 'base64'),
        a = Buffer.from(rows[10]!.data[0], 'base64'),
        d = Buffer.from(rows[11]!.data[0], 'base64');
      if (
        pool.length !== 637 ||
        cfg.length !== 236 ||
        a.length !== 165 ||
        d.length !== 165 ||
        rows[5] !== null
      )
        fail();
      return calculateJitoCpmmCurrentQuote({
        ...quoteInput,
        inputReserveRaw: (
          a.readBigUInt64LE(64) -
          pool.readBigUInt64LE(341) -
          pool.readBigUInt64LE(357) -
          pool.readBigUInt64LE(397)
        ).toString(),
        outputReserveRaw: (
          d.readBigUInt64LE(64) -
          pool.readBigUInt64LE(349) -
          pool.readBigUInt64LE(365) -
          pool.readBigUInt64LE(405)
        ).toString(),
        tradeFeeMillionths: cfg.readBigUInt64LE(12).toString(),
        creatorFeeMillionths: (pool[390] === 1
          ? cfg.readBigUInt64LE(108)
          : 0n
        ).toString(),
        protocolFeeMillionths: cfg.readBigUInt64LE(20).toString(),
        fundFeeMillionths: cfg.readBigUInt64LE(28).toString(),
        creatorFeeOnInput: pool[389] !== 2,
      });
    }
    const compile = (
      instructions: Instruction[],
      life: { blockhash: string; lastValidBlockHeight: string },
    ) => {
      const m = compileTransactionMessage(
        appendTransactionMessageInstructions(
          instructions,
          setTransactionMessageLifetimeUsingBlockhash(
            {
              blockhash: blockhash(life.blockhash),
              lastValidBlockHeight: BigInt(life.lastValidBlockHeight),
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
    function packets(
      life: { blockhash: string; lastValidBlockHeight: string },
      minimum: string,
    ) {
      const setup = compile(
        [
          getCreateAssociatedTokenIdempotentInstruction({
            payer,
            ata: destination,
            owner: payer.address,
            mint: address(USDC),
          }),
        ],
        life,
      );
      const metas = [
        PAYER,
        authority,
        CONFIG,
        POOL,
        source,
        destination,
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
      const swap = compile(
        [
          {
            programAddress: address(CPMM),
            data,
            accounts: metas.map((key, i) => ({
              address: address(key),
              role: i === 0 ? 3 : [3, 4, 5, 6, 7, 12].includes(i) ? 1 : 0,
            })),
          },
        ],
        life,
      );
      const anchor = buildJitoCpmmBankAnchor(PAYER, TIP, life.blockhash);
      const tip = Buffer.concat([
        Buffer.from([1]),
        Buffer.alloc(64),
        Buffer.from(solanaTransferMessage(PAYER, TIP, life.blockhash, 1000n)),
      ]).toString('base64');
      const all = [anchor, setup.transaction, swap.transaction, tip].map(
        (transaction) => ({
          transaction,
          loadedAddresses: null,
          maximumFeeLamports: '20000',
          expectedFeeLamports: '1',
        }),
      );
      const swapPacket = {
        transaction: swap.transaction,
        expected: {
          payer: PAYER,
          inputMint: WSOL,
          outputMint: USDC,
          inputRaw: '1000000',
          minimumOutputRaw: minimum,
        },
      };
      return {
        all,
        swapPacket,
        setupPacket: {
          transaction: setup.transaction,
          expected: {
            payer: PAYER,
            mint: USDC,
            destination: String(destination),
            blockhash: life.blockhash,
          },
        },
        tip,
      };
    }
    // Layout-only candidate is never submitted to RPC or admitted as economics.
    const layout = packets(latest.value, '1');
    const request = await buildJitoBundleSimulationRequest(layout.all, floor, {
      verifySignatures: false,
      bankEncoding: 'slot-object',
    });
    const keys = [
      ...new Set(
        request.params[1].preExecutionAccountsConfigs.flatMap(
          (x) => x.addresses,
        ),
      ),
    ];
    stage('first-code-and-state');
    const opening = await Promise.allSettled([
      collectJitoCpmmSetupResearchRuntimeEvidence(
        keys,
        floor,
        floor,
        signal,
        runtimeRpc,
      ),
      state(floor),
    ]);
    if (opening[0].status !== 'fulfilled') throw opening[0].reason;
    if (opening[1].status !== 'fulfilled') throw opening[1].reason;
    first = opening[0].value;
    const before = opening[1].value;
    retained.before = before;
    retained.first = first;
    stage('fresh-quote-and-lifetime');
    const firstFloor = first.maximumSlot;
    const lifetimeRpc: PumpLaunchRpc = (method, params, s) =>
      rpc(
        method,
        method === 'getLatestBlockhash'
          ? [
              {
                ...(params[0] as object),
                minContextSlot: Math.max(
                  firstFloor,
                  (params[0] as { minContextSlot: number }).minContextSlot,
                ),
              },
            ]
          : params,
        s,
      );
    const issue = await Promise.allSettled([
      state(firstFloor),
      captureJitoCpmmLifetime(floor, lifetimeRpc, signal),
    ]);
    if (issue[0].status !== 'fulfilled' || issue[1].status !== 'fulfilled')
      return fail();
    const fresh = issue[0].value,
      life = issue[1].value;
    retained.fresh = fresh;
    for (const i of [0, 4, 5, 3])
      if (JSON.stringify(before.rows[i]) !== JSON.stringify(fresh.rows[i]))
        fail();
    retained.lifetimeCapture = life;
    if (life.slot < firstFloor) fail();
    const q = quote(fresh.rows);
    summary.quote = {
      ...q,
      minimumOutputRaw: q.expectedOutputRaw,
      minimumPolicy: 'exact-source-expected-output',
    };
    const candidate = packets(life, q.expectedOutputRaw);
    retained.candidate = candidate;
    await inspectJitoCpmmUnsignedPacket(candidate.swapPacket);
    stage('provider-observed-bundle');
    const attempt = await collectJitoProviderObservedAttempt({
      packets: candidate.all,
      minimumSlot: floor,
      minimumReadSlot: Math.max(life.slot, fresh.slot),
      feeIdPrefix: 'cpmm-fees',
      simulationRpcId: 'cpmm-sim',
      verifySignatures: false,
      signal,
      transport: async ({ body }) => (await wire(body)).response,
    });
    retained.attempt = attempt;
    summary.attemptStatus = attempt.status;
    if (attempt.status !== 'captured') {
      summary.attemptReason = attempt.reason;
      summary.rawReason =
        attempt.simulation && 'reason' in attempt.simulation
          ? attempt.simulation.reason
          : null;
      fail();
    }
    if (
      attempt.simulation?.status !== 'admitted' ||
      attempt.fees?.status !== 'observed'
    )
      return fail();
    const frames = attempt.simulation.frames,
      bank = frames.slot;
    summary.simulationSlot = bank;
    summary.feeSlots = attempt.fees!.fees.map((x) => x.slot);
    stage('bank-and-complete-settlement-replay');
    const bankAccounts = inspectJitoCpmmBankAnchor(
      frames.frames[0],
      { payer: PAYER, tip: TIP, blockhash: life.blockhash },
      bank,
    );
    retained.bankAccounts = bankAccounts;
    const normalized = attempt.simulation.normalizedResult;
    const settlement = await replayJitoCpmmSetupBundle(
      {
        setup: candidate.setupPacket,
        bundle: {
          swaps: [candidate.swapPacket],
          tip: {
            transaction: candidate.tip,
            recipient: TIP,
            amountRaw: '1000',
          },
          walletReserves: [{ wallet: PAYER, reserveLamports: '0' }],
          // The owned candidate explicitly has no lookup tables. Retain its
          // original null representation and bind the independently read fees;
          // canonical fee packets encode the same empty set as two arrays.
          packets: candidate.all.slice(1).map((p, i) => ({
            ...p,
            expectedFeeLamports:
              attempt.fees!.status === 'observed'
                ? attempt.fees!.fees[i + 1].feeLamports
                : fail(),
          })),
          minimumSlot: floor,
          simulationBankSlot: bank,
          result: {
            ...normalized,
            value: {
              ...normalized.value,
              transactionResults: normalized.value.transactionResults.slice(1),
            },
          },
          bankAccounts,
        },
      },
      signal,
    );
    retained.settlement = settlement;
    const maximumFees = frames.frames.reduce(
      (sum, f) => sum + BigInt(f.maximumFeeLamports),
      0n,
    );
    if (
      BigInt(frames.frames[0].preAccounts[0]!.lamports) <
      BigInt(settlement.setup.createdRentLamports) +
        maximumFees +
        BigInt(settlement.walletBalances[0].tipLamports) +
        BigInt(settlement.walletBalances[0].requiredSystemRentLamports)
    )
      fail();
    // Aggregate anchor fee as well as unchanged setup/swap/tip settlement.
    const wallet = settlement.walletBalances[0],
      initial = frames.frames[0].preAccounts[0]!;
    if (
      BigInt(initial.lamports) - BigInt(wallet.finalLamports) !==
      BigInt(settlement.setup.createdRentLamports) +
        BigInt(wallet.networkFeeLamports) +
        BigInt(wallet.tipLamports) +
        BigInt(frames.frames[0].feeLamports)
    )
      fail();
    const wireAccount = (a: typeof initial | null) =>
      a === null
        ? null
        : {
            owner: a.owner,
            executable: a.executable,
            lamports: a.lamports,
            data: [Buffer.from(a.data).toString('base64'), 'base64'],
          };
    if (
      JSON.stringify(wireAccount(initial)) !==
      JSON.stringify({
        owner: fresh.rows[0]!.owner,
        executable: fresh.rows[0]!.executable,
        lamports: fresh.rows[0]!.lamports,
        data: fresh.rows[0]!.data,
      })
    )
      fail();
    const swapFrame = frames.frames[2];
    for (const key of [source, destination]) {
      const frame = key === destination ? frames.frames[1] : swapFrame;
      const a = frame.preAccounts[frame.keys.indexOf(key)];
      const raw = fresh.rows[stateKeys.indexOf(key)];
      if (
        key === destination &&
        raw === null &&
        a !== null &&
        a.owner === '11111111111111111111111111111111' &&
        !a.executable &&
        a.lamports === '0' &&
        a.data.length === 0
      )
        continue;
      if (
        JSON.stringify(wireAccount(a)) !==
        JSON.stringify(
          raw === null
            ? null
            : {
                owner: raw.owner,
                executable: raw.executable,
                lamports: raw.lamports,
                data: raw.data,
              },
        )
      )
        fail();
    }
    const afterFloor = Math.max(bank, ...attempt.fees!.fees.map((x) => x.slot));
    stage('second-code-scan');
    const last = await collectJitoCpmmSetupResearchRuntimeEvidence(
      keys,
      floor,
      afterFloor,
      signal,
      runtimeRpc,
    );
    retained.last = last;
    summary.runtimeProof = await verifyJitoCpmmSetupResearchRuntimeBracket(
      first,
      last,
      frames,
      signal,
    );
    stage('final-custody-and-mints');
    const finish = await Promise.allSettled([
      state(last.maximumSlot),
      recheckJitoCpmmLifetime(
        candidate.swapPacket,
        life,
        last.maximumSlot,
        signal,
      ),
    ]);
    if (finish[0].status !== 'fulfilled' || finish[1].status !== 'fulfilled')
      return fail();
    const after = finish[0].value,
      lifetime = finish[1].value;
    retained.after = after;
    summary.custodyRoles = await inspectJitoNativeTipCustody({
      tip: TIP,
      before: before.rows.slice(0, 4),
      after: after.rows.slice(0, 4),
    });
    for (const i of [4, 5])
      if (JSON.stringify(before.rows[i]) !== JSON.stringify(after.rows[i]))
        fail();
    for (const [i, mint] of [
      [6, WSOL],
      [7, USDC],
    ] as const) {
      const a = await inspectSwapMintAccount(before.rows[i], mint),
        b = await inspectSwapMintAccount(after.rows[i], mint);
      assertSameSwapMintEvidence(
        { slot: before.slot, mints: [a] },
        { slot: after.slot, mints: [b] },
      );
      if (
        !Buffer.from(
          swapFrame.preAccounts[swapFrame.keys.indexOf(mint)]!.data,
        ).equals(Buffer.from(after.rows[i]!.data[0], 'base64'))
      )
        fail();
    }
    if (
      JSON.stringify(before.rows[3]) !==
      JSON.stringify({
        owner: bankAccounts.before[1].owner,
        executable: bankAccounts.before[1].executable,
        lamports: bankAccounts.before[1].lamports,
        data: [bankAccounts.before[1].dataBase64, 'base64'],
        space: (before.rows[3] as Account & { space?: string }).space,
        rentEpoch: (before.rows[3] as Account & { rentEpoch?: string })
          .rentEpoch,
      })
    ) {
      // Compare semantic fields only: optional RPC metadata is not in frames.
      const r = before.rows[3]!;
      if (
        r.owner !== bankAccounts.before[1].owner ||
        r.executable !== bankAccounts.before[1].executable ||
        r.lamports !== bankAccounts.before[1].lamports ||
        r.data[0] !== bankAccounts.before[1].dataBase64
      )
        fail();
    }
    stage('independent-price');
    const prices = await markets;
    retained.markets = prices;
    if (prices.some((x) => x.status !== 'fulfilled')) fail();
    const observed = prices.map(
      (x) =>
        (
          x as PromiseFulfilledResult<
            Awaited<ReturnType<typeof observeTokenMarket>>
          >
        ).value,
    );
    const selected = observed.map(
      (x) =>
        x.pairs.find((p) => p.address !== POOL && p.priceUsd !== null)?.address,
    );
    if (selected.some((x) => !x)) fail();
    const supplied: PumpLaunchRpc = async (method, params, s) => {
      s.throwIfAborted();
      if (
        method !== 'getMultipleAccounts' ||
        JSON.stringify(params[0]) !== JSON.stringify([WSOL, USDC, PAIR_RENT]) ||
        (params[1] as { minContextSlot: number }).minContextSlot > bank
      )
        fail();
      return {
        context: { slot: String(bank) },
        value: [
          swapFrame.preAccounts[swapFrame.keys.indexOf(WSOL)],
          swapFrame.preAccounts[swapFrame.keys.indexOf(USDC)],
          frames.frames[0].preAccounts[4],
        ].map(wireAccount),
      };
    };
    const price = await readJitoCpmmPriceComparison(
      candidate.swapPacket,
      { inputPair: selected[0]!, outputPair: selected[1]! },
      floor,
      supplied,
      signal,
      {
        observe: async (source) => {
          const value = observed.find((x) => x.address === source.address);
          return value ?? fail();
        },
      },
    );
    summary.price = price;
    if (!price.available || price.acknowledgementRequired) fail();
    stage('lifetime-after');
    summary.lifetime = lifetime;
    const end = Number(
      await rpc(
        'getSlot',
        [
          {
            commitment: 'confirmed',
            minContextSlot: Math.max(lifetime.validitySlot, after.slot),
          },
        ],
        signal,
      ),
    );
    summary.maximumSlot = end;
    if (
      !Number.isSafeInteger(end) ||
      end < Math.max(lifetime.validitySlot, after.slot) ||
      end - floor > 32
    )
      fail();
    summary.slotSpan = end - floor;
    summary.status = 'unsigned-cpmm-checks-passed-provider-trust-required';
    summary.completeSwapEvidenceChecked = true;
    summary.fullSwapQualified = false;
  } catch (error) {
    retained.policyRefusal = jitoRuntimePolicyRefusal(error);
    summary.refusal =
      error instanceof Error
        ? error.message.replace(/https?:\/\/\S+/g, '[redacted]')
        : 'guard-refusal';
    summary.status = 'refused';
  }
  retained.stageTimings = timings;
  return retained;
}
