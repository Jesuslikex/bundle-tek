import {
  autoSellRunId,
  autoSellRunOccurrenceKeys,
  autoSellRunAmountLimbs,
  autoSellRunLimbsRaw,
  createAutoSellRun,
  createAutoSellRunAttempt,
  readAutoSellRun,
  readAutoSellRunAttempt,
  readAutoSellRunAttemptInput,
  replayAutoSellRun,
  type AutoSellRun,
  type AutoSellRunAttempt,
  type AutoSellRunAttemptInput,
  type AutoSellRunWallet,
} from './auto-sell-run';
import {
  readAutoSellProfile,
  AutoSellProfileStorageError,
} from './auto-sell-profile-storage';
import type { SwapPreparationSummary } from './imported-swap-preparation-history';

export class AutoSellRunStorageError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}
function refused(message: string, status = 409): never {
  throw new AutoSellRunStorageError(message, status);
}
function active(signal: AbortSignal) {
  if (signal.aborted)
    refused(
      'Auto Sell journal waiting cancelled. Recover the original run and attempt IDs.',
      499,
    );
}
function ownerId(owner: string) {
  if (typeof owner !== 'string' || owner.length < 1 || owner.length > 128)
    refused('Choose the original signed-in account.', 400);
}
function id(value: unknown) {
  try {
    return autoSellRunId(value);
  } catch {
    return refused('Choose a complete original Auto Sell journal ID.', 400);
  }
}
function hash(value: unknown) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    return refused('Choose the original Auto Sell journal hash.', 400);
  return value;
}
function record(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    refused('Review the exact Auto Sell journal request.', 400);
  if (Reflect.ownKeys(value).length !== keys.length)
    refused('Review the exact Auto Sell journal request.', 400);
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      !keys.includes(key) ||
      !d?.enumerable ||
      !Object.hasOwn(d, 'value')
    )
      refused('Review the exact Auto Sell journal request.', 400);
  }
  return value as Record<string, unknown>;
}
function failed(error: unknown, signal: AbortSignal): never {
  active(signal);
  if (error instanceof AutoSellRunStorageError) throw error;
  if (error instanceof AutoSellProfileStorageError)
    refused(error.message, error.status);
  if (String(error).includes('Auto Sell run preparation remains held'))
    refused(
      'An original preparation has not been published. Recover that exact attempt before starting another preparation or reserving more allowance.',
    );
  if (
    String(error).includes(
      'Auto Sell earlier same-token allowance remains held',
    )
  )
    refused(
      'An earlier Auto Sell run retains an unresolved journal allowance for this wallet and token. Recover that run before recording or reserving another.',
    );
  if (
    /Auto Sell .* (changed|full|used|append|invalid|started|unavailable|disabled|claimed|held)/.test(
      String(error),
    )
  )
    refused(
      'Auto Sell journal source, sequence or capacity changed. Recover the original run before continuing.',
    );
  return refused(
    'Auto Sell journal storage is unavailable. Keep the original run and attempt IDs.',
    503,
  );
}
async function sqlNow(db: D1Database) {
  const r = await db
    .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now")
    .first<{ now: string }>();
  if (!r || typeof r.now !== 'string') throw Error('Missing database clock');
  return r.now;
}
type RunRow = {
  owner_id: string;
  id: string;
  project_id: string;
  project_revision: number;
  profile_save_id: string;
  profile_sha256: string;
  document: string;
  sha256: string;
  source_document: string;
  own_wallets_json: string;
  created_at: string;
  active_at: string;
  ends_at: string | null;
};
type AttemptRow = {
  owner_id: string;
  id: string;
  run_id: string;
  sequence: number;
  previous_sha256: string;
  sha256: string;
  strategy_id: string;
  wallet: string;
  wallet_revision: number;
  input_raw: string;
  amount_high: number;
  amount_middle: number;
  amount_low: number;
  preparation_id: string;
  document: string;
  reserved_at: string;
};
type HeadRow = {
  sequence: number;
  head_sha256: string;
  state: 'open' | 'stopped';
  accounted_high: number;
  accounted_middle: number;
  accounted_low: number;
  total_bytes: number;
  updated_at: string;
};
type StrategyHead = {
  strategy_id: string;
  accounted_high: number;
  accounted_middle: number;
  accounted_low: number;
  next_dca_index: number;
  next_dca_at: string | null;
};
type StopRow = {
  owner_id: string;
  id: string;
  run_id: string;
  run_sha256: string;
  created_at: string;
};
type StartRow = {
  attempt_id: string;
  preparation_id: string;
  head_sequence: number;
  head_sha256: string;
  created_at: string;
};
async function decodeRun(owner: string, row: RunRow) {
  const run = await readAutoSellRun(JSON.parse(row.document));
  if (
    row.owner_id !== owner ||
    row.id !== run.id ||
    row.project_id !== run.profile.terms.projectId ||
    row.project_revision !== run.profile.terms.projectRevision ||
    row.profile_save_id !== run.profile.id ||
    row.profile_sha256 !== run.profile.sha256 ||
    row.sha256 !== run.sha256 ||
    row.created_at !== run.createdAt ||
    row.active_at !== run.activeAt ||
    row.ends_at !== run.endsAt ||
    row.own_wallets_json !== JSON.stringify(run.ownWallets) ||
    row.document !== JSON.stringify(run)
  )
    throw Error('Retained run differs');
  return run;
}
async function decodeAttempt(owner: string, row: AttemptRow) {
  const a = await readAutoSellRunAttempt(JSON.parse(row.document));
  if (
    row.owner_id !== owner ||
    row.id !== a.id ||
    row.run_id !== a.runId ||
    row.sequence !== a.sequence ||
    row.previous_sha256 !== a.previousSha256 ||
    row.sha256 !== a.sha256 ||
    row.strategy_id !== a.strategyId ||
    row.wallet !== a.wallet ||
    row.wallet_revision !== a.walletRevision ||
    row.input_raw !== a.inputRaw ||
    row.preparation_id !== a.preparationId ||
    row.reserved_at !== a.reservedAt ||
    row.document !== JSON.stringify(a) ||
    autoSellRunLimbsRaw({
      high: row.amount_high,
      middle: row.amount_middle,
      low: row.amount_low,
    }) !== a.inputRaw
  )
    throw Error('Retained attempt differs');
  return a;
}
const falseAuthority = {
  signingAllowed: false,
  executionAllowed: false,
  automaticResumeAllowed: false,
} as const;
function stopReceipt(row: StopRow) {
  id(row.id);
  id(row.run_id);
  hash(row.run_sha256);
  if (
    typeof row.created_at !== 'string' ||
    row.created_at.length !== 24 ||
    !Number.isFinite(Date.parse(row.created_at)) ||
    new Date(row.created_at).toISOString() !== row.created_at
  )
    throw Error('Retained stop differs');
  return {
    format: 'auto-sell-run-stop-v1' as const,
    id: row.id,
    runId: row.run_id,
    runSha256: row.run_sha256,
    createdAt: row.created_at,
    ...falseAuthority,
  };
}
export type AutoSellRunStop = ReturnType<typeof stopReceipt>;
async function rawRun(db: D1Database, owner: string, runId: string) {
  return db
    .prepare('SELECT * FROM auto_sell_runs WHERE owner_id=? AND id=?')
    .bind(owner, runId)
    .first<RunRow>();
}
export async function readOwnedAutoSellRun(
  db: D1Database,
  owner: string,
  runId: string,
  signal: AbortSignal,
): Promise<AutoSellRun | null> {
  active(signal);
  ownerId(owner);
  id(runId);
  try {
    const row = await rawRun(db, owner, runId);
    active(signal);
    const result = row ? await decodeRun(owner, row) : null;
    active(signal);
    return result;
  } catch (error) {
    return failed(error, signal);
  }
}
export async function createOwnedAutoSellRun(
  db: D1Database,
  owner: string,
  input: {
    id: string;
    projectId: string;
    profileSaveId: string;
    profileSha256: string;
    consent: 'record-auto-sell-run-v1';
  },
  signal: AbortSignal,
): Promise<AutoSellRun> {
  active(signal);
  ownerId(owner);
  const body = record(input, [
    'id',
    'projectId',
    'profileSaveId',
    'profileSha256',
    'consent',
  ]);
  const runId = id(body.id),
    projectId = id(body.projectId),
    profileSaveId = id(body.profileSaveId),
    profileSha256 = hash(body.profileSha256);
  if (body.consent !== 'record-auto-sell-run-v1')
    refused('Approve recording this exact Auto Sell journal.', 400);
  const matching = (run: AutoSellRun) => {
    if (
      run.profile.id !== profileSaveId ||
      run.profile.sha256 !== profileSha256 ||
      run.profile.terms.projectId !== projectId
    )
      refused('This run ID belongs to different original configuration.');
    return run;
  };
  try {
    const old = await readOwnedAutoSellRun(db, owner, runId, signal);
    if (old) return matching(old);
    const profile = await readAutoSellProfile(
      db,
      owner,
      projectId,
      profileSaveId,
      signal,
    );
    if (profile.sha256 !== profileSha256)
      refused('The original Auto Sell configuration hash differs.');
    const source = await db
      .prepare(
        'SELECT document,revision,archived,chain,address FROM imported_token_projects WHERE owner_id=? AND id=?',
      )
      .bind(owner, projectId)
      .first<{
        document: string;
        revision: number;
        archived: number;
        chain: string;
        address: string;
      }>();
    const wallets = await db
      .prepare(
        "SELECT address,revision,archived FROM workspace_wallets WHERE owner_id=? AND chain='Solana' ORDER BY address LIMIT 1001",
      )
      .bind(owner)
      .all<{ address: string; revision: number; archived: number }>();
    active(signal);
    const token = source ? JSON.parse(source.document).token : null;
    if (
      !source ||
      source.archived !== 0 ||
      source.revision !== profile.terms.projectRevision ||
      source.chain !== 'Solana' ||
      source.address !== profile.terms.token.mint ||
      token?.chain !== 'Solana' ||
      token?.address !== profile.terms.token.mint ||
      token?.decimals !== profile.terms.token.decimals ||
      token?.totalSupplyRaw !== profile.terms.token.totalSupplyRaw
    )
      refused('The original Auto Sell project changed.');
    if (
      !wallets.success ||
      !Array.isArray(wallets.results) ||
      wallets.results.length > 1000
    )
      refused('The complete owned-wallet snapshot is unavailable.');
    const ownWallets: AutoSellRunWallet[] = wallets.results.map((w) => {
      if (w.archived !== 0 && w.archived !== 1)
        throw Error('Invalid roster archive state');
      return {
        address: w.address,
        revision: w.revision,
        archived: w.archived === 1,
      };
    });
    const now = await sqlNow(db),
      run = await createAutoSellRun(runId, profile, ownWallets, now);
    active(signal);
    await db
      .prepare(
        'INSERT INTO auto_sell_runs(owner_id,id,project_id,project_revision,profile_save_id,profile_sha256,document,sha256,source_document,own_wallets_json,created_at,active_at,ends_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        owner,
        run.id,
        projectId,
        run.profile.terms.projectRevision,
        profileSaveId,
        profileSha256,
        JSON.stringify(run),
        run.sha256,
        source.document,
        JSON.stringify(run.ownWallets),
        run.createdAt,
        run.activeAt,
        run.endsAt,
      )
      .run();
    active(signal);
    return matching(
      (await readOwnedAutoSellRun(db, owner, runId, signal)) ??
        refused('The original Auto Sell run was not retained.'),
    );
  } catch (error) {
    active(signal);
    const old = await readOwnedAutoSellRun(db, owner, runId, signal);
    if (old) return matching(old);
    return failed(error, signal);
  }
}
export async function readOwnedAutoSellAttempts(
  db: D1Database,
  owner: string,
  runId: string,
  signal: AbortSignal,
) {
  active(signal);
  ownerId(owner);
  id(runId);
  try {
    const result = await db.batch([
      db
        .prepare('SELECT * FROM auto_sell_runs WHERE owner_id=? AND id=?')
        .bind(owner, runId),
      db
        .prepare(
          'SELECT * FROM auto_sell_run_attempts WHERE owner_id=? AND run_id=? AND (SELECT COALESCE(sum(length(CAST(document AS BLOB))),0) FROM auto_sell_run_attempts WHERE owner_id=? AND run_id=?)<=33554432 ORDER BY sequence LIMIT 1001',
        )
        .bind(owner, runId, owner, runId),
      db
        .prepare(
          'SELECT * FROM auto_sell_run_heads WHERE owner_id=? AND run_id=?',
        )
        .bind(owner, runId),
      db
        .prepare(
          'SELECT * FROM auto_sell_run_strategy_heads WHERE owner_id=? AND run_id=? ORDER BY strategy_id',
        )
        .bind(owner, runId),
      db
        .prepare(
          'SELECT strategy_id,key,attempt_id FROM auto_sell_run_occurrences WHERE owner_id=? AND run_id=? ORDER BY strategy_id,key LIMIT 128001',
        )
        .bind(owner, runId),
      db
        .prepare(
          'SELECT * FROM auto_sell_run_stops WHERE owner_id=? AND run_id=?',
        )
        .bind(owner, runId),
      db
        .prepare(
          'SELECT attempt_id,preparation_id,head_sequence,head_sha256,created_at FROM auto_sell_run_preparation_starts WHERE owner_id=? AND run_id=? ORDER BY created_at,attempt_id LIMIT 1001',
        )
        .bind(owner, runId),
    ]);
    active(signal);
    if (result.some((r) => !r.success || !Array.isArray(r.results)))
      throw Error('Missing journal snapshot');
    const rows = result[0].results as unknown as RunRow[];
    if (rows.length !== 1) refused('Owned Auto Sell run unavailable.', 404);
    const run = await decodeRun(owner, rows[0]);
    const ar = result[1].results as unknown as AttemptRow[];
    if (ar.length > 1000) throw Error('Run history full');
    const attempts = await Promise.all(
      ar.map((row) => decodeAttempt(owner, row)),
    );
    const accounting = await replayAutoSellRun(run, attempts);
    const heads = result[2].results as unknown as HeadRow[];
    if (heads.length !== 1) throw Error('Missing run head');
    const h = heads[0],
      totalBytes =
        new TextEncoder().encode(JSON.stringify(run)).byteLength +
        attempts.reduce(
          (n, a) => n + new TextEncoder().encode(JSON.stringify(a)).byteLength,
          0,
        );
    if (
      h.sequence !== accounting.sequence ||
      h.head_sha256 !== accounting.headSha256 ||
      autoSellRunLimbsRaw({
        high: h.accounted_high,
        middle: h.accounted_middle,
        low: h.accounted_low,
      }) !== accounting.accountedRaw ||
      h.total_bytes !== totalBytes ||
      totalBytes > 33554432
    )
      throw Error('Run accounting differs');
    const strategyHeads = result[3].results as unknown as StrategyHead[];
    if (
      strategyHeads.length !== accounting.strategies.length ||
      accounting.strategies.some((s) => {
        const stored = strategyHeads.find((x) => x.strategy_id === s.id);
        return (
          !stored ||
          autoSellRunLimbsRaw({
            high: stored.accounted_high,
            middle: stored.accounted_middle,
            low: stored.accounted_low,
          }) !== s.accountedRaw ||
          stored.next_dca_index !== s.nextDcaIndex ||
          stored.next_dca_at !== s.nextDcaAt
        );
      })
    )
      throw Error('Strategy accounting differs');
    const claims = result[4].results as unknown as {
      strategy_id: string;
      key: string;
      attempt_id: string;
    }[];
    if (
      claims.length !==
        accounting.strategies.reduce((n, s) => n + s.claimedKeys.length, 0) ||
      accounting.strategies.some((s) => {
        const keys = claims.filter((c) => c.strategy_id === s.id);
        return (
          keys.length !== s.claimedKeys.length ||
          keys.some(
            (c) =>
              !s.claimedKeys.includes(c.key) ||
              !attempts.some(
                (a) =>
                  a.id === c.attempt_id &&
                  a.strategyId === s.id &&
                  autoSellRunOccurrenceKeys(a.occurrence).includes(c.key),
              ),
          )
        );
      })
    )
      throw Error('Occurrence history differs');
    const stops = result[5].results as unknown as StopRow[];
    if (stops.length > 1 || h.state !== (stops.length ? 'stopped' : 'open'))
      throw Error('Stop state differs');
    const stop = stops.length ? stopReceipt(stops[0]) : null;
    if (stop && stop.runSha256 !== run.sha256) throw Error('Stop root differs');
    if (
      h.updated_at !==
      (stop?.createdAt ?? attempts.at(-1)?.reservedAt ?? run.createdAt)
    )
      throw Error('Run head clock differs');
    const starts = result[6].results as unknown as StartRow[];
    if (
      starts.length > 1000 ||
      starts.some(
        (s) =>
          !attempts.some(
            (a) =>
              a.id === s.attempt_id && a.preparationId === s.preparation_id,
          ) ||
          !Number.isSafeInteger(s.head_sequence) ||
          s.head_sequence < 1 ||
          s.head_sequence > accounting.sequence ||
          attempts[s.head_sequence - 1]?.sha256 !== s.head_sha256 ||
          typeof s.created_at !== 'string' ||
          !Number.isFinite(Date.parse(s.created_at)),
      )
    )
      throw Error('Preparation-start history differs');
    active(signal);
    return {
      run,
      attempts,
      accounting,
      stopped: stop !== null,
      stop,
      preparationStarts: starts.map((s) => ({
        attemptId: s.attempt_id,
        preparationId: s.preparation_id,
        headSequence: s.head_sequence,
        headSha256: s.head_sha256,
        createdAt: s.created_at,
      })),
    };
  } catch (error) {
    return failed(error, signal);
  }
}
function sameAttempt(a: AutoSellRunAttempt, r: AutoSellRunAttemptInput) {
  return (
    a.id === r.id &&
    a.runId === r.runId &&
    a.sequence === r.expectedSequence + 1 &&
    a.previousSha256 === r.expectedHeadSha256 &&
    a.strategyId === r.strategyId &&
    a.wallet === r.wallet &&
    a.walletRevision === r.walletRevision &&
    a.inputRaw === r.inputRaw &&
    JSON.stringify(a.occurrence) === JSON.stringify(r.occurrence)
  );
}
export async function reserveOwnedAutoSellAttempt(
  db: D1Database,
  owner: string,
  input: unknown,
  signal: AbortSignal,
): Promise<AutoSellRunAttempt> {
  active(signal);
  ownerId(owner);
  let request: AutoSellRunAttemptInput;
  try {
    request = readAutoSellRunAttemptInput(input);
  } catch {
    return refused('Review the exact Auto Sell attempt and allowance.', 400);
  }
  try {
    const history = await readOwnedAutoSellAttempts(
      db,
      owner,
      request.runId,
      signal,
    );
    const replay = history.attempts.find((a) => a.id === request.id);
    if (replay) {
      if (!sameAttempt(replay, request))
        refused('This attempt ID belongs to a different reservation.');
      return replay;
    }
    if (history.stopped)
      refused(
        'This Auto Sell run is stopped. Existing attempts remain charged.',
      );
    const at = await sqlNow(db);
    let attempt: AutoSellRunAttempt;
    try {
      attempt = await createAutoSellRunAttempt(
        history.run,
        history.attempts,
        request,
        crypto.randomUUID(),
        at,
      );
    } catch {
      return refused(
        'The Auto Sell occurrence, amount, timing or allowance changed.',
      );
    }
    const limbs = autoSellRunAmountLimbs(attempt.inputRaw);
    active(signal);
    await db
      .prepare(
        'INSERT INTO auto_sell_run_attempts(owner_id,id,run_id,sequence,previous_sha256,sha256,strategy_id,wallet,wallet_revision,input_raw,amount_high,amount_middle,amount_low,preparation_id,document,reserved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        owner,
        attempt.id,
        attempt.runId,
        attempt.sequence,
        attempt.previousSha256,
        attempt.sha256,
        attempt.strategyId,
        attempt.wallet,
        attempt.walletRevision,
        attempt.inputRaw,
        limbs.high,
        limbs.middle,
        limbs.low,
        attempt.preparationId,
        JSON.stringify(attempt),
        attempt.reservedAt,
      )
      .run();
    active(signal);
    const saved = (
      await readOwnedAutoSellAttempts(db, owner, request.runId, signal)
    ).attempts.find((a) => a.id === request.id);
    if (!saved || !sameAttempt(saved, request))
      refused('The original Auto Sell attempt was not retained.');
    return saved;
  } catch (error) {
    active(signal);
    const history = await readOwnedAutoSellAttempts(
      db,
      owner,
      request.runId,
      signal,
    );
    const old = history.attempts.find((a) => a.id === request.id);
    if (old) {
      if (!sameAttempt(old, request))
        refused('This attempt ID belongs to a different reservation.');
      return old;
    }
    return failed(error, signal);
  }
}
export async function stopOwnedAutoSellRun(
  db: D1Database,
  owner: string,
  input: { id: string; runId: string; runSha256: string },
  signal: AbortSignal,
): Promise<AutoSellRunStop> {
  active(signal);
  ownerId(owner);
  const r = record(input, ['id', 'runId', 'runSha256']),
    stopId = id(r.id),
    runId = id(r.runId),
    runSha256 = hash(r.runSha256);
  const read = async () => {
    const result = await db
      .prepare('SELECT * FROM auto_sell_run_stops WHERE owner_id=? AND id=?')
      .bind(owner, stopId)
      .first<StopRow>();
    active(signal);
    return result;
  };
  const match = (row: StopRow) => {
    if (row.run_id !== runId || row.run_sha256 !== runSha256)
      refused('This stop ID belongs to a different run.');
    return stopReceipt(row);
  };
  try {
    const old = await read();
    if (old) return match(old);
    const run = await readOwnedAutoSellRun(db, owner, runId, signal);
    if (!run || run.sha256 !== runSha256)
      refused('The original Auto Sell run differs.');
    const now = await sqlNow(db);
    active(signal);
    await db
      .prepare(
        'INSERT INTO auto_sell_run_stops(owner_id,id,run_id,run_sha256,created_at) VALUES(?,?,?,?,?)',
      )
      .bind(owner, stopId, runId, runSha256, now)
      .run();
    active(signal);
    const saved = await read();
    if (!saved) refused('The original Auto Sell stop was not retained.');
    return match(saved);
  } catch (error) {
    active(signal);
    const old = await read();
    if (old) return match(old);
    return failed(error, signal);
  }
}
export type AutoSellRunCursor = { createdAt: string; id: string };
export async function listOwnedAutoSellRuns(
  db: D1Database,
  owner: string,
  projectId: string,
  before: AutoSellRunCursor | null,
  signal: AbortSignal,
) {
  active(signal);
  ownerId(owner);
  id(projectId);
  let cursor: AutoSellRunCursor | null = null;
  if (before !== null && before !== undefined) {
    const b = record(before, ['createdAt', 'id']);
    const beforeId = id(b.id);
    if (
      typeof b.createdAt !== 'string' ||
      b.createdAt.length !== 24 ||
      !Number.isFinite(Date.parse(b.createdAt)) ||
      new Date(b.createdAt).toISOString() !== b.createdAt
    )
      refused('Choose a valid saved-run cursor.', 400);
    cursor = { createdAt: b.createdAt, id: beforeId };
  }
  try {
    if (
      cursor &&
      !(await db
        .prepare(
          'SELECT id FROM auto_sell_runs WHERE owner_id=? AND project_id=? AND id=? AND created_at=?',
        )
        .bind(owner, projectId, cursor.id, cursor.createdAt)
        .first())
    )
      refused(
        'The saved-run cursor does not belong to this owned project.',
        400,
      );
    const rows = await db
      .prepare(
        `SELECT r.id,r.created_at,r.profile_save_id,r.profile_sha256,r.sha256,h.sequence,h.accounted_high,h.accounted_middle,h.accounted_low,h.state FROM auto_sell_runs r JOIN auto_sell_run_heads h ON h.owner_id=r.owner_id AND h.run_id=r.id WHERE r.owner_id=? AND r.project_id=? ${cursor ? 'AND (r.created_at<? OR (r.created_at=? AND r.id<?))' : ''} ORDER BY r.created_at DESC,r.id DESC LIMIT 21`,
      )
      .bind(
        owner,
        projectId,
        ...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : []),
      )
      .all<{
        id: string;
        created_at: string;
        profile_save_id: string;
        profile_sha256: string;
        sha256: string;
        sequence: number;
        accounted_high: number;
        accounted_middle: number;
        accounted_low: number;
        state: string;
      }>();
    active(signal);
    if (
      !rows.success ||
      !Array.isArray(rows.results) ||
      rows.results.length > 21 ||
      rows.results.some(
        (r) =>
          !Number.isSafeInteger(r.sequence) ||
          r.sequence < 0 ||
          r.sequence > 1000 ||
          !['open', 'stopped'].includes(r.state) ||
          typeof r.created_at !== 'string' ||
          r.created_at.length !== 24 ||
          !Number.isFinite(Date.parse(r.created_at)) ||
          new Date(r.created_at).toISOString() !== r.created_at,
      )
    )
      throw Error('Missing or invalid index');
    const page = rows.results.slice(0, 20),
      last = page.at(-1);
    return {
      runs: page.map((r) => ({
        id: id(r.id),
        createdAt: r.created_at,
        profileSaveId: id(r.profile_save_id),
        profileSha256: hash(r.profile_sha256),
        runSha256: hash(r.sha256),
        attemptCount: r.sequence,
        accountedRaw: autoSellRunLimbsRaw({
          high: r.accounted_high,
          middle: r.accounted_middle,
          low: r.accounted_low,
        }),
        stopped: r.state === 'stopped',
      })),
      nextCursor:
        rows.results.length > 20 && last
          ? { createdAt: last.created_at, id: last.id }
          : null,
    };
  } catch (error) {
    return failed(error, signal);
  }
}
export type AutoSellRunPreparationGuard = Readonly<{
  owner: string;
  runId: string;
  attemptId: string;
  preparationId: string;
  runSha256: string;
  attemptSha256: string;
  projectId: string;
  projectRevision: number;
  wallet: string;
  walletRevision: number;
  mint: string;
  decimals: number;
  inputRaw: string;
  maxSlippageBps: number;
  headSequence: number;
  headSha256: string;
  sourceDocument: string;
  ownWalletsJson: string;
}>;
const preparationGuards = new WeakSet<object>();
export function requireAutoSellRunPreparationGuard(
  value: unknown,
): asserts value is AutoSellRunPreparationGuard {
  if (!value || typeof value !== 'object' || !preparationGuards.has(value))
    refused('A fresh original server preparation-start guard is required.');
}
export async function startOwnedAutoSellPreparation(
  db: D1Database,
  owner: string,
  runId: string,
  attemptId: string,
  signal: AbortSignal,
): Promise<AutoSellRunPreparationGuard> {
  active(signal);
  ownerId(owner);
  id(runId);
  id(attemptId);
  try {
    const history = await readOwnedAutoSellAttempts(db, owner, runId, signal),
      attempt = history.attempts.find((a) => a.id === attemptId);
    if (!attempt || history.stopped)
      refused(
        'The original run or attempt is unavailable for a new preparation.',
      );
    if (history.preparationStarts.some((s) => s.attemptId === attemptId))
      refused(
        'This preparation already started. Recover the original attempt; do not repeat provider work.',
      );
    const source = await rawRun(db, owner, runId);
    if (!source) refused('The original run is unavailable.');
    const now = await sqlNow(db);
    active(signal);
    await db
      .prepare(
        'INSERT INTO auto_sell_run_preparation_starts(owner_id,run_id,attempt_id,preparation_id,head_sequence,head_sha256,created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .bind(
        owner,
        runId,
        attemptId,
        attempt.preparationId,
        history.accounting.sequence,
        history.accounting.headSha256,
        now,
      )
      .run();
    active(signal);
    const guard: AutoSellRunPreparationGuard = Object.freeze({
      owner,
      runId,
      attemptId,
      preparationId: attempt.preparationId,
      runSha256: history.run.sha256,
      attemptSha256: attempt.sha256,
      projectId: history.run.profile.terms.projectId,
      projectRevision: history.run.profile.terms.projectRevision,
      wallet: attempt.wallet,
      walletRevision: attempt.walletRevision,
      mint: history.run.profile.terms.token.mint,
      decimals: history.run.profile.terms.token.decimals,
      inputRaw: attempt.inputRaw,
      maxSlippageBps:
        history.run.profile.terms.configuration.session.maxSlippageBps ?? 50,
      headSequence: history.accounting.sequence,
      headSha256: history.accounting.headSha256,
      sourceDocument: source.source_document,
      ownWalletsJson: source.own_wallets_json,
    });
    preparationGuards.add(guard);
    return guard;
  } catch (error) {
    return failed(error, signal);
  }
}
export function autoSellPreparationWriteGuard(
  owner: string,
  guard: AutoSellRunPreparationGuard,
  context: {
    projectId: string;
    projectRevision: number;
    wallet: string;
    walletRevision: number;
  },
  document: SwapPreparationSummary,
) {
  requireAutoSellRunPreparationGuard(guard);
  if (
    owner !== guard.owner ||
    context.projectId !== guard.projectId ||
    context.projectRevision !== guard.projectRevision ||
    context.wallet !== guard.wallet ||
    context.walletRevision !== guard.walletRevision ||
    document.wallet !== guard.wallet ||
    document.side !== 'Sell' ||
    document.inputMint !== guard.mint ||
    document.outputMint !== 'So11111111111111111111111111111111111111112' ||
    document.inAmountRaw !== guard.inputRaw ||
    !Number.isSafeInteger(document.slippageBps) ||
    document.slippageBps < 1 ||
    document.slippageBps > guard.maxSlippageBps ||
    document.acquisition !== undefined ||
    document.conditional !== undefined ||
    document.session !== undefined
  )
    refused(
      'The preparation differs from the original Auto Sell journal attempt.',
    );
  return {
    preparationId: guard.preparationId,
    sql: ` AND EXISTS(SELECT 1 FROM auto_sell_runs r JOIN auto_sell_run_attempts a ON a.owner_id=r.owner_id AND a.run_id=r.id JOIN auto_sell_run_heads h ON h.owner_id=r.owner_id AND h.run_id=r.id JOIN auto_sell_run_preparation_starts s ON s.owner_id=a.owner_id AND s.attempt_id=a.id WHERE r.owner_id=? AND r.id=? AND r.sha256=? AND a.id=? AND a.sha256=? AND a.preparation_id=? AND h.state='open' AND h.sequence=? AND h.head_sha256=? AND s.head_sequence=h.sequence AND s.head_sha256=h.head_sha256 AND r.source_document=? AND r.own_wallets_json=? AND EXISTS(SELECT 1 FROM auto_sell_run_current_sources c WHERE c.owner_id=r.owner_id AND c.id=r.id) AND NOT EXISTS(SELECT 1 FROM auto_sell_run_stops z WHERE z.owner_id=r.owner_id AND z.run_id=r.id) AND strftime('%Y-%m-%dT%H:%M:%fZ','now')>=r.active_at AND (r.ends_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ','now')<r.ends_at))`,
    bindings: [
      owner,
      guard.runId,
      guard.runSha256,
      guard.attemptId,
      guard.attemptSha256,
      guard.preparationId,
      guard.headSequence,
      guard.headSha256,
      guard.sourceDocument,
      guard.ownWalletsJson,
    ],
  };
}
