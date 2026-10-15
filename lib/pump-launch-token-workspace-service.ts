import { readPumpLaunchGroupReview } from './pump-launch-group-review-service';
import { readOwnedPumpGroupBroadcast } from './pump-group-broadcast-service';
import { parsePumpGroupView } from './pump-launch-group-client';
import { canonicalPumpHolderJson } from './pump-holder-review';
import { PumpPreflightError } from './owned-pump-preflight';
import {
  importedTokenDocument,
  type ImportedTokenProject,
} from './imported-token-project';
import { inspectToken, type ImportedToken } from './token-import';
import type { TokenSource } from './token-source';
import { PUMP_TOKEN_2022 } from './pump-launch-config';
import {
  parsePumpLaunchTokenWorkspace,
  pumpLaunchWorkspaceReady,
  type PumpLaunchTokenWorkspace,
} from './pump-launch-token-workspace';

type Row = {
  id: string;
  revision: number;
  archived: number;
  document: string;
  updatedAt: string;
};
type Proof = { review: string; signed: string; receipt: string; state: string };
export type PumpWorkspaceInspector = (
  source: TokenSource,
  signal: AbortSignal,
) => Promise<ImportedToken>;
const fail = (message: string, status = 409): never => {
  throw new PumpPreflightError(message, status);
};
const inspect: PumpWorkspaceInspector = (source, signal) =>
  inspectToken(source, (url, options) =>
    fetch(url, {
      ...options,
      signal: AbortSignal.any([
        signal,
        ...(options?.signal ? [options.signal] : []),
      ]),
    }),
  );
