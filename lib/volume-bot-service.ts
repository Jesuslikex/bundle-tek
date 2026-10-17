import type { SolanaSwapPreparation } from './warmup-swap-quote';
import { WRAPPED_SOL } from './warmup-swap-quote';
import type { ImportedTokenDocument } from './imported-token-project';
import {
  createVolumeBatchReview,
  requireVolumeBatchConsent,
  verifyVolumeBatchSigned,
  type VolumeBatchConsent,
  type VolumeBatchReview,
  type VolumeBatchTrade,
} from './volume-bot-batch';
import {
  planVolumeSession,
  type VolumePlan,
  type VolumeTerms,
} from './volume-bot-plan';

export class VolumeBotError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
const fail = (message: string, status = 409): never => {
  throw new VolumeBotError(message, status);
};
export type VolumeRpc = (
  method: string,
  params: unknown[],
  signal: AbortSignal,
) => Promise<unknown>;
export type VolumeDeps = {
  rpc: VolumeRpc;
  /** Wallet-bound unsigned Jupiter order for one exact input amount. */
  prepareSwap: (
    input: {
      tokenMint: string;
      side: 'Buy' | 'Sell';
      amount: string;
      decimals: number;
      wallet: string;
    },
    signal: AbortSignal,
  ) => Promise<SolanaSwapPreparation>;
  /** Unsigned simulation of the exact order; throws if it would fail. */
  simulate: (order: SolanaSwapPreparation, signal: AbortSignal) => Promise<unknown>;
};

/** How long a prepared batch stays signable and sendable: inside one blockhash window. */
export const VOLUME_BATCH_LIFETIME_MS = 60_000;
const EXPIRY_MARGIN_BLOCKS = 32n;
const OPEN = ['signed', 'submitting', 'submitted'];

