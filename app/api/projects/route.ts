import { validateHoldersQuoteAmount } from '@/lib/launch-buy';
import { validateSequencedSupply } from '@/lib/launch-supply';
import { validateQuoteSelection } from '@/lib/quote-catalog';
import { validateLaunchMethod } from '@/lib/launch-methods';
import { validateLaunchTiming } from '@/lib/launch-timing';
import {
  assignmentEntries,
  validateLaunchWalletSelection,
} from '@/lib/launch-wallets';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { validateVenuePlan } from '@/lib/venue-limits';
import {
  projectIdValid,
  validateProjectDocument,
  projectChanges,
} from '@/lib/workspace-project';

export const dynamic = 'force-dynamic';
type Row = {
  id: string;
  document: string;
  archived: number;
  updatedAt: string;
};
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const parse = (row: Row) => ({
  ...validateProjectDocument(JSON.parse(row.document)),
  id: row.id,
  archived: Boolean(row.archived),
  updatedAt: row.updatedAt,
});

export async function GET() {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to open your saved projects.' }, 401);
  try {
    const result = await getD1()
      .prepare(
        'SELECT id, document, archived, updated_at AS updatedAt FROM workspace_projects WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 100',
      )
      .bind(user.userId)
      .all<Row>();
    return json({ projects: result.results.map(parse) });
  } catch {
    return json({ error: 'Project library temporarily unavailable.' }, 503);
  }
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to save projects.' }, 401);
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  )
    return json({ error: 'JSON required.' }, 415);
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin)
    return json({ error: 'Cross-origin save rejected.' }, 403);
  let storageStarted = false;
  try {
    const text = await request.text();
    if (text.length > 24_000)
      return json({ error: 'Project is too large.' }, 413);
    const body = JSON.parse(text);
    if (!projectIdValid(body.id) || typeof body.archived !== 'boolean')
      return json({ error: 'Invalid project.' }, 400);
    const document = validateProjectDocument(body);
    if (
      body.expectedUpdatedAt !== null &&
      (typeof body.expectedUpdatedAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
          body.expectedUpdatedAt,
        ) ||
        !Number.isFinite(Date.parse(body.expectedUpdatedAt)))
    )
      return json({ error: 'Missing or invalid project revision.' }, 400);
    // Strictly advance the revision even when two edits occur in the same millisecond.
    const updatedAt = new Date(
      Math.max(
        Date.now(),
        body.expectedUpdatedAt ? Date.parse(body.expectedUpdatedAt) + 1 : 0,
      ),
    ).toISOString();
    storageStarted = true;
    const db = getD1();
    const previous =
      body.expectedUpdatedAt === null
        ? null
        : await db
            .prepare(
              'SELECT document,archived FROM workspace_projects WHERE owner_id=? AND id=?',
            )
            .bind(user.userId, body.id)
            .first<{ document: string; archived: number }>();
    const previousDocument = previous
      ? validateProjectDocument(JSON.parse(previous.document))
      : null;
    storageStarted = false;
    // Retain readable, archivable legacy drafts. Enforce captured limits when
    // creating a project or changing its plan; do not silently rewrite history.
    if (
      !previousDocument ||
      JSON.stringify(previousDocument.plan) !== JSON.stringify(document.plan)
    ) {
      validateVenuePlan(document.plan);
      validateSequencedSupply(document.plan);
      validateHoldersQuoteAmount(document.plan);
      validateQuoteSelection(document.plan);
      validateLaunchMethod(document.plan);
      validateLaunchTiming(document.plan);
    }
    storageStarted = true;
    const changeLabels = projectChanges(previousDocument, document);
    const validateWallets =
      !previousDocument ||
      JSON.stringify(previousDocument.plan) !== JSON.stringify(document.plan) ||
      JSON.stringify(previousDocument.options.wallets) !==
        JSON.stringify(document.options.wallets);
    storageStarted = false;
    if (validateWallets)
      validateLaunchWalletSelection(
        document.options.wallets,
        document.plan.chain,
        document.plan.holderCount,
      );
    const walletEntries = validateWallets
      ? assignmentEntries(document.options.wallets)
      : [];
    // Eligibility and both revisions are checked inside the project mutation,
    // preventing a folder/archive/move race between a read and this save.
    const walletGuard = walletEntries.length
      ? ` AND (SELECT COUNT(*) FROM json_each(?) wanted
      JOIN workspace_wallets w ON w.owner_id=? AND w.chain=? AND w.address=json_extract(wanted.value,'$.address')
      LEFT JOIN wallet_folders f ON f.owner_id=w.owner_id AND f.id=COALESCE(json_extract(wanted.value,'$.folderId'),w.folder_id) AND f.id IN(SELECT value FROM json_each(COALESCE(w.folder_ids,json_array(w.folder_id)))) AND f.chain=w.chain
      WHERE w.archived=0 AND w.role=json_extract(wanted.value,'$.role')
      AND w.revision=json_extract(wanted.value,'$.revision') AND ((json_extract(wanted.value,'$.root')=1 AND json_extract(wanted.value,'$.folderRevision')=0 AND json_extract(wanted.value,'$.folderId') IS NULL) OR (json_array_length(COALESCE(w.folder_ids,json_array(w.folder_id)))=0 AND json_extract(wanted.value,'$.folderRevision')=0 AND json_extract(wanted.value,'$.folderId') IS NULL) OR (f.archived=0 AND f.revision=json_extract(wanted.value,'$.folderRevision'))))=?`
      : '';
    const walletBindings = walletEntries.length
      ? [
          JSON.stringify(walletEntries),
          user.userId,
          document.plan.chain,
          walletEntries.length,
        ]
      : [];
    storageStarted = true;
    const type =
      body.expectedUpdatedAt === null
        ? 'project.created'
        : body.archived && !previous?.archived
          ? 'project.archived'
          : !body.archived && previous?.archived
            ? 'project.restored'
            : 'project.saved';
    const mutationId = crypto.randomUUID();
    const statement =
      body.expectedUpdatedAt === null
        ? db
            .prepare(`INSERT OR IGNORE INTO workspace_projects (id, owner_id, document, archived, updated_at, mutation_id)
          SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM workspace_projects WHERE owner_id = ?) < 100${walletGuard}`)
            .bind(
              body.id,
              user.userId,
              JSON.stringify(document),
              body.archived ? 1 : 0,
              updatedAt,
              mutationId,
              user.userId,
              ...walletBindings,
            )
        : db
            .prepare(
              `UPDATE workspace_projects SET document = ?, archived = ?, updated_at = ?, mutation_id = ? WHERE owner_id = ? AND id = ? AND updated_at = ?${walletGuard}`,
            )
            .bind(
              JSON.stringify(document),
              body.archived ? 1 : 0,
              updatedAt,
              mutationId,
              user.userId,
              body.id,
              body.expectedUpdatedAt,
              ...walletBindings,
            );
    const [result] = await db.batch([
      statement,
      db
        .prepare(`INSERT INTO project_events(owner_id,project_id,name,chain,launchpad,type,changes,revision,created_at)
      SELECT owner_id,id,?,?,?,?,?,?,? FROM workspace_projects WHERE owner_id=? AND id=? AND mutation_id=?`)
        .bind(
          document.plan.tokenName,
          document.plan.chain,
          document.plan.launchpad,
          type,
          JSON.stringify(changeLabels),
          updatedAt,
          new Date().toISOString(),
          user.userId,
          body.id,
          mutationId,
        ),
    ]);
    if (!result.meta.changes)
      return json(
        {
          error:
            'Project or selected wallets changed, or the 100-project limit was reached. Refresh the project and wallet lists before saving again.',
        },
        409,
      );
    return json({
      project: { ...document, id: body.id, archived: body.archived, updatedAt },
    });
  } catch (error) {
    return storageStarted
      ? json(
          {
            error:
              'Project storage temporarily unavailable. Your draft has not been discarded.',
          },
          503,
        )
      : json(
          {
            error: error instanceof Error ? error.message : 'Invalid project.',
          },
          400,
        );
  }
}