/** Creates/reuses a private token workspace, never a trade, restoration, signature or reservation transition. */
export async function openOwnedPumpTokenWorkspace(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
  inspector: PumpWorkspaceInspector = inspect,
): Promise<PumpLaunchTokenWorkspace> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(40000)]);
  deadline.throwIfAborted();
  const saved = await readPumpLaunchGroupReview(db, owner, id);
  const group = await parsePumpGroupView(
    saved,
    saved.review.projectId,
    deadline,
  );
  if (!pumpLaunchWorkspaceReady(group))
    return fail(
      'Recover a successful finalized complete broadcast before opening its token workspace.',
    );
  const broadcast = await readOwnedPumpGroupBroadcast(db, owner, id);
  if (
    !broadcast?.reservationsReleased ||
    broadcast.recovery?.state !== 'finalized' ||
    broadcast.recovery.tip.succeeded !== true ||
    broadcast.recovery.tip.slot === null
  )
    return fail(
      'The complete launch and tip need their exact saved finalized recovery before opening a workspace.',
    );
  const slot = Number(broadcast.recovery.tip.slot);
  if (!Number.isSafeInteger(slot) || slot <= 0)
    return fail('Saved launch finality scope differs.');
  const proof = () =>
    db
      .prepare(
        "SELECT r.review,r.signed,r.receipt,r.state FROM pump_launch_reviews r JOIN pump_group_broadcast_closures c ON c.owner_id=r.owner_id AND c.review_id=r.id AND c.receipt=r.receipt AND c.state='finalized' WHERE r.owner_id=? AND r.id=? AND r.state='finalized'",
      )
      .bind(owner, id)
      .first<Proof>();
  const before = await proof();
  if (
    !before ||
    canonicalPumpHolderJson(JSON.parse(before.review)) !==
      canonicalPumpHolderJson(group.review) ||
    canonicalPumpHolderJson(JSON.parse(before.signed)) !==
      canonicalPumpHolderJson(group.signedEvidence) ||
    canonicalPumpHolderJson(JSON.parse(before.receipt)) !==
      canonicalPumpHolderJson(group.receipt)
  )
    return fail('Finalized launch closure proof differs.');
  const unchanged = async () => {
    deadline.throwIfAborted();
    if (
      canonicalPumpHolderJson(await proof()) !== canonicalPumpHolderJson(before)
    )
      return fail(
        'Finalized launch changed. Reload before opening its token workspace.',
      );
    deadline.throwIfAborted();
  };
  const mint = group.review.input.create.mint;
  const read = () =>
    db
      .prepare(
        "SELECT id,revision,archived,document,updated_at AS updatedAt FROM imported_token_projects WHERE owner_id=? AND chain='Solana' AND address=?",
      )
      .bind(owner, mint)
      .first<Row>();
  const response = (row: Row, created: boolean) => {
    const project: ImportedTokenProject = {
      id: row.id,
      revision: row.revision,
      archived: !!row.archived,
      updatedAt: row.updatedAt,
      document: JSON.parse(row.document),
    };
    return parsePumpLaunchTokenWorkspace(
      {
        format: 'pump-launch-token-workspace-v1',
        reviewId: id,
        contextSha256: group.review.contextSha256,
        signedGroupSha256: group.signedEvidence!.signedGroupSha256,
        mint,
        project,
        created,
        signingAllowed: false,
        executionAllowed: false,
        reservationsChanged: false,
      },
      group,
    );
  };
  const existing = await read();
  if (existing) {
    await unchanged();
    return response(existing, false);
  }
  const observation = await new Promise<ImportedToken>((resolve, reject) => {
    const abort = () =>
      reject(
        new PumpPreflightError(
          'Token identity read timed out or was cancelled. Retry the same launch to recover its workspace.',
          408,
        ),
      );
    deadline.addEventListener('abort', abort, { once: true });
    if (deadline.aborted) {
      abort();
      deadline.removeEventListener('abort', abort);
      return;
    }
    Promise.resolve()
      .then(() => {
        deadline.throwIfAborted();
        return inspector({ chain: 'Solana', address: mint }, deadline);
      })
      .then(resolve, reject)
      .finally(() => deadline.removeEventListener('abort', abort));
  });
  if (
    observation.contextSlot === undefined ||
    !Number.isSafeInteger(observation.contextSlot) ||
    observation.contextSlot < slot ||
    observation.tokenProgram !== PUMP_TOKEN_2022 ||
    observation.decimals !== 6
  )
    return fail(
      'Token identity has not caught up with the finalized launch. Retry this same group later.',
    );
  const document = importedTokenDocument(
    { chain: 'Solana', address: mint },
    observation,
  );
  await unchanged();
  const projectId = crypto.randomUUID(),
    mutation = crypto.randomUUID(),
    now = new Date().toISOString();
  // The client contract must accept the complete document before it is durable.
  response(
    {
      id: projectId,
      revision: 1,
      archived: 0,
      document: JSON.stringify(document),
      updatedAt: now,
    },
    true,
  );
  // The source is bound again at the actual insert, not just before the RPC.
  const results = await db.batch([
    db
      .prepare(
        "INSERT INTO imported_token_projects(owner_id,id,chain,address,document,mutation_id,updated_at) SELECT ?,?,'Solana',?,?,?,? WHERE (SELECT COUNT(*) FROM imported_token_projects WHERE owner_id=?)<100 AND EXISTS(SELECT 1 FROM pump_launch_reviews r JOIN pump_group_broadcast_closures c ON c.owner_id=r.owner_id AND c.review_id=r.id AND c.receipt=r.receipt AND c.state='finalized' WHERE r.owner_id=? AND r.id=? AND r.state='finalized' AND r.review=? AND r.signed=? AND r.receipt=?) ON CONFLICT DO NOTHING",
      )
      .bind(
        owner,
        projectId,
        mint,
        JSON.stringify(document),
        mutation,
        now,
        owner,
        owner,
        id,
        before.review,
        before.signed,
        before.receipt,
      ),
    db
      .prepare(
        "INSERT INTO imported_token_project_events(id,owner_id,project_id,type,revision,document,created_at) SELECT ?,owner_id,id,'project.import',revision,document,? FROM imported_token_projects WHERE owner_id=? AND id=? AND mutation_id=?",
      )
      .bind(crypto.randomUUID(), now, owner, projectId, mutation),
  ]);
  deadline.throwIfAborted();
  await unchanged();
  const row = await read();
  if (!row)
    return fail(
      'Workspace creation did not complete, the 100-project limit was reached, or the saved launch changed. Reload before retrying.',
    );
  return response(row, !!results[0].meta.changes);
}