const sha = async (value: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
const unsigned = (value: unknown) => {
  if (
    (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) &&
    (typeof value !== 'string' || !/^\d{1,20}$/.test(value))
  )
    fail('Provider returned an invalid integer.', 502);
  return BigInt(value as number | string);
};
/** Exact atomic units to the decimal string the swap preparation expects. */
export function rawToDecimal(raw: bigint, decimals: number) {
  const text = raw.toString().padStart(decimals + 1, '0');
  const whole = text.slice(0, text.length - decimals),
    fraction = text.slice(text.length - decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

type SessionRow = {
  id: string;
  project_id: string;
  project_revision: number;
  mint: string;
  decimals: number;
  plan: string;
  state: string;
  created_at: string;
};
type BatchRow = {
  id: string;
  session_id: string;
  batch: number;
  review: string;
  state: string;
  expires_at: string;
};
type TradeRow = {
  batch_id: string;
  trade_index: number;
  round: number;
  side: 'Buy' | 'Sell';
  wallet: string;
  signed: string;
  signature: string;
  state: string;
  receipt: string | null;
};
type Receipt = {
  slot: number;
  err: unknown;
  feeLamports?: string;
  solDeltaLamports?: string;
  tokenDeltaRaw?: string;
};

async function ownedToken(
  db: D1Database,
  owner: string,
  projectId: string,
  revision: number,
) {
  const row = await db
    .prepare(
      "SELECT document FROM imported_token_projects WHERE owner_id=? AND id=? AND chain='Solana' AND revision=? AND archived=0",
    )
    .bind(owner, projectId, revision)
    .first<{ document: string }>();
  if (!row)
    return fail('Project changed or is unavailable. Reload its details.');
  const token = (JSON.parse(row.document) as ImportedTokenDocument).token;
  if (
    token.chain !== 'Solana' ||
    token.address === WRAPPED_SOL ||
    !Number.isSafeInteger(token.decimals)
  )
    return fail('Volume Bot needs a Solana token traded against SOL.', 400);
  return token;
}

/** Reads every selected wallet's balance from the server's provider, never from the client. */
async function observeBalances(
  db: D1Database,
  owner: string,
  terms: VolumeTerms,
  signal: AbortSignal,
  rpc: VolumeRpc,
) {
  const { results } = await db
    .prepare(
      `SELECT address FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND archived=0 AND address IN (${terms.wallets.map(() => '?').join(',')})`,
    )
    .bind(owner, ...terms.wallets)
    .all<{ address: string }>();
  if (new Set(results.map((r) => r.address)).size !== terms.wallets.length)
    fail('Choose only your own active Solana wallets.', 400);
  const balances = [];
  for (const address of terms.wallets) {
    const value = (await rpc(
      'getBalance',
      [address, { commitment: 'confirmed' }],
      signal,
    )) as { value?: unknown };
    balances.push({ address, lamports: unsigned(value?.value).toString() });
  }
  return balances;
}

/** Read-only estimate with current balances. Saves nothing. */
export async function estimateVolumeSession(
  db: D1Database,
  owner: string,
  input: {
    projectId: string;
    projectRevision: number;
    terms: VolumeTerms;
    seed: string;
  },
  signal: AbortSignal,
  rpc: VolumeRpc,
) {
  await ownedToken(db, owner, input.projectId, input.projectRevision);
  const balances = await observeBalances(db, owner, input.terms, signal, rpc);
  return { plan: planVolumeSession(input.terms, balances, input.seed), balances };
}

/** Saves the plan and reserves its wallets. The plan alone signs or sends nothing. */
export async function createVolumeSession(
  db: D1Database,
  owner: string,
  input: {
    projectId: string;
    projectRevision: number;
    terms: VolumeTerms;
    seed: string;
  },
  signal: AbortSignal,
  rpc: VolumeRpc,
) {
  const token = await ownedToken(
    db,
    owner,
    input.projectId,
    input.projectRevision,
  );
  const balances = await observeBalances(db, owner, input.terms, signal, rpc);
  const plan = planVolumeSession(input.terms, balances, input.seed);
  const text = JSON.stringify(plan),
    id = crypto.randomUUID();
  try {
    await db
      .prepare(
        "INSERT INTO volume_bot_sessions(id,owner_id,project_id,project_revision,mint,decimals,plan,plan_sha256,state) VALUES(?,?,?,?,?,?,?,?,'active')",
      )
      .bind(
        id,
        owner,
        input.projectId,
        input.projectRevision,
        token.address,
        token.decimals,
        text,
        await sha(text),
      )
      .run();
  } catch (error) {
    if (error instanceof Error && /reserved/i.test(error.message))
      fail(
        'A selected wallet is busy in another launch, swap, withdrawal or Volume Bot session.',
      );
    throw error;
  }
  return publicSession(db, owner, id);
}

async function readSession(db: D1Database, owner: string, id: string) {
  const row = await db
    .prepare(
      'SELECT id,project_id,project_revision,mint,decimals,plan,state,created_at FROM volume_bot_sessions WHERE owner_id=? AND id=?',
    )
    .bind(owner, id)
    .first<SessionRow>();
  return row ?? fail('Volume Bot session not found.', 404);
}
async function readBatches(db: D1Database, owner: string, sessionId: string) {
  const { results } = await db
    .prepare(
      'SELECT id,session_id,batch,review,state,expires_at FROM volume_bot_batches WHERE owner_id=? AND session_id=? ORDER BY batch',
    )
    .bind(owner, sessionId)
    .all<BatchRow>();
  return results;
}
async function readBatch(db: D1Database, owner: string, id: string) {
  const row = await db
    .prepare(
      'SELECT id,session_id,batch,review,state,expires_at FROM volume_bot_batches WHERE owner_id=? AND id=?',
    )
    .bind(owner, id)
    .first<BatchRow>();
  return row ?? fail('Volume batch not found.', 404);
}
async function readTrades(db: D1Database, owner: string, batchIds: string[]) {
  if (!batchIds.length) return [];
  const { results } = await db
    .prepare(
      `SELECT batch_id,trade_index,round,side,wallet,signed,signature,state,receipt FROM volume_bot_trades WHERE owner_id=? AND batch_id IN (${batchIds.map(() => '?').join(',')}) ORDER BY trade_index`,
    )
    .bind(owner, ...batchIds)
    .all<TradeRow>();
  return results;
}

/**
 * Prepares the next batch. Buys use their planned SOL amount; each sell sells
 * exactly what its own finalized buy received. A sell whose buy did not land
 * is skipped. Every trade is a fresh unsigned order and must simulate.
 */
export async function prepareVolumeBatch(
  db: D1Database,
  owner: string,
  sessionId: string,
  signal: AbortSignal,
  deps: VolumeDeps,
) {
  const session = await readSession(db, owner, sessionId);
  if (session.state !== 'active')
    return fail('This Volume Bot session is not active.');
  await ownedToken(db, owner, session.project_id, session.project_revision);
  const plan = JSON.parse(session.plan) as VolumePlan;
  // An unsigned review that expired grants nothing and can be replaced.
  await db
    .prepare(
      "DELETE FROM volume_bot_batches WHERE owner_id=? AND session_id=? AND state='review' AND expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    )
    .bind(owner, sessionId)
    .run();
  const batches = await readBatches(db, owner, sessionId);
  const number = batches.length;
  if (number >= plan.batches)
    return fail('Every planned batch is already prepared.');
  if (batches.some((b) => b.state !== 'closed'))
    return fail(
      'Wait for the previous batch to settle before preparing the next one.',
    );
  const trades = await readTrades(
    db,
    owner,
    batches.map((b) => b.id),
  );
  const events = plan.events.filter((e) => e.batch === number);
  const prepared: VolumeBatchTrade[] = [],
    skipped: number[] = [];
  for (const event of events) {
    signal.throwIfAborted();
    let amount: string;
    if (event.side === 'Buy') {
      const round = plan.rounds[event.round];
      if (round?.wallet !== event.wallet)
        return fail('Volume Bot plan is inconsistent.', 500);
      amount = rawToDecimal(BigInt(round.lamports), 9);
    } else {
      const buy = trades.find(
        (t) => t.round === event.round && t.side === 'Buy',
      );
      const receipt = buy?.receipt ? (JSON.parse(buy.receipt) as Receipt) : null;
      const received = BigInt(receipt?.tokenDeltaRaw ?? '0');
      if (
        !buy ||
        buy.state !== 'finalized' ||
        buy.wallet !== event.wallet ||
        received <= 0n
      ) {
        skipped.push(event.index);
        continue;
      }
      amount = rawToDecimal(received, session.decimals);
    }
    const order = await deps.prepareSwap(
      {
        tokenMint: session.mint,
        side: event.side,
        amount,
        decimals: session.decimals,
        wallet: event.wallet,
      },
      signal,
    );
    if (
      order.side !== event.side ||
      order.preparation.wallet !== event.wallet ||
      (event.side === 'Buy'
        ? order.inputMint !== WRAPPED_SOL || order.outputMint !== session.mint
        : order.inputMint !== session.mint || order.outputMint !== WRAPPED_SOL)
    )
      return fail('Swap preparation differs from the planned trade.', 502);
    await deps.simulate(order, signal);
    prepared.push({
      index: event.index,
      round: event.round,
      side: event.side,
      wallet: event.wallet,
      batchOffsetMs: event.batchOffsetMs,
      inAmountRaw: order.inAmount,
      minimumOutRaw: order.minimumOutAmount,
      estimatedFeesLamports: order.preparation.estimatedFeesLamports,
      transaction: order.preparation.transaction,
      packetSha256: order.preparation.sha256,
      lastValidBlockHeight: order.preparation.lastValidBlockHeight,
    });
  }
  await ownedToken(db, owner, session.project_id, session.project_revision);
  const review = await createVolumeBatchReview({
    id: crypto.randomUUID(),
    sessionId,
    batch: number,
    mint: session.mint,
    decimals: session.decimals,
    trades: prepared,
    skipped,
    expiresAt: new Date(Date.now() + VOLUME_BATCH_LIFETIME_MS).toISOString(),
  });
  await db
    .prepare(
      'INSERT INTO volume_bot_batches(id,owner_id,session_id,batch,review,review_sha256,state,expires_at) VALUES(?,?,?,?,?,?,?,?)',
    )
    .bind(
      review.id,
      owner,
      sessionId,
      number,
      JSON.stringify(review),
      review.sha256,
      prepared.length ? 'review' : 'closed',
      review.expiresAt,
    )
    .run();
  if (!prepared.length) await completeIfDone(db, owner, sessionId);
  return publicSession(db, owner, sessionId);
}

/** Records exact consent and every verified signature at once. Never signs. */
export async function registerVolumeBatch(
  db: D1Database,
  owner: string,
  batchId: string,
  supplied: { consent: VolumeBatchConsent; transactions: string[] },
) {
  const row = await readBatch(db, owner, batchId);
  const review = JSON.parse(row.review) as VolumeBatchReview;
  try {
    requireVolumeBatchConsent(review, supplied.consent);
  } catch {
    return fail('Approve this exact volume batch before registering it.', 400);
  }
  if (row.state === 'signed') return publicSession(db, owner, row.session_id);
  if (row.state !== 'review') return fail('Volume batch is no longer open.');
  if (Date.parse(row.expires_at) <= Date.now())
    return fail('Volume batch expired. Prepare it again.');
  const signatures = await verifyVolumeBatchSigned(
    review,
    supplied.transactions,
  );
  const results = await db.batch([
    db
      .prepare(
        "UPDATE volume_bot_batches SET state='signed',consent=? WHERE owner_id=? AND id=? AND state='review' AND review_sha256=?",
      )
      .bind(JSON.stringify(supplied.consent), owner, batchId, review.sha256),
    ...review.trades.map((trade, n) =>
      db
        .prepare(
          "INSERT INTO volume_bot_trades(owner_id,batch_id,trade_index,round,side,wallet,signed,signature,state) VALUES(?,?,?,?,?,?,?,?,'signed')",
        )
        .bind(
          owner,
          batchId,
          trade.index,
          trade.round,
          trade.side,
          trade.wallet,
          supplied.transactions[n],
          signatures[n],
        ),
    ),
  ]);
  if (!results[0].meta.changes)
    return fail('Volume batch changed while registering.');
  return publicSession(db, owner, row.session_id);
}

/**
 * One-attempt send of one signed trade. State moves to submitting before the
 * only provider call, so a lost response can never be resent.
 */
export async function sendVolumeTrade(
  db: D1Database,
  owner: string,
  batchId: string,
  index: number,
  signal: AbortSignal,
  rpc: VolumeRpc,
) {
  const row = await readBatch(db, owner, batchId);
  const trade = (await readTrades(db, owner, [batchId])).find(
    (t) => t.trade_index === index,
  );
  if (!trade) return fail('Volume trade not found.', 404);
  if (trade.state !== 'signed') return publicSession(db, owner, row.session_id);
  const claimed = await db
    .prepare(
      "UPDATE volume_bot_trades SET state='submitting',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=? AND batch_id=? AND trade_index=? AND state='signed'",
    )
    .bind(owner, batchId, index)
    .run()
    .catch(() => fail('Volume batch is cancelled, expired or not signed.'));
  if (!claimed.meta.changes) return publicSession(db, owner, row.session_id);
  try {
    signal.throwIfAborted();
    const signature = await rpc(
      'sendTransaction',
      [
        trade.signed,
        {
          encoding: 'base64',
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 0,
        },
      ],
      signal,
    );
    if (signature === trade.signature)
      await db
        .prepare(
          "UPDATE volume_bot_trades SET state='submitted',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=? AND batch_id=? AND trade_index=? AND state='submitting'",
        )
        .bind(owner, batchId, index)
        .run();
  } catch {
    // Unknown outcome stays submitting; only observation can settle it.
  }
  return publicSession(db, owner, row.session_id);
}

/** Cancel: stops future batches. Signed-but-unsent trades are cancelled and expire on chain. */
export async function cancelVolumeSession(
  db: D1Database,
  owner: string,
  sessionId: string,
) {
  await readSession(db, owner, sessionId);
  await db.batch([
    db
      .prepare(
        "UPDATE volume_bot_sessions SET state='cancelled' WHERE owner_id=? AND id=? AND state='active'",
      )
      .bind(owner, sessionId),
    db
      .prepare(
        "UPDATE volume_bot_trades SET state='cancelled',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=? AND state='signed' AND batch_id IN (SELECT id FROM volume_bot_batches WHERE owner_id=? AND session_id=?)",
      )
      .bind(owner, owner, sessionId),
    db
      .prepare(
        "UPDATE volume_bot_batches SET state='cancelled' WHERE owner_id=? AND session_id=? AND state='review'",
      )
      .bind(owner, sessionId),
  ]);
  return publicSession(db, owner, sessionId);
}

/** Exact wallet SOL and token change from a finalized transaction. */
function settlement(
  tx: unknown,
  wallet: string,
  mint: string,
): Omit<Receipt, 'slot' | 'err'> {
  const value = tx as {
    meta?: {
      fee?: unknown;
      preBalances?: unknown[];
      postBalances?: unknown[];
      preTokenBalances?: { owner?: string; mint?: string; uiTokenAmount?: { amount?: string } }[];
      postTokenBalances?: { owner?: string; mint?: string; uiTokenAmount?: { amount?: string } }[];
    };
    transaction?: { message?: { accountKeys?: unknown[] } };
  };
  const meta = value?.meta;
  const keys = value?.transaction?.message?.accountKeys;
  if (!meta || !Array.isArray(keys) || String(keys[0]) !== wallet)
    return fail('Finalized volume trade does not match its wallet.', 502);
  const tokens = (list: typeof meta.preTokenBalances) =>
    (list ?? [])
      .filter((b) => b.owner === wallet && b.mint === mint)
      .reduce((sum, b) => sum + unsigned(b.uiTokenAmount?.amount), 0n);
  return {
    feeLamports: unsigned(meta.fee).toString(),
    solDeltaLamports: (
      unsigned(meta.postBalances?.[0]) - unsigned(meta.preBalances?.[0])
    ).toString(),
    tokenDeltaRaw: (
      tokens(meta.postTokenBalances) - tokens(meta.preTokenBalances)
    ).toString(),
  };
}

async function completeIfDone(db: D1Database, owner: string, sessionId: string) {
  await db
    .prepare(
      "UPDATE volume_bot_sessions SET state='complete' WHERE owner_id=? AND id=? AND state='active' AND json_extract(plan,'$.batches')=(SELECT count(*) FROM volume_bot_batches b WHERE b.session_id=volume_bot_sessions.id AND b.state='closed')",
    )
    .bind(owner, sessionId)
    .run();
}

/**
 * Read-only settlement. Finalized statuses settle trades with their exact
 * wallet changes; anything unseen after its lifetime plus 32 blocks expires.
 */
export async function observeVolumeBatch(
  db: D1Database,
  owner: string,
  batchId: string,
  signal: AbortSignal,
  rpc: VolumeRpc,
) {
  const batch = await readBatch(db, owner, batchId);
  const review = JSON.parse(batch.review) as VolumeBatchReview;
  const open = (await readTrades(db, owner, [batchId])).filter((t) =>
    OPEN.includes(t.state),
  );
  if (open.length) {
    const statuses = (await rpc(
      'getSignatureStatuses',
      [open.map((t) => t.signature), { searchTransactionHistory: true }],
      signal,
    )) as { value?: unknown[] };
    if (!Array.isArray(statuses?.value) || statuses.value.length !== open.length)
      return fail('Volume trade status mapping differs.', 502);
    const height = unsigned(
      await rpc('getBlockHeight', [{ commitment: 'finalized' }], signal),
    );
    for (const [n, trade] of open.entries()) {
      const status = statuses.value[n] as {
        slot?: number;
        err?: unknown;
        confirmationStatus?: string;
      } | null;
      const reviewed = review.trades.find((t) => t.index === trade.trade_index);
      let next: string | undefined, receipt: unknown;
      if (status?.confirmationStatus === 'finalized') {
        const tx = await rpc(
          'getTransaction',
          [
            trade.signature,
            {
              encoding: 'json',
              commitment: 'finalized',
              maxSupportedTransactionVersion: 0,
            },
          ],
          signal,
        );
        if (!tx) continue;
        next = status.err === null ? 'finalized' : 'failed';
        receipt = {
          slot: status.slot,
          err: status.err ?? null,
          ...settlement(tx, trade.wallet, review.mint),
        };
      } else if (
        !status &&
        reviewed &&
        height > BigInt(reviewed.lastValidBlockHeight) + EXPIRY_MARGIN_BLOCKS
      ) {
        next = 'expired';
        receipt = { finalizedBlockHeight: height.toString(), marginBlocks: 32 };
      }
      if (next)
        await db
          .prepare(
            "UPDATE volume_bot_trades SET state=?,receipt=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=? AND batch_id=? AND trade_index=? AND state=?",
          )
          .bind(
            next,
            JSON.stringify(receipt),
            owner,
            batchId,
            trade.trade_index,
            trade.state,
          )
          .run();
    }
  }
  const remaining = (await readTrades(db, owner, [batchId])).some((t) =>
    OPEN.includes(t.state),
  );
  if (!remaining)
    await db
      .prepare(
        "UPDATE volume_bot_batches SET state='closed' WHERE owner_id=? AND id=? AND state='signed'",
      )
      .bind(owner, batchId)
      .run();
  await completeIfDone(db, owner, batch.session_id);
  return publicSession(db, owner, batch.session_id);
}

/** One session with its plan, every batch and trade, and realized totals. */
export async function publicSession(db: D1Database, owner: string, id: string) {
  const session = await readSession(db, owner, id);
  const plan = JSON.parse(session.plan) as VolumePlan;
  const batches = await readBatches(db, owner, id);
  const trades = await readTrades(
    db,
    owner,
    batches.map((b) => b.id),
  );
  const reviews = new Map(
    batches.map((b) => [b.id, JSON.parse(b.review) as VolumeBatchReview]),
  );
  let volume = 0n,
    net = 0n,
    finalized = 0;
  for (const trade of trades) {
    if (trade.state !== 'finalized' || !trade.receipt) continue;
    const receipt = JSON.parse(trade.receipt) as Receipt;
    const delta = BigInt(receipt.solDeltaLamports ?? '0'),
      fee = BigInt(receipt.feeLamports ?? '0');
    // Buys count their exact SOL input; sells count SOL received before the network fee.
    volume +=
      trade.side === 'Buy'
        ? BigInt(
            reviews
              .get(trade.batch_id)
              ?.trades.find((t) => t.index === trade.trade_index)
              ?.inAmountRaw ?? '0',
          )
        : delta + fee;
    net += delta;
    finalized++;
  }
  return {
    id: session.id,
    projectId: session.project_id,
    projectRevision: session.project_revision,
    mint: session.mint,
    decimals: session.decimals,
    state: session.state,
    createdAt: session.created_at,
    plan,
    realized: {
      finalizedTrades: finalized,
      volumeLamports: volume.toString(),
      netSolLamports: net.toString(),
    },
    batches: batches.map((b) => {
      const review = reviews.get(b.id)!;
      return {
        id: b.id,
        batch: b.batch,
        state: b.state,
        expiresAt: b.expires_at,
        review,
        trades: trades
          .filter((t) => t.batch_id === b.id)
          .map((t) => ({
            index: t.trade_index,
            round: t.round,
            side: t.side,
            wallet: t.wallet,
            signature: t.signature,
            state: t.state,
            receipt: t.receipt ? (JSON.parse(t.receipt) as Receipt) : null,
            batchOffsetMs:
              review.trades.find((r) => r.index === t.trade_index)
                ?.batchOffsetMs ?? 0,
          })),
      };
    }),
    signingAllowed: false as const,
  };
}

export async function listVolumeSessions(
  db: D1Database,
  owner: string,
  projectId: string,
) {
  const { results } = await db
    .prepare(
      'SELECT id FROM volume_bot_sessions WHERE owner_id=? AND project_id=? ORDER BY created_at DESC LIMIT 10',
    )
    .bind(owner, projectId)
    .all<{ id: string }>();
  return Promise.all(results.map((r) => publicSession(db, owner, r.id)));
}
