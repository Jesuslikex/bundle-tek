import {
  preflightOwnedPumpInitialBuy,
  PumpPreflightError,
  type OwnedPumpTerms,
} from './owned-pump-preflight';
import { encodePumpSigningInput } from './pump-launch-signing';
import {
  requirePumpInitialBuySigningReview,
  type PumpInitialBuySigningReview,
} from './pump-initial-buy-signing';
import {
  pumpLaunchRpc,
  requirePumpLaunchAuthorityPolicy,
} from './pump-launch-service';
import type { PumpCreateInput } from './pump-launch-message';
import type { PumpLaunchRpc } from './pump-launch-simulation';
type Terms = OwnedPumpTerms & { maximumQuoteCostRaw: string };
type Row = {
  id: string;
  owner_id: string;
  project_document: string;
  terms: string;
  review: string;
  simulation: string;
  state: string;
};
const publicReview = (row: Row) => ({
  format: 'pump-create-buy-review-v1' as const,
  review: JSON.parse(row.review) as PumpInitialBuySigningReview,
  simulation: JSON.parse(row.simulation) as Awaited<
    ReturnType<typeof preflightOwnedPumpInitialBuy>
  >['simulation'],
  state: row.state,
  signingAllowed: false as const,
  executionAllowed: false as const,
  completeLaunch: false as const,
  containsHolderBuys: false as const,
});
const fail = (message: string, status = 409): never => {
  throw new PumpPreflightError(message, status);
};

/** Server-internal immutable review preparation. Owner must come from an authenticated session. */
export async function preparePumpInitialBuyReview(
  db: D1Database,
  owner: string,
  supplied: Terms,
  signal: AbortSignal,
  rpc: PumpLaunchRpc = pumpLaunchRpc(),
) {
  const terms = structuredClone(supplied);
  const encodedTerms = JSON.stringify(terms, Object.keys(terms).sort());
  if (
    !/^[1-9]\d{0,9}$/.test(terms.feeAndRentLimitRaw) ||
    BigInt(terms.feeAndRentLimitRaw) > 1000000000n
  )
    fail('Review a positive fee/rent allowance of at most 1 SOL.', 400);
  const saved = await db
    .prepare(
      'SELECT document,updated_at,archived FROM workspace_projects WHERE owner_id=? AND id=?',
    )
    .bind(owner, terms.projectId)
    .first<{ document: string; updated_at: string; archived: number }>();
  if (!saved || saved.archived)
    return fail('Active owned launch project not found.', 404);
  if (saved.updated_at !== terms.updatedAt)
    fail('Save and review the current launch draft.');
  const existing = await db
    .prepare(
      "SELECT * FROM pump_launch_reviews WHERE owner_id=? AND project_id=? AND state NOT IN ('cancelled','failed')",
    )
    .bind(owner, terms.projectId)
    .first<Row>();
  if (existing) {
    if (
      existing.project_document !== saved.document ||
      existing.terms !== encodedTerms
    )
      fail(
        'Another launch review reserves this project. Recover or cancel it before preparing different terms.',
      );
    return publicReview(existing);
  }
  const reserved = await db
    .prepare(`SELECT 1 AS reserved FROM solana_execution_reservations WHERE owner_id=? AND wallet_address=?
    UNION ALL SELECT 1 FROM pump_launch_reviews WHERE (owner_id=? AND payer=? AND state NOT IN ('cancelled','failed','finalized'))
    OR (mint=? AND state NOT IN ('cancelled','failed')) LIMIT 1`)
    .bind(owner, terms.payer, owner, terms.payer, terms.mint)
    .first();
  if (reserved)
    fail(
      'This payer or mint is already reserved. Recover its existing operation first.',
    );
  let input: PumpCreateInput | undefined;
  const checked = await preflightOwnedPumpInitialBuy(db, owner, terms, signal, {
    rpc,
    captureInput: (v) => {
      input = v;
    },
  });
  await requirePumpLaunchAuthorityPolicy(checked.simulation, terms.mint);
  if (!input || signal.aborted) fail('Atomic launch preparation interrupted.');
  const review: PumpInitialBuySigningReview = {
    id: crypto.randomUUID(),
    projectId: terms.projectId,
    projectUpdatedAt: terms.updatedAt,
    releaseId: terms.releaseId,
    expiresAt: checked.simulation.expiresAt,
    transaction: checked.packet.transaction,
    sha256: checked.packet.sha256,
    input: {
      create: encodePumpSigningInput(input!),
      tokenAmountRaw: checked.tokenAmountRaw,
      maximumQuoteCostRaw: terms.maximumQuoteCostRaw,
      transactionVersion: 1,
    },
    developerSupplyPercent: checked.developerSupplyPercent,
    feeAndRentLimitRaw: terms.feeAndRentLimitRaw,
  };
  await requirePumpInitialBuySigningReview(review);
  if (signal.aborted) fail('Atomic launch preparation interrupted.');
  try {
    await db
      .prepare(`INSERT INTO pump_launch_reviews(id,owner_id,project_id,payer,mint,project_document,terms,review,simulation,state,created_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,'review',?,?)`)
      .bind(
        review.id,
        owner,
        terms.projectId,
        terms.payer,
        terms.mint,
        saved.document,
        encodedTerms,
        JSON.stringify(review),
        JSON.stringify(checked.simulation),
        new Date().toISOString(),
        review.expiresAt,
      )
      .run();
  } catch {
    fail(
      'Launch context or reservation changed. Reload its saved review before retrying.',
    );
  }
  const row = await db
    .prepare('SELECT * FROM pump_launch_reviews WHERE owner_id=? AND id=?')
    .bind(owner, review.id)
    .first<Row>();
  if (!row)
    fail('Saved atomic launch review is unavailable. Reload its history.');
  return publicReview(row!);
}

