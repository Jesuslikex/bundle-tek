import { PumpPreflightError } from './owned-pump-preflight';
import {
  decodePumpSigningInput,
  type PumpSigningInput,
} from './pump-launch-signing';
import { pumpCreateAddresses } from './pump-launch-message';
import { decodePumpLaunchConfig } from './pump-launch-config';
import { decodePumpInitialBuyState } from './pump-initial-buy-state';
import {
  pumpAccountBytes,
  pumpRpcAccount,
  pumpUnsignedInteger,
  type PumpLaunchRpc,
} from './pump-launch-simulation';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import {
  planPumpOrganicSequence,
  type PumpOrganicMode,
} from './pump-organic-sequence';
import { buildPumpOrganicBuyMessage } from './pump-organic-buy-message';
import { simulatePumpOrganicBuy } from './pump-organic-buy-simulation';
import { createPumpOrganicBatchReview } from './pump-organic-batch';
import {
  readPumpOrganicSequence,
  savePumpOrganicBatch,
  savePumpOrganicSequence,
} from './pump-organic-service';

const FEE_CONFIG = '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt';
/** Signed packets must be sent well inside the ~60s blockhash lifetime. */
const BATCH_LIFETIME_MS = 55_000;
const fail = (message: string, status = 409): never => {
  throw new PumpPreflightError(message, status);
};

export type PumpOrganicPlanTerms = {
  launchReviewId: string;
  mode: PumpOrganicMode;
  buys: { address: string; tokenAmountRaw: string }[];
  delayMinMs: number;
  delayMaxMs: number;
  slippageBps: number;
  rentAllowanceRaw: string;
};

/** Finalized owned launch whose created token the holder buys will target. */
async function readFinalizedLaunch(db: D1Database, owner: string, id: string) {
  const row = await db
    .prepare(
      "SELECT project_id,review FROM pump_launch_reviews WHERE owner_id=? AND id=? AND state='finalized'",
    )
    .bind(owner, id)
    .first<{ project_id: string; review: string }>();
  if (!row)
    return fail(
      'Choose a finalized launch of yours; holder buys start after the token exists.',
      404,
    );
  const review = JSON.parse(row.review) as {
    input?: PumpSigningInput & { create?: PumpSigningInput };
  };
  const encoded = review.input?.create ?? review.input;
  if (!encoded?.mint) return fail('Launch review has no create identity.');
  return { projectId: row.project_id, create: decodePumpSigningInput(encoded) };
}

async function requireOwnedHolders(
  db: D1Database,
  owner: string,
  addresses: string[],
) {
  for (const address of addresses) {
    const ok = await db
      .prepare(
        "SELECT 1 AS ok FROM workspace_wallets w WHERE w.owner_id=? AND w.chain='Solana' AND w.address=? AND w.archived=0 AND EXISTS(SELECT 1 FROM wallet_ownership_proofs o WHERE o.owner_id=w.owner_id AND o.chain='Solana' AND o.address=w.address)",
      )
      .bind(owner, address)
      .first<{ ok: number }>();
    if (!ok)
      fail('Every holder must be one of your verified Solana wallets.', 400);
  }
}

