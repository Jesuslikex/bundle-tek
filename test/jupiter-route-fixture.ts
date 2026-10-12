import bs58 from 'bs58';
import { address, getCompiledTransactionMessageDecoder } from '@solana/kit';
import { solanaTransferMessage } from '../lib/solana-funding';
import { reviewSwapInstructions } from '../lib/swap-instruction-review';
export const routeWallet = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
export const routeOrder = {
  inputMint: 'So11111111111111111111111111111111111111112',
  outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  inAmount: '1000000',
  outAmount: '1000',
  minimumOutAmount: '995',
  slippageBps: 50,
  preparation: { wallet: routeWallet },
};
export function routeMessage(
  options: {
    shared?: boolean;
    v2?: boolean;
    positiveFee?: number;
    amount?: bigint;
    output?: bigint;
    slippage?: number;
    fee?: number;
    variant?: number;
    variantData?: number[];
    alter?: (bytes: Uint8Array) => Uint8Array;
    accountIndices?: number[];
    unknownProgram?: boolean;
  } = {},
) {
  const shared = options.shared !== false;
  const v2 = options.v2 === true;
  const prefix = shared
    ? v2
      ? 'd19853937cfed8e9'
      : 'c1209b3341d69c81'
    : v2
      ? 'bb64facc31c4af14'
      : 'e517cb977ae3ad2a';
  const trailer = new Uint8Array(v2 ? 22 : 19),
    view = new DataView(trailer.buffer);
  view.setBigUint64(0, options.amount ?? 1000000n, true);
  view.setBigUint64(8, options.output ?? 1000n, true);
  view.setUint16(16, options.slippage ?? 50, true);
  if (v2) {
    view.setUint16(18, options.fee ?? 0, true);
    view.setUint16(20, options.positiveFee ?? 0, true);
  } else trailer[18] = options.fee ?? 0;
  let bytes: Uint8Array = Uint8Array.from([
    ...prefix.match(/../g)!.map((b) => parseInt(b, 16)),
    ...(shared ? [0] : []),
    ...(v2 ? trailer : []),
    1,
    0,
    0,
    0,
    options.variant ?? 7,
    ...(options.variantData ?? []),
    ...(v2 ? [16, 39] : [100]),
    0,
    1,
    ...(v2 ? [] : trailer),
  ]);
  bytes = options.alter?.(bytes) ?? bytes;
  const other = bs58.encode(new Uint8Array(32).fill(2)),
    destination = bs58.encode(new Uint8Array(32).fill(3));
  const base = getCompiledTransactionMessageDecoder().decode(
    Uint8Array.from([
      128,
      ...solanaTransferMessage(
        routeWallet,
        other,
        '11111111111111111111111111111111',
        1n,
      ),
      0,
    ]),
  );
  if (base.version !== 0) throw new Error('Invalid route fixture');
  const staticAccounts = [
    routeWallet,
    other,
    destination,
    routeOrder.inputMint,
    routeOrder.outputMint,
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    options.unknownProgram
      ? '11111111111111111111111111111111'
      : 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  ].map((a) => address(a));
  return {
    ...base,
    header: {
      numSignerAccounts: 1,
      numReadonlySignerAccounts: 0,
      numReadonlyNonSignerAccounts: 4,
    },
    staticAccounts,
    instructions: [
      {
        programAddressIndex: 6,
        accountIndices:
          options.accountIndices ??
          (v2
            ? shared
              ? [6, 0, 1, 1, 2, 2, 3, 4, 5, 5, 6, 6]
              : [0, 1, 2, 3, 4, 5, 5, 6, 6, 6]
            : shared
              ? [5, 6, 0, 1, 1, 2, 2, 3, 4, 6, 5]
              : [5, 0, 1, 2, 6, 4, 6]),
        data: bytes,
      },
    ],
  };
}
export function routeReview(options: Parameters<typeof routeMessage>[0] = {}) {
  return reviewSwapInstructions(routeMessage(options));
}
