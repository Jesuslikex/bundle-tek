import { snapshotJitoEvidence } from './jito-evidence-json';
const U64 = (1n << 64n) - 1n,
  DENOMINATOR = 1000000n;
const fail = (): never => {
  throw Error('Current CPMM quote refused.');
};
function uint(v: unknown, positive = false) {
  if (typeof v !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(v)) return fail();
  const n = BigInt(v);
  if (n > U64 || (positive && n === 0n)) return fail();
  return n;
}
/** Modeled against locally matched source f4b9b263. Not a provider or signing approval. */
export function calculateJitoCpmmCurrentQuote(input: {
  inputRaw: string;
  minimumOutputRaw: string;
  inputReserveRaw: string;
  outputReserveRaw: string;
  tradeFeeMillionths: string;
  creatorFeeMillionths: string;
  protocolFeeMillionths: string;
  fundFeeMillionths: string;
  creatorFeeOnInput: boolean;
}) {
  input = snapshotJitoEvidence(input, 2048);
  const fields = [
    'inputRaw',
    'minimumOutputRaw',
    'inputReserveRaw',
    'outputReserveRaw',
    'tradeFeeMillionths',
    'creatorFeeMillionths',
    'protocolFeeMillionths',
    'fundFeeMillionths',
    'creatorFeeOnInput',
  ];
  if (
    !input ||
    Object.keys(input).length !== fields.length ||
    !fields.every((k) => Object.hasOwn(input, k)) ||
    typeof input.creatorFeeOnInput !== 'boolean'
  )
    return fail();
  const amount = uint(input.inputRaw, true),
    minimum = uint(input.minimumOutputRaw, true),
    x = uint(input.inputReserveRaw, true),
    y = uint(input.outputReserveRaw, true),
    trade = uint(input.tradeFeeMillionths),
    creator = uint(input.creatorFeeMillionths),
    protocol = uint(input.protocolFeeMillionths),
    fund = uint(input.fundFeeMillionths);
  if (
    trade + creator >= DENOMINATOR ||
    protocol > DENOMINATOR ||
    fund > DENOMINATOR ||
    protocol + fund > DENOMINATOR ||
    x + amount > U64
  )
    return fail();
  const ceil = (n: bigint, rate: bigint) =>
    (n * rate + DENOMINATOR - 1n) / DENOMINATOR;
  let creatorFee = 0n,
    tradeFee = 0n,
    net = 0n;
  if (input.creatorFeeOnInput) {
    // The matched Rust source returns None from split_creator_fee when both
    // rates are zero, even though the total fee itself would be zero.
    if (trade + creator === 0n) return fail();
    const totalFee = ceil(amount, trade + creator);
    creatorFee = (totalFee * creator) / (trade + creator);
    tradeFee = totalFee - creatorFee;
    net = amount - totalFee;
  } else {
    tradeFee = ceil(amount, trade);
    net = amount - tradeFee;
  }
  if (net <= 0n) return fail();
  const grossOutput = (net * y) / (x + net);
  if (!input.creatorFeeOnInput) creatorFee = ceil(grossOutput, creator);
  const output = input.creatorFeeOnInput
    ? grossOutput
    : grossOutput - creatorFee;
  if (
    output <= 0n ||
    output < minimum ||
    grossOutput >= y ||
    (x + net) * (y - grossOutput) < x * y
  )
    return fail();
  return {
    inputRaw: amount.toString(),
    minimumOutputRaw: minimum.toString(),
    expectedOutputRaw: output.toString(),
    grossOutputRaw: grossOutput.toString(),
    inputCurveAmountRaw: net.toString(),
    tradeFeeRaw: tradeFee.toString(),
    creatorFeeRaw: creatorFee.toString(),
    creatorFeeOnInput: input.creatorFeeOnInput,
    protocolFeeRaw: ((tradeFee * protocol) / DENOMINATOR).toString(),
    fundFeeRaw: ((tradeFee * fund) / DENOMINATOR).toString(),
    sourceProfile: 'f4b9b26342afe9122d5ff67cd7a4f19ded4ac0a5' as const,
    programApproved: false as const,
    providerQualified: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
