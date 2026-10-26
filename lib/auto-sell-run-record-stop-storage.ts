import {
  readAutoSellRun,
  autoSellRunId,
  type AutoSellRun,
} from './auto-sell-run';
import {
  autoSellRunRecordStopAuthority,
  autoSellRunRecordStopRequestSha256,
  readAutoSellRunRecordStopRequest,
  readAutoSellRunRecordStop,
  type AutoSellRunRecordStop,
  type AutoSellRunRecordStopRequest,
} from './auto-sell-run-record-stop';

export class AutoSellRunRecordStopStorageError extends Error {
  constructor(
    message: string,
    public readonly status = 409,
  ) {
    super(message);
  }
}
function fail(message: string, status = 409): never {
  throw new AutoSellRunRecordStopStorageError(message, status);
}
function active(signal: AbortSignal) {
  if (signal.aborted)
    fail(
      'Waiting stopped. Retain the original record-request identity and inspect it again.',
      408,
    );
}
function ownerId(owner: string) {
  if (typeof owner !== 'string' || owner.length < 1 || owner.length > 128)
    fail('Choose the original signed-in account.', 400);
}
const fingerprints: Record<string, string> = {
  auto_sell_runs:
    '831da4230fd2243741bcfa8e0d965e76b147009e5312fb614678a213473c0819',
  auto_sell_runs_insert:
    'f2e538d8bec071864b6c1c61cac0d716dad1fc36cd1d8f65a7731a496bfd1068',
  auto_sell_runs_no_update:
    '726cd055ae3572aeb88effdd31d0aff2b8b3ab52108f6e15b36e39b475ba3c7b',
  auto_sell_runs_no_delete:
    '37b5e7f28cae59cf1eb054ef7d27604ad060f2c59cdfcae376b3a4d8ff6cb710',
  auto_sell_run_record_stops:
    '954412264a925054e4f1ad24455f636a1e1274003c03f25ea34936acd7e7de86',
  auto_sell_run_record_stops_insert:
    'bbb20b80899b067259c12dc597757d79d768771c8ace2477d64b890622be298f',
  auto_sell_run_record_stops_no_update:
    'd7629c5fbd09da82ff51c00e2e7e8c2543700294331ff601337cde24eb2d3dd9',
  auto_sell_run_record_stops_no_delete:
    '5c33e74f951f925a96457a3c4a01a4e3c047787aa130f10086b852cd9fba3427',
  auto_sell_runs_record_stop_fence:
    'f339b103161fa56a2e73410fcf717aface23c4f8d161f5c27da04e9d5ca80372',
};
export async function autoSellRunRecordStopReady(
  db: D1Database,
  signal: AbortSignal,
) {
  active(signal);
  try {
    const names = Object.keys(fingerprints);
    const rows = await db
      .prepare(
        `SELECT name,sql FROM sqlite_master WHERE name IN (${names.map(() => '?').join(',')})`,
      )
      .bind(...names)
      .all<{ name: string; sql: string }>();
    if (!rows.success || rows.results.length !== names.length)
      throw Error('Schema missing');
    for (const row of rows.results) {
      const canonical = row.sql.trim().replace(/;$/, '').replace(/\s+/g, ' ');
      const hash = Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(canonical),
          ),
        ),
        (b) => b.toString(16).padStart(2, '0'),
      ).join('');
      if (hash !== fingerprints[row.name]) throw Error('Schema differs');
    }
    active(signal);
  } catch (error) {
    active(signal);
    if (error instanceof AutoSellRunRecordStopStorageError) throw error;
    fail(
      'Original record-stop protection is unavailable. Keep the original request identity.',
      503,
    );
  }
}
type Row = {
  owner_id: string | null;
  run_id: string | null;
  project_id: string;
  profile_save_id: string;
  profile_sha256: string;
  request_sha256: string;
  status: string;
  run_sha256: string | null;
  created_at: string;
  run_document: string | null;
  original_sha256: string | null;
  original_project_id: string | null;
  original_profile_save_id: string | null;
  original_profile_sha256: string | null;
};
export type AutoSellRunRecordStopRecovery = {
  stop: AutoSellRunRecordStop | null;
  run: AutoSellRun | null;
};
export async function readOwnedAutoSellRunRecordStop(
  db: D1Database,
  owner: string,
  runId: string,
  signal: AbortSignal,
): Promise<AutoSellRunRecordStopRecovery> {
  active(signal);
  ownerId(owner);
  try {
    autoSellRunId(runId);
  } catch {
    fail('Choose the complete original run ID.', 400);
  }
  await autoSellRunRecordStopReady(db, signal);
  try {
    const row = await db
      .prepare(
        `SELECT s.*,r.document AS run_document,r.sha256 AS original_sha256,r.project_id AS original_project_id,r.profile_save_id AS original_profile_save_id,r.profile_sha256 AS original_profile_sha256 FROM (SELECT 1) singleton LEFT JOIN auto_sell_run_record_stops s ON s.owner_id=? AND s.run_id=? LEFT JOIN auto_sell_runs r ON r.owner_id=? AND r.id=?`,
      )
      .bind(owner, runId, owner, runId)
      .first<Row>();
    active(signal);
    if (!row) throw Error('Snapshot missing');
    const run =
      row.run_document === null
        ? null
        : await readAutoSellRun(JSON.parse(row.run_document));
    if (
      run &&
      (run.id !== runId ||
        run.sha256 !== row.original_sha256 ||
        run.profile.id !== row.original_profile_save_id ||
        run.profile.sha256 !== row.original_profile_sha256 ||
        run.profile.terms.projectId !== row.original_project_id ||
        JSON.stringify(run) !== row.run_document)
    )
      throw Error('Original run differs');
    const stop =
      row.run_id === null
        ? null
        : await readAutoSellRunRecordStop({
            format: 'auto-sell-run-record-stop-v1',
            projectId: row.project_id,
            runId: row.run_id,
            profileSaveId: row.profile_save_id,
            profileSha256: row.profile_sha256,
            requestSha256: row.request_sha256,
            status: row.status,
            runSha256: row.run_sha256,
            createdAt: row.created_at,
            ...autoSellRunRecordStopAuthority,
          });
    if (
      stop &&
      (row.owner_id !== owner ||
        stop.runId !== runId ||
        (stop.status === 'creation-fenced'
          ? run !== null
          : !run ||
            run.sha256 !== stop.runSha256 ||
            run.profile.id !== stop.profileSaveId ||
            run.profile.sha256 !== stop.profileSha256 ||
            run.profile.terms.projectId !== stop.projectId))
    )
      throw Error('Terminal receipt differs');
    active(signal);
    return { stop, run };
  } catch (error) {
    active(signal);
    if (error instanceof AutoSellRunRecordStopStorageError) throw error;
    return fail(
      'Original record-stop recovery is unavailable. Keep its identity and retry inspection.',
      503,
    );
  }
}
export async function stopOwnedAutoSellRunRecord(
  db: D1Database,
  owner: string,
  input: unknown,
  signal: AbortSignal,
): Promise<AutoSellRunRecordStopRecovery> {
  active(signal);
  ownerId(owner);
  let request: AutoSellRunRecordStopRequest;
  try {
    request = readAutoSellRunRecordStopRequest(input);
  } catch {
    fail('Separately approve the exact original record request.', 400);
  }
  const requestSha256 = await autoSellRunRecordStopRequestSha256(request);
  const match = (saved: AutoSellRunRecordStopRecovery) => {
    if (saved.stop && saved.stop.requestSha256 !== requestSha256)
      fail('This original run ID is fenced for different configuration.');
    if (
      saved.run &&
      (saved.run.profile.id !== request.profileSaveId ||
        saved.run.profile.sha256 !== request.profileSha256 ||
        saved.run.profile.terms.projectId !== request.projectId)
    )
      fail('This original run ID belongs to different configuration.');
    return saved;
  };
  const before = match(
    await readOwnedAutoSellRunRecordStop(db, owner, request.runId, signal),
  );
  if (before.stop) return before;
  try {
    await db
      .prepare(
        `INSERT INTO auto_sell_run_record_stops(owner_id,run_id,project_id,profile_save_id,profile_sha256,request_sha256,status,run_sha256,created_at) SELECT ?,?,?,?,?,?,CASE WHEN r.id IS NULL THEN 'creation-fenced' ELSE 'record-found' END,r.sha256,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM (SELECT 1) singleton LEFT JOIN auto_sell_runs r ON r.owner_id=? AND r.id=?`,
      )
      .bind(
        owner,
        request.runId,
        request.projectId,
        request.profileSaveId,
        request.profileSha256,
        requestSha256,
        owner,
        request.runId,
      )
      .run();
    active(signal);
  } catch (error) {
    active(signal);
    const recovery = match(
      await readOwnedAutoSellRunRecordStop(db, owner, request.runId, signal),
    );
    if (recovery.stop) return recovery;
    if (error instanceof AutoSellRunRecordStopStorageError) throw error;
    fail(
      'Original record request was not stopped. Keep its identity; inspect before retrying.',
      409,
    );
  }
  const result = match(
    await readOwnedAutoSellRunRecordStop(db, owner, request.runId, signal),
  );
  if (!result.stop)
    fail('Original record stop was not confirmed. Keep its identity.', 503);
  return result;
}
