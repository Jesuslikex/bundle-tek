import { expect, it } from 'vitest';
import { chartExecutionAverages } from './chart-execution-averages';
import {
  acquisitionReceipt,
  acquisitionId,
  acquisitionMint,
} from '../test/imported-sell-acquisition-fixture';
const calculate = (
  rows: ReturnType<typeof acquisitionReceipt>[],
  decimals = 0,
) => chartExecutionAverages(rows, acquisitionId(1), acquisitionMint, decimals);
function receipt(
  n: number,
  side: 'Buy' | 'Sell',
  units: string,
  lamports: string,
  decimals = 0,
) {
  const r = acquisitionReceipt(n, side, units);
  r.document.decimals = decimals;
  r.document.nativeSettlementRaw = (
    side === 'Buy' ? -BigInt(lamports) : BigInt(lamports)
  ).toString();
  r.document.networkFeeLamports = '100000000';
  r.document.nativeChangeRaw = (
    BigInt(r.document.nativeSettlementRaw) - 100000000n
  ).toString();
  return r;
}
it('weights settlement by actual token units rather than averaging individual prices or fees', () => {
  const result = calculate([
    receipt(2, 'Buy', '2', '2000000000'),
    receipt(3, 'Buy', '8', '4000000000'),
    receipt(4, 'Sell', '1', '2000000000'),
  ]);
  expect(result.buy).toEqual({
    receiptCount: 2,
    tokenUnitsRaw: '10',
    settlementLamports: '6000000000',
    numerator: '3',
    denominator: '5',
    display: '0.6',
    truncated: false,
  });
  expect(result.sell?.display).toBe('2');
});
it('retains exact fractions for non-terminating prices and atomic values above safe integer precision', () => {
  const thirds = calculate([receipt(2, 'Buy', '3', '1000000000')]);
  expect(thirds.buy).toMatchObject({
    numerator: '1',
    denominator: '3',
    display: '0.333333333333333333333333',
    truncated: true,
  });
  const large = calculate(
    [receipt(2, 'Buy', '9007199254740993', '9007199254740991', 6)],
    6,
  );
  expect(large.buy).toMatchObject({
    numerator: '9007199254740991',
    denominator: '9007199254740993000',
    tokenUnitsRaw: '9007199254740993',
    settlementLamports: '9007199254740991',
    truncated: true,
  });
});
it('keeps dust prices positive and supports validated decimal extremes without numeric overflow', () => {
  const dust = calculate([receipt(2, 'Buy', '18446744073709551615', '1')]);
  expect(dust.buy).toMatchObject({
    numerator: '1',
    denominator: '18446744073709551615000000000',
    display: '<0.000000000000000000000001',
    truncated: true,
  });
  expect(calculate([receipt(2, 'Buy', '1', '1', 255)], 255).buy?.display).toBe(
    '1' + '0'.repeat(246),
  );
});
it('does not invent averages for absent sides and rejects duplicate, foreign or inconsistent evidence', () => {
  expect(calculate([])).toEqual({ receiptCount: 0, buy: null, sell: null });
  const r = receipt(2, 'Buy', '1', '1');
  expect(calculate([r]).sell).toBeNull();
  expect(() => calculate([r, r])).toThrow('Duplicate');
  expect(() => calculate([r, { ...r, id: acquisitionId(3) }])).toThrow(
    'Duplicate',
  );
  expect(() => calculate([{ ...r, projectId: acquisitionId(7) }])).toThrow();
  expect(() =>
    calculate([{ ...r, document: { ...r.document, mint: r.document.wallet } }]),
  ).toThrow();
  expect(() => calculate([r], 6)).toThrow();
  expect(() =>
    calculate([
      { ...r, document: { ...r.document, nativeSettlementRaw: '1' } },
    ]),
  ).toThrow();
});
