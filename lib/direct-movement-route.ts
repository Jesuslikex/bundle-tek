import schema from './movement-route-schema.json';
import type { MovementInstruction } from './tracked-wallet-transaction';
import { walletAddress } from './wallet-workspace';
type Bound =
  | 'input-exact'
  | 'input-maximum'
  | 'output-exact'
  | 'output-minimum';
type Variant = {
  name: string;
  discriminator: string;
  bytes: number;
  accountCount: number;
  authority: number;
  source: number;
  destination: number;
  incoming: number[];
  outgoing: number[];
  first: string;
  second: string;
  tokenPrograms: number[];
  inputMint?: number;
  outputMint?: number;
};
export type DirectMovementRoute = {
  protocol: 'PumpSwap' | 'Raydium AMM v4' | 'Raydium CPMM';
  authority: string;
  source: string;
  destination: string;
  incoming: string[];
  outgoing: string[];
  inputMint?: string;
  outputMint?: string;
  bounds: { kind: Bound; raw: bigint }[];
};
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const DIRECT_MOVEMENT_PROGRAMS = new Set(
  schema.programs.map((p) => p.program),
);
export function decodeDirectMovementRoute(
  instruction: MovementInstruction,
): DirectMovementRoute | null {
  const program = schema.programs.find(
    (p) => p.program === instruction.program,
  );
  const hex = instruction.dataHex,
    accounts = instruction.accounts;
  if (
    !program ||
    !instruction.topLevel ||
    !hex ||
    !/^(?:[a-f0-9]{2})+$/.test(hex) ||
    !accounts ||
    accounts.length > 64
  )
    return null;
  const variant: Variant | undefined = program.variants.find(
    (v) =>
      hex.startsWith(v.discriminator) &&
      (program.name === 'PumpSwap'
        ? accounts.length >= v.accountCount
        : accounts.length === v.accountCount),
  );
  if (
    !variant ||
    hex.length !== variant.bytes * 2 ||
    (program.name === 'PumpSwap'
      ? accounts.length < variant.accountCount
      : accounts.length !== variant.accountCount)
  )
    return null;
  try {
    accounts.forEach((a) => walletAddress(a, 'Solana'));
    if (
      variant.tokenPrograms.some(
        (i) =>
          ![
            TOKEN,
            ...(program.name !== 'Raydium AMM v4' ? [TOKEN2022] : []),
          ].includes(accounts[i]),
      )
    )
      return null;
    const bytes = Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16));
    const offset = variant.discriminator.length / 2;
    if (variant.bytes > offset + 16 && bytes[offset + 16] > 1) return null;
    const view = new DataView(bytes.buffer),
      first = view.getBigUint64(offset, true),
      second = view.getBigUint64(offset + 8, true);
    const source = accounts[variant.source],
      destination = accounts[variant.destination];
    if (
      source === destination ||
      !first ||
      ((variant.first === 'output-exact' ||
        variant.second === 'output-exact') &&
        !second)
    )
      return null;
    return {
      protocol: program.name as DirectMovementRoute['protocol'],
      authority: accounts[variant.authority],
      source,
      destination,
      incoming: variant.incoming.map((i) => accounts[i]),
      outgoing: variant.outgoing.map((i) => accounts[i]),
      ...(variant.inputMint === undefined
        ? {}
        : { inputMint: accounts[variant.inputMint] }),
      ...(variant.outputMint === undefined
        ? {}
        : { outputMint: accounts[variant.outputMint] }),
      bounds: [
        { kind: variant.first as Bound, raw: first },
        { kind: variant.second as Bound, raw: second },
      ],
    };
  } catch {
    return null;
  }
}
export function directMovementAmountsMatch(
  route: DirectMovementRoute,
  input: bigint,
  output: bigint,
) {
  return (
    input > 0n &&
    output > 0n &&
    route.bounds.every((bound) => {
      switch (bound.kind) {
        case 'input-exact':
          return input === bound.raw;
        case 'input-maximum':
          return input <= bound.raw;
        case 'output-exact':
          return output === bound.raw;
        case 'output-minimum':
          return output >= bound.raw;
      }
    })
  );
}
