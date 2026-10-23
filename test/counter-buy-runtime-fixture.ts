import {
  getCompiledTransactionMessageEncoder,
  getBase64Decoder,
} from '@solana/kit';
import { nativeWarmupFixture } from '../test/warmup-native-fixture';
import { reviewUnsignedSwapEnvelope } from '../lib/unsigned-swap-order';
import type { CounterBuyPreparation } from '../lib/counter-buy-preparation';
import { assessJupiterExactOutRoute } from '../lib/jupiter-exact-out-assessment';
import type { CounterSimulationRpc } from '../lib/counter-buy-simulation';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';
import { pairQuoteClock } from './imported-pair-quote-fixture';
import { pairRentAccount } from './pair-rent-fixture';
import { PAIR_CLOCK } from '../lib/pair-mint-evidence';
import { PAIR_RENT } from '../lib/pair-rent-evidence';
import { vi } from 'vitest';
import bs58 from 'bs58';
import { readSwapLookupAccounts } from '../lib/swap-lookup-accounts';
import { reviewSwapInstructions } from '../lib/swap-instruction-review';
/** Protocol-shaped ExactOut evidence; no provider endpoint or real wallet action. */
export async function counterBuyRuntimeFixture(
  options: {
    lookup?: boolean;
    payloadCount?: 99 | 100;
    mint?: string;
    tokenRaw?: bigint;
  } = {},
) {
  const f = await nativeWarmupFixture({ side: 'Buy', ...options }),
    message = structuredClone(f.message);
  const extraKeys = options.payloadCount
    ? Array.from({ length: options.payloadCount - f.keys.length }, (_, i) =>
        bs58.encode(new Uint8Array(32).fill(60 + i)),
      )
    : [];
  if (extraKeys.length) {
    if (!options.lookup) throw Error('Large synthetic scope requires lookup');
    (
      message.addressTableLookups![0] as { readonlyIndexes: number[] }
    ).readonlyIndexes = extraKeys.map((_, i) => i + 1);
  }
  const route = message.instructions.find(
    (i) =>
      String(message.staticAccounts[i.programAddressIndex]) ===
      'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  )!;
  const data = Uint8Array.from(route.data!),
    view = new DataView(data.buffer);
  data.set([176, 209, 105, 168, 154, 125, 69, 62]);
  const outputTargetRaw = (options.tokenRaw ?? 1000n).toString();
  view.setBigUint64(data.length - 19, BigInt(outputTargetRaw), true);
  view.setBigUint64(data.length - 11, 1000000n, true);
  route.data = data;
  const packet = getBase64Decoder().decode(
    Uint8Array.from([
      1,
      ...new Uint8Array(64),
      ...getCompiledTransactionMessageEncoder().encode(message),
    ]),
  );
  const envelope = await reviewUnsignedSwapEnvelope(packet, f.wallet),
    now = new Date().toISOString(),
    expiresAt = new Date(Date.now() + 30000).toISOString();
  const projectId = '00000000-0000-4000-8000-000000000001',
    planId = '00000000-0000-4000-8000-000000000002';
  const assessment = assessJupiterExactOutRoute(
    reviewSwapInstructions(
      message,
      options.lookup
        ? { writable: [f.keys[f.keys.length - 1]], readonly: extraKeys }
        : undefined,
    ),
    {
      swapMode: 'ExactOut',
      wallet: f.wallet,
      inputMint: f.order.inputMint,
      outputMint: f.mint,
      quotedInputRaw: '1000000',
      outputTargetRaw,
      maximumInputRaw: '1005000',
      reviewedInputBudgetRaw: '1005000',
      slippageBps: 50,
    },
  );
  const order: CounterBuyPreparation = {
    format: 'counter-buy-preparation-v1',
    executionAllowed: false,
    instructionsVerified: false,
    tokenDecimals: 6,
    quote: {
      format: 'counter-buy-target-quote-v1',
      executionAllowed: false,
      projectId,
      projectRevision: 1,
      planId,
      planRevision: 2,
      decisionIdentity: 'test-signal',
      inputMint: f.order.inputMint,
      outputMint: f.mint,
      outputTargetRaw,
      requiredSolInputRaw: '1000000',
      maximumSolInputRaw: '1005000',
      reviewedSolBudgetRaw: '1005000',
      swapMode: 'ExactOut',
      slippageBps: 50,
      contextSlot: 100,
      routes: [],
      source: 'api.jup.ag',
      observedAt: now,
      expiresAt,
      limitations: 'Synthetic quote.',
    },
    review: {
      format: 'counter-buy-instruction-review-v1',
      executionAllowed: false,
      projectId,
      projectRevision: 1,
      planId,
      planRevision: 2,
      decisionIdentity: 'test-signal',
      wallet: f.wallet,
      expiresAt,
      assessment,
      limitations: 'Synthetic review.',
    },
    preparation: {
      ...envelope,
      lastValidBlockHeight: '123456',
      estimatedFeesLamports: null,
      lookupAccounts: null,
    },
    observedAt: now,
    expiresAt,
    limitations: 'Synthetic unsigned preparation.',
  };
  const base = (lamports = '0') => ({
    owner: '11111111111111111111111111111111',
    executable: false,
    lamports,
    data: ['', 'base64'],
  });
  const mint = (decimals: number) => {
    const b = new Uint8Array(82);
    b[44] = decimals;
    b[45] = 1;
    return {
      owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      executable: false,
      lamports: '1461600',
      data: [btoa(String.fromCharCode(...b)), 'base64'],
    };
  };
  const keys = [
      ...message.staticAccounts.map(String),
      ...(options.lookup ? [f.keys[f.keys.length - 1], ...extraKeys] : []),
    ],
    before: unknown[] = keys.map(() => base()),
    post: unknown[] = keys.map(() => base()),
    e = f.simulation.settlementEvidence!;
  before[0] = base(e.before[0]);
  post[0] = base(e.after[0]);
  const source = keys.indexOf(f.simulation.accountBindings.accounts[0].address),
    destination = keys.indexOf(
      f.simulation.accountBindings.accounts[1].address,
    );
  before[source] = f.first[0];
  before[destination] = f.first[1];
  post[source] = f.last[0];
  post[destination] = f.last[1];
  for (const [key, decimals] of [
    [f.order.inputMint, 9],
    [f.mint, 6],
  ] as const) {
    const i = keys.indexOf(key);
    before[i] = mint(decimals);
    post[i] = mint(decimals);
  }
  const accounts = new Map(keys.map((key, i) => [key, before[i]]));
  const programs = new Map<
    string,
    {
      owner: string;
      executable: boolean;
      lamports: string;
      space: string;
      data: string[];
    }
  >();
  const programKeys = [
    ...new Set(
      message.instructions.map((i) =>
        String(message.staticAccounts[i.programAddressIndex]),
      ),
    ),
  ];
  for (const key of programKeys) {
    const native =
      key === '11111111111111111111111111111111' ||
      key === 'ComputeBudget111111111111111111111111111111';
    const bytes = Uint8Array.from([
      127,
      69,
      76,
      70,
      programs.size + 1,
      ...new Uint8Array(251),
    ]);
    const account = {
      owner: native
        ? 'NativeLoader1111111111111111111111111111111'
        : 'BPFLoader2111111111111111111111111111111111',
      executable: true,
      lamports: '1000000',
      space: native
        ? key.startsWith('ComputeBudget')
          ? '1'
          : '0'
        : String(bytes.length),
      data: [
        native
          ? key.startsWith('ComputeBudget')
            ? 'AQ=='
            : ''
          : Buffer.from(bytes).toString('base64'),
        'base64',
      ],
    };
    programs.set(key, account);
    accounts.set(key, account);
    const index = keys.indexOf(key);
    post[index] = structuredClone(account);
  }
  accounts.set(PAIR_RENT, pairRentAccount(3480n, 2));
  if (options.lookup) {
    const bytes = new Uint8Array(88 + extraKeys.length * 32),
      view = new DataView(bytes.buffer);
    view.setUint32(0, 1, true);
    view.setBigUint64(4, (1n << 64n) - 1n, true);
    view.setBigUint64(12, 80n, true);
    bytes.set(bs58.decode(keys[destination]), 56);
    extraKeys.forEach((key, i) => bytes.set(bs58.decode(key), 88 + i * 32));
    accounts.set(String(message.addressTableLookups![0].lookupTableAddress), {
      owner: 'AddressLookupTab1e1111111111111111111111111',
      executable: false,
      lamports: '10000000',
      data: [Buffer.from(bytes).toString('base64'), 'base64'],
    });
  }
  const clock = { now: Math.floor(Date.now() / 1000) * 1000 };
  const state = {
    slot: 100,
    advance: 0,
    clockDelta: 0,
    clockUnixDelta: 0,
    simulations: 0,
    onRequest: null as null | ((method: string, params: unknown[]) => void),
    onResult: null as
      | null
      | ((method: string, result: unknown, params: unknown[]) => unknown),
  };
  const rpc: CounterSimulationRpc = vi.fn(async (method, params, signal) => {
    signal.throwIfAborted();
    state.onRequest?.(method, params);
    const cfg = (params[
      ['getSlot', 'getBlockHeight'].includes(method) ? 0 : 1
    ] ?? {}) as {
      minContextSlot?: number;
      dataSlice?: { offset: number; length: number };
      accounts?: { addresses: string[] };
    };
    const slot =
      Math.max(state.slot, cfg.minContextSlot ?? 100) + state.advance;
    const read = (key: string) =>
      key === PAIR_CLOCK
        ? pairQuoteClock(
            slot + state.clockDelta,
            String(Math.floor(clock.now / 1000) + state.clockUnixDelta),
          )
        : structuredClone(accounts.get(key) ?? null);
    let result: unknown;
    if (method === 'getGenesisHash') result = SOLANA_MAINNET_GENESIS;
    else if (method === 'getSlot') result = String(slot);
    else if (method === 'getBlockHeight') result = '1000';
    else if (method === 'isBlockhashValid')
      result = { context: { slot: String(slot) }, value: true };
    else if (method === 'getMinimumBalanceForRentExemption') result = '2039280';
    else if (method === 'getFeeForMessage')
      result = { context: { slot: String(slot) }, value: '5000' };
    else if (method === 'getMultipleAccounts')
      result = {
        context: { slot: String(slot) },
        value: (params[0] as string[]).map((key) => {
          const account = read(key) as { data: string[] } | null;
          if (account && cfg.dataSlice)
            account.data[0] = Buffer.from(account.data[0], 'base64')
              .subarray(
                cfg.dataSlice.offset,
                cfg.dataSlice.offset + cfg.dataSlice.length,
              )
              .toString('base64');
          return account;
        }),
      };
    else if (method === 'simulateTransaction') {
      state.simulations++;
      result = {
        context: { slot: String(slot) },
        value: {
          err: null,
          accounts: cfg.accounts!.addresses.map((key) =>
            structuredClone(post[keys.indexOf(key)] ?? read(key)),
          ),
          unitsConsumed: '10000',
          fee: '5000',
          replacementBlockhash: null,
          innerInstructions: [
            {
              index: String(message.instructions.indexOf(route)),
              instructions: [
                {
                  programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                  program: 'spl-token',
                  parsed: {
                    type: 'transfer',
                    info: {
                      source: keys[source],
                      destination: keys[destination],
                      authority: f.wallet,
                      amount: '1000000',
                    },
                  },
                  stackHeight: '2',
                },
              ],
            },
          ],
        },
      };
    } else throw Error('Unexpected synthetic runtime method ' + method);
    return state.onResult ? state.onResult(method, result, params) : result;
  });
  if (options.lookup) {
    order.preparation.lookupAccounts = await readSwapLookupAccounts(
      message,
      100,
      (method, params) => rpc(method, params, new AbortController().signal),
    );
    vi.mocked(rpc).mockClear();
  }
  const upgrade = (key: string) => {
    const programData = bs58.encode(new Uint8Array(32).fill(42));
    const header = new Uint8Array(36);
    new DataView(header.buffer).setUint32(0, 2, true);
    header.set(bs58.decode(programData), 4);
    const program = {
      owner: 'BPFLoaderUpgradeab1e11111111111111111111111',
      executable: true,
      lamports: '1000000',
      space: '36',
      data: [Buffer.from(header).toString('base64'), 'base64'],
    };
    const bytes = new Uint8Array(301),
      view = new DataView(bytes.buffer);
    view.setUint32(0, 3, true);
    view.setBigUint64(4, 90n, true);
    bytes[12] = 1;
    bytes.set(new Uint8Array(32).fill(43), 13);
    bytes.set([127, 69, 76, 70, 1], 45);
    const deployment = {
      owner: program.owner,
      executable: false,
      lamports: '1000000',
      space: String(bytes.length),
      data: [Buffer.from(bytes).toString('base64'), 'base64'],
    };
    programs.set(key, program);
    accounts.set(key, program);
    accounts.set(programData, deployment);
    post[keys.indexOf(key)] = structuredClone(program);
    return { programData, deployment };
  };
  return {
    order,
    rpc,
    clock,
    state,
    programs,
    programKeys,
    accounts,
    keys,
    message,
    before,
    post,
    source,
    destination,
    upgrade,
  };
}
