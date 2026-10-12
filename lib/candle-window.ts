import type { Candle } from './pool-candles';

export function candleContainingTime(
  candles: Candle[],
  time: number,
  intervalSeconds: number,
) {
  if (
    !Number.isFinite(time) ||
    !Number.isSafeInteger(intervalSeconds) ||
    intervalSeconds <= 0
  )
    return undefined;
  const candle = candles.findLast((c) => c.time <= time);
  return candle && time < candle.time + intervalSeconds ? candle : undefined;
}
export function focusCandleWindow(
  candles: Candle[],
  size: number,
  time: number,
) {
  candleWindow(candles, size);
  const index = candles.findIndex((c) => c.time === time);
  if (index < 0) throw new Error('Candle is not in loaded history.');
  const end = Math.min(
    candles.length,
    Math.max(
      Math.min(size, candles.length),
      index + 1 + Math.floor((size - 1) / 2),
    ),
  );
  return end === candles.length ? null : candles[end - 1].time;
}

export function nearestCandle(candles: Candle[], time: number) {
  if (!Number.isFinite(time)) return undefined;
  return candles.reduce<Candle | undefined>(
    (nearest, candle) =>
      !nearest || Math.abs(candle.time - time) < Math.abs(nearest.time - time)
        ? candle
        : nearest,
    undefined,
  );
}

export function candleWindow(
  candles: Candle[],
  size: number,
  endTime: number | null = null,
) {
  if (!Number.isInteger(size) || size < 1 || size > 500)
    throw new Error('Invalid chart window size.');
  const requestedEnd =
    endTime === null
      ? candles.length
      : candles.findLastIndex((c) => c.time <= endTime) + 1;
  const end = Math.max(Math.min(size, candles.length), requestedEnd);
  const start = Math.max(0, end - size);
  return {
    rows: candles.slice(start, end),
    start,
    end,
    earlier: start > 0,
    later: end < candles.length,
  };
}

export function moveCandleWindow(
  candles: Candle[],
  size: number,
  endTime: number | null,
  direction: -1 | 1,
) {
  const current = candleWindow(candles, size, endTime);
  const end = Math.min(
    candles.length,
    Math.max(
      Math.min(size, candles.length),
      current.end + direction * Math.max(1, Math.floor(size / 2)),
    ),
  );
  return end === candles.length ? null : (candles[end - 1]?.time ?? null);
}

export function dragCandleWindow(
  candles: Candle[],
  size: number,
  endTime: number | null,
  deltaX: number,
  plotWidth: number,
) {
  if (!Number.isFinite(deltaX) || !Number.isFinite(plotWidth) || plotWidth <= 0)
    throw new Error('Invalid chart drag coordinates.');
  const current = candleWindow(candles, size, endTime);
  const shift = Math.round(
    (deltaX / plotWidth) * Math.max(0, current.rows.length - 1),
  );
  const end = Math.min(
    candles.length,
    Math.max(Math.min(size, candles.length), current.end - shift),
  );
  return end === candles.length ? null : (candles[end - 1]?.time ?? null);
}

export function zoomCandleWindow(
  candles: Candle[],
  size: number,
  endTime: number | null,
  nextSize: number,
  anchorTime: number,
) {
  const current = candleWindow(candles, size, endTime);
  candleWindow(candles, nextSize);
  if (!Number.isFinite(anchorTime))
    throw new Error('Invalid chart zoom anchor.');
  const anchor = nearestCandle(current.rows, anchorTime);
  if (!anchor) return null;
  const index = candles.findIndex((c) => c.time === anchor.time);
  const fraction =
    (index - current.start) / Math.max(1, current.rows.length - 1);
  const end = Math.min(
    candles.length,
    Math.max(
      Math.min(nextSize, candles.length),
      index +
        1 +
        Math.round((1 - fraction) * (Math.min(nextSize, candles.length) - 1)),
    ),
  );
  return end === candles.length ? null : (candles[end - 1]?.time ?? null);
}
