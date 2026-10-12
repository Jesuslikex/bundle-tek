import {
  appendHolderIndexPage,
  HOLDER_INDEX_MAX_PAGES,
  HOLDER_RUN_RESUME_MS,
  type HolderIndexPage,
} from './holder-index';

export type HolderIndexRunRow = {
  id: string;
  project_revision: number;
  document: string;
  last_page: number;
  indexed_raw: string;
  status: string;
  created_at: string;
  updated_at: string;
};
export type HolderIndexRunContext = {
  mint: string;
  decimals: number;
  totalSupplyRaw: string;
  source: string;
};
export class HolderIndexConflict extends Error {}
export const MAX_HOLDER_RUNS = 20;
export { HOLDER_RUN_RESUME_MS } from './holder-index';
export function requireHolderRunPage(
  run: HolderIndexRunRow | null,
  page: HolderIndexPage,
  now = Date.now(),
) {
  // Validate the independently read page before it becomes durable.
  appendHolderIndexPage(null, { ...page, page: 1 }, page.mint, page.decimals);
  if (!run) {
    if (page.page !== 1)
      throw new HolderIndexConflict(
        'Start a holder scan before requesting later pages.',
      );
    return;
  }
  const context = JSON.parse(run.document) as HolderIndexRunContext;
  if (
    run.status !== 'partial' ||
    page.page !== run.last_page + 1 ||
    now - Date.parse(run.updated_at) > HOLDER_RUN_RESUME_MS ||
    context.mint !== page.mint ||
    context.decimals !== page.decimals ||
    context.totalSupplyRaw !== page.totalSupplyRaw ||
    context.source !== page.source
  )
    throw new HolderIndexConflict(
      'Holder run changed or is too old to resume. Start a fresh scan.',
    );
}
export function holderRun(
  db: D1Database,
  owner: string,
  project: string,
  id: string,
) {
  return db
    .prepare(
      'SELECT id,project_revision,document,last_page,indexed_raw,status,created_at,updated_at FROM holder_index_runs WHERE owner_id=? AND project_id=? AND id=?',
    )
    .bind(owner, project, id)
    .first<HolderIndexRunRow>();
}
export async function saveHolderRunPage(
  db: D1Database,
  owner: string,
  project: string,
  revision: number,
  runId: string,
  run: HolderIndexRunRow | null,
  page: HolderIndexPage,
) {
  requireHolderRunPage(run, page);
  const prior = run?.last_page ?? 0;
  const addition = page.accounts.reduce(
    (sum, account) => sum + BigInt(account.raw),
    0n,
  );
  const indexed = BigInt(run?.indexed_raw ?? '0') + addition;
  if (indexed > BigInt(page.totalSupplyRaw))
    throw new HolderIndexConflict(
      'Indexed balances exceed supply. Start a fresh scan.',
    );
  const status =
    page.accounts.length === 0
      ? 'enumerated'
      : page.page === HOLDER_INDEX_MAX_PAGES
        ? 'limit'
        : 'partial';
  const stamp = new Date().toISOString();
  const context: HolderIndexRunContext = {
    mint: page.mint,
    decimals: page.decimals,
    totalSupplyRaw: page.totalSupplyRaw,
    source: page.source,
  };
  // A page row is the commit gate. Every following statement requires that exact
  // serialized page, and the batch rolls back if any account identity overlaps.
  const guard = `EXISTS(SELECT 1 FROM imported_token_projects WHERE owner_id=? AND id=? AND revision=? AND archived=0 AND chain='Solana' AND address=?)`;
  const scope = [owner, project, revision, page.mint];
  const text = JSON.stringify(page);
  const gate = `EXISTS(SELECT 1 FROM holder_index_pages WHERE owner_id=? AND project_id=? AND run_id=? AND page=? AND document=?)`;
  const gateArgs = [owner, project, runId, page.page, text];
  const result = await db
    .batch([
      db
        .prepare(
          `INSERT INTO holder_index_pages(owner_id,project_id,run_id,page,document) SELECT ?,?,?,?,? WHERE ${guard} AND COALESCE((SELECT last_page FROM holder_index_runs WHERE owner_id=? AND project_id=? AND id=?),0)=? AND (EXISTS(SELECT 1 FROM holder_index_runs WHERE owner_id=? AND project_id=? AND id=? AND status='partial') OR (?=1 AND (SELECT COUNT(*) FROM holder_index_runs WHERE owner_id=? AND project_id=?)<?))`,
        )
        .bind(
          owner,
          project,
          runId,
          page.page,
          text,
          ...scope,
          owner,
          project,
          runId,
          prior,
          owner,
          project,
          runId,
          page.page,
          owner,
          project,
          MAX_HOLDER_RUNS,
        ),
      db
        .prepare(
          `INSERT INTO holder_index_accounts(owner_id,project_id,run_id,address) SELECT ?,?,?,json_extract(value,'$.address') FROM json_each(?) WHERE ${gate}`,
        )
        .bind(
          owner,
          project,
          runId,
          JSON.stringify(page.accounts),
          ...gateArgs,
        ),
      db
        .prepare(
          `INSERT INTO holder_index_runs(owner_id,project_id,id,project_revision,document,last_page,indexed_raw,status,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${gate} ON CONFLICT(owner_id,project_id,id) DO UPDATE SET last_page=excluded.last_page,indexed_raw=excluded.indexed_raw,status=excluded.status,updated_at=excluded.updated_at WHERE holder_index_runs.last_page=?`,
        )
        .bind(
          owner,
          project,
          runId,
          revision,
          JSON.stringify(context),
          page.page,
          indexed.toString(),
          status,
          run?.created_at ?? stamp,
          stamp,
          ...gateArgs,
          prior,
        ),
    ])
    .catch((error: unknown) => {
      if (
        error instanceof Error &&
        /UNIQUE constraint failed: holder_index_(accounts|pages)/.test(
          error.message,
        )
      )
        throw new HolderIndexConflict(
          'Holder pages overlap or changed. Start a fresh scan.',
        );
      throw error;
    });
  if (!result[0].meta.changes || !result[2].meta.changes)
    throw new HolderIndexConflict(
      'Holder run or project changed. Reload saved scans.',
    );
  return { runId, page, status };
}

export async function deleteHolderRun(
  db: D1Database,
  owner: string,
  project: string,
  revision: number,
  id: string,
) {
  const guard =
    'EXISTS(SELECT 1 FROM imported_token_projects WHERE owner_id=? AND id=? AND revision=?)';
  const statements = [
    'holder_index_accounts',
    'holder_index_pages',
    'holder_index_runs',
  ].map((table) =>
    db
      .prepare(
        `DELETE FROM ${table} WHERE owner_id=? AND project_id=? AND ${table === 'holder_index_runs' ? 'id' : 'run_id'}=? AND ${guard}`,
      )
      .bind(owner, project, id, owner, project, revision),
  );
  const result = await db.batch(statements);
  if (!result[2].meta.changes)
    throw new HolderIndexConflict(
      'Saved run or project changed. Reload saved scans.',
    );
}
