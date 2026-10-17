import { readPumpLaunchGroupReview } from './pump-launch-group-review-service';
import { PumpPreflightError } from './owned-pump-preflight';
import { pumpCreateAddresses } from './pump-launch-message';
import { decodePumpSigningInput } from './pump-launch-signing';
import { inspectPumpQuoteMint, PUMP_NATIVE_QUOTE } from './pump-launch-config';
import {
  evaluateSniperGuard,
  parseSniperGuardSettings,
  sniperGuardActions,
  type SniperGuardCurveBuy,
  type SniperGuardEvaluation,
  type SniperGuardLaunch,
  type SniperGuardSettings,
} from './sniper-guard';
import { stopPumpOrganicSequence } from './pump-organic-service';
import {
  readCurveBuys,
  readLaunchTokenBalances,
  type SniperGuardRpc,
} from './sniper-guard-chain';

export const SNIPER_GUARD_STORED_BUYS = 1000;
export type SniperGuardState =
  | 'planned'
  | 'watching'
  | 'triggered'
  | 'ended'
  | 'stopped';
export type SniperGuardBalance = {
  wallet: string;
  tokenAccount: string;
  amountRaw: string;
};
export type SniperGuardObservation = {
  cursor: string | null;
  buys: SniperGuardCurveBuy[];
  coverage: 'complete' | 'partial';
  pendingTransactions: boolean;
  observedAt: string;
  launchState: string;
  evaluation: SniperGuardEvaluation;
  endReason: 'launch-complete' | 'timed' | 'capacity' | null;
  balances: SniperGuardBalance[] | null;
  /** Organic/Stagger sequences of this launch stopped by Complete Early. */
  stoppedSequences: string[];
};
export type SniperGuardView = {
  id: string;
  reviewId: string;
  projectId: string;
  revision: number;
  state: SniperGuardState;
  settings: SniperGuardSettings;
  launch: SniperGuardLaunch | null;
  observation: Omit<SniperGuardObservation, 'buys'> | null;
  armedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  automaticExecution: false;
  signingAllowed: false;
};
type Row = {
  id: string;
  owner_id: string;
  project_id: string;
  review_id: string;
  revision: number;
  state: SniperGuardState;
  settings: string;
  launch: string | null;
  observation: string | null;
  updated_at: string;
  armed_at: string | null;
  finished_at: string | null;
};
const fail = (message: string, status = 409): never => {
  throw new PumpPreflightError(message, status);
};
const ENDED_LAUNCH = new Set(['finalized', 'failed', 'cancelled']);

function view(row: Row): SniperGuardView {
  const observation = row.observation
    ? (JSON.parse(row.observation) as SniperGuardObservation)
    : null;
  let summary: SniperGuardView['observation'] = null;
  if (observation) {
    const { buys: _buys, ...rest } = observation;
    summary = rest;
  }
  return {
    id: row.id,
    reviewId: row.review_id,
    projectId: row.project_id,
    revision: row.revision,
    state: row.state,
    settings: parseSniperGuardSettings(JSON.parse(row.settings)),
    launch: row.launch ? (JSON.parse(row.launch) as SniperGuardLaunch) : null,
    observation: summary,
    armedAt: row.armed_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
    automaticExecution: false,
    signingAllowed: false,
  };
}

async function readRow(db: D1Database, owner: string, reviewId: string) {
  return db
    .prepare('SELECT * FROM sniper_guards WHERE owner_id=? AND review_id=?')
    .bind(owner, reviewId)
    .first<Row>();
}

/** Launch identity derived from the owned saved group review, never from the client. */
export async function readSniperGuardLaunch(
  db: D1Database,
  owner: string,
  reviewId: string,
) {
  const saved = await readPumpLaunchGroupReview(db, owner, reviewId);
  const create = decodePumpSigningInput(saved.review.input.create);
  const native = create.quoteMint === PUMP_NATIVE_QUOTE;
  let quoteDecimals = 9,
    quoteTokenProgram: string | null = null;
  if (!native) {
    if (!create.quoteMintAccount)
      return fail('Saved launch quote mint evidence is missing.');
    const quote = inspectPumpQuoteMint(create.quoteMintAccount);
    quoteDecimals = quote.decimals;
    quoteTokenProgram = quote.tokenProgram;
  }
  const { bondingCurve } = await pumpCreateAddresses(create.mint);
  const holders = [
    ...new Set(
      saved.review.input.holders
        .map((h) => h.address)
        .filter((a) => a !== create.payer),
    ),
  ];
  const launch: SniperGuardLaunch = {
    mint: create.mint,
    bondingCurve: String(bondingCurve),
    quoteMint: create.quoteMint,
    quoteDecimals,
    quoteTokenProgram,
    developer: create.payer,
    holders,
  };
  return {
    launch,
    projectId: saved.review.projectId,
    launchState: saved.state as string,
  };
}

