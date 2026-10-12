import { SupplyMonitorReadError } from './supply-monitor-read';
export type MovementInspectionState = {
  status: 'off' | 'running' | 'paused' | 'error' | 'complete' | 'limit';
  reason: string;
  pages: number;
};
type Page = {
  requestedCursor: string | null;
  nextCursor: string | null;
  completeThroughBoundary: boolean;
  anchor: number;
};
let movementReadTail: Promise<unknown> = Promise.resolve();
function queuedRead(read: () => Promise<Page>, signal: AbortSignal) {
  const result = movementReadTail.then(() => {
    if (signal.aborted) throw new Error('Inspection cancelled.');
    return read();
  });
  movementReadTail = result.catch(() => undefined);
  return result;
}
// A continuation reads one index only. Stopping or hiding never restarts it.
export function createForegroundMovementInspection(options: {
  available: () => boolean;
  read: (cursor: string | null, signal: AbortSignal) => Promise<Page>;
  onState: (state: MovementInspectionState) => void;
  maxPages?: number;
}) {
  const max = options.maxPages ?? 20;
  if (!Number.isInteger(max) || max < 1 || max > 20)
    throw new Error('Choose one to twenty inspection pages.');
  let timer: ReturnType<typeof setTimeout> | undefined,
    request: AbortController | undefined;
  let generation = 0,
    running = false,
    pages = 0,
    failures = 0,
    cursor: string | null = null,
    anchor: number | null = null;
  const seen = new Set<string>();
  const publish = (status: MovementInspectionState['status'], reason = '') =>
    options.onState({ status, reason, pages });
  const clear = () => {
    generation++;
    running = false;
    clearTimeout(timer);
    request?.abort();
    request = undefined;
  };
  const finish = (
    status: MovementInspectionState['status'],
    reason: string,
  ) => {
    clear();
    publish(status, reason);
  };
  async function tick(run: number) {
    if (!running || run !== generation) return;
    if (!options.available()) {
      finish(
        'paused',
        'Inspection paused because the tab is hidden or offline.',
      );
      return;
    }
    const controller = new AbortController();
    request = controller;
    try {
      const page = await queuedRead(
        () => options.read(cursor, controller.signal),
        controller.signal,
      );
      if (controller.signal.aborted || run !== generation) return;
      request = undefined;
      if (
        page.requestedCursor !== cursor ||
        typeof page.completeThroughBoundary !== 'boolean' ||
        !Number.isSafeInteger(page.anchor) ||
        page.anchor < 0 ||
        (anchor !== null && page.anchor !== anchor) ||
        (page.nextCursor !== null &&
          (typeof page.nextCursor !== 'string' ||
            page.nextCursor.length > 220 ||
            seen.has(page.nextCursor))) ||
        (page.completeThroughBoundary
          ? page.nextCursor !== null
          : page.nextCursor === null)
      )
        throw new Error(
          'Inspection cursor or anchor changed. Reload saved evidence.',
        );
      anchor = page.anchor;
      pages++;
      failures = 0;
      if (page.completeThroughBoundary) {
        finish(
          'complete',
          'This address index reached the interval boundary. Wallet coverage remains partial.',
        );
        return;
      }
      cursor = page.nextCursor;
      seen.add(cursor!);
      if (pages >= max) {
        finish(
          'limit',
          `${max} pages read. More evidence may remain; continue explicitly.`,
        );
        return;
      }
      publish('running', 'Next page in 30 seconds.');
      timer = setTimeout(() => void tick(run), 30000);
    } catch (error) {
      if (controller.signal.aborted || run !== generation) return;
      request = undefined;
      if (
        error instanceof SupplyMonitorReadError &&
        error.retryable &&
        ++failures <= 5
      ) {
        const backoff = Math.min(300000, 30000 * 2 ** (failures - 1));
        const hint = error.retryAfterMs;
        const delay = Math.max(
          Math.min(300000, backoff + Math.floor(Math.random() * backoff * 0.2)),
          typeof hint === 'number' && Number.isFinite(hint) && hint > 0
            ? Math.min(hint, 86400000)
            : 0,
        );
        publish(
          'running',
          `${error.message} Retrying the same page in ${Math.ceil(delay / 1000)} seconds.`,
        );
        timer = setTimeout(() => void tick(run), delay);
      } else
        finish(
          'error',
          error instanceof Error
            ? error.message
            : 'Movement inspection unavailable.',
        );
    }
  }
  return {
    start(initialCursor: string | null = null) {
      if (running) return;
      clear();
      pages = 0;
      failures = 0;
      anchor = null;
      cursor = initialCursor;
      seen.clear();
      if (cursor) seen.add(cursor);
      if (!options.available()) {
        publish('paused', 'Open a visible online tab to continue inspection.');
        return;
      }
      running = true;
      publish('running');
      void tick(generation);
    },
    pause() {
      if (running)
        finish(
          'paused',
          'Inspection paused because the tab is hidden or offline.',
        );
    },
    stop() {
      clear();
      publish('off', 'Inspection stopped. Saved evidence is retained.');
    },
    destroy: clear,
  };
}
