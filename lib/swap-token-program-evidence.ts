import { withdrawalExtensions } from './token-withdrawal-extensions';
export const SWAP_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const SWAP_TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const SWAP_WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
export const SWAP_TOKEN_2022_ACCOUNT_SIZE = 170;
export function supportedSwapTokenProgram(value: unknown): value is string {
  return value === SWAP_TOKEN || value === SWAP_TOKEN_2022;
}
export function swapTokenBytes(raw: unknown, mint: boolean) {
  const account = raw as {
    owner?: unknown;
    executable?: unknown;
    data?: unknown;
  };
  if (
    !account ||
    !supportedSwapTokenProgram(account.owner) ||
    account.executable !== false ||
    !Array.isArray(account.data) ||
    account.data.length !== 2 ||
    account.data[1] !== 'base64' ||
    typeof account.data[0] !== 'string' ||
    account.data[0].length > 21848
  )
    throw new Error('Unsupported swap token account metadata.');
  const text = atob(account.data[0]);
  if (
    btoa(text) !== account.data[0] ||
    text.length < (mint ? 82 : 165) ||
    text.length > 16384
  )
    throw new Error('Noncanonical swap token account bytes.');
  const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
  const extensions = withdrawalExtensions(bytes, account.owner, mint);
  if (
    extensions.some(
      (e) =>
        !(
          mint ? ['MetadataPointer', 'TokenMetadata'] : ['ImmutableOwner']
        ).includes(e.__kind),
    )
  )
    throw new Error(
      'Swap token extension requires a separate settlement adapter.',
    );
  return {
    bytes,
    program: account.owner,
    extensions: extensions.map((e) => e.__kind),
  };
}
export type SwapMintEvidence = {
  slot: number;
  mints: {
    address: string;
    program: string;
    decimals: number;
    policySha256: string;
  }[];
};
export type SwapToken2022Evidence = SwapMintEvidence & {
  format: 'swap-token-2022-evidence-v1';
  recheckSlot: number;
  accountSize: 170;
  rentLamports: string;
};
type Pair = { inputMint: string; outputMint: string };
type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
export async function readSwapMintEvidence(
  order: Pair,
  minContextSlot: number,
  rpc: Rpc,
): Promise<SwapMintEvidence> {
  if (
    !Number.isSafeInteger(minContextSlot) ||
    minContextSlot < 0 ||
    order.inputMint === order.outputMint
  )
    throw new Error('Invalid swap mint observation scope.');
  const addresses = [order.inputMint, order.outputMint];
  const result = (await rpc('getMultipleAccounts', [
    addresses,
    { encoding: 'base64', commitment: 'confirmed', minContextSlot },
  ])) as { context?: { slot?: unknown }; value?: unknown[] };
  if (
    typeof result?.context?.slot !== 'string' ||
    !/^(0|[1-9]\d{0,15})$/.test(result.context.slot) ||
    !Number.isSafeInteger(Number(result.context.slot)) ||
    Number(result.context.slot) < minContextSlot ||
    Number(result.context.slot) > minContextSlot + 32 ||
    !Array.isArray(result.value) ||
    result.value.length !== 2
  )
    throw new Error('Inconsistent swap mint observation.');
  const mints = await Promise.all(
    result.value.map(async (raw, index) => {
      const { bytes, program } = swapTokenBytes(raw, true),
        view = new DataView(bytes.buffer);
      if (
        bytes[45] !== 1 ||
        bytes[44] > 18 ||
        view.getUint32(0, true) > 1 ||
        view.getUint32(46, true) > 1 ||
        (addresses[index] === SWAP_WRAPPED_SOL &&
          (program !== SWAP_TOKEN || bytes[44] !== 9))
      )
        throw new Error('Unsupported swap mint identity.');
      // Supply changes do not change transfer policy. Keep program, precision,
      // authorities and every extension byte bound while allowing routine mint/burns.
      const policy = Uint8Array.from(bytes);
      policy.fill(0, 36, 44);
      const digest = await crypto.subtle.digest('SHA-256', policy.buffer);
      return {
        address: addresses[index],
        program,
        decimals: bytes[44],
        policySha256: Array.from(new Uint8Array(digest), (b) =>
          b.toString(16).padStart(2, '0'),
        ).join(''),
      };
    }),
  );
  return { slot: Number(result.context.slot), mints };
}
export function assertSameSwapMintEvidence(
  before: SwapMintEvidence,
  after: SwapMintEvidence,
) {
  if (
    after.slot < before.slot ||
    after.slot > before.slot + 32 ||
    JSON.stringify(before.mints) !== JSON.stringify(after.mints)
  )
    throw new Error(
      'Swap mint programs or extension bytes changed during simulation.',
    );
}
/** This proof is produced by fresh server reads. It does not itself authorize a signature. */
export function swapToken2022Programs(
  value: SwapToken2022Evidence,
  order: Pair,
  simulationSlot?: number,
) {
  if (
    !value ||
    value.format !== 'swap-token-2022-evidence-v1' ||
    value.accountSize !== SWAP_TOKEN_2022_ACCOUNT_SIZE ||
    !Number.isSafeInteger(value.slot) ||
    value.slot < 0 ||
    !Number.isSafeInteger(value.recheckSlot) ||
    value.recheckSlot < value.slot ||
    value.recheckSlot > value.slot + 32 ||
    (simulationSlot !== undefined &&
      (value.slot > simulationSlot || value.recheckSlot < simulationSlot)) ||
    typeof value.rentLamports !== 'string' ||
    !/^[1-9]\d{0,6}$/.test(value.rentLamports) ||
    BigInt(value.rentLamports) > 3000000n ||
    !Array.isArray(value.mints) ||
    value.mints.length !== 2 ||
    order.inputMint === order.outputMint
  )
    throw new Error('Token-2022 swap proof is incomplete.');
  for (const [index, mint] of value.mints.entries())
    if (
      mint.address !== [order.inputMint, order.outputMint][index] ||
      !supportedSwapTokenProgram(mint.program) ||
      !Number.isInteger(mint.decimals) ||
      mint.decimals < 0 ||
      mint.decimals > 18 ||
      !/^[a-f0-9]{64}$/.test(mint.policySha256) ||
      (mint.address === SWAP_WRAPPED_SOL &&
        (mint.program !== SWAP_TOKEN || mint.decimals !== 9))
    )
      throw new Error('Token-2022 swap proof identity differs.');
  if (
    !value.mints.some((m) => m.program === SWAP_TOKEN_2022) ||
    !value.mints.some((m) => m.address === SWAP_WRAPPED_SOL)
  )
    throw new Error('Token-2022 swap proof requires a supported native pair.');
  return new Map(value.mints.map((m) => [m.address, m.program]));
}
