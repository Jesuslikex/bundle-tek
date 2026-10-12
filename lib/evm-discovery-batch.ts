import type { EvmDiscovery } from './evm-transaction-discovery';
export type DiscoveryBatchState = {
  status: 'off' | 'reading' | 'waiting' | 'stopped' | 'complete' | 'error';
  reason: string;
  pages: number;
};
const fingerprint = (scan: unknown) => JSON.stringify(scan);
export function createEvmDiscoveryBatch(options: {
  unavailable: () => string | null;
  read: (signal: AbortSignal) => Promise<EvmDiscovery>;
  advance: (
    scan: EvmDiscovery,
    signal: AbortSignal,
  ) => Promise<EvmDiscovery | null>;
  onScan: (scan: EvmDiscovery) => void;
  onState: (state: DiscoveryBatchState) => void;
}) {
  let enabled = false,
    generation = 0,
    expected: EvmDiscovery | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined,
    pending: AbortController | undefined;
  const publish = (status: DiscoveryBatchState['status'], reason = '') =>
    options.onState({
      status,
      reason,
      pages: expected?.pages?.length ?? (expected ? 1 : 0),
    });
  const clear = () => {
    generation++;
    clearTimeout(timer);
    timer = undefined;
    pending?.abort();
    pending = undefined;
  };
  const stop = (reason = 'Automatic discovery stopped.') => {
    enabled = false;
    clear();
    publish('stopped', reason);
  };
  const validate = (scan: EvmDiscovery) => {
    if (
      !scan ||
      !/^(0|[1-9]\d{0,15})$/.test(scan.fromBlock) ||
      !/^(0|[1-9]\d{0,15})$/.test(scan.toBlock) ||
      BigInt(scan.fromBlock) > BigInt(scan.toBlock) ||
      BigInt(scan.toBlock) - BigInt(scan.fromBlock) >= 200n ||
      !Number.isFinite(Date.parse(scan.observedAt)) ||
      !Number.isInteger(scan.blocksScanned) ||
      scan.blocksScanned < 1 ||
      scan.blocksScanned > 200 ||
      !Array.isArray(scan.candidates) ||
      scan.candidates.length > 100 ||
      (scan.pages &&
        (!Array.isArray(scan.pages) ||
          !scan.pages.length ||
          scan.pages.length > 20))
    )
      throw new Error('Invalid saved discovery window.');
    return scan;
  };
  const finished = (scan: EvmDiscovery) =>
    scan.fromBlock === '0' ||
    (scan.pages?.length ?? 1) >= 20 ||
    scan.candidates.length >= 100;
  const wait = (run: number) => {
    publish('waiting', 'Waiting 15 seconds before the next page.');
    timer = setTimeout(() => void tick(run), 15000);
  };
  async function tick(run: number) {
    if (!enabled || run !== generation || pending) return;
    const unavailable = options.unavailable();
    if (unavailable) {
      stop(unavailable);
      return;
    }
    const controller = new AbortController();
    pending = controller;
    publish('reading');
    const current = () =>
      enabled && generation === run && !controller.signal.aborted;
    try {
      const scan = validate(await options.read(controller.signal));
      if (!current()) return;
      if (expected && fingerprint(scan) !== fingerprint(expected))
        throw new Error('Saved discovery changed. Reload before restarting.');
      expected = scan;
      options.onScan(scan);
      if (finished(scan)) {
        enabled = false;
        pending = undefined;
        publish(
          'complete',
          'Saved scan reached its history limit or genesis. This is bounded coverage, not complete wallet history.',
        );
        return;
      }
      if (!scan.fromParentHash || !scan.fromBlockHash)
        throw new Error(
          'Saved scan has no continuation anchors. Start a latest scan first.',
        );
      const next = await options.advance(scan, controller.signal);
      if (!current()) return;
      pending = undefined;
      if (!next) {
        wait(run);
        return;
      }
      validate(next);
      if (
        next.chain !== scan.chain ||
        next.address !== scan.address ||
        next.toBlock !== scan.toBlock ||
        next.blockHash !== scan.blockHash ||
        Boolean(next.includesTokenEvents) !==
          Boolean(scan.includesTokenEvents) ||
        next.observedAt <= scan.observedAt ||
        BigInt(next.fromBlock) >= BigInt(scan.fromBlock) ||
        BigInt(scan.fromBlock) - BigInt(next.fromBlock) > 10n ||
        (next.pages?.length ?? 1) !== (scan.pages?.length ?? 1) + 1 ||
        fingerprint(next.pages?.slice(0, scan.pages?.length ?? 1)) !==
          fingerprint(
            scan.pages ?? [
              {
                fromBlock: scan.fromBlock,
                toBlock: scan.toBlock,
                blockHash: scan.blockHash,
                observedAt: scan.observedAt,
                blocksScanned: scan.blocksScanned,
                transactionsScanned: scan.transactionsScanned,
              },
            ],
          ) ||
        next.candidates.length < scan.candidates.length ||
        fingerprint(next.candidates.slice(0, scan.candidates.length)) !==
          fingerprint(scan.candidates)
      )
        throw new Error(
          'Discovery did not extend the saved window. Reload before restarting.',
        );
      expected = next;
      options.onScan(next);
      if (finished(next)) {
        enabled = false;
        publish(
          'complete',
          'Saved scan reached its history limit or genesis. This is bounded coverage, not complete wallet history.',
        );
      } else wait(run);
    } catch (error) {
      if (!current()) return;
      enabled = false;
      pending = undefined;
      publish(
        'error',
        error instanceof Error
          ? error.message
          : 'Discovery unavailable. Saved pages remain available.',
      );
    }
  }
  return {
    start() {
      if (enabled) return;
      clear();
      enabled = true;
      expected = null;
      void tick(generation);
    },
    stop,
    availabilityChanged() {
      const reason = options.unavailable();
      if (enabled && reason) stop(reason);
    },
    destroy() {
      enabled = false;
      clear();
    },
  };
}
