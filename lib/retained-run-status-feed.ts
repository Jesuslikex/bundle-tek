export type RetainedRunFeedState = {
  status: 'off' | 'refreshing' | 'waiting' | 'paused' | 'retrying';
  reason: string;
  reads: number;
  retryInMs: number | null;
};
// Reads saved application state only. This transport never advances a run.
export function createRetainedRunStatusFeed(options: {
  unavailable: () => string | null;
  read: (signal: AbortSignal) => Promise<boolean>;
  onState: (state: RetainedRunFeedState) => void;
}) {
  let enabled = false,
    generation = 0,
    reads = 0,
    failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: AbortController | undefined;
  const clear = () => {
    generation++;
    clearTimeout(timer);
    timer = undefined;
    pending?.abort();
    pending = undefined;
  };
  const publish = (
    status: RetainedRunFeedState['status'],
    reason = '',
    retryInMs: number | null = null,
  ) => options.onState({ status, reason, reads, retryInMs });
  async function tick(run: number) {
    if (!enabled || run !== generation || pending) return;
    const reason = options.unavailable();
    if (reason) {
      publish('paused', reason);
      return;
    }
    const controller = new AbortController();
    pending = controller;
    publish('refreshing');
    let success = false;
    try {
      success = await options.read(controller.signal);
    } catch {
      /* Panel retains the error. */
    }
    if (controller.signal.aborted || run !== generation || !enabled) return;
    pending = undefined;
    if (success) {
      reads++;
      failures = 0;
      publish('waiting');
    } else {
      failures = Math.min(failures + 1, 4);
    }
    const delay = success ? 5000 : Math.min(5000 * 2 ** (failures - 1), 30000);
    if (!success)
      publish(
        'retrying',
        'Saved status read failed. Retained results remain visible.',
        delay,
      );
    timer = setTimeout(() => void tick(run), delay);
  }
  return {
    start() {
      if (enabled) return;
      enabled = true;
      failures = 0;
      clear();
      void tick(generation);
    },
    pause(reason: string) {
      if (!enabled) return;
      clear();
      publish('paused', reason);
    },
    availabilityChanged() {
      if (!enabled) return;
      clear();
      void tick(generation);
    },
    stop() {
      enabled = false;
      clear();
      publish('off');
    },
    destroy() {
      enabled = false;
      clear();
    },
  };
}
