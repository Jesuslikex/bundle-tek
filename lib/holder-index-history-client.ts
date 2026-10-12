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
    const response = await fetcher(
      `/api/imported-projects/holder-index?${params}`,
      { credentials: 'same-origin', cache: 'no-store', signal },
    );
    const data = (await response.json()) as {
      id?: string;
      revision?: number;
      runId?: string | null;
      runs?: SavedHolderRun[];
      pages?: HolderIndexPage[];
      nextCursor?: number | null;
      error?: string;
    };
    if (!response.ok)
      throw new Error(data.error || 'Saved holder history unavailable.');
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
