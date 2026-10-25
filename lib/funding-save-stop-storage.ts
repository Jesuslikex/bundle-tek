import { fundingOwnerScope } from './funding-owner-scope';
import {
  fundingSaveStopId,
  fundingSaveStopRequestHash,
  readFundingSaveStopRequest,
  readFundingSaveStopReceipt,
  type FundingSaveStopRequest,
  type FundingSaveStopReceipt,
} from './funding-save-stop';

export class FundingSaveStopStorageError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}
function fail(message: string, status = 409): never {
  throw new FundingSaveStopStorageError(message, status);
}
function active(signal: AbortSignal) {
  if (signal.aborted)
    fail(
      'Stop waiting cancelled. Check the original draft-save stop before continuing.',
      499,
    );
}
function scope(owner: string) {
  if (typeof owner !== 'string' || owner.length < 1 || owner.length > 128)
    fail('Choose the original signed-in account.', 400);
}
type StopRow = {
  owner_id: string;
  stop_id: string;
  plan_id: string;
  expected_revision: number;
  action: string;
  document_hash: string;
  owner_scope: string;
  request_hash: string;
  request_json: string;
  outcome: string;
  before_revision: number | null;
  after_revision: number | null;
  created_at: string;
};
const columns =
  'owner_id,stop_id,plan_id,expected_revision,action,document_hash,owner_scope,request_hash,request_json,outcome,before_revision,after_revision,created_at';
