import { snapshotJitoEvidence } from './jito-evidence-json';
/** Exact-input classic SPL math from the referenced Raydium CPMM source.
 * This calculation alone authenticates neither source binary, pool nor quote. */
const U64 = (1n << 64n) - 1n;
const DENOMINATOR = 1000000n;
const fail = (): never => {
  throw Error('CPMM constant-product quote refused.');
};
function uint(value: unknown, positive = false) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value))
    return fail();
  const n = BigInt(value);
  if (n > U64 || (positive && n === 0n)) return fail();
  return n;
}
export function calculateJitoCpmmConstantProduct(input: {
  inputRaw: string;
  minimumOutputRaw: string;
  inputReserveRaw: string;
  outputReserveRaw: string;
  tradeFeeMillionths: string;
  protocolFeeMillionths: string;
  fundFeeMillionths: string;
}) {
  input = snapshotJitoEvidence(input, 1024);
  if (
    !input ||
    Object.keys(input).length !== 7 ||
    ![
      'inputRaw',
      'minimumOutputRaw',
      'inputReserveRaw',
      'outputReserveRaw',
      'tradeFeeMillionths',
      'protocolFeeMillionths',
      'fundFeeMillionths',
    ].every((k) => Object.hasOwn(input, k))
  )
    return fail();
  const amount = uint(input.inputRaw, true),
    minimum = uint(input.minimumOutputRaw, true),
    x = uint(input.inputReserveRaw, true),
    y = uint(input.outputReserveRaw, true);
  const trade = uint(input.tradeFeeMillionths),
    protocol = uint(input.protocolFeeMillionths),
    fund = uint(input.fundFeeMillionths);
  if (
    trade >= DENOMINATOR ||
    protocol > DENOMINATOR ||
    fund > DENOMINATOR ||
    protocol + fund > DENOMINATOR ||
    x + amount > U64
  )
    return fail();
  const tradeFee = (amount * trade + DENOMINATOR - 1n) / DENOMINATOR;
  if (tradeFee >= amount) return fail();
  const net = amount - tradeFee,
    output = (net * y) / (x + net);
  if (
    output === 0n ||
    output < minimum ||
    output >= y ||
    (x + net) * (y - output) < x * y
  )
    return fail();
  return {
    inputRaw: amount.toString(),
    minimumOutputRaw: minimum.toString(),
    expectedOutputRaw: output.toString(),
    tradeFeeRaw: tradeFee.toString(),
    protocolFeeRaw: ((tradeFee * protocol) / DENOMINATOR).toString(),
    fundFeeRaw: ((tradeFee * fund) / DENOMINATOR).toString(),
    sourceAuthenticated: false as const,
    priceVerified: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
