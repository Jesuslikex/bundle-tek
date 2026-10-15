import { vi } from 'vitest';
import { address, getCompiledTransactionMessageEncoder } from '@solana/kit';
import { pairWalletFixture } from './pair-wallet-fixture';
import { routeMessage } from './jupiter-route-fixture';
import { prepareSolanaPair } from '../lib/warmup-swap-quote';
import { pairAssociatedAddress } from '../lib/pair-wallet-evidence';
import { PAIR_CLOCK } from '../lib/pair-mint-evidence';
import { pairWalletTokenAccount } from './pair-wallet-fixture';
import { requiredPairAccountExtensions } from '../lib/pair-wallet-evidence';
import {
  SWAP_TOKEN,
  SWAP_WRAPPED_SOL,
} from '../lib/swap-token-program-evidence';
import type {
  ImportedPairOrderRequest,
  ImportedPairOrderDependencies,
} from '../lib/imported-pair-order-candidate';
type Message = ReturnType<typeof routeMessage>;
type Simulated = {
  context: { slot: string };
  value: {
    err: unknown;
    unitsConsumed: string;
    fee?: string;
    replacementBlockhash: unknown;
    accounts: unknown[];
  };
};
export async function pairOrderFixture(side: 'Buy' | 'Sell' = 'Buy') {
  const f = await pairWalletFixture(side);
  const state = {
    v2: true,
    shared: false,
    feeRaw: '5000',
    height: '100',
    valid: true,
    closedAsNull: false,
    otherAccounts: new Map<string, unknown>(),
    transform: null as null | ((m: Message) => Message),
    responsePatch: {} as Record<string, unknown>,
    onSimulation: null as
      | null
      | ((response: Simulated, addresses: string[]) => void),
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
    if (method === 'simulateTransaction') {
      const settings = params[1] as {
        minContextSlot: number;
        accounts: { addresses: string[] };
      };
      const addresses = settings.accounts.addresses;
      const inputMint =
        currentInput.side === 'Buy'
          ? currentInput.quoteMint
          : currentInput.baseMint;
      const outputMint =
        currentInput.side === 'Buy'
          ? currentInput.baseMint
          : currentInput.quoteMint;
      const raw = (key: string) =>
        key === f.wallet
          ? f.state.walletAccount
          : (f.accounts[f.atas.indexOf(key)] ??
            state.otherAccounts.get(key) ??
            null);
      const post = new Map(
        addresses.map((key) => [key, structuredClone(raw(key))]),
      );
      let walletDelta = -BigInt(state.feeRaw);
      for (const [i, mint] of [inputMint, outputMint].entries()) {
        const program =
          mint === SWAP_WRAPPED_SOL
            ? SWAP_TOKEN
            : mint === currentInput.baseMint
              ? f.mints[0].owner
              : f.mints[1].owner;
        const key =
          mint === SWAP_WRAPPED_SOL
            ? String(lastMessage.staticAccounts[i + 1])
            : await pairAssociatedAddress(
                { ...f.mintEvidence.mints[0], address: mint, program },
                f.wallet,
              );
        const prior = raw(key) as ReturnType<
          typeof pairWalletTokenAccount
        > | null;
        const closed = lastMessage.instructions.some(
          (instruction) =>
            String(
              lastMessage.staticAccounts[instruction.programAddressIndex],
            ) === SWAP_TOKEN &&
            instruction.data?.length === 1 &&
            instruction.data[0] === 9 &&
            String(
              lastMessage.staticAccounts[instruction.accountIndices![0]],
            ) === key,
        );
        const native = mint === SWAP_WRAPPED_SOL;
        let next = structuredClone(prior);
        if (native) {
          walletDelta +=
            i === 0 ? -BigInt(lastOrder.inAmount) : BigInt(lastOrder.outAmount);
          if (closed) {
            post.set(
              key,
              state.closedAsNull
                ? null
                : {
                    owner: '11111111111111111111111111111111',
                    executable: false,
                    lamports: '0',
                    data: ['', 'base64'],
                  },
            );
            walletDelta += BigInt(prior?.lamports ?? '0');
            continue;
          }
        }
        if (!next) {
          const metadata = f.mintEvidence.mints.find(
            (m) => m.address === mint,
          )!;
          const program = native
            ? SWAP_TOKEN
            : mint === currentInput.baseMint
              ? f.mints[0].owner
              : f.mints[1].owner;
          next = pairWalletTokenAccount(
            mint,
            f.wallet,
            program,
            '0',
            program === SWAP_TOKEN
              ? []
              : requiredPairAccountExtensions(metadata),
          );
          const size = atob(next.data[0]).length;
          next.lamports =
            f.state.rentBySize.get(size) ?? String(1000 + size * 10);
          walletDelta -= BigInt(next.lamports);
          if (native) {
            const bytes = Uint8Array.from(atob(next.data[0]), (c) =>
              c.charCodeAt(0),
            );
            const v = new DataView(bytes.buffer);
            v.setUint32(109, 1, true);
            v.setBigUint64(113, BigInt(next.lamports), true);
            next.data[0] = btoa(String.fromCharCode(...bytes));
          }
        }
        if (!native) {
          const bytes = Uint8Array.from(atob(next.data[0]), (c) =>
            c.charCodeAt(0),
          );
          const v = new DataView(bytes.buffer);
          v.setBigUint64(
            64,
            v.getBigUint64(64, true) +
              (i === 0
                ? -BigInt(lastOrder.inAmount)
                : BigInt(lastOrder.outAmount)),
            true,
          );
          next.data[0] = btoa(String.fromCharCode(...bytes));
        }
        post.set(key, next);
      }
      const wallet = post.get(f.wallet) as NonNullable<
        typeof f.state.walletAccount
      >;
      wallet.lamports = (BigInt(wallet.lamports) + walletDelta).toString();
      const response: Simulated = {
        context: { slot: String(settings.minContextSlot + 1) },
        value: {
          err: null,
          unitsConsumed: '100000',
          replacementBlockhash: null,
          accounts: addresses.map((key) => post.get(key)),
        },
      };
      state.onSimulation?.(response, addresses);
      return response;
    }
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
    const result = await originalRpc(method, params);
    if (
      method === 'getMultipleAccounts' &&
      (params[0] as string[])[0] === f.wallet
    ) {
      const response = result as { value: unknown[] };
      response.value = (params[0] as string[]).map((key, i) =>
        state.otherAccounts.has(key)
          ? structuredClone(state.otherAccounts.get(key))
          : response.value[i],
      );
    }
    return result;
  });
  let currentInput: Parameters<typeof prepareSolanaPair>[0];
  let lastMessage: Message;
  let lastOrder: Awaited<ReturnType<typeof prepareSolanaPair>>;
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
      lastMessage = message;
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
      lastOrder = order;
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
