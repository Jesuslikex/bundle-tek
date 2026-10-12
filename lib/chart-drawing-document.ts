import type { ChartAnchor, ChartTrendLine } from './chart-trend-line';

export type ChartDrawingDocument = {
  format: 'bundle-chart-drawings-v1';
  context: string;
  savedAt: string;
  guides: number[];
  trends: ChartTrendLine[];
};
export function chartDrawingStorageKey(context: string) {
  return `bundle:chart-drawings:v1:${encodeURIComponent(context)}`;
}
export function parseChartDrawingDocument(
  text: string,
  context: string,
): ChartDrawingDocument {
  const invalid = () => new Error('Saved drawings are invalid for this chart.');
  if (text.length > 8192) throw invalid();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid();
  const record = value as Record<string, unknown>;
  const price = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0;
  const anchor = (v: unknown): v is ChartAnchor => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const a = v as Record<string, unknown>;
    return (
      typeof a.time === 'number' &&
      Number.isSafeInteger(a.time) &&
      a.time >= 0 &&
      price(a.price)
    );
  };
  if (
    record.format !== 'bundle-chart-drawings-v1' ||
    record.context !== context ||
    typeof record.savedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.savedAt)) ||
    !Array.isArray(record.guides) ||
    record.guides.length > 8 ||
    !record.guides.every(price) ||
    new Set(record.guides).size !== record.guides.length ||
    !Array.isArray(record.trends) ||
    record.trends.length > 8
  )
    throw invalid();
  const trends = record.trends.map((v: unknown) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid();
    const line = v as Record<string, unknown>;
    if (
      !anchor(line.first) ||
      !anchor(line.second) ||
      line.first.time === line.second.time
    )
      throw invalid();
    return {
      first: { time: line.first.time, price: line.first.price },
      second: { time: line.second.time, price: line.second.price },
    };
  });
  return {
    format: 'bundle-chart-drawings-v1',
    context,
    savedAt: record.savedAt,
    guides: [...record.guides],
    trends,
  };
}
