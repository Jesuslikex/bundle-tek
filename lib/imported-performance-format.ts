export type ImportedWalletPerformance = {
  wallet: string;
  receiptCount: number;
  buyCount: number;
  sellCount: number;
  ordering: 'by-finalized-slot' | 'unavailable';
  matchedSoldRaw: string;
  unknownBasisSoldRaw: string;
  unresolvedSoldRaw: string;
  realizedCostLamports: string;
  attributedNetProceedsLamports: string;
  attributedResultLamports: string;
  realizedResultLamports: string | null;
  openCostLamports: string | null;
  recordedOpenRaw: string | null;
};
export type ImportedPerformance = {
  method: 'recorded-fifo';
  receiptCount: number;
  buyCount: number;
  sellCount: number;
  wallets: ImportedWalletPerformance[];
  matchedSoldRaw: string;
  unknownBasisSoldRaw: string;
  unresolvedSoldRaw: string;
  realizedCostLamports: string;
  attributedNetProceedsLamports: string;
  attributedResultLamports: string;
  realizedResultLamports: string | null;
  openCostLamports: string | null;
  recordedOpenRaw: string | null;
};
const raw = (value: unknown, signed = false) =>
  typeof value === 'string' &&
  (signed ? /^(0|-?[1-9]\d{0,23})$/ : /^(0|[1-9]\d{0,23})$/).test(value);
const count = (value: number) =>
  Number.isSafeInteger(value) && value >= 0 && value <= 4000;
const unsigned = [
  'matchedSoldRaw',
  'unknownBasisSoldRaw',
  'unresolvedSoldRaw',
  'realizedCostLamports',
] as const;
const signed = [
  'attributedNetProceedsLamports',
  'attributedResultLamports',
] as const;
const nullableUnsigned = ['openCostLamports', 'recordedOpenRaw'] as const;
function values(p: ImportedPerformance | ImportedWalletPerformance) {
  if (
    ![p.receiptCount, p.buyCount, p.sellCount].every(count) ||
    p.buyCount + p.sellCount !== p.receiptCount ||
    !unsigned.every((k) => raw(p[k])) ||
    !signed.every((k) => raw(p[k], true)) ||
    !nullableUnsigned.every((k) => p[k] === null || raw(p[k])) ||
    (p.realizedResultLamports !== null &&
      !raw(p.realizedResultLamports, true)) ||
    BigInt(p.attributedNetProceedsLamports) - BigInt(p.realizedCostLamports) !==
      BigInt(p.attributedResultLamports) ||
    (p.realizedResultLamports !== null &&
      (p.sellCount === 0 ||
        p.unknownBasisSoldRaw !== '0' ||
        p.unresolvedSoldRaw !== '0' ||
        p.realizedResultLamports !== p.attributedResultLamports))
  )
    throw new Error('Recorded performance evidence differs.');
}
export function validatedImportedPerformance(
  value: unknown,
  receiptCount: number,
  boughtRaw: string,
  soldRaw: string,
): ImportedPerformance {
  const p = value as ImportedPerformance;
  if (
    !p ||
    p.method !== 'recorded-fifo' ||
    !Array.isArray(p.wallets) ||
    p.wallets.length > 4000 ||
    p.receiptCount !== receiptCount
  )
    throw new Error('Recorded performance context differs.');
  values(p);
  const seen = new Set<string>();
  for (const w of p.wallets) {
    if (
      !w ||
      typeof w.wallet !== 'string' ||
      !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w.wallet) ||
      seen.has(w.wallet) ||
      w.receiptCount === 0 ||
      !['by-finalized-slot', 'unavailable'].includes(w.ordering)
    )
      throw new Error('Recorded wallet performance differs.');
    seen.add(w.wallet);
    values(w);
    if (
      w.ordering === 'unavailable'
        ? w.openCostLamports !== null ||
          w.recordedOpenRaw !== null ||
          w.realizedResultLamports !== null ||
          w.matchedSoldRaw !== '0' ||
          w.unknownBasisSoldRaw !== '0' ||
          w.realizedCostLamports !== '0' ||
          w.attributedNetProceedsLamports !== '0'
        : w.openCostLamports === null ||
          w.recordedOpenRaw === null ||
          w.unresolvedSoldRaw !== '0'
    )
      throw new Error('Recorded slot-order evidence differs.');
    if (
      w.ordering === 'by-finalized-slot' &&
      w.sellCount > 0 &&
      w.unknownBasisSoldRaw === '0' &&
      w.realizedResultLamports === null
    )
      throw new Error('Missing recorded result.');
  }
  for (const key of ['receiptCount', 'buyCount', 'sellCount'] as const)
    if (p.wallets.reduce((n, w) => n + w[key], 0) !== p[key])
      throw new Error('Recorded performance counts differ.');
  for (const key of [...unsigned, ...signed] as const)
    if (
      p.wallets.reduce((n, w) => n + BigInt(w[key]), 0n).toString() !== p[key]
    )
      throw new Error('Recorded performance totals differ.');
  for (const key of nullableUnsigned) {
    const expected = p.wallets.some((w) => w[key] === null)
      ? null
      : p.wallets.reduce((n, w) => n + BigInt(w[key]!), 0n).toString();
    if (p[key] !== expected) throw new Error('Recorded open cost differs.');
  }
  if (
    BigInt(p.matchedSoldRaw) > BigInt(boughtRaw) ||
    BigInt(p.matchedSoldRaw) +
      BigInt(p.unknownBasisSoldRaw) +
      BigInt(p.unresolvedSoldRaw) !==
      BigInt(soldRaw) ||
    (p.recordedOpenRaw !== null &&
      BigInt(boughtRaw) - BigInt(p.matchedSoldRaw) !==
        BigInt(p.recordedOpenRaw)) ||
    p.realizedResultLamports !==
      (p.sellCount > 0 &&
      p.wallets.every(
        (w) =>
          w.ordering === 'by-finalized-slot' && w.unknownBasisSoldRaw === '0',
      )
        ? p.attributedResultLamports
        : null)
  )
    throw new Error('Recorded performance coverage differs.');
  return p;
}
