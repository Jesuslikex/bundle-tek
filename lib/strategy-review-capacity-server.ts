import { UUID } from './wallet-operation';
import {
  readStrategyDraft,
  StrategyDraftError,
} from './strategy-session-drafts';
import {
  applyReviewCapacity,
  capacityDate,
  capacityDigest,
  emptyReviewCapacity,
  reviewCapacityTotals,
  strategyReviewCandidate,
  type ReviewCapacity,
  type ReviewCapacityEvent,
} from './strategy-review-capacity';

type Row = {
  draft_id: string;
  owner_id: string;
  project_id: string;
  plan_sha256: string;
  revision: number;
  document: string;
  sha256: string;
  created_at: string;
  updated_at: string;
};
function refused(message: string, status = 409): never {
  throw new StrategyDraftError(message, status);
}
async function scope(
  db: D1Database,
  owner: string,
  projectId: string,
  draftId: string,
) {
  const draft = await readStrategyDraft(db, owner, projectId, draftId),
    planSha256 = await capacityDigest(draft.plan);
  const row = await db
    .prepare(
      'SELECT * FROM strategy_review_capacity WHERE owner_id=? AND project_id=? AND draft_id=?',
    )
    .bind(owner, projectId, draftId)
    .first<Row>();
  let state = emptyReviewCapacity();
  if (row) {
    state = JSON.parse(row.document) as ReviewCapacity;
    if (
      row.plan_sha256 !== planSha256 ||
      row.sha256 !== (await capacityDigest(state)) ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      row.revision !==
        state.holds.length +
          state.holds.filter((h) => h.state === 'released').length ||
      !capacityDate(row.created_at) ||
      !capacityDate(row.updated_at) ||
      row.updated_at < row.created_at
    )
      throw Error('Stored review capacity differs.');
  }
  const summary = reviewCapacityTotals(draft.plan, state);
  return { draft, planSha256, row, state, summary };
}
function result(s: Awaited<ReturnType<typeof scope>>) {
  return {
    draftId: s.draft.id,
    projectId: s.draft.plan.input.projectId,
    planSha256: s.planSha256,
    revision: s.row?.revision ?? 0,
    state: s.state,
    summary: s.summary,
    planningOnly: true as const,
    fundingAllowed: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
export async function readStrategyReviewCapacity(
  db: D1Database,
  owner: string,
  projectId: string,
  draftId: string,
) {
  return result(await scope(db, owner, projectId, draftId));
}
/** Fresh public ownership/revision context for a read-only candidate check. */
export async function currentStrategyReviewContext(
  db: D1Database,
  owner: string,
  projectId: string,
  draftId: string,
  revision: number,
  holdId: string,
) {
  if (!Number.isSafeInteger(revision) || revision < 1 || !UUID.test(holdId))
    refused('Reload review slots before checking this candidate.', 400);
  const current = await scope(db, owner, projectId, draftId);
  const hold = current.state.holds.find(
    (h) => h.id === holdId && h.state === 'held',
  );
  if (current.draft.archived || current.row?.revision !== revision || !hold)
    refused('The draft or review slot changed. Reload review slots.');
  const p = await db
    .prepare(
      "SELECT revision,archived,document,strftime('%Y-%m-%dT%H:%M:%fZ','now') AS database_at FROM imported_token_projects WHERE owner_id=? AND id=?",
    )
    .bind(owner, projectId)
    .first<{
      revision: number;
      archived: number;
      document: string;
      database_at: string;
    }>();
  const token = p
    ? (JSON.parse(p.document) as { token: Record<string, unknown> }).token
    : null;
  if (
    !p ||
    p.archived ||
    p.revision !== current.draft.plan.input.projectRevision ||
    !token ||
    (['chain', 'address', 'decimals', 'symbol'] as const).some(
      (k) => token[k] !== current.draft.plan.token[k],
    )
  )
    refused('Project changed. Open the draft and save reviewed current terms.');
  if (!capacityDate(p.database_at))
    throw Error('Database clock is unavailable.');
  const addresses = JSON.stringify([
    ...new Set(current.draft.plan.input.strategies.map((s) => s.wallet)),
  ]);
  const roster = await db
    .prepare(
      "SELECT address,revision FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND archived=0 AND address IN (SELECT value FROM json_each(?)) LIMIT 17",
    )
    .bind(owner, addresses)
    .all<{ address: string; revision: number }>();
  if (
    current.draft.plan.input.strategies.some(
      (s) =>
        roster.results.filter((w) => w.address === s.wallet).length !== 1 ||
        roster.results.find((w) => w.address === s.wallet)?.revision !==
          s.walletRevision,
    )
  )
    refused(
      'A strategy wallet changed. Open the draft and review current wallets.',
    );
  const fingerprint = await capacityDigest({
    draftRevision: current.draft.revision,
    plan: current.planSha256,
    capacity: current.row.sha256,
    project: p!.document,
  });
  return {
    draft: current.draft,
    capacity: result(current),
    hold: hold!,
    fingerprint,
    databaseAt: p.database_at,
    tokenProgram: token.tokenProgram,
  };
}
/** Claims input capacity for an unsigned review only. No executor or financial reservation consumes this ledger. */
export async function changeStrategyReviewCapacity(
  db: D1Database,
  owner: string,
  projectId: string,
  draftId: string,
  revision: number,
  event: ReviewCapacityEvent,
) {
  if (!Number.isSafeInteger(revision) || revision < 0 || !UUID.test(event?.id))
    refused('Reload the review capacity before continuing.', 400);
  const current = await scope(db, owner, projectId, draftId),
    now = new Date().toISOString();
  let next: ReviewCapacity;
  try {
    next = applyReviewCapacity(current.draft.plan, current.state, event, now);
  } catch (e) {
    return refused(
      e instanceof Error ? e.message : 'Review capacity unavailable.',
    );
  }
  if (JSON.stringify(next) === JSON.stringify(current.state))
    return result(current);
  if (revision !== (current.row?.revision ?? 0))
    refused('Review capacity changed in another tab. Reload before retrying.');
  const document = JSON.stringify(next),
    sha256 = await capacityDigest(next);
  const base = [document, sha256, now];
  let guard = '',
    args: unknown[] = [];
  if (event.kind === 'hold') {
    if (current.draft.archived)
      refused(
        'Archived drafts cannot claim new review capacity. Release remains available.',
      );
    const p = await db
      .prepare(
        'SELECT revision,archived,document FROM imported_token_projects WHERE owner_id=? AND id=?',
      )
      .bind(owner, projectId)
      .first<{ revision: number; archived: number; document: string }>();
    const token = p
      ? (
          JSON.parse(p.document) as {
            token: {
              chain: string;
              address: string;
              decimals: number;
              symbol: string;
            };
          }
        ).token
      : null;
    if (
      !p ||
      p.archived ||
      p.revision !== current.draft.plan.input.projectRevision ||
      !token ||
      ['chain', 'address', 'decimals', 'symbol'].some(
        (key) =>
          token[key as keyof typeof token] !==
          current.draft.plan.token[
            key as keyof typeof current.draft.plan.token
          ],
      )
    )
      refused(
        'Project changed. Open the draft and save reviewed current terms.',
      );
    const candidate = strategyReviewCandidate(
      current.draft.plan,
      event.strategyId,
      event.candidate,
    );
    const roster = JSON.stringify(
      current.draft.plan.input.strategies.map((row) => ({
        address: row.wallet,
        revision: row.walletRevision,
      })),
    );
    guard =
      " AND EXISTS(SELECT 1 FROM strategy_session_drafts WHERE owner_id=? AND project_id=? AND id=? AND revision=? AND archived=0 AND sha256=?) AND EXISTS(SELECT 1 FROM imported_token_projects WHERE owner_id=? AND id=? AND revision=? AND archived=0 AND document=?) AND NOT EXISTS(SELECT 1 FROM json_each(?) j WHERE NOT EXISTS(SELECT 1 FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND archived=0 AND address=json_extract(j.value,'$.address') AND revision=json_extract(j.value,'$.revision'))) AND (? IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ','now')<?)";
    args = [
      owner,
      projectId,
      draftId,
      current.draft.revision,
      current.planSha256,
      owner,
      projectId,
      p!.revision,
      p!.document,
      roster,
      owner,
      candidate.endsAt,
      candidate.endsAt,
    ];
  }
  if (current.row) {
    await db
      .prepare(
        `UPDATE strategy_review_capacity SET document=?,sha256=?,updated_at=?,revision=revision+1 WHERE owner_id=? AND project_id=? AND draft_id=? AND revision=? AND sha256=?${guard}`,
      )
      .bind(
        ...base,
        owner,
        projectId,
        draftId,
        revision,
        current.row.sha256,
        ...args,
      )
      .run();
  } else {
    if (event.kind !== 'hold') refused('Review slot unavailable.', 404);
    await db
      .prepare(
        `INSERT OR IGNORE INTO strategy_review_capacity(draft_id,owner_id,project_id,plan_sha256,revision,document,sha256,created_at,updated_at) SELECT ?,?,?,?,1,?,?,?,? WHERE 1=1${guard}`,
      )
      .bind(
        draftId,
        owner,
        projectId,
        current.planSha256,
        document,
        sha256,
        now,
        now,
        ...args,
      )
      .run();
  }
  const saved = await scope(db, owner, projectId, draftId);
  if (
    saved.row?.revision !== revision + 1 ||
    JSON.stringify(saved.state) !== document
  )
    refused(
      'Review capacity or wallet/project context changed. Reload before retrying the same request.',
    );
  return result(saved);
}
