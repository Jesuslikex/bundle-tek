import {
  appendHolderIndexPage,
  HOLDER_INDEX_MAX_PAGES,
  type HolderIndexPage,
  type HolderIndexScan,
} from './holder-index';
export type SavedHolderRun = {
  id: string;
  revision: number;
  pages: number;
  status: 'partial' | 'enumerated' | 'limit';
  updatedAt: string;
  createdAt: string;
};
/** Bound both fetch and body reads, even when a transport ignores cancellation. */
async function readHistoryResponse(
  url: string,
  parent: AbortSignal,
  fetcher: typeof fetch,
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent.addEventListener('abort', abort, { once: true });
  if (parent.aborted) abort();
  const timer = setTimeout(abort, 30_000);
  let cancel = () => {};
  try {
    controller.signal.throwIfAborted();
    return await Promise.race([
      new Promise<never>((_resolve, reject) => {
        cancel = () =>
          reject(
            new Error(
              'Saved holder history stopped or timed out. Reload history to try again.',
            ),
          );
        controller.signal.addEventListener('abort', cancel, { once: true });
        if (controller.signal.aborted) cancel();
      }),
      (async () => {
        const response = await fetcher(url, {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
        });
        let data: unknown;
        try {
          data = await response.json();
        } catch {
          throw new Error(
            'Saved holder history returned an unreadable response. Reload history to try again.',
          );
        }
        controller.signal.throwIfAborted();
        if (!response.ok)
          throw new Error(
            'Saved holder history unavailable. Reload history to try again.',
          );
        if (!data || typeof data !== 'object' || Array.isArray(data))
          throw new Error(
            'Saved holder history returned an unreadable response. Reload history to try again.',
          );
        return data;
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', cancel);
    controller.abort();
  }
}
export async function readHolderIndexHistory(
  project: { id: string; revision: number; mint: string; decimals: number },
  selected: string | null,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  let cursor = 0,
    scan: HolderIndexScan | null = null,
    runId = selected;
  let runs: SavedHolderRun[] = [];
  do {
    const params = new URLSearchParams({
      id: project.id,
      revision: String(project.revision),
    });
    if (runId) params.set('run', runId);
    if (cursor) params.set('cursor', String(cursor));
    const data = (await readHistoryResponse(
      `/api/imported-projects/holder-index?${params}`,
      signal,
      fetcher,
    )) as {
      id?: string;
      revision?: number;
      runId?: string | null;
      runs?: SavedHolderRun[];
      pages?: HolderIndexPage[];
      nextCursor?: number | null;
      error?: string;
    };
    if (
      data.id !== project.id ||
      data.revision !== project.revision ||
      !Array.isArray(data.runs) ||
      data.runs.length > 20 ||
      !Array.isArray(data.pages) ||
      data.pages.length > 5 ||
      (runId && data.runId !== runId)
    )
      throw new Error('Saved holder history context differs.');
    for (const run of data.runs) {
      if (
        !/^[0-9a-f-]{36}$/.test(run.id) ||
        !Number.isSafeInteger(run.revision) ||
        run.revision < 1 ||
        !Number.isSafeInteger(run.pages) ||
        run.pages < 1 ||
        run.pages > HOLDER_INDEX_MAX_PAGES ||
        !['partial', 'enumerated', 'limit'].includes(run.status) ||
        !Number.isFinite(Date.parse(run.updatedAt))
      )
        throw new Error('Invalid saved holder run.');
    }
    runs = data.runs;
    runId = data.runId ?? null;
    if (
      (runId && !runs.some((run) => run.id === runId)) ||
      (!runId && data.pages.length)
    )
      throw new Error('Saved holder run not found.');
    for (const page of data.pages)
      scan = appendHolderIndexPage(scan, page, project.mint, project.decimals);
    signal.throwIfAborted();
    if (data.nextCursor === null) {
      const run = runs.find((item) => item.id === runId);
      if (run && (scan?.pages !== run.pages || scan.status !== run.status))
        throw new Error(
          'Saved holder pages are incomplete or changed. Reload history.',
        );
      return { runId, runs, scan };
    }
    if (
      !Number.isSafeInteger(data.nextCursor) ||
      Number(data.nextCursor) <= cursor ||
      data.nextCursor !== scan?.pages ||
      Number(data.nextCursor) >= HOLDER_INDEX_MAX_PAGES
    )
      throw new Error('Invalid saved holder pagination.');
    cursor = Number(data.nextCursor);
  } while (cursor < HOLDER_INDEX_MAX_PAGES);
  throw new Error('Saved holder page limit exceeded.');
}
