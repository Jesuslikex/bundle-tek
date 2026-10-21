import { expect, it } from 'vitest';
import {
  decodeMainnetFundingHistory,
  mainnetFundingProgressKey,
  mainnetFundingRecordLabel,
} from './mainnet-funding-history';
import {
  fundingLegPage,
  fundingLegRecord,
} from '../test/mainnet-funding-leg-history-fixture';
const decode = (records: ReturnType<typeof fundingLegRecord>[]) =>
  decodeMainnetFundingHistory(fundingLegPage(records), 'saved-funding', 1);
it('admits all400 unique exact proxy steps with strict native-only capture identities', () => {
  const records = Array.from({ length: 400 }, (_, i) =>
    fundingLegRecord(Math.floor(i / 4) + 1, (i % 4) + 1),
  );
  expect(decode(records).progress.records).toHaveLength(400);
  expect(new Set(records.map(mainnetFundingProgressKey)).size).toBe(400);
  expect(() => decode([...records, fundingLegRecord(100, 4, 401)])).toThrow();
});
it.each([0, 5, -1, 1.1, null, '1'] as const)(
  'refuses malformed explicit leg %s',
  (leg) => {
    const record = fundingLegRecord();
    Object.assign(record.funding, { leg });
    expect(() => decode([record])).toThrow();
  },
);
it.each(['step', 'sequence', 'attempt', 'root', 'mixed', 'token'] as const)(
  'refuses ambiguous %s progress',
  (kind) => {
    const a = fundingLegRecord(1, 1),
      b = fundingLegRecord(1, 2);
    if (kind === 'step') b.funding.leg = 1;
    if (kind === 'sequence') b.sequence = a.sequence;
    if (kind === 'attempt') b.withdrawalId = a.withdrawalId;
    if (kind === 'root') b.funding.termsSha256 = 'b'.repeat(64);
    if (kind === 'mixed') delete b.funding.leg;
    if (kind === 'token')
      b.asset = { kind: 'token', mint: 'public-mint', decimals: 6 };
    expect(() => decode([a, b])).toThrow();
  },
);
it('does not infer a final route delivery from the highest observed proxy leg', () => {
  const record = fundingLegRecord(1, 4);
  record.state = 'finalized';
  record.receipt = {
    slot: 100,
    observedAt: record.createdAt,
    deliveredRaw: record.amountRaw,
    networkFeeLamports: '5000',
    accountRentLamports: '0',
    transferFeeRaw: null,
  };
  expect(decode([record]).progress.records).toHaveLength(1);
  expect(mainnetFundingRecordLabel(record)).toBe(
    'Finalized proxy-leg transfer verified',
  );
});
it('requires explicit unavailable progress to withhold all records and remain scope-bound', () => {
  const page = fundingLegPage([]);
  page.progress = { revision: 1, records: null, unavailable: true };
  expect(
    decodeMainnetFundingHistory(page, 'saved-funding', 1).progress.records,
  ).toBeNull();
  for (const bad of [
    { revision: 1, records: [], unavailable: true },
    { revision: 1, records: null },
    { revision: 2, records: null, unavailable: true },
  ]) {
    expect(() =>
      decodeMainnetFundingHistory(
        { ...page, progress: bad },
        'saved-funding',
        1,
      ),
    ).toThrow();
  }
});
