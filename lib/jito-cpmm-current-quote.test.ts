import { expect, it } from 'vitest';
import reference from '../test/fixtures/jito-cpmm-current-rust-20261030.json';
import { calculateJitoCpmmCurrentQuote } from './jito-cpmm-current-quote';
it.each(reference.vectors.map((v, i) => ({ i, ...v })))(
  'matches native Rust source vector $i',
  (v) => {
    if (!v.accepted) {
      expect(() => calculateJitoCpmmCurrentQuote(v.input)).toThrow();
      return;
    }
    const result = calculateJitoCpmmCurrentQuote(v.input),
      expected = v.expected!;
    expect(result).toMatchObject({
      expectedOutputRaw: expected.expectedOutputRaw,
      tradeFeeRaw: expected.tradeFeeRaw,
      protocolFeeRaw: expected.protocolFeeRaw,
      fundFeeRaw: expected.fundFeeRaw,
      creatorFeeRaw: expected.creatorFeeRaw,
      signingAllowed: false,
      executionAllowed: false,
      providerQualified: false,
      programApproved: false,
    });
    expect(
      BigInt(v.input.inputReserveRaw) + BigInt(result.inputCurveAmountRaw),
    ).toBe(BigInt(expected.newInputReserveRaw));
    expect(
      BigInt(v.input.outputReserveRaw) - BigInt(result.grossOutputRaw),
    ).toBe(BigInt(expected.newOutputReserveRaw));
  },
);
it('does not accept a minimum above the executable output', () => {
  const v = reference.vectors.find((v) => v.accepted)!;
  const valid = calculateJitoCpmmCurrentQuote(v.input);
  expect(() =>
    calculateJitoCpmmCurrentQuote({
      ...v.input,
      minimumOutputRaw: (BigInt(valid.expectedOutputRaw) + 1n).toString(),
    }),
  ).toThrow();
});
it('refuses an invalid combined fee rate', () => {
  const v = reference.vectors.find((v) => v.accepted)!;
  expect(() =>
    calculateJitoCpmmCurrentQuote({
      ...v.input,
      tradeFeeMillionths: '999999',
      creatorFeeMillionths: '1',
    }),
  ).toThrow();
});
it('refuses accessors without invoking them', () => {
  const value = { ...reference.vectors[0].input };
  let invoked = false;
  Object.defineProperty(value, 'inputRaw', {
    enumerable: true,
    get() {
      invoked = true;
      return '123';
    },
  });
  expect(() => calculateJitoCpmmCurrentQuote(value)).toThrow();
  expect(invoked).toBe(false);
});