async function receipt(
  owner: string,
  row: StopRow,
): Promise<FundingSaveStopReceipt> {
  const request = readFundingSaveStopRequest(JSON.parse(row.request_json));
  const reminder = request.reminder;
  if (
    row.owner_id !== owner ||
    row.owner_scope !== fundingOwnerScope(owner) ||
    row.stop_id !== request.stopId ||
    row.plan_id !== reminder.id ||
    row.expected_revision !== reminder.expectedRevision ||
    row.action !== reminder.action ||
    row.document_hash !== reminder.documentHash ||
    row.owner_scope !== reminder.ownerScope ||
    row.request_json !== JSON.stringify(request)
  )
    throw Error('Invalid retained stop.');
  return readFundingSaveStopReceipt(
    {
      format: 'funding-save-stop-receipt-v1',
      stopId: row.stop_id,
      requestHash: row.request_hash,
      reminder,
      outcome: row.outcome,
      beforeRevision: row.before_revision,
      afterRevision: row.after_revision,
      createdAt: row.created_at,
      transfersCancelled: false,
      signingAuthorized: false,
    },
    request,
  );
}
function unavailable(error: unknown, signal: AbortSignal): never {
  active(signal);
  if (error instanceof FundingSaveStopStorageError) throw error;
  fail(
    'Draft-save stop storage is unavailable. Keep the original recovery details and check the same stop ID.',
    503,
  );
}
export async function readFundingSaveStop(
  db: D1Database,
  owner: string,
  stopId: string,
  signal: AbortSignal,
): Promise<FundingSaveStopReceipt | null> {
  active(signal);
  scope(owner);
  try {
    fundingSaveStopId(stopId);
  } catch {
    fail('Choose a valid original draft-save stop ID.', 400);
  }
  try {
    const row = await db
      .prepare(
        `SELECT ${columns} FROM funding_save_stops WHERE owner_id=? AND stop_id=?`,
      )
      .bind(owner, stopId)
      .first<StopRow>();
    active(signal);
    const result = row ? await receipt(owner, row) : null;
    active(signal);
    return result;
  } catch (error) {
    return unavailable(error, signal);
  }
}
export type FundingSaveStopRecovery = {
  plan: {
    id: string;
    document: string;
    revision: number;
    archived: number;
    updatedAt: string;
  } | null;
  stop: FundingSaveStopReceipt | null;
};
/** One SQL snapshot prevents a stop bump being mistaken for a no-op original save. */
export async function readFundingSaveStopRecovery(
  db: D1Database,
  owner: string,
  planId: string,
  expectedRevision: number | null,
  signal: AbortSignal,
): Promise<FundingSaveStopRecovery> {
  active(signal);
  scope(owner);
  try {
    fundingSaveStopId(planId);
  } catch {
    fail('Choose a valid original funding draft.', 400);
  }
  if (
    expectedRevision !== null &&
    (!Number.isSafeInteger(expectedRevision) ||
      Object.is(expectedRevision, -0) ||
      expectedRevision < 0 ||
      expectedRevision > 1_000_000_000)
  )
    fail('Choose a valid original revision.', 400);
  try {
    const row = await db
      .prepare(`SELECT ${columns
        .split(',')
        .map((name) => `s.${name}`)
        .join(',')},
      p.id AS current_id,p.document AS current_document,p.revision AS current_revision,
      p.archived AS current_archived,p.updated_at AS current_updated_at
      FROM (SELECT 1) AS singleton
      LEFT JOIN funding_plans p ON p.owner_id=? AND p.id=?
      LEFT JOIN funding_save_stops s ON s.owner_id=? AND s.plan_id=? AND (? IS NULL OR s.expected_revision=?)
      ORDER BY s.expected_revision DESC LIMIT 1`)
      .bind(owner, planId, owner, planId, expectedRevision, expectedRevision)
      .first<
        StopRow & {
          current_id: string | null;
          current_document: string;
          current_revision: number;
          current_archived: number;
          current_updated_at: string;
        }
      >();
    active(signal);
    if (!row) throw Error('Missing singleton.');
    const stop = row.stop_id === null ? null : await receipt(owner, row);
    const plan =
      row.current_id === null
        ? null
        : {
            id: row.current_id,
            document: row.current_document,
            revision: row.current_revision,
            archived: row.current_archived,
            updatedAt: row.current_updated_at,
          };
    active(signal);
    return { plan, stop };
  } catch (error) {
    return unavailable(error, signal);
  }
}
export async function readFundingSaveStopForRevision(
  db: D1Database,
  owner: string,
  planId: string,
  expectedRevision: number,
  signal: AbortSignal,
) {
  return (
    await readFundingSaveStopRecovery(
      db,
      owner,
      planId,
      expectedRevision,
      signal,
    )
  ).stop;
}
export async function hasFundingSaveStop(
  db: D1Database,
  owner: string,
  planId: string,
  signal: AbortSignal,
) {
  return (
    (await readFundingSaveStopRecovery(db, owner, planId, null, signal))
      .stop !== null
  );
}
export async function retainFundingSaveStop(
  db: D1Database,
  owner: string,
  input: unknown,
  signal: AbortSignal,
): Promise<FundingSaveStopReceipt> {
  active(signal);
  scope(owner);
  let request: FundingSaveStopRequest;
  try {
    request = readFundingSaveStopRequest(input);
  } catch {
    fail('Review and approve the exact original draft-save stop.', 400);
  }
  if (request.reminder.ownerScope !== fundingOwnerScope(owner))
    fail('The original funding account changed.', 403);
  const requestHash = await fundingSaveStopRequestHash(request);
  active(signal);
  const replay = await readFundingSaveStop(db, owner, request.stopId, signal);
  if (replay) {
    if (replay.requestHash !== requestHash)
      fail('This stop ID belongs to a different original request.');
    return replay;
  }
  try {
    const r = request.reminder;
    await db
      .prepare(`WITH input(owner_id,stop_id,plan_id,expected_revision,action,document_hash,owner_scope,request_hash,request_json)
      AS (VALUES(?,?,?,?,?,?,?,?,?))
      INSERT INTO funding_save_stops(owner_id,stop_id,plan_id,expected_revision,action,document_hash,owner_scope,
        request_hash,request_json,outcome,before_revision,after_revision,source_document,source_archived,created_at)
      SELECT i.owner_id,i.stop_id,i.plan_id,i.expected_revision,i.action,i.document_hash,i.owner_scope,i.request_hash,i.request_json,
        CASE WHEN p.id IS NULL THEN 'creation_fenced' WHEN p.revision=i.expected_revision THEN 'revision_advanced' ELSE 'already_advanced' END,
        p.revision,CASE WHEN p.id IS NULL THEN NULL WHEN p.revision=i.expected_revision THEN p.revision+1 ELSE p.revision END,
        p.document,p.archived,strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM input i LEFT JOIN funding_plans p ON p.owner_id=i.owner_id AND p.id=i.plan_id
      WHERE (p.id IS NULL AND i.expected_revision=0 AND i.action='save')
         OR (p.id IS NOT NULL AND typeof(p.revision)='integer' AND p.revision BETWEEN 1 AND 1000000001
           AND p.archived IN (0,1) AND typeof(p.document)='text' AND p.revision>=i.expected_revision
           AND (p.revision>i.expected_revision OR p.revision<1000000001))`)
      .bind(
        owner,
        request.stopId,
        r.id,
        r.expectedRevision,
        r.action,
        r.documentHash,
        r.ownerScope,
        requestHash,
        JSON.stringify(request),
      )
      .run();
    active(signal);
    const saved = await readFundingSaveStop(db, owner, request.stopId, signal);
    if (!saved || saved.requestHash !== requestHash)
      fail(
        'The original draft revision cannot be stopped. Inspect its saved state.',
      );
    return saved;
  } catch (error) {
    active(signal);
    // A concurrent identical writer may have won before our immutable insert.
    const saved = await readFundingSaveStop(db, owner, request.stopId, signal);
    if (saved?.requestHash === requestHash) return saved;
    if (saved) fail('This stop ID belongs to a different original request.');
    if (error instanceof FundingSaveStopStorageError) throw error;
    const target = await readFundingSaveStopForRevision(
      db,
      owner,
      request.reminder.id,
      request.reminder.expectedRevision,
      signal,
    );
    if (target)
      fail(
        'This original revision already has a different stop ID. Recover that original stop.',
      );
    if (String(error).includes('Funding stop capacity reached'))
      fail(
        'Draft-save stop history is full. Keep the original save held and inspect its saved state.',
        409,
      );
    return unavailable(error, signal);
  }
}