export type SniperGuardLaunchReader = typeof readSniperGuardLaunch;
/** Cheap per-poll read of the launch state; identity was fixed when the guard was armed. */
export async function readSniperGuardLaunchState(
  db: D1Database,
  owner: string,
  reviewId: string,
) {
  const row = await db
    .prepare('SELECT state FROM pump_launch_reviews WHERE owner_id=? AND id=?')
    .bind(owner, reviewId)
    .first<{ state: string }>();
  return row ? row.state : fail('Owned launch review not found.', 404);
}
export type SniperGuardLaunchStateReader = typeof readSniperGuardLaunchState;

export async function readSniperGuard(
  db: D1Database,
  owner: string,
  reviewId: string,
) {
  const row = await readRow(db, owner, reviewId);
  return row ? view(row) : null;
}

/** Saves or edits planned settings. Settings freeze once the guard is armed. */
export async function saveSniperGuardSettings(
  db: D1Database,
  owner: string,
  reviewId: string,
  supplied: unknown,
  revision: number | null,
  now = new Date(),
  readLaunch: SniperGuardLaunchReader = readSniperGuardLaunch,
) {
  let settings: SniperGuardSettings;
  try {
    settings = parseSniperGuardSettings(supplied);
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : 'Sniper Guard settings differ.',
      400,
    );
  }
  const { projectId, launchState } = await readLaunch(db, owner, reviewId);
  if (launchState === 'failed' || launchState === 'cancelled')
    fail(
      'This launch was cancelled or failed. Sniper Guard has nothing to watch.',
    );
  const at = now.toISOString();
  const existing = await readRow(db, owner, reviewId);
  if (!existing) {
    if (revision !== null)
      fail('Sniper Guard was removed or never saved. Reload it.');
    await db
      .prepare(
        "INSERT INTO sniper_guards(id,owner_id,project_id,review_id,revision,state,settings,created_at,updated_at) VALUES(?,?,?,?,1,'planned',?,?,?) ON CONFLICT(owner_id,review_id) DO NOTHING",
      )
      .bind(
        crypto.randomUUID(),
        owner,
        projectId,
        reviewId,
        JSON.stringify(settings),
        at,
        at,
      )
      .run();
  } else {
    if (existing.state !== 'planned')
      fail('Sniper Guard settings are locked once it starts watching.');
    if (revision !== existing.revision)
      fail('Sniper Guard changed elsewhere. Reload it before saving.');
    const result = await db
      .prepare(
        "UPDATE sniper_guards SET settings=?,revision=revision+1,updated_at=? WHERE owner_id=? AND review_id=? AND revision=? AND state='planned'",
      )
      .bind(JSON.stringify(settings), at, owner, reviewId, revision)
      .run();
    if (!result.meta.changes)
      fail('Sniper Guard changed elsewhere. Reload it before saving.');
  }
  return view((await readRow(db, owner, reviewId))!);
}

/** Starts watching. The bonding curve is read from its first transaction. */
export async function armSniperGuard(
  db: D1Database,
  owner: string,
  reviewId: string,
  revision: number,
  now = new Date(),
  readLaunch: SniperGuardLaunchReader = readSniperGuardLaunch,
) {
  const row = await readRow(db, owner, reviewId);
  if (!row) return fail('Save Sniper Guard settings before arming it.', 404);
  if (row.state !== 'planned' || row.revision !== revision)
    return fail('Sniper Guard changed elsewhere. Reload it.');
  const { launch, launchState } = await readLaunch(db, owner, reviewId);
  if (launchState === 'failed' || launchState === 'cancelled')
    fail(
      'This launch was cancelled or failed. Sniper Guard has nothing to watch.',
    );
  const at = now.toISOString();
  const observation: SniperGuardObservation = {
    cursor: null,
    buys: [],
    coverage: 'complete',
    pendingTransactions: false,
    observedAt: at,
    launchState,
    evaluation: evaluateSniperGuard({
      settings: parseSniperGuardSettings(JSON.parse(row.settings)),
      launch,
      ownedWallets: [],
      buys: [],
      armedAtMs: now.getTime(),
      nowMs: now.getTime(),
      launchBuysComplete: false,
    }),
    endReason: null,
    balances: null,
    stoppedSequences: [],
  };
  const result = await db
    .prepare(
      "UPDATE sniper_guards SET state='watching',launch=?,observation=?,armed_at=?,revision=revision+1,updated_at=? WHERE owner_id=? AND review_id=? AND revision=? AND state='planned'",
    )
    .bind(
      JSON.stringify(launch),
      JSON.stringify(observation),
      at,
      at,
      owner,
      reviewId,
      revision,
    )
    .run();
  if (!result.meta.changes) fail('Sniper Guard changed elsewhere. Reload it.');
  return view((await readRow(db, owner, reviewId))!);
}

export async function stopSniperGuard(
  db: D1Database,
  owner: string,
  reviewId: string,
  revision: number,
  now = new Date(),
) {
  const at = now.toISOString();
  const result = await db
    .prepare(
      "UPDATE sniper_guards SET state='stopped',finished_at=?,revision=revision+1,updated_at=? WHERE owner_id=? AND review_id=? AND revision=? AND state IN ('planned','watching')",
    )
    .bind(at, at, owner, reviewId, revision)
    .run();
  if (!result.meta.changes)
    fail('Sniper Guard already finished or changed elsewhere. Reload it.');
  return view((await readRow(db, owner, reviewId))!);
}

