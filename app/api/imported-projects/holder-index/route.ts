import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { observeHolderIndexPage } from '@/lib/holder-index-provider';
import { HolderMintObservationConflict } from '@/lib/holder-index-mint';
import { HOLDER_INDEX_MAX_PAGES } from '@/lib/holder-index';
import type { HolderIndexPage } from '@/lib/holder-index';
import { WalletRpcError } from '@/lib/wallet-balances';
import {
  holderRun,
  deleteHolderRun,
  saveHolderRunPage,
  HolderIndexConflict,
  HOLDER_RUN_RESUME_MS,
  MAX_HOLDER_RUNS,
  type HolderIndexRunRow,
} from '@/lib/holder-index-store';

export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
type Project = {
  revision: number;
  archived: number;
  chain: string;
  address: string;
};
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to scan token holders.' }, 401);
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return json({ error: 'Cross-origin request rejected.' }, 403);
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  )
    return json({ error: 'JSON required.' }, 415);
  let query: {
    id: string;
    revision: number;
    page: number;
    runId: string;
    enumeration?: 'das-cursor' | 'program-accounts-v2';
  };
  try {
    const text = await request.text();
    if (text.length > 256) return json({ error: 'Request too large.' }, 413);
    query = JSON.parse(text);
    if (
      !query ||
      (query.enumeration !== undefined &&
        !['das-cursor', 'program-accounts-v2'].includes(query.enumeration)) ||
      typeof query.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(query.id) ||
      !Number.isSafeInteger(query.revision) ||
      query.revision < 1 ||
      !Number.isSafeInteger(query.page) ||
      query.page < 1 ||
      query.page > HOLDER_INDEX_MAX_PAGES ||
      typeof query.runId !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(query.runId)
    )
      throw new Error();
  } catch {
    return json(
      { error: 'Choose a saved project and valid holder page.' },
      400,
    );
  }
  try {
    const db = getD1();
    const readProject = () =>
      db
        .prepare(
          'SELECT revision,archived,chain,address FROM imported_token_projects WHERE owner_id=? AND id=?',
        )
        .bind(user.userId, query.id)
        .first<Project>();
    const project = await readProject();
    if (!project) return json({ error: 'Imported project not found.' }, 404);
    if (
      project.revision !== query.revision ||
      project.archived ||
      project.chain !== 'Solana'
    )
      return json(
        { error: 'Project changed or unavailable. Reload projects.' },
        409,
      );
    const run = await holderRun(db, user.userId, query.id, query.runId);
    if (!run) {
      const quota = await db
        .prepare(
          'SELECT COUNT(*) AS count FROM holder_index_runs WHERE owner_id=? AND project_id=?',
        )
        .bind(user.userId, query.id)
        .first<{ count: number }>();
      if ((quota?.count ?? 0) >= MAX_HOLDER_RUNS)
        return json(
          {
            error:
              'This project has 20 saved holder runs. Remove an old saved scan before starting another.',
          },
          409,
        );
    }
    if (run && run.project_revision !== query.revision)
      return json(
        {
          error:
            'Saved scan belongs to another project revision. Start a fresh scan.',
        },
        409,
      );
    const existing = await db
      .prepare(
        'SELECT document FROM holder_index_pages WHERE owner_id=? AND project_id=? AND run_id=? AND page=?',
      )
      .bind(user.userId, query.id, query.runId, query.page)
      .first<{ document: string }>();
    if (
      existing &&
      query.enumeration &&
      JSON.parse(existing.document).enumeration !== query.enumeration
    )
      return json(
        { error: 'Saved scan enumeration method differs. Reload saved scans.' },
        409,
      );
    if (existing)
      return json({
        id: query.id,
        revision: query.revision,
        runId: query.runId,
        page: JSON.parse(existing.document),
      });
    if (
      run
        ? run.status !== 'partial' ||
          query.page !== run.last_page + 1 ||
          Date.now() - Date.parse(run.updated_at) > HOLDER_RUN_RESUME_MS
        : query.page !== 1
    )
      return json(
        {
          error:
            'Saved holder run changed or is too old to resume. Start a fresh scan.',
        },
        409,
      );
    const previous = run
      ? (JSON.parse(
          (await db
            .prepare(
              'SELECT document FROM holder_index_pages WHERE owner_id=? AND project_id=? AND run_id=? AND page=?',
            )
            .bind(user.userId, query.id, query.runId, run.last_page)
            .first<{ document: string }>())!.document,
        ) as HolderIndexPage)
      : null;
    if (
      previous &&
      query.enumeration &&
      previous.enumeration !== query.enumeration
    )
      return json(
        { error: 'Saved scan enumeration method differs. Reload saved scans.' },
        409,
      );
    const page = await observeHolderIndexPage(
      project.address,
      query.page,
      AbortSignal.any([request.signal, AbortSignal.timeout(25000)]),
      fetch,
      previous,
      ...(query.enumeration ? ([query.enumeration] as const) : ([] as const)),
    );
    const current = await readProject();
    if (
      !current ||
      current.revision !== query.revision ||
      current.archived ||
      current.address !== project.address ||
      current.chain !== 'Solana'
    )
      return json(
        { error: 'Project changed during holder scan. Reload projects.' },
        409,
      );
    let saved;
    try {
      saved = await saveHolderRunPage(
        db,
        user.userId,
        query.id,
        query.revision,
        query.runId,
        run,
        page,
      );
    } catch (failure) {
      if (failure instanceof HolderIndexConflict) throw failure;
      return json(
        {
          error:
            'Holder scan storage unavailable. Reload saved runs before resuming.',
        },
        503,
      );
    }
    return json({ id: query.id, revision: query.revision, ...saved });
  } catch (error) {
    if (
      error instanceof HolderIndexConflict ||
      error instanceof HolderMintObservationConflict
    )
      return json({ error: error.message }, 409);
    return json(
      {
        error:
          'Holder index unavailable. The configured indexer must support mint-filtered cursor pagination and valid slot metadata. Retry or check provider configuration.',
      },
      error instanceof WalletRpcError && error.status === 429 ? 429 : 502,
    );
  }
}

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to read saved holder scans.' }, 401);
  const params = new URL(request.url).searchParams;
  const id = params.get('id'),
    revision = Number(params.get('revision')),
    runId = params.get('run');
  const cursor = Number(params.get('cursor') ?? '0');
  if (
    !id ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(id) ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    (runId !== null && !/^[0-9a-f-]{36}$/.test(runId)) ||
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    cursor > HOLDER_INDEX_MAX_PAGES ||
    (cursor && !runId)
  )
    return json({ error: 'Choose a saved holder run.' }, 400);
  try {
    const db = getD1();
    const project = await db
      .prepare(
        'SELECT revision,chain,address FROM imported_token_projects WHERE owner_id=? AND id=?',
      )
      .bind(user.userId, id)
      .first<Project>();
    if (!project) return json({ error: 'Imported project not found.' }, 404);
    if (project.revision !== revision || project.chain !== 'Solana')
      return json({ error: 'Project changed. Reload projects.' }, 409);
    const rows = (
      await db
        .prepare(
          'SELECT id,project_revision,document,last_page,indexed_raw,status,created_at,updated_at FROM holder_index_runs WHERE owner_id=? AND project_id=? ORDER BY created_at DESC,id DESC LIMIT 20',
        )
        .bind(user.userId, id)
        .all<HolderIndexRunRow>()
    ).results;
    const selected = runId ? rows.find((row) => row.id === runId) : rows[0];
    if (runId && !selected)
      return json({ error: 'Saved holder run not found.' }, 404);
    const pages = selected
      ? (
          await db
            .prepare(
              'SELECT document FROM holder_index_pages WHERE owner_id=? AND project_id=? AND run_id=? AND page>? ORDER BY page LIMIT 5',
            )
            .bind(user.userId, id, selected.id, cursor)
            .all<{ document: string }>()
        ).results.map((row) => JSON.parse(row.document))
      : [];
    const last = pages.at(-1)?.page ?? cursor;
    return json({
      id,
      revision,
      runs: rows.map((row) => ({
        id: row.id,
        revision: row.project_revision,
        pages: row.last_page,
        status: row.status,
        updatedAt: row.updated_at,
        createdAt: row.created_at,
      })),
      runId: selected?.id ?? null,
      pages,
      nextCursor: selected && last < selected.last_page ? last : null,
    });
  } catch {
    return json({ error: 'Saved holder scan storage unavailable.' }, 503);
  }
}

export async function DELETE(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to remove a saved holder scan.' }, 401);
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return json({ error: 'Cross-origin request rejected.' }, 403);
  const params = new URL(request.url).searchParams;
  const id = params.get('id'),
    run = params.get('run'),
    revision = Number(params.get('revision'));
  if (
    !id ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(id) ||
    !run ||
    !/^[0-9a-f-]{36}$/.test(run) ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  )
    return json({ error: 'Choose a saved run and project revision.' }, 400);
  try {
    await deleteHolderRun(getD1(), user.userId, id, revision, run);
    return json({ id, revision, removed: run });
  } catch (failure) {
    return failure instanceof HolderIndexConflict
      ? json({ error: failure.message }, 409)
      : json({ error: 'Saved holder run removal unavailable.' }, 503);
  }
}
