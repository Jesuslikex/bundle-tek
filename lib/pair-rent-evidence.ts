export const PAIR_RENT = 'SysvarRent111111111111111111111111111111111';
const OWNER = 'Sysvar1111111111111111111111111111111111111';
export type PairRentEvidence = {
  lamportsPerByte: string;
  exemptionThreshold: 1 | 2;
  burnPercent: number;
  dataBase64: string;
};
/** Only the SDK's exact integer profiles are admitted. Unknown floating-point profiles fail closed. */
export function inspectPairRentAccount(raw: unknown): PairRentEvidence {
  const a = raw as {
    owner?: unknown;
    executable?: unknown;
    lamports?: unknown;
    space?: unknown;
    data?: unknown;
  };
  if (
    !a ||
    a.owner !== OWNER ||
    a.executable !== false ||
    typeof a.lamports !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(a.lamports) ||
    BigInt(a.lamports) > (1n << 64n) - 1n ||
    (a.space !== undefined && a.space !== '17') ||
    !Array.isArray(a.data) ||
    a.data.length !== 2 ||
    a.data[1] !== 'base64' ||
    typeof a.data[0] !== 'string' ||
    a.data[0].length !== 24
  )
    throw Error('Pair Rent account envelope is unavailable.');
  const text = atob(a.data[0]);
  if (text.length !== 17 || btoa(text) !== a.data[0])
    throw Error('Pair Rent account encoding differs.');
  const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0)),
    view = new DataView(bytes.buffer),
    rate = view.getBigUint64(0, true),
    threshold = view.getFloat64(8, true),
    burn = bytes[16];
  if (
    (threshold !== 1 && threshold !== 2) ||
    burn > 100 ||
    rate > (threshold === 1 ? 1759197129867n : 879598564933n)
  )
    throw Error('Pair Rent profile is unsupported.');
  return {
    lamportsPerByte: rate.toString(),
    exemptionThreshold: threshold,
    burnPercent: burn,
    dataBase64: a.data[0],
  };
}
/** Solana storage overhead is 128 bytes; Bank applies a one-lamport minimum even for free rent. */
export function pairRentMinimumRaw(rent: PairRentEvidence, size: number) {
  if (!Number.isSafeInteger(size) || size < 0 || size > 4096)
    throw Error('Pair rent account size is unsupported.');
  const value =
    (128n + BigInt(size)) *
    BigInt(rent.lamportsPerByte) *
    BigInt(rent.exemptionThreshold);
  if (value > (1n << 64n) - 1n)
    throw Error('Pair rent minimum exceeds raw units.');
  return (value < 1n ? 1n : value).toString();
}