async function activeOrganicSequences(
  db: D1Database,
  owner: string,
  reviewId: string,
) {
  const { results } = await db
    .prepare(
      "SELECT id FROM pump_organic_sequences WHERE owner_id=? AND launch_review_id=? AND state='active' ORDER BY created_at",
    )
    .bind(owner, reviewId)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

async function ownedWallets(db: D1Database, owner: string) {
  const { results } = await db
    .prepare(
      "SELECT address FROM wallet_ownership_proofs WHERE owner_id=? AND chain='Solana'",
    )
    .bind(owner)
    .all<{ address: string }>();
  return results.map((r) => r.address);
}

/**
 * One read-only poll: collects new curve buys, re-evaluates every buy seen
 * since arming and records the state. A trigger only prepares the Nuke list
 * with token balances; nothing is signed or sent.
 */
export async function observeSniperGuard(
  db: D1Database,
  owner: string,
  reviewId: string,
  revision: number,
  rpc: SniperGuardRpc,
  signal: AbortSignal,
  now: () => Date = () => new Date(),
  readLaunchState: SniperGuardLaunchStateReader = readSniperGuardLaunchState,
  stopSequence: (
    db: D1Database,
    owner: string,
    id: string,
  ) => Promise<unknown> = stopPumpOrganicSequence,
) {
  const row = await readRow(db, owner, reviewId);
  if (!row) return fail('Sniper Guard not found.', 404);
  if (row.revision !== revision)
    return fail('Sniper Guard changed elsewhere. Reload it.');
  if (row.state !== 'watching') return fail('Sniper Guard is not watching.');
  const settings = parseSniperGuardSettings(JSON.parse(row.settings));
  const launch = JSON.parse(row.launch!) as SniperGuardLaunch;
  const prior = JSON.parse(row.observation!) as SniperGuardObservation;
  const launchState = await readLaunchState(db, owner, reviewId);
  const read = await readCurveBuys(rpc, launch, prior.cursor, signal);
  const known = new Set(prior.buys.map((b) => b.signature));
  const buys = [
    ...prior.buys,
    ...read.buys.filter((b) => !known.has(b.signature)),
  ];
  const coverage =
    prior.coverage === 'partial' || (!read.complete && !read.pending)
      ? 'partial'
      : 'complete';
  const at = now();
  const evaluation = evaluateSniperGuard({
    settings,
    launch,
    ownedWallets: await ownedWallets(db, owner),
    buys,
    armedAtMs: Date.parse(row.armed_at!),
    nowMs: at.getTime(),
    // Staged (Organic/Stagger) holder buys keep the launch open until every
    // sequence for it has completed or stopped.
    launchBuysComplete:
      ENDED_LAUNCH.has(launchState) &&
      !(await activeOrganicSequences(db, owner, reviewId)).length,
  });
  const overCapacity = buys.length > SNIPER_GUARD_STORED_BUYS;
  let state: SniperGuardState = 'watching',
    endReason: SniperGuardObservation['endReason'] = null,
    balances: SniperGuardBalance[] | null = null;
  const stoppedSequences: string[] = [];
  if (evaluation.triggered) {
    state = 'triggered';
    const response = sniperGuardActions(settings, launch);
    // Complete Early: stop sending this launch's remaining staged holder buys.
    // Stopping only refuses future sends of the user's own signed buys; it
    // never signs or sends anything.
    if (response.stopRemainingBuys)
      for (const id of await activeOrganicSequences(db, owner, reviewId)) {
        await stopSequence(db, owner, id);
        stoppedSequences.push(id);
      }
    const sell = response.sellWallets;
    try {
      balances = await readLaunchTokenBalances(rpc, launch.mint, sell, signal);
    } catch {
      balances = null;
    }
  } else if (evaluation.ended) {
    state = 'ended';
    endReason = evaluation.endReason;
  } else if (overCapacity) {
    state = 'ended';
    endReason = 'capacity';
  }
  const observation: SniperGuardObservation = {
    cursor: read.cursor,
    buys: buys.slice(-SNIPER_GUARD_STORED_BUYS),
    coverage: overCapacity ? 'partial' : coverage,
    pendingTransactions: read.pending,
    observedAt: at.toISOString(),
    launchState,
    evaluation,
    endReason,
    balances,
    stoppedSequences,
  };
  const stamp = at.toISOString();
  const result = await db
    .prepare(
      'UPDATE sniper_guards SET state=?,observation=?,finished_at=?,revision=revision+1,updated_at=? WHERE owner_id=? AND review_id=? AND revision=? AND state=?',
    )
    .bind(
      state,
      JSON.stringify(observation),
      state === 'watching' ? null : stamp,
      stamp,
      owner,
      reviewId,
      revision,
      'watching',
    )
    .run();
  if (!result.meta.changes) fail('Sniper Guard changed elsewhere. Reload it.');
  return view((await readRow(db, owner, reviewId))!);
}
