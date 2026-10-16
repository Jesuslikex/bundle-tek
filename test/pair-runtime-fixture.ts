import { address } from '@solana/kit';
import { pairOrderFixture } from './pair-order-fixture';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';
import { PAIR_CLOCK } from '../lib/pair-mint-evidence';
import { pairQuoteClock } from './imported-pair-quote-fixture';
import type { ImportedPairRuntimeDependencies } from '../lib/imported-pair-runtime';
const BPF2 = 'BPFLoader2111111111111111111111111111111111';
export async function pairRuntimeFixture() {
  const f = await pairOrderFixture();
  const programs = new Map<
    string,
    {
      owner: string;
      executable: boolean;
      lamports: string;
      data: string[];
      space?: string;
    }
  >();
  for (const key of [
    'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    ...f.mints.map((m) => m.owner),
  ]) {
    const bytes = new Uint8Array(256);
    bytes.set([127, 69, 76, 70]);
    bytes[4] = programs.size + 1;
    programs.set(key, {
      owner: BPF2,
      executable: true,
      lamports: '1000000',
      space: String(bytes.length),
      data: [Buffer.from(bytes).toString('base64'), 'base64'],
    });
  }
  const state = {
    codeReads: 0,
    onCodeRead: null as null | ((key: string, read: number) => void),
    onTrace: null as null | ((trace: unknown[]) => unknown[]),
    onScan: null as null | ((keys: string[]) => void),
  };
  const originalRpc = f.rpc.getMockImplementation()!;
  const raw = (key: string) =>
    key === f.wallet
      ? f.state.walletAccount
      : (f.accounts[f.atas.indexOf(key)] ??
        f.orderState.otherAccounts.get(key) ??
        programs.get(key) ??
        null);
  const sliced = (
    account: unknown,
    config: { dataSlice?: { offset: number; length: number } },
  ) => {
    if (account === null) return null;
    const a = structuredClone(account) as { data: string[] };
    if (config.dataSlice) {
      const { offset, length } = config.dataSlice;
      a.data[0] = Buffer.from(a.data[0], 'base64')
        .subarray(offset, offset + length)
        .toString('base64');
    }
    return a;
  };
  const codeRpc: NonNullable<
    ImportedPairRuntimeDependencies['programRpc']
  > = async (method, params) => {
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method !== 'getMultipleAccounts') throw Error('Unexpected code RPC');
    const keys = params[0] as string[],
      config = params[1] as {
        minContextSlot: number;
        dataSlice: { offset: number; length: number };
      };
    return {
      context: { slot: String(config.minContextSlot) },
      value: keys.map((key) => {
        state.onCodeRead?.(key, ++state.codeReads);
        return sliced(programs.get(key) ?? null, config);
      }),
    };
  };
  f.rpc.mockImplementation(async (method, params) => {
    const config = params[1] as
      | {
          minContextSlot?: number;
          dataSlice?: { offset: number; length: number };
          innerInstructions?: boolean;
        }
      | undefined;
    if (
      method === 'getMultipleAccounts' &&
      config &&
      [45, 166].includes(config.dataSlice?.length ?? 0)
    ) {
      const keys = params[0] as string[];
      state.onScan?.(keys);
      return {
        context: { slot: String(config.minContextSlot) },
        value: keys.map((key) => sliced(raw(key), config)),
      };
    }
    const result = (await originalRpc(method, params)) as {
      context?: { slot: string };
      value?: { innerInstructions?: unknown };
    };
    if (result?.context && typeof config?.minContextSlot === 'number')
      result.context.slot = String(config.minContextSlot);
    if (
      method === 'getMultipleAccounts' &&
      (params[0] as string[]).includes(PAIR_CLOCK)
    ) {
      const response = result as unknown as { value: unknown[] };
      const slot = config!.minContextSlot!;
      for (const [i, key] of (params[0] as string[]).entries())
        if (key === PAIR_CLOCK)
          response.value[i] = pairQuoteClock(
            slot,
            String(Math.floor(f.clock.now / 1000)),
          );
    }
    if (method === 'simulateTransaction' && config?.innerInstructions) {
      const input = f.orderRequest;
      const message = await f.makeMessage({
        baseMint: f.baseMint,
        quoteMint: input.quoteMint,
        side: input.side,
        amountRaw: '1',
        wallet: f.wallet,
      });
      const route = message.instructions.findIndex(
        (ix) =>
          String(message.staticAccounts[ix.programAddressIndex]) ===
          'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      );
      const trace: unknown[] = [
        {
          index: String(route),
          instructions: [
            {
              programId: f.mints[1].owner,
              program: 'spl-token-2022',
              parsed: {
                type: 'transferChecked',
                info: {
                  source: f.atas[1],
                  destination: f.atas[0],
                  authority: f.wallet,
                  tokenAmount: {
                    amount: '1',
                    decimals: '8',
                    uiAmount: 0.00000001,
                  },
                },
              },
              stackHeight: '2',
            },
          ],
        },
      ];
      result.value!.innerInstructions = state.onTrace?.(trace) ?? trace;
    }
    return result;
  });
  const dependencies: ImportedPairRuntimeDependencies = {
    ...f.orderDependencies,
    programRpc: codeRpc,
  };
  return {
    ...f,
    programs,
    runtimeState: state,
    runtimeDependencies: dependencies,
    runtimeRequest: { ...f.orderRequest, inspectRuntime: true as const },
    addExecutable: (key: string) => {
      address(key);
      const sample = structuredClone(programs.values().next().value!);
      programs.set(key, sample);
    },
  };
}
