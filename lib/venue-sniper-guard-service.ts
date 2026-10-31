import { readVenueLaunchRecovery } from './venue-launch-recovery';
import { stonkLaunchAddresses } from './stonkfun-launch';
import { dbcPoolAddress, dbcTokenVault } from './meteora-dbc-launch';
import type { LaunchLabReview } from './launchlab-launch-service';
import type { StonkLaunchReview } from './stonkfun-launch-service';
import type { MeteoraDbcReview } from './meteora-dbc-launch-service';
import { readCurveBuys, type SniperGuardRpc } from './sniper-guard-chain';
import type {
  VenueSniperLaunch,
  VenueSniperRead,
  VenueSniperVenue,
} from './venue-sniper-guard';

export class VenueSniperError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
const fail = (message: string, status = 409): never => {
  throw new VenueSniperError(message, status);
};
/** Launches whose coin may already trade: the transaction was sent or finalized. */
const WATCHABLE = new Set(['submitting', 'submitted', 'finalized']);

/**
 * Launch identity from the owned saved launch, never from the client. The pool
 * and its quote vault are re-derived from the reviewed mint, quote and config,
 * and must match the pool the user reviewed.
 */
export async function readVenueSniperLaunch(
  db: D1Database,
  owner: string,
  venue: VenueSniperVenue,
  id: string,
): Promise<VenueSniperLaunch> {
  const record = await readVenueLaunchRecovery(db, owner, venue, id);
  if (!WATCHABLE.has(record.state))
    fail('Sniper Guard watches a launch once it has been broadcast.');
  let pool: string, quoteVault: string;
  const review = record.review as
    | LaunchLabReview
    | StonkLaunchReview
    | MeteoraDbcReview;
  const { mint, quoteMint, payer } = review.input;
  if (venue === 'meteora-dbc') {
    const input = (review as MeteoraDbcReview).input;
    pool = String(await dbcPoolAddress(input.config, mint, quoteMint));
    quoteVault = String(await dbcTokenVault(pool, quoteMint));
  } else {
    const input = (review as LaunchLabReview | StonkLaunchReview).input;
    const addresses = await stonkLaunchAddresses(
      mint,
      quoteMint,
      input.platformId,
      payer,
    );
    pool = String(addresses.pool);
    quoteVault = String(addresses.vaultB);
  }
  if (pool !== review.summary.pool)
    fail('Saved launch pool differs from its reviewed token.');
  const wallet = await db
    .prepare(
      "SELECT revision FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND address=? AND archived=0",
    )
    .bind(owner, payer)
    .first<{ revision: number }>();
  // Cleanup sells need a saved destination other than the seller for their
  // later sweep step; the sell itself keeps its SOL in the developer wallet.
  const other = await db
    .prepare(
      "SELECT address FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND archived=0 AND address<>? ORDER BY address LIMIT 1",
    )
    .bind(owner, payer)
    .first<{ address: string }>();
  return {
    venue,
    id: record.id,
    state: record.state,
    mint,
    pool,
    quoteVault,
    quoteMint,
    quoteSymbol: review.summary.quoteSymbol,
    quoteDecimals: review.summary.quoteDecimals,
    developer: payer,
    developerRevision: wallet ? wallet.revision : null,
    cleanupDestination: other ? other.address : null,
    signature: record.signature,
  };
}

async function ownedWallets(db: D1Database, owner: string) {
  const { results } = await db
    .prepare(
      "SELECT address FROM wallet_ownership_proofs WHERE owner_id=? AND chain='Solana'",
    )
    .bind(owner)
    .all<{ address: string }>();
  return new Set(results.map((r) => r.address));
}

/**
 * One read-only poll of the pool's quote vault from `cursor`. Buys signed by
 * the developer or any wallet the user proved ownership of are only counted,
 * never returned, so the browser sums outside buys alone.
 */
export async function observeVenueSniper(
  db: D1Database,
  owner: string,
  launch: VenueSniperLaunch,
  cursor: string | null,
  rpc: SniperGuardRpc,
  signal: AbortSignal,
): Promise<VenueSniperRead> {
  const read = await readCurveBuys(
    rpc,
    {
      bondingCurve: launch.pool,
      quoteMint: launch.quoteMint,
      quoteVault: launch.quoteVault,
    },
    cursor,
    signal,
  );
  const owned = await ownedWallets(db, owner);
  owned.add(launch.developer);
  const buys = read.buys.filter((b) => !b.signers.some((s) => owned.has(s)));
  return {
    buys,
    excludedCount: read.buys.length - buys.length,
    cursor: read.cursor,
    complete: read.complete,
    pending: read.pending,
  };
}
