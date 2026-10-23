export type TrackedHistoryFilters = {
  search: string;
  status: 'all' | 'failed' | 'no-error';
  from: string;
  to: string;
  order: 'newest' | 'oldest';
};
export const TRACKED_HISTORY_FILTERS: TrackedHistoryFilters = {
  search: '',
  status: 'all',
  from: '',
  to: '',
  order: 'newest',
};
export const TRACKED_HISTORY_PAGE_SIZE = 25;
/** Same UTC basis as the date bounds; malformed or missing evidence stays unknown. */
export function trackedHistoryTimeLabel(time: number | null) {
  if (time === null || !Number.isFinite(time)) return 'Time unavailable';
  try {
    return new Date(time).toISOString().replace('T', ' ').replace('Z', ' UTC');
  } catch {
    return 'Time unavailable';
  }
}
/** Relative record time is a presentation, never wallet age or refreshed evidence. */
export function trackedHistoryRelativeLabel(
  time: number | null,
  now: number | null,
) {
  const full = trackedHistoryTimeLabel(time);
  if (
    full === 'Time unavailable' ||
    time === null ||
    now === null ||
    !Number.isFinite(now)
  )
    return full;
  const delta = now - time;
  const seconds = Math.floor(Math.abs(delta) / 1000);
  if (seconds === 0)
    return delta < 0 ? 'In less than 1s (future timestamp)' : 'Just now';
  const amount =
    seconds < 60
      ? `${seconds}s`
      : seconds < 3600
        ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
        : seconds < 86400
          ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`
          : `${Math.floor(seconds / 86400)}d ${Math.floor(seconds / 3600) % 24}h`;
  return delta < 0 ? `In ${amount} (future timestamp)` : `${amount} ago`;
}
function utcDay(value: string) {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value.startsWith('0000'))
    throw Error();
  const time = Date.parse(value + 'T00:00:00.000Z');
  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString().slice(0, 10) !== value
  )
    throw Error();
  return time;
}
/** Local display only. Dates are whole UTC days; unknown times never gain invented dates. */
export function trackedHistoryView<
  T extends { signature: string; slot: number; failed: boolean },
>(
  records: readonly T[],
  filters: TrackedHistoryFilters,
  requestedPage: number,
  recordedTime: (row: T) => number | null,
) {
  const empty = {
    rows: [] as T[],
    matching: 0,
    loaded: records.length,
    page: 0,
    pageCount: 1,
    valid: false,
  };
  try {
    const from = filters.from ? utcDay(filters.from) : null,
      to = filters.to ? utcDay(filters.to) : null;
    if (from !== null && to !== null && from > to) return empty;
    const query = filters.search.trim();
    const matches = records
      .map((row) => {
        const value = recordedTime(row);
        return {
          row,
          time: value !== null && Number.isFinite(value) ? value : null,
        };
      })
      .filter(
        ({ row, time }) =>
          row.signature.includes(query) &&
          (filters.status === 'all' ||
            row.failed === (filters.status === 'failed')) &&
          (from === null || (time !== null && time >= from)) &&
          (to === null || (time !== null && time < to + 86400000)),
      );
    const direction = filters.order === 'oldest' ? 1 : -1;
    matches.sort((a, b) => {
      if (a.time === null || b.time === null) {
        if (a.time !== b.time) return a.time === null ? 1 : -1;
      } else if (a.time !== b.time) return (a.time - b.time) * direction;
      if (a.row.slot !== b.row.slot)
        return (a.row.slot - b.row.slot) * direction;
      return a.row.signature < b.row.signature
        ? -1
        : a.row.signature > b.row.signature
          ? 1
          : 0;
    });
    const pageCount = Math.max(
      1,
      Math.ceil(matches.length / TRACKED_HISTORY_PAGE_SIZE),
    );
    const page = Math.min(
      Math.max(0, Number.isSafeInteger(requestedPage) ? requestedPage : 0),
      pageCount - 1,
    );
    return {
      rows: matches
        .slice(
          page * TRACKED_HISTORY_PAGE_SIZE,
          (page + 1) * TRACKED_HISTORY_PAGE_SIZE,
        )
        .map((e) => e.row),
      matching: matches.length,
      loaded: records.length,
      page,
      pageCount,
      valid: true,
    };
  } catch {
    return empty;
  }
}