/** Reads the live curve and fee config, plans the schedule and saves it. */
export async function planOwnedPumpOrganicSequence(
  db: D1Database,
  owner: string,
  supplied: PumpOrganicPlanTerms,
  signal: AbortSignal,
  rpc: PumpLaunchRpc,
) {
  const terms = structuredClone(supplied);
  const launch = await readFinalizedLaunch(db, owner, terms.launchReviewId);
  if (terms.buys.some((b) => b.address === launch.create.payer))
    fail('The deployer cannot be an organic holder.', 400);
  await requireOwnedHolders(
    db,
    owner,
    terms.buys.map((b) => b.address),
  );
  if ((await rpc('getGenesisHash', [], signal)) !== SOLANA_MAINNET_GENESIS)
    fail('Organic holder buys require Solana mainnet.');
  const { bondingCurve } = await pumpCreateAddresses(launch.create.mint);
  const result = (await rpc(
    'getMultipleAccounts',
    [
      [String(bondingCurve), FEE_CONFIG],
      { encoding: 'base64', commitment: 'confirmed' },
    ],
    signal,
  )) as { value?: unknown[] };
  if (!Array.isArray(result?.value) || result.value.length !== 2)
    return fail('Curve and fee configuration are unavailable.');
  const [curveAccount, feeAccount] = result.value.map(pumpRpcAccount);
  if (!curveAccount || !feeAccount)
    return fail('The token curve is not live yet.');
  const curve = decodePumpLaunchConfig(
    'BondingCurve',
    pumpAccountBytes(curveAccount),
  ) as Record<string, unknown>;
  if (curve.complete !== false)
    fail('The curve has completed; organic curve buys no longer apply.');
  const plan = planPumpOrganicSequence({
    mode: terms.mode,
    buys: terms.buys,
    delayMinMs: terms.delayMinMs,
    delayMaxMs: terms.delayMaxMs,
    slippageBps: terms.slippageBps,
    quoteMint: launch.create.quoteMint,
    curve: {
      virtualTokensRaw: String(curve.virtual_token_reserves),
      virtualQuoteRaw: String(curve.virtual_quote_reserves),
      realTokensRaw: String(curve.real_token_reserves),
    },
    feeConfig: decodePumpInitialBuyState(
      'FeeConfig',
      pumpAccountBytes(feeAccount),
    ),
  });
  return savePumpOrganicSequence(db, owner, {
    projectId: launch.projectId,
    launchReviewId: terms.launchReviewId,
    mint: launch.create.mint,
    rentAllowanceRaw: terms.rentAllowanceRaw,
    plan,
  });
}

/**
 * Builds and freshly simulates every buy of one batch with a new shared
 * lifetime, then saves the hash-bound review for explicit approval.
 */
export async function preparePumpOrganicBatch(
  db: D1Database,
  owner: string,
  sequenceId: string,
  batch: number,
  signal: AbortSignal,
  rpc: PumpLaunchRpc,
) {
  const sequence = await readPumpOrganicSequence(db, owner, sequenceId);
  if (sequence.state !== 'active') fail('This organic sequence was stopped.');
  const launch = await readFinalizedLaunch(
    db,
    owner,
    sequence.launch_review_id,
  );
  const plan = JSON.parse(sequence.plan) as ReturnType<
    typeof planPumpOrganicSequence
  >;
  const rows = plan.rows.filter((r) => r.batch === batch);
  if (!rows.length) return fail('That organic batch does not exist.', 404);
  const previous = await db
    .prepare(
      "SELECT 1 AS open FROM pump_organic_batches WHERE owner_id=? AND sequence_id=? AND batch<? AND state IN ('review','signed')",
    )
    .bind(owner, sequenceId, batch)
    .first<{ open: number }>();
  if (previous) fail('Finish or close the earlier batch first.');
  const latest = (await rpc(
    'getLatestBlockhash',
    [{ commitment: 'confirmed' }],
    signal,
  )) as { value?: { blockhash?: string; lastValidBlockHeight?: unknown } };
  const blockhash = latest?.value?.blockhash;
  if (typeof blockhash !== 'string')
    return fail('A fresh blockhash is unavailable.');
  const lastValidBlockHeight = pumpUnsignedInteger(
    String(latest.value!.lastValidBlockHeight),
  );
  const expiresAt = new Date(Date.now() + BATCH_LIFETIME_MS).toISOString();
  const buys = [];
  for (const row of rows) {
    const input = {
      create: launch.create,
      holder: row.address,
      tokenAmountRaw: row.tokenAmountRaw,
      maximumQuoteCostRaw: row.maximumQuoteCostRaw,
      blockhash,
      lastValidBlockHeight,
    };
    const packet = await buildPumpOrganicBuyMessage(input);
    await simulatePumpOrganicBuy(
      input,
      { rentAllowanceRaw: sequence.rent_allowance_raw },
      rpc,
      signal,
    );
    buys.push({
      index: row.index,
      holder: row.address,
      batchOffsetMs: row.batchOffsetMs,
      tokenAmountRaw: row.tokenAmountRaw,
      maximumQuoteCostRaw: row.maximumQuoteCostRaw,
      transaction: packet.transaction,
      packetSha256: packet.packetSha256,
    });
  }
  const review = await createPumpOrganicBatchReview({
    id: crypto.randomUUID(),
    sequenceId,
    batch,
    mint: launch.create.mint,
    quoteMint: launch.create.quoteMint,
    buys,
    lastValidBlockHeight: lastValidBlockHeight.toString(),
    expiresAt,
  });
  await savePumpOrganicBatch(db, owner, review);
  return review;
}
