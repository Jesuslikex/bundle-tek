import { CANDLE_INTERVALS, type PoolCandles } from './pool-candles';
import {
  importedTradeReceipt,
  type ImportedTradeReceipt,
} from './imported-trade-ledger';
export function chartTradeMarkers(
  snapshot: PoolCandles,
  receipts: ImportedTradeReceipt[],
  projectId: string,
  decimals: number,
) {
  if (receipts.length > 500) throw new Error('Chart trade limit exceeded.');
  const groups = new Map<
    string,
    { time: number; side: 'Buy' | 'Sell'; receipts: ImportedTradeReceipt[] }
  >();
  const seen = new Set<string>();
  let missingTime = 0,
    outsideCandles = 0;
  for (const value of receipts) {
    const r = importedTradeReceipt(
      value,
      projectId,
      snapshot.address,
      decimals,
    );
    if (seen.has(r.document.signature)) continue;
    seen.add(r.document.signature);
    const time = r.document.blockTime;
    if (time === null) {
      missingTime++;
      continue;
    }
    const candle = snapshot.candles.find(
      (c) =>
        c.time <= time &&
        time < c.time + CANDLE_INTERVALS[snapshot.interval].seconds,
    );
    if (!candle) {
      outsideCandles++;
      continue;
    }
    const key = `${candle.time}:${r.document.side}`;
    const group = groups.get(key) ?? {
      time: candle.time,
      side: r.document.side,
      receipts: [],
    };
    group.receipts.push(r);
    groups.set(key, group);
  }
  return {
    groups: [...groups.values()],
    missingTime,
    outsideCandles,
    matched: [...groups.values()].flatMap((g) => g.receipts),
  };
}
