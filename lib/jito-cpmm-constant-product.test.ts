import { expect, it } from 'vitest';
import { calculateJitoCpmmConstantProduct } from './jito-cpmm-constant-product';
const base = () => ({
  inputRaw: '1000000',
  minimumOutputRaw: '99000',
  inputReserveRaw: '1000000000000',
  outputReserveRaw: '100000000000',
  tradeFeeMillionths: '2500',
  protocolFeeMillionths: '120000',
  fundFeeMillionths: '40000',
});
it('matches the referenced fee ceiling, fee-share floors and constant-product output', () => {
  expect(calculateJitoCpmmConstantProduct(base())).toMatchObject({
    expectedOutputRaw: '99749',
    tradeFeeRaw: '2500',
    protocolFeeRaw: '300',
    fundFeeRaw: '100',
    signingAllowed: false,
  });
});
it('accepts exact minimum equality and rejects one raw unit above executable output', () => {
  expect(
    calculateJitoCpmmConstantProduct({ ...base(), minimumOutputRaw: '99749' })
      .expectedOutputRaw,
  ).toBe('99749');
  expect(() =>
    calculateJitoCpmmConstantProduct({ ...base(), minimumOutputRaw: '99750' }),
  ).toThrow();
});
it('rounds a nonintegral trade fee upward', () => {
  const r = calculateJitoCpmmConstantProduct({
    ...base(),
    inputRaw: '123',
    minimumOutputRaw: '1',
    inputReserveRaw: '1000000',
    outputReserveRaw: '1000000',
  });
  expect(r.tradeFeeRaw).toBe('1');
  expect(r.expectedOutputRaw).toBe('121');
});
it.each([
  { tradeFeeMillionths: '1000000' },
  { protocolFeeMillionths: '999999', fundFeeMillionths: '2' },
  { inputRaw: '01' },
  { inputReserveRaw: '0' },
  { inputRaw: '1', tradeFeeMillionths: '1' },
  { inputReserveRaw: '18446744073709551615' },
])('refuses unsupported or impossible bounds %j', (patch) => {
  expect(() =>
    calculateJitoCpmmConstantProduct({ ...base(), ...patch }),
  ).toThrow();
});
it('keeps the invariant over a deterministic grid including zero trade fees', () => {
  for (const x of [1n, 101n, 1000000n])
    for (const y of [101n, 1000000n])
      for (const amount of [10n, 123n, 10000n])
        for (const rate of [0n, 2500n, 100000n]) {
          const fee = (amount * rate + 999999n) / 1000000n;
          const expected = ((amount - fee) * y) / (x + amount - fee);
          if (expected === 0n) continue;
          const result = calculateJitoCpmmConstantProduct({
            inputRaw: amount.toString(),
            minimumOutputRaw: expected.toString(),
            inputReserveRaw: x.toString(),
            outputReserveRaw: y.toString(),
            tradeFeeMillionths: rate.toString(),
            protocolFeeMillionths: '0',
            fundFeeMillionths: '0',
          });
          expect(BigInt(result.expectedOutputRaw)).toBe(expected);
          expect((x + amount - fee) * (y - expected) >= x * y).toBe(true);
        }
});
