export type MarketFeedState = {
  status: 'off' | 'running' | 'paused' | 'error';
  reason: string;
  reads: number;
};
export type MarketFeedReadResult =
  | boolean
  | { status: 'retry'; reason: string; retryAfterMs?: number };
// Foreground-only, explicit start. Schedule after completion so reads cannot overlap.
export function createForegroundMarketFeed(options: {
  available: () => boolean;
  read: (signal: AbortSignal) => Promise<MarketFeedReadResult>;
  onState: (state: MarketFeedState) => void;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  let generation = 0;
  let reads = 0;
  let running = false;
  let failures = 0;
  const clear = () => {
    generation++;
    running = false;
    clearTimeout(timer);
    request?.abort();
    request = undefined;
    failures = 0;
  };
  const publish = (status: MarketFeedState['status'], reason = '') =>
    options.onState({ status, reason, reads });
  const pause = (reason: string) => {
    if (!running) return;
    clear();
    publish('paused', reason);
  };
  async function tick(run: number) {
    if (run !== generation || !running) return;
    if (!options.available()) {
      pause('Project is not visible or the browser is offline.');
      return;
    }
    const c = new AbortController();
    request = c;
    let success: MarketFeedReadResult = false;
    try {
      success = await options.read(c.signal);
    } catch {
      /* The panel retains the detailed read error. */
    }
    if (run !== generation || c.signal.aborted) return;
    request = undefined;
    if (typeof success === 'object' && success.status === 'retry') {
      failures++;
      const backoff = Math.min(300000, 30000 * 2 ** Math.min(failures - 1, 4));
      const jitter = Math.min(
        300000,
        backoff + Math.floor(Math.random() * backoff * 0.2),
      );
      const hint = success.retryAfterMs;
      const delay = Math.max(
        jitter,
        typeof hint === 'number' && Number.isFinite(hint) && hint > 0
          ? Math.min(hint, 86400000)
          : 0,
      );
      publish(
        'running',
        `${success.reason} Retrying in ${Math.ceil(delay / 1000)} seconds.`,
      );
      timer = setTimeout(() => void tick(run), delay);
      return;
    }
    if (!success) {
      clear();
      publish('error', 'Read failed. Review the error and restart explicitly.');
      return;
    }
    reads++;
    failures = 0;
    publish('running');
    timer = setTimeout(() => void tick(run), 30000);
  }
  return {
    start() {
      if (running) return;
      clear();
      if (!options.available()) {
        publish(
          'paused',
          'Open the project in a visible, online tab to start.',
        );
        return;
      }
      running = true;
      publish('running');
      void tick(generation);
    },
    pause,
    stop() {
      clear();
      publish('off');
    },
    destroy: clear,
  };
}
