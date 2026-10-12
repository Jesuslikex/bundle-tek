export type ChartAnchor = { time: number; price: number };
export type ChartTrendLine = { first: ChartAnchor; second: ChartAnchor };

// Clip in data coordinates so zooming cannot move an anchor or stretch prices.
export function visibleTrendLine(
  line: ChartTrendLine,
  bounds: { start: number; end: number; low: number; high: number },
): ChartTrendLine | null {
  const { first, second } = line;
  if (
    ![
      first.time,
      second.time,
      first.price,
      second.price,
      bounds.start,
      bounds.end,
      bounds.low,
      bounds.high,
    ].every(Number.isFinite) ||
    first.time === second.time ||
    bounds.start > bounds.end ||
    bounds.low > bounds.high
  )
    return null;
  let entry = 0,
    exit = 1;
  for (const [origin, delta, min, max] of [
    [first.time, second.time - first.time, bounds.start, bounds.end],
    [first.price, second.price - first.price, bounds.low, bounds.high],
  ]) {
    if (delta === 0) {
      if (origin < min || origin > max) return null;
      continue;
    }
    const a = (min - origin) / delta,
      b = (max - origin) / delta;
    entry = Math.max(entry, Math.min(a, b));
    exit = Math.min(exit, Math.max(a, b));
    if (entry > exit) return null;
  }
  const point = (fraction: number): ChartAnchor => ({
    time: first.time + fraction * (second.time - first.time),
    price: first.price + fraction * (second.price - first.price),
  });
  return { first: point(entry), second: point(exit) };
}
