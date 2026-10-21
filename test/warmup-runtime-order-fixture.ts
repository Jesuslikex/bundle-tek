import { vi } from 'vitest';
import { nativeWarmupFixture } from './warmup-native-fixture';
import { pairQuoteClock } from './imported-pair-quote-fixture';
import { pairRentAccount } from './pair-rent-fixture';
import { PAIR_CLOCK } from '../lib/pair-mint-evidence';
import { PAIR_RENT } from '../lib/pair-rent-evidence';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';
import { assessWarmupSellInventory } from '../lib/warmup-sell-inventory';
import { walletWarmupRuntimeOrderRequestDigest } from '../lib/wallet-warmup-runtime-order';
import { formatNativeBalance } from '../lib/wallet-balance-format';
import type {
  WarmupRuntimeOrderRequest,
  WarmupRuntimeOrderDependencies,
} from '../lib/wallet-warmup-runtime-order';
const SYSTEM = '11111111111111111111111111111111',
  NATIVE_LOADER = 'NativeLoader1111111111111111111111111111111';
/** Protocol-shaped, wholly synthetic RPC. No network or real wallet action. */
export async function warmupRuntimeOrderFixture(
  options: Parameters<typeof nativeWarmupFixture>[0] = {},
) {
  const f = await nativeWarmupFixture(options),
    order = structuredClone(f.order),
    now = () => clock.now,
    clock = { now: Math.floor(Date.now() / 1000) * 1000 };
  order.observedAt = new Date(now()).toISOString();
  order.expiresAt = new Date(now() + 30000).toISOString();
  order.preparation.lastValidBlockHeight = '180';
  // The route's exact decoded account positions vary between v1 and v2. Use the
  // real instruction decoder to establish the map.
  const { reviewSwapInstructions } =
    await import('../lib/swap-instruction-review');
  const { assessJupiterRoute } =
    await import('../lib/jupiter-route-assessment');
  const route = assessJupiterRoute(
    reviewSwapInstructions(
      f.message,
      options?.lookup
        ? { writable: [f.keys[f.keys.length - 1]], readonly: [] }
        : undefined,
    ),
    order,
  );
  if (!route.decoded) throw Error('Fixture route decoding failed');
  const keys = [route.decoded.sourceAccount, route.decoded.destinationAccount];
  const accounts = new Map<string, unknown>([
    [
      f.wallet,
      {
        owner: SYSTEM,
        executable: false,
        lamports: '100000000',
        data: ['', 'base64'],
      },
    ],
    [keys[0], f.first[0]],
    [keys[1], f.first[1]],
    [order.inputMint, { ...f.mints[0], lamports: '10000000' }],
    [order.outputMint, { ...f.mints[1], lamports: '10000000' }],
    [PAIR_RENT, pairRentAccount(3480n, 2)],
  ]);
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
  for (const key of new Set([
    ...f.rawInstructions.map((i) => i.program),
    ...f.mints.map((m) => m.owner),
  ])) {
    const native =
      key === SYSTEM || key === 'ComputeBudget111111111111111111111111111111';
    const bytes = Uint8Array.from([
      127,
      69,
      76,
      70,
      programs.size + 1,
      ...new Uint8Array(251),
    ]);
    const a = {
      owner: native
        ? NATIVE_LOADER
        : 'BPFLoader2111111111111111111111111111111111',
      executable: true,
      lamports: '1000000',
      space: native ? '0' : String(bytes.length),
      data: [native ? '' : Buffer.from(bytes).toString('base64'), 'base64'],
    };
    programs.set(key, a);
    accounts.set(key, a);
  }
  if (options?.lookup) {
    const bytes = new Uint8Array(88),
      view = new DataView(bytes.buffer);
    view.setUint32(0, 1, true);
    view.setBigUint64(4, (1n << 64n) - 1n, true);
    view.setBigUint64(12, 80n, true);
    const bs58 = (await import('bs58')).default;
    bytes.set(bs58.decode(keys[1]), 56);
    accounts.set(String(f.message.addressTableLookups![0].lookupTableAddress), {
      owner: 'AddressLookupTab1e1111111111111111111111111',
      executable: false,
      lamports: '10000000',
      data: [Buffer.from(bytes).toString('base64'), 'base64'],
    });
  }
  // Synthetic provider metadata covers every newly created account, including
  // temporary wrapped SOL. The application refuses underestimated metadata.
  const rent = f.first.reduce(
    (sum, a, i) =>
      sum + (a === null ? BigInt(f.last[i]?.lamports ?? f.rent) : 0n),
    0n,
  );
  order.preparation.estimates.rentFeeLamports = rent.toString();
  order.preparation.estimatedFeesLamports = (5000n + rent).toString();
  const state = {
    slot: 100,
    clockDelta: 0,
    clockUnixDelta: 0,
    advance: 0,
    onRequest: null as null | ((method: string, params: unknown[]) => void),
    onSimulation: null as
      | null
      | ((
          value: { accounts: unknown[]; innerInstructions: unknown[] },
          addresses: string[],
        ) => void),
    onPrepare: null as null | (() => void),
  };
  const rpc = vi.fn(async (method: string, params: unknown[]) => {
    state.onRequest?.(method, params);
    const index = ['getSlot', 'getBlockHeight'].includes(method) ? 0 : 1,
      config = (params[index] ?? {}) as {
        minContextSlot?: number;
        dataSlice?: { offset: number; length: number };
        accounts?: { addresses: string[] };
      };
    const slot =
      Math.max(state.slot, config.minContextSlot ?? 100) + state.advance;
    const raw = (key: string) =>
      key === PAIR_CLOCK
        ? pairQuoteClock(
            slot + state.clockDelta,
            String(Math.floor(now() / 1000) + state.clockUnixDelta),
          )
        : structuredClone(accounts.get(key) ?? null);
    switch (method) {
      case 'getGenesisHash':
        return SOLANA_MAINNET_GENESIS;
      case 'getSlot':
        return String(slot);
      case 'getBlockHeight':
        return '100';
      case 'getFeeForMessage':
        return { context: { slot: String(slot) }, value: '5000' };
      case 'isBlockhashValid':
        return { context: { slot: String(slot) }, value: true };
      case 'getMultipleAccounts':
        return {
          context: { slot: String(slot) },
          value: (params[0] as string[]).map((key) => {
            const a = raw(key) as { data: string[] } | null;
            if (a && config.dataSlice)
              a.data[0] = Buffer.from(a.data[0], 'base64')
                .subarray(
                  config.dataSlice.offset,
                  config.dataSlice.offset + config.dataSlice.length,
                )
                .toString('base64');
            return a;
          }),
        };
      case 'simulateTransaction': {
        const addresses = config.accounts!.addresses;
        const value = {
          err: null,
          unitsConsumed: '100000',
          replacementBlockhash: null,
          fee: '5000',
          accounts: addresses.map((key) =>
            key === f.wallet
              ? {
                  owner: SYSTEM,
                  executable: false,
                  lamports: f.receipt.meta.postBalances[0],
                  data: ['', 'base64'],
                }
              : keys.includes(key)
                ? structuredClone(f.last[keys.indexOf(key)])
                : raw(key),
          ),
          innerInstructions: [
            {
              index: String(
                f.rawInstructions.findIndex(
                  (i) =>
                    i.program === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
                ),
              ),
              instructions: [
                {
                  programId: f.mints[0].owner,
                  program: 'spl-token',
                  parsed: {
                    type: 'transfer',
                    info: {
                      source: keys[0],
                      destination: keys[1],
                      authority: f.wallet,
                      amount: order.inAmount,
                    },
                  },
                  stackHeight: '2',
                },
              ],
            },
          ] as unknown[],
        };
        state.onSimulation?.(value, addresses);
        return { context: { slot: String(slot) }, value };
      }
      default:
        throw Error('Unexpected synthetic read method: ' + method);
    }
  });
  const prepare = vi.fn(async () => {
    state.onPrepare?.();
    return structuredClone(order);
  });
  const request: WarmupRuntimeOrderRequest = {
    requestSha256: 'a'.repeat(64),
    wallet: f.wallet,
    mint: f.mint,
    side: order.side,
    inputRaw: order.inAmount,
    feeAndRentLimitRaw: '10000000',
    deadline: now() + 60000,
    inventory:
      order.side === 'Buy'
        ? null
        : assessWarmupSellInventory(
            {
              chain: 'Solana',
              address: f.wallet,
              holdings: [
                {
                  mint: f.mint,
                  program: f.mints[0].owner,
                  decimals: 6,
                  raw: order.inAmount,
                  amount: formatNativeBalance(order.inAmount, 6),
                  accounts: [
                    {
                      address: keys[0],
                      raw: order.inAmount,
                      frozen: false,
                      extensions: Boolean(options?.token2022),
                      extensionTypes: options?.token2022
                        ? ['immutableOwner']
                        : [],
                    },
                  ],
                },
              ],
              minSlot: 100,
              maxSlot: 100,
              observedAt: new Date(now()).toISOString(),
              source: 'synthetic',
            },
            f.wallet,
            f.mint,
            formatNativeBalance(order.inAmount, 6),
            {
              mint: f.mint,
              program: f.mints[0].owner,
              decimals: 6,
              slot: 100,
              extensions: [],
            },
          ),
  };
  if (request.inventory)
    request.inventory.expiresAt = new Date(now() + 30000).toISOString();
  request.requestSha256 = await walletWarmupRuntimeOrderRequestDigest(request);
  const dependencies: WarmupRuntimeOrderDependencies = {
    apiKey: 'synthetic-key',
    signal: new AbortController().signal,
    rpc,
    programRpc: rpc,
    prepare,
    now,
  };
  return {
    ...f,
    order,
    clock,
    accounts,
    programs,
    state,
    rpc,
    prepare,
    request,
    dependencies,
  };
}
