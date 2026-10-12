import { it, expect } from 'vitest';
import {
  validatedAccountPerformance,
  accountPerformanceCsv,
} from './account-performance';
import { summarizeAccountPerformance } from './account-performance-server';
import {
  acquisitionReceipt,
  acquisitionId,
} from '../test/imported-sell-acquisition-fixture';
import { proposedImportedLotLink } from './imported-lot-links';
const date = '2026-10-11T00:00:00Z';
function source() {
  const receipts = [acquisitionReceipt(2), acquisitionReceipt(3, 'Sell', '1')];
  return {
    id: acquisitionId(1),
    name: 'Token',
    archived: true,
    receipts,
    links: [
      proposedImportedLotLink(
        receipts,
        [],
        acquisitionId(1),
        receipts[0].id,
        receipts[1].id,
        acquisitionId(500),
        date,
      ),
    ],
  };
}
it('keeps partial buy cost and rent separate, includes archives, and does not equate open cost with token value', () => {
  const s = source();
  s.receipts[0].document.rentChangeRaw = '20';
  const value = summarizeAccountPerformance([s], [], date);
  expect(value).toMatchObject({
    receiptCount: 2,
    recordedRealizedLamports: '16',
    allocatedCostLamports: '33',
    unallocatedCostLamports: '68',
    linkedNetProceedsLamports: '49',
    linkedResultLamports: '16',
    rentChangeLamports: '20',
    successfulFeeLamports: '2',
  });
  expect(value.scopes[0].archived).toBe(true);
});
it('withholds complete realized totals for unassigned sales while preserving the exact linked subset', () => {
  const s = source();
  s.receipts.push(acquisitionReceipt(4, 'Sell', '1'));
  expect(summarizeAccountPerformance([s], [], date)).toMatchObject({
    recordedRealizedLamports: null,
    linkedResultLamports: '16',
    unlinkedSaleCount: 1,
    sellCount: 2,
  });
  expect(summarizeAccountPerformance([], [], date)).toMatchObject({
    receiptCount: 0,
    recordedRealizedLamports: null,
    scopes: [],
  });
});
it('rejects partial split evidence, cross-scope receipts and duplicate transaction evidence', () => {
  const s = source();
  expect(() =>
    summarizeAccountPerformance([{ ...s, id: acquisitionId(8) }], [], date),
  ).toThrow();
  expect(() => summarizeAccountPerformance([s, s], [], date)).toThrow();
  expect(() =>
    summarizeAccountPerformance(
      [{ ...s, links: [{ ...s.links[0], unitsRaw: '2' }] }],
      [],
      date,
    ),
  ).toThrow();
});
it('keeps exact values beyond Number precision and validates response totals and coverage', () => {
  const s = source();
  s.receipts[0].document.nativeSettlementRaw = '-9007199254740993';
  const v = summarizeAccountPerformance([s], [], date);
  expect(v.allocatedCostLamports).toBe('3002399751580331');
  expect(v.recordedRealizedLamports).toBe('-3002399751580282');
  expect(() =>
    validatedAccountPerformance({ ...v, recordedRealizedLamports: '1' }),
  ).toThrow();
  expect(() =>
    validatedAccountPerformance({
      ...v,
      scopes: [{ ...v.scopes[0], unlinkedSaleCount: 1 }],
    }),
  ).toThrow();
  expect(() =>
    validatedAccountPerformance({
      ...v,
      scopes: [{ ...v.scopes[0], archived: 'false' }],
    }),
  ).toThrow();
});
it('exports every scope with exact lamports and neutralizes spreadsheet formulas in names', () => {
  const s = source();
  s.name = '=SUM(1,2)';
  const csv = accountPerformanceCsv(summarizeAccountPerformance([s], [], date));
  expect(csv).toContain('"\'=SUM(1,2)"');
  expect(csv).toContain('allocatedCostLamports');
  expect(csv).toContain('"33","68","49","16","2","0"');
  s.name = '  =SUM(1,2)';
  expect(
    accountPerformanceCsv(summarizeAccountPerformance([s], [], date)),
  ).toContain('"\'  =SUM(1,2)"');
});
