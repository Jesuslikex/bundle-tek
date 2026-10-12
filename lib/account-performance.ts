const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
import { type ImportedLotLink } from './imported-lot-links';
import { type ImportedTradeReceipt } from './imported-trade-ledger';
import {
  type PerformanceBuy,
  type PerformanceSell,
} from './warmup-lot-performance';

export const ACCOUNT_PERFORMANCE_LIMIT = 4000;
export type PerformanceScope = {
  kind: 'Imported trades' | 'Warmup';
  id: string;
  name: string;
  archived: boolean;
  buyCount: number;
  sellCount: number;
  linkedSaleCount: number;
  unlinkedSaleCount: number;
  allocatedCostLamports: string;
  unallocatedCostLamports: string;
  linkedNetProceedsLamports: string;
  linkedResultLamports: string;
  successfulFeeLamports: string;
  rentChangeLamports: string;
};
export type ImportedPerformanceSource = {
  id: string;
  name: string;
  archived: boolean;
  receipts: ImportedTradeReceipt[];
  links: ImportedLotLink[];
};
export type WarmupPerformanceSource = {
  id: string;
  name: string;
  archived: boolean;
  buys: PerformanceBuy[];
  sells: PerformanceSell[];
};
export type AccountPerformance = {
  scopes: PerformanceScope[];
  receiptCount: number;
  buyCount: number;
  sellCount: number;
  linkedSaleCount: number;
  unlinkedSaleCount: number;
  allocatedCostLamports: string;
  unallocatedCostLamports: string;
  linkedNetProceedsLamports: string;
  linkedResultLamports: string;
  recordedRealizedLamports: string | null;
  successfulFeeLamports: string;
  rentChangeLamports: string;
  observedAt: string;
};
const moneyFields = [
  'allocatedCostLamports',
  'unallocatedCostLamports',
  'linkedNetProceedsLamports',
  'linkedResultLamports',
  'successfulFeeLamports',
  'rentChangeLamports',
] as const;
const countFields = [
  'buyCount',
  'sellCount',
  'linkedSaleCount',
  'unlinkedSaleCount',
] as const;
const ceiling = 2n * BigInt(ACCOUNT_PERFORMANCE_LIMIT) * ((1n << 64n) - 1n);
function exact(value: unknown, signed = false): value is string {
  return (
    typeof value === 'string' &&
    (signed ? /^(0|-?[1-9]\d{0,24})$/ : /^(0|[1-9]\d{0,24})$/).test(value) &&
    BigInt(value) <= ceiling &&
    BigInt(value) >= (signed ? -ceiling : 0n)
  );
}
function total(
  scopes: PerformanceScope[],
  observedAt: string,
): AccountPerformance {
  const sum = (field: (typeof moneyFields)[number]) =>
    scopes.reduce((s, r) => s + BigInt(r[field]), 0n).toString();
  const count = (field: (typeof countFields)[number]) =>
    scopes.reduce((s, r) => s + r[field], 0);
  const sellCount = count('sellCount'),
    unlinkedSaleCount = count('unlinkedSaleCount');
  return {
    scopes,
    observedAt,
    receiptCount: count('buyCount') + sellCount,
    buyCount: count('buyCount'),
    sellCount,
    linkedSaleCount: count('linkedSaleCount'),
    unlinkedSaleCount,
    allocatedCostLamports: sum('allocatedCostLamports'),
    unallocatedCostLamports: sum('unallocatedCostLamports'),
    linkedNetProceedsLamports: sum('linkedNetProceedsLamports'),
    linkedResultLamports: sum('linkedResultLamports'),
    recordedRealizedLamports:
      sellCount > 0 && unlinkedSaleCount === 0
        ? sum('linkedResultLamports')
        : null,
    successfulFeeLamports: sum('successfulFeeLamports'),
    rentChangeLamports: sum('rentChangeLamports'),
  };
}
export function accountPerformanceFromScopes(
  scopes: PerformanceScope[],
  observedAt: string,
) {
  return validatedAccountPerformance(total(scopes, observedAt));
}
export function validatedAccountPerformance(
  value: unknown,
): AccountPerformance {
  const v = value as AccountPerformance;
  if (
    !v ||
    !Array.isArray(v.scopes) ||
    v.scopes.length > ACCOUNT_PERFORMANCE_LIMIT ||
    !Number.isFinite(Date.parse(v.observedAt))
  )
    throw new Error('Performance summary unavailable.');
  const seen = new Set<string>();
  for (const row of v.scopes) {
    if (
      !row ||
      !['Imported trades', 'Warmup'].includes(row.kind) ||
      !UUID.test(row.id) ||
      typeof row.name !== 'string' ||
      !row.name.trim() ||
      row.name.length > 256 ||
      typeof row.archived !== 'boolean' ||
      seen.has(`${row.kind}:${row.id}`) ||
      !countFields.every(
        (k) =>
          Number.isSafeInteger(row[k]) &&
          row[k] >= 0 &&
          row[k] <= ACCOUNT_PERFORMANCE_LIMIT,
      ) ||
      row.buyCount + row.sellCount === 0 ||
      row.linkedSaleCount + row.unlinkedSaleCount !== row.sellCount ||
      (row.kind === 'Warmup' && row.unlinkedSaleCount !== 0) ||
      !moneyFields.every((k) =>
        exact(
          row[k],
          [
            'linkedNetProceedsLamports',
            'linkedResultLamports',
            'rentChangeLamports',
          ].includes(k),
        ),
      ) ||
      BigInt(row.linkedNetProceedsLamports) -
        BigInt(row.allocatedCostLamports) !==
        BigInt(row.linkedResultLamports) ||
      (row.linkedSaleCount === 0 &&
        [
          row.allocatedCostLamports,
          row.linkedNetProceedsLamports,
          row.linkedResultLamports,
        ].some((s) => s !== '0'))
    )
      throw new Error('Performance scope differs.');
    seen.add(`${row.kind}:${row.id}`);
  }
  const expected = total(v.scopes, v.observedAt);
  if (
    expected.receiptCount > ACCOUNT_PERFORMANCE_LIMIT ||
    (
      [
        ...countFields,
        ...moneyFields,
        'receiptCount',
        'recordedRealizedLamports',
      ] as const
    ).some((k) => v[k] !== expected[k])
  )
    throw new Error('Performance totals differ.');
  return v;
}

export function accountPerformanceCsv(value: AccountPerformance) {
  const v = validatedAccountPerformance(value);
  const fields = [
    'kind',
    'id',
    'name',
    'archived',
    ...countFields,
    ...moneyFields,
  ] as const;
  const cell = (value: unknown) => {
    let s = String(value);
    if (/^[=+\-@]/.test(s.trimStart()) || ['\t', '\r', '\n'].includes(s[0]))
      s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  return (
    [
      'observedAt,' + fields.join(','),
      ...v.scopes.map((row) =>
        [v.observedAt, ...fields.map((k) => row[k])].map(cell).join(','),
      ),
    ].join('\r\n') + '\r\n'
  );
}