/** Refresh the exact saved packet and original lifetime before a future explicit approval step. */
export async function refreshPumpInitialBuyReview(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
  rpc: PumpLaunchRpc = pumpLaunchRpc(),
) {
  const row = await db
    .prepare('SELECT * FROM pump_launch_reviews WHERE owner_id=? AND id=?')
    .bind(owner, id)
    .first<Row>();
  if (!row) return fail('Owned atomic launch review not found.', 404);
  const review = JSON.parse(row.review) as PumpInitialBuySigningReview;
  const terms = JSON.parse(row.terms) as Terms;
  await requirePumpInitialBuySigningReview(review);
  const saved = await db
    .prepare(
      'SELECT document,updated_at,archived FROM workspace_projects WHERE owner_id=? AND id=?',
    )
    .bind(owner, review.projectId)
    .first<{ document: string; updated_at: string; archived: number }>();
  if (
    !saved ||
    saved.archived ||
    saved.document !== row.project_document ||
    saved.updated_at !== terms.updatedAt
  )
    return fail('Saved atomic launch changed. Recover or cancel its review.');
  const checked = await preflightOwnedPumpInitialBuy(db, owner, terms, signal, {
    rpc,
    lifetime: {
      blockhash: review.input.create.blockhash,
      lastValidBlockHeight: review.input.create.lastValidBlockHeight,
    },
  });
  await requirePumpLaunchAuthorityPolicy(checked.simulation, terms.mint);
  const original = JSON.parse(row.simulation) as typeof checked.simulation;
  const stable = (s: typeof checked.simulation) => ({
    accounts: s.accountHashes,
    programs: s.programDeploymentHashes,
    price: s.price,
    quoteCostRaw: s.quoteCostRaw,
    feeAndRentDebitRaw: s.feeAndRentDebitRaw,
    payerDebitRaw: s.payerDebitRaw,
  });
  if (
    checked.packet.sha256 !== review.sha256 ||
    JSON.stringify(stable(checked.simulation)) !==
      JSON.stringify(stable(original)) ||
    signal.aborted
  )
    return fail(
      'Atomic launch packet, costs or observed state changed. Prepare a new review.',
    );
  return checked;
}
