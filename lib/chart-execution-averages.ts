import {
  importedTradeReceipt,
  type ImportedTradeReceipt,
} from './imported-trade-ledger';
export type ExecutionAverage = {
  receiptCount: number;
  tokenUnitsRaw: string;
  settlementLamports: string;
  numerator: string;
  denominator: string;
  display: string;
  truncated: boolean;
};
function gcd(a: bigint, b: bigint): bigint {
  while (b) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}
function average(
  count: number,
  units: bigint,
  lamports: bigint,
  decimals: number,
): ExecutionAverage | null {
  if (!count) return null;
  let numerator = lamports * 10n ** BigInt(decimals),
    denominator = units * 1000000000n;
  const divisor = gcd(numerator, denominator);
  numerator /= divisor;
  denominator /= divisor;
  const places = 24n,
    scale = 10n ** places,
    scaled = (numerator * scale) / denominator;
  const whole = scaled / scale,
    fraction = (scaled % scale)
      .toString()
      .padStart(Number(places), '0')
      .replace(/0+$/, '');
  const truncated = (numerator * scale) % denominator !== 0n;
  const display =
    scaled === 0n
      ? '<0.000000000000000000000001'
      : `${whole}${fraction ? '.' + fraction : ''}`;
  return {
    receiptCount: count,
    tokenUnitsRaw: units.toString(),
    settlementLamports: lamports.toString(),
    numerator: numerator.toString(),
    denominator: denominator.toString(),
    display,
    truncated,
  };
}
export function chartExecutionAverages(
  receipts: ImportedTradeReceipt[],
  projectId: string,
  mint: string,
  decimals: number,
) {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255 ||
    receipts.length > 500
  )
    throw new Error('Average execution context differs.');
  const ids = new Set<string>(),
    signatures = new Set<string>();
  let buyCount = 0,
    sellCount = 0,
    buyUnits = 0n,
    sellUnits = 0n,
    buySettlement = 0n,
    sellSettlement = 0n;
  for (const value of receipts) {
    const r = importedTradeReceipt(value, projectId, mint, decimals),
      d = r.document;
    if (ids.has(r.id) || signatures.has(d.signature))
      throw new Error('Duplicate execution evidence.');
    ids.add(r.id);
    signatures.add(d.signature);
    if (d.side === 'Buy') {
      buyCount++;
      buyUnits += BigInt(d.tokenUnitsRaw);
      buySettlement -= BigInt(d.nativeSettlementRaw);
    } else {
      sellCount++;
      sellUnits += BigInt(d.tokenUnitsRaw);
      sellSettlement += BigInt(d.nativeSettlementRaw);
    }
  }
  return {
    receiptCount: receipts.length,
    buy: average(buyCount, buyUnits, buySettlement, decimals),
    sell: average(sellCount, sellUnits, sellSettlement, decimals),
  };
}
