import { vi } from 'vitest';
import { address, getCompiledTransactionMessageEncoder } from '@solana/kit';
import { pairWalletFixture } from './pair-wallet-fixture';
import { routeMessage } from './jupiter-route-fixture';
import { prepareSolanaPair } from '../lib/warmup-swap-quote';
import { pairAssociatedAddress } from '../lib/pair-wallet-evidence';
import { PAIR_CLOCK } from '../lib/pair-mint-evidence';
import type {
  ImportedPairOrderRequest,
  ImportedPairOrderDependencies,
} from '../lib/imported-pair-order-candidate';
type Message = ReturnType<typeof routeMessage>;
export async function pairOrderFixture(side: 'Buy' | 'Sell' = 'Buy') {
  const f = await pairWalletFixture(side);
  const state = {
    v2: true,
    shared: false,
    feeRaw: '5000',
    height: '100',
    valid: true,
    otherAccounts: new Map<string, unknown>(),
    transform: null as null | ((m: Message) => Message),
    responsePatch: {} as Record<string, unknown>,
  };
  const originalRpc = f.rpc.getMockImplementation()!;
  f.rpc.mockImplementation(async (method, params) => {
    const config = params[1] as { minContextSlot?: number } | undefined;
    if (method === 'getBlockHeight') return state.height;
    if (method === 'getFeeForMessage')
      return {
        context: { slot: String(config!.minContextSlot! + 1) },
        value: state.feeRaw,
      };
    if (method === 'isBlockhashValid')
      return {
        context: { slot: String(config!.minContextSlot! + 1) },
        value: state.valid,
      };
    if (
      method === 'getMultipleAccounts' &&
      (params[0] as string[])[0] !== f.wallet &&
      !(params[0] as string[]).includes(PAIR_CLOCK)
    ) {
      return {
        context: { slot: String(config!.minContextSlot! + 1) },
        value: (params[0] as string[]).map((a) =>
          structuredClone(state.otherAccounts.get(a) ?? null),
        ),
      };
    }
    return originalRpc(method, params);
  });
  let currentInput: Parameters<typeof prepareSolanaPair>[0];
  const makeMessage = async (
    input: Parameters<typeof prepareSolanaPair>[0],
  ) => {
    const inputMint = input.side === 'Buy' ? input.quoteMint : input.baseMint,
      outputMint = input.side === 'Buy' ? input.baseMint : input.quoteMint;
    const program = (mint: string) =>
      mint === input.baseMint ? f.mints[0].owner : f.mints[1].owner;
    const asset = (mint: string) => ({
      address: mint,
      program: program(mint),
      decimals: 0,
      policySha256: '0'.repeat(64),
      amountPolicy: { kind: 'unscaled' as const },
      extensions: [],
      issuerControls: [],
    });
    const source = await pairAssociatedAddress(asset(inputMint), input.wallet),
      destination = await pairAssociatedAddress(
        asset(outputMint),
        input.wallet,
      );
    const base = routeMessage({
      v2: state.v2,
      shared: state.shared,
      amount: BigInt(input.amountRaw),
      output: 1000000n,
    });
    const keys = [
      input.wallet,
      source,
      destination,
      inputMint,
      outputMint,
      program(inputMint),
      'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    ];
    let outputProgram = 5;
    if (program(inputMint) !== program(outputMint)) {
      outputProgram = keys.length;
      keys.push(program(outputMint));
    }
    const accounts = state.v2
      ? state.shared
        ? [6, 0, 1, 1, 2, 2, 3, 4, 5, outputProgram, 6, 6]
        : [0, 1, 2, 3, 4, 5, outputProgram, 6, 6, 6]
      : state.shared
        ? [5, 6, 0, 1, 1, 2, 2, 3, 4, 6, 5]
        : [5, 0, 1, 2, 6, 4, 6];
    const message: Message = {
      ...base,
      staticAccounts: keys.map((a) => address(a)),
      header: { ...base.header, numReadonlyNonSignerAccounts: keys.length - 3 },
      instructions: [{ ...base.instructions[0], accountIndices: accounts }],
    };
    return state.transform?.(message) ?? message;
  };
  const fetcher = vi.fn(
    async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) => {
      const input = currentInput,
        message = await makeMessage(input);
      const transaction = btoa(
        String.fromCharCode(
          ...Uint8Array.from([
            1,
            ...new Uint8Array(64),
            ...getCompiledTransactionMessageEncoder().encode(message),
          ]),
        ),
      );
      return Response.json({
        inputMint: input.side === 'Buy' ? input.quoteMint : input.baseMint,
        outputMint: input.side === 'Buy' ? input.baseMint : input.quoteMint,
        inAmount: input.amountRaw,
        outAmount: '1000000',
        otherAmountThreshold: '995000',
        swapMode: 'ExactIn',
        slippageBps: 50,
        router: 'metis',
        taker: input.wallet,
        gasless: false,
        transactionVersion: 0,
        transaction,
        lastValidBlockHeight: '180',
        signatureFeeLamports: 5000,
        signatureFeePayer: input.wallet,
        prioritizationFeeLamports: 0,
        prioritizationFeePayer: null,
        rentFeeLamports: 0,
        rentFeePayer: null,
        ...state.responsePatch,
      });
    },
  );
  const prepare = vi.fn(
    async (
      input: Parameters<typeof prepareSolanaPair>[0],
      signal: AbortSignal,
    ) => {
      currentInput = input;
      const order = await prepareSolanaPair(
        input,
        'isolated-test-only',
        signal,
        fetcher as typeof fetch,
      );
      return {
        ...order,
        observedAt: new Date(f.clock.now).toISOString(),
        expiresAt: new Date(f.clock.now + 30000).toISOString(),
      };
    },
  );
  const dependencies: ImportedPairOrderDependencies = {
    ...f.dependencies,
    prepare,
  };
  const request: ImportedPairOrderRequest = {
    ...f.walletRequest,
    prepareUnsigned: true,
  };
  return {
    ...f,
    orderState: state,
    orderFetcher: fetcher,
    prepare,
    orderDependencies: dependencies,
    orderRequest: request,
    makeMessage,
  };
}
