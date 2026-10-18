import {
  planStrategySession,
  requireStrategySessionPlan,
  type StrategySessionInput,
  type StrategySessionPlan,
  type StrategyContext,
} from './strategy-session-plan';
import { UUID } from './wallet-operation';
export type SavedStrategyDraft = {
  id: string;
  revision: number;
  archived: boolean;
  createdAt: string;
  plan: StrategySessionPlan;
};
type Row = {
  id: string;
  project_revision: number;
  revision: number;
  archived: number;
  created_at: string;
  document: string;
  sha256: string;
};
export class StrategyDraftError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
function refused(message: string, status = 400): never {
  throw new StrategyDraftError(message, status);
}
const digest = async (value: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    ),
  ]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
const columns =
  'id,project_revision,revision,archived,created_at,document,sha256';
const scope = (owner: string, projectId: string) => {
  if (!owner || owner.length > 128 || !UUID.test(projectId))
    refused('Choose an owned project.');
};
async function decode(row: Row): Promise<SavedStrategyDraft> {
  const plan = requireStrategySessionPlan(JSON.parse(row.document));
  if (
    !UUID.test(row.id) ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    ![0, 1].includes(row.archived) ||
    row.project_revision !== plan.input.projectRevision ||
    new Date(row.created_at).toISOString() !== row.created_at ||
    (await digest(row.document)) !== row.sha256
  )
    throw new Error('Stored strategy draft differs.');
  return {
    id: row.id,
    revision: row.revision,
    archived: row.archived === 1,
    createdAt: row.created_at,
    plan,
  };
}
async function project(db: D1Database, owner: string, projectId: string) {
  const p = await db
    .prepare(
      'SELECT revision,archived,document FROM imported_token_projects WHERE owner_id=? AND id=?',
    )
    .bind(owner, projectId)
    .first<{ revision: number; archived: number; document: string }>();
  if (!p) refused('Project unavailable.', 404);
  return p;
}
export async function listStrategyDrafts(
  db: D1Database,
  owner: string,
  projectId: string,
  archived = false,
  before?: string,
) {
  scope(owner, projectId);
  await project(db, owner, projectId);
  let cursor: Row | null = null;
  if (before) {
    if (!UUID.test(before)) refused('Invalid draft page.');
    cursor = await db
      .prepare(
        `SELECT ${columns} FROM strategy_session_drafts WHERE owner_id=? AND project_id=? AND id=?`,
      )
      .bind(owner, projectId, before)
      .first<Row>();
    if (!cursor) refused('Draft page unavailable.', 404);
  }
  const rows = await db
    .prepare(
      `SELECT ${columns} FROM strategy_session_drafts WHERE owner_id=? AND project_id=? AND archived=?${cursor ? ' AND (created_at<? OR (created_at=? AND id<?))' : ''} ORDER BY created_at DESC,id DESC LIMIT 21`,
    )
    .bind(
      owner,
      projectId,
      Number(archived),
      ...(cursor ? [cursor.created_at, cursor.created_at, cursor.id] : []),
    )
    .all<Row>();
  const drafts = await Promise.all(rows.results.slice(0, 20).map(decode));
  if (drafts.some((d) => d.plan.input.projectId !== projectId))
    throw new Error('Draft project differs.');
  return {
    projectId,
    archived,
    drafts,
    next: rows.results.length > 20 ? drafts.at(-1)!.id : null,
    planningOnly: true,
    executionAllowed: false,
  };
}
/** Owned immutable terms for review-only consumers; never execution authority. */
export async function readStrategyDraft(
  db: D1Database,
  owner: string,
  projectId: string,
  id: string,
) {
  scope(owner, projectId);
  if (!UUID.test(id)) refused('Choose a saved strategy draft.');
  await project(db, owner, projectId);
  const row = await db
    .prepare(
      `SELECT ${columns} FROM strategy_session_drafts WHERE owner_id=? AND project_id=? AND id=?`,
    )
    .bind(owner, projectId, id)
    .first<Row>();
  if (!row) refused('Strategy draft unavailable.', 404);
  return decode(row);
}
export async function saveStrategyDraft(
  db: D1Database,
  owner: string,
  id: string,
  input: StrategySessionInput,
) {
  scope(owner, input?.projectId);
  if (!UUID.test(id)) refused('Choose a draft ID.');
  const existing = await db
    .prepare(
      `SELECT ${columns} FROM strategy_session_drafts WHERE owner_id=? AND project_id=? AND id=?`,
    )
    .bind(owner, input.projectId, id)
    .first<Row>();
  if (existing) {
    const saved = await decode(existing);
    // Retries never turn the old document into a new session or a fresh start.
    if (JSON.stringify(saved.plan.input) !== JSON.stringify(input))
      refused(
        'This draft ID already has different terms. Save a new draft.',
        409,
      );
    return saved;
  }
  const p = await project(db, owner, input.projectId);
  if (p.archived)
    refused('Archived projects can view drafts but cannot save new ones.', 409);
  const token = (JSON.parse(p.document) as { token: StrategyContext['token'] })
    .token;
  const wallets = await db
    .prepare(
      "SELECT chain,address,revision,archived FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND archived=0",
    )
    .bind(owner)
    .all<{
      chain: string;
      address: string;
      revision: number;
      archived: number;
    }>();
  let plan: StrategySessionPlan;
  try {
    plan = planStrategySession(input, {
      projectId: input.projectId,
      projectRevision: p.revision,
      token,
      wallets: wallets.results.map((w) => ({
        ...w,
        chain: 'Solana' as const,
        archived: w.archived === 1,
      })),
    });
  } catch (e) {
    return refused(e instanceof Error ? e.message : 'Review the draft.');
  }
  // Only canonical terms are accepted, making request identity stable on retry.
  if (JSON.stringify(plan.input) !== JSON.stringify(input))
    refused('Review normalized draft terms before saving.');
  const document = JSON.stringify(plan),
    sha256 = await digest(document),
    createdAt = new Date().toISOString();
  const roster = JSON.stringify(
    plan.input.strategies.map((s) => ({
      address: s.wallet,
      revision: s.walletRevision,
    })),
  );
  await db
    .prepare(
      "INSERT OR IGNORE INTO strategy_session_drafts(id,owner_id,project_id,project_revision,revision,archived,document,sha256,created_at) SELECT ?,?,?,?,1,0,?,?,? WHERE EXISTS(SELECT 1 FROM imported_token_projects WHERE owner_id=? AND id=? AND revision=? AND archived=0 AND document=?) AND NOT EXISTS(SELECT 1 FROM json_each(?) j WHERE NOT EXISTS(SELECT 1 FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND archived=0 AND address=json_extract(j.value,'$.address') AND revision=json_extract(j.value,'$.revision'))) AND (SELECT count(*) FROM strategy_session_drafts WHERE owner_id=? AND project_id=? AND archived=0)<100 AND (SELECT count(*) FROM strategy_session_drafts WHERE owner_id=? AND project_id=?)<1000",
    )
    .bind(
      id,
      owner,
      input.projectId,
      p.revision,
      document,
      sha256,
      createdAt,
      owner,
      input.projectId,
      p.revision,
      p.document,
      roster,
      owner,
      owner,
      input.projectId,
      owner,
      input.projectId,
    )
    .run();
  const row = await db
    .prepare(
      `SELECT ${columns} FROM strategy_session_drafts WHERE owner_id=? AND project_id=? AND id=?`,
    )
    .bind(owner, input.projectId, id)
    .first<Row>();
  if (!row)
    refused(
      'Project or wallets changed, or draft storage is full. Reload drafts before retrying the same save.',
      409,
    );
  const saved = await decode(row);
  if (JSON.stringify(saved.plan) !== document)
    refused('This draft ID already has different terms.', 409);
  return saved;
}
export async function archiveStrategyDraft(
  db: D1Database,
  owner: string,
  projectId: string,
  id: string,
  revision: number,
  archived: boolean,
) {
  scope(owner, projectId);
  if (
    !UUID.test(id) ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    typeof archived !== 'boolean'
  )
    refused('Choose a current draft.');
  await project(db, owner, projectId);
  await db
    .prepare(
      'UPDATE strategy_session_drafts SET archived=?,revision=revision+1 WHERE owner_id=? AND project_id=? AND id=? AND revision=? AND archived<>? AND (?=1 OR (SELECT count(*) FROM strategy_session_drafts WHERE owner_id=? AND project_id=? AND archived=0)<100)',
    )
    .bind(
      Number(archived),
      owner,
      projectId,
      id,
      revision,
      Number(archived),
      Number(archived),
      owner,
      projectId,
    )
    .run();
  const row = await db
    .prepare(
      `SELECT ${columns} FROM strategy_session_drafts WHERE owner_id=? AND project_id=? AND id=?`,
    )
    .bind(owner, projectId, id)
    .first<Row>();
  if (
    !row ||
    row.archived !== Number(archived) ||
    row.revision !== revision + 1
  )
    refused(
      'Draft changed or active storage is full. Reload before retrying.',
      409,
    );
  return decode(row);
}
