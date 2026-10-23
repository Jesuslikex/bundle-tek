import { UUID } from './wallet-operation';
import { walletAddress } from './wallet-workspace';
import { decodeCounterPlan } from './counter-trade-store';
import { counterAutoBuyCandidateIdentity } from './auto-buy-counter-candidate';
import {
  autoBuyBudgetTerms,
  AUTO_BUY_BUDGET_AUTHORITY,
  AutoBuyBudgetError,
} from './auto-buy-budget';
import {
  readAutoBuyBudget,
  retainAutoBuyBudget,
} from './auto-buy-budget-store';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';

export const COUNTER_BUDGET_SAVE_ACK =
  'Save this read-only Auto Buy accounting budget. This does not authorize trades or reserve wallet funds.';
const authority = {
  approvalAllowed: false as const,
  reservationCreated: false as const,
  accountingCapacityReserved: false as const,
  ...AUTO_BUY_BUDGET_AUTHORITY,
};
export const COUNTER_BUDGET_LIMITATIONS =
  'Accounting metadata only. No provider/source qualification, trading approval, wallet-fund reservation or execution authority. Current Counter checks are optimistic, not an atomic SQL plan guard. Saved rows are permanent under the existing storage policy; pacing is not a lifetime quota.';
export type CounterBudgetSelection = {
  budgetId: string;
  projectId: string;
  projectRevision: number;
  planId: string;
  planRevision: number;
  decisionIdentity: string;
  wallet: string;
  walletRevision: number;
  maximumInputLamports: string;
  maximumFeeAndRentLamports: string;
  expiresAt: string;
};
export type CounterBudgetRequest = CounterBudgetSelection &
  (
    | { action: 'review' }
    | {
        action: 'save';
        reviewSha256: string;
        acknowledgement: typeof COUNTER_BUDGET_SAVE_ACK;
      }
  );
export class CounterBudgetError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
/** Bound refusal only before retainAutoBuyBudget has been invoked. */
export class CounterBudgetSaveRefusalError extends CounterBudgetError {
  readonly format = 'owned-counter-budget-save-refusal-v1' as const;
  readonly scope = 'current-request-only' as const;
  readonly priorSaveOutcomeVerified = false as const;
  readonly writerAttempted = false as const;
  readonly recoveryRequired = false as const;
  constructor(
    readonly originalId: string,
    readonly reviewSha256: string,
    message: string,
    status = 409,
  ) {
    super(message, status);
  }
}
/** A write may have completed. Always recover this original ID, never mint a retry ID. */
export class CounterBudgetRecoveryError extends CounterBudgetError {
  readonly format = 'owned-counter-budget-save-recovery-v1' as const;
  readonly writerAttempted = 'possible' as const;
  readonly recoveryRequired = true;
  constructor(
    readonly originalId: string,
    aborted = false,
  ) {
    super(
      'The metadata save outcome needs recovery. Read the original budget ID before another save.',
      aborted ? 408 : 409,
    );
  }
}
const selectionKeys =
  'budgetId,decisionIdentity,expiresAt,maximumFeeAndRentLamports,maximumInputLamports,planId,planRevision,projectId,projectRevision,wallet,walletRevision';
function selection(value: unknown): CounterBudgetSelection {
  const v = value as CounterBudgetSelection;
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).sort().join(',') !== selectionKeys ||
    [v.budgetId, v.projectId, v.planId].some(
      (x) => typeof x !== 'string' || !UUID.test(x),
    ) ||
    [v.projectRevision, v.planRevision, v.walletRevision].some(
      (x) => !Number.isSafeInteger(x) || x < 1 || x > 1e9,
    ) ||
    typeof v.decisionIdentity !== 'string' ||
    !v.decisionIdentity ||
    v.decisionIdentity.length > 512 ||
    typeof v.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(v.expiresAt)) ||
    new Date(v.expiresAt).toISOString() !== v.expiresAt
  )
    throw new CounterBudgetError(
      'Choose exact current Counter, wallet and budget metadata.',
      400,
    );
  try {
    walletAddress(v.wallet, 'Solana');
  } catch {
    throw new CounterBudgetError('Choose a valid Solana wallet.', 400);
  }
  return structuredClone(v);
}
export function counterBudgetRequest(value: unknown): CounterBudgetRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CounterBudgetError('JSON metadata request required.', 400);
  const { action, ...rest } = value as Record<string, unknown>;
  if (action === 'review') return { ...selection(rest), action };
  if (action === 'save') {
    const { reviewSha256, acknowledgement, ...base } = rest;
    if (
      typeof reviewSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(reviewSha256) ||
      acknowledgement !== COUNTER_BUDGET_SAVE_ACK
    )
      throw new CounterBudgetError(
        'Approve the exact reviewed metadata digest and separate save acknowledgement.',
        400,
      );
    return { ...selection(base), action, reviewSha256, acknowledgement };
  }
  throw new CounterBudgetError('Choose review or save metadata.', 400);
}
function selected(input: CounterBudgetRequest): CounterBudgetSelection {
  const {
    budgetId,
    projectId,
    projectRevision,
    planId,
    planRevision,
    decisionIdentity,
    wallet,
    walletRevision,
    maximumInputLamports,
    maximumFeeAndRentLamports,
    expiresAt,
  } = input;
  return {
    budgetId,
    projectId,
    projectRevision,
    planId,
    planRevision,
    decisionIdentity,
    wallet,
    walletRevision,
    maximumInputLamports,
    maximumFeeAndRentLamports,
    expiresAt,
  };
}
type Context = {
  project_document: string;
  mint: string;
  project_revision: number;
  plan_document: string;
  plan_revision: number;
  plan_state: string;
  wallet_revision: number;
  wallet_role: string;
  wallet_updated_at: string;
};
function contextReader(
  db: D1Database,
  owner: string,
  input: CounterBudgetSelection,
) {
  return () =>
    db
      .prepare(`SELECT p.document AS project_document,p.address AS mint,p.revision AS project_revision,c.document AS plan_document,c.revision AS plan_revision,c.state AS plan_state,w.revision AS wallet_revision,w.role AS wallet_role,w.updated_at AS wallet_updated_at
 FROM counter_trade_plans c JOIN imported_token_projects p ON p.owner_id=c.owner_id AND p.id=c.project_id JOIN workspace_wallets w ON w.owner_id=c.owner_id AND w.chain='Solana' AND w.address=?
 WHERE c.owner_id=? AND c.project_id=? AND c.id=? AND c.revision=? AND c.state='active' AND p.chain='Solana' AND p.revision=? AND p.archived=0 AND w.revision=? AND w.archived=0 AND w.role IN ('Recipient','Deployer','Funder')
 AND EXISTS(SELECT 1 FROM wallet_ownership_proofs o WHERE o.owner_id=c.owner_id AND o.chain='Solana' AND o.address=w.address)
 AND NOT EXISTS(SELECT 1 FROM wallet_ownership_proofs o WHERE o.owner_id=c.owner_id AND o.chain='Solana' AND NOT EXISTS(SELECT 1 FROM json_each(c.document,'$.rules.ignoredWallets') x WHERE x.value=o.address))`)
      .bind(
        input.wallet,
        owner,
        input.projectId,
        input.planId,
        input.planRevision,
        input.projectRevision,
        input.walletRevision,
      )
      .first<Context>();
}
async function derive(
  db: D1Database,
  owner: string,
  input: CounterBudgetSelection,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (
    Date.parse(input.expiresAt) <= Date.now() ||
    Date.parse(input.expiresAt) > Date.now() + 31 * 86400000
  )
    throw new CounterBudgetError(
      'Choose an original future expiry within 31 days.',
      400,
    );
  const read = contextReader(db, owner, input),
    context = await read();
  signal.throwIfAborted();
  if (!context)
    throw new CounterBudgetError(
      'Current owned Counter proposal, proven wallet or exclusions changed. Review metadata again.',
    );
  let plan: ReturnType<typeof decodeCounterPlan>;
  try {
    plan = decodeCounterPlan(JSON.parse(context.plan_document));
  } catch {
    throw new CounterBudgetError('Saved Counter plan is unavailable.');
  }
  const token = JSON.parse(context.project_document)?.token;
  const decision = plan.ledger.decisions.find(
    (d) => d.identity === input.decisionIdentity,
  );
  if (
    plan.id !== input.planId ||
    plan.projectId !== input.projectId ||
    plan.revision !== context.plan_revision ||
    plan.state !== context.plan_state ||
    plan.rules.responseSide !== 'Buy' ||
    plan.projectDocument !== context.project_document ||
    plan.ledger.scope.revision !== context.project_revision ||
    plan.ledger.scope.mint !== context.mint ||
    token?.chain !== 'Solana' ||
    token.address !== context.mint ||
    token.decimals !== plan.ledger.scope.decimals ||
    decision?.outcome !== 'proposal' ||
    decision.proposalTokenRaw === null
  )
    throw new CounterBudgetError(
      'Counter proposal, token or precision differs from the owned metadata.',
    );
  let identity: Awaited<ReturnType<typeof counterAutoBuyCandidateIdentity>>;
  try {
    identity = await counterAutoBuyCandidateIdentity(
      plan,
      input.decisionIdentity,
    );
  } catch {
    signal.throwIfAborted();
    throw new CounterBudgetError(
      'Retained Counter proposal source cannot identify these accounting terms. Review a supported proposal.',
      409,
    );
  }
  signal.throwIfAborted();
  const terms = autoBuyBudgetTerms({
    id: input.budgetId,
    projectId: input.projectId,
    projectRevision: input.projectRevision,
    mint: context.mint,
    tokenDecimals: token.decimals,
    maximumInputLamports: input.maximumInputLamports,
    maximumFeeAndRentLamports: input.maximumFeeAndRentLamports,
    expiresAt: input.expiresAt,
    wallets: [
      {
        address: input.wallet,
        revision: input.walletRevision,
        maximumInputLamports: input.maximumInputLamports,
        maximumFeeAndRentLamports: input.maximumFeeAndRentLamports,
      },
    ],
    strategies: [
      {
        id: plan.id,
        kind: 'Counter',
        sourceSha256: identity.sourceSha256,
        maximumInputLamports: input.maximumInputLamports,
        maximumFeeAndRentLamports: input.maximumFeeAndRentLamports,
      },
    ],
  });
  const reviewSha256 = await digest(
    canonical({
      format: 'owned-counter-budget-review-binding-v1',
      owner,
      selection: input,
      terms,
      context,
    }),
  );
  signal.throwIfAborted();
  if (canonical(await read()) !== canonical(context))
    throw new CounterBudgetError(
      'Owned Counter metadata changed during review.',
    );
  signal.throwIfAborted();
  return { read, context, terms, reviewSha256 };
}
export async function reviewOwnedCounterBudget(
  db: D1Database,
  owner: string,
  value: CounterBudgetRequest,
  signal: AbortSignal,
) {
  const input = selected(counterBudgetRequest(value));
  const d = await derive(db, owner, input, signal);
  return {
    format: 'owned-counter-budget-review-v1' as const,
    selection: input,
    terms: d.terms,
    reviewSha256: d.reviewSha256,
    requiredAcknowledgement: COUNTER_BUDGET_SAVE_ACK,
    scope: 'read-only-accounting-only' as const,
    ...authority,
    limitations: COUNTER_BUDGET_LIMITATIONS,
  };
}
function savedDto(
  originalId: string,
  budget: NonNullable<Awaited<ReturnType<typeof readAutoBuyBudget>>>,
  currentContext:
    | 'rechecked-advisory-only'
    | 'changed-or-unavailable-after-write'
    | 'not-checked-history',
  disposition:
    | 'recovered-existing-terms'
    | 'history-read'
    | 'created-or-recovered-terms',
) {
  return {
    format: 'owned-counter-budget-saved-v1' as const,
    recordKind: 'immutable-budget-terms-only' as const,
    reviewProvenanceStored: false as const,
    disposition,
    originalId,
    budget,
    currentContext,
    scope: 'historical-accounting-record' as const,
    ...authority,
    limitations: COUNTER_BUDGET_LIMITATIONS,
  };
}
/** Read original owned terms before current admission or pacing. This does not
 * authenticate any newly supplied decision/review hash:0136 stores neither.
 */
export async function recoverExistingCounterBudgetSave(
  db: D1Database,
  owner: string,
  value: CounterBudgetRequest,
  signal: AbortSignal,
) {
  const request = counterBudgetRequest(value);
  if (request.action !== 'save')
    throw new CounterBudgetError('Choose metadata save recovery.', 400);
  signal.throwIfAborted();
  const budget = await readAutoBuyBudget(db, owner, request.budgetId);
  signal.throwIfAborted();
  if (!budget) return null;
  const t = budget.terms,
    w = t.wallets[0],
    strategy = t.strategies[0];
  if (
    t.id !== request.budgetId ||
    t.projectId !== request.projectId ||
    t.projectRevision !== request.projectRevision ||
    t.maximumInputLamports !== request.maximumInputLamports ||
    t.maximumFeeAndRentLamports !== request.maximumFeeAndRentLamports ||
    t.expiresAt !== request.expiresAt ||
    t.wallets.length !== 1 ||
    w.address !== request.wallet ||
    w.revision !== request.walletRevision ||
    w.maximumInputLamports !== request.maximumInputLamports ||
    w.maximumFeeAndRentLamports !== request.maximumFeeAndRentLamports ||
    t.strategies.length !== 1 ||
    strategy.id !== request.planId ||
    strategy.kind !== 'Counter' ||
    strategy.maximumInputLamports !== request.maximumInputLamports ||
    strategy.maximumFeeAndRentLamports !== request.maximumFeeAndRentLamports
  )
    throw new CounterBudgetRecoveryError(request.budgetId);
  return savedDto(
    request.budgetId,
    budget,
    'not-checked-history',
    'recovered-existing-terms',
  );
}
export async function saveOwnedCounterBudget(
  db: D1Database,
  owner: string,
  value: CounterBudgetRequest,
  signal: AbortSignal,
) {
  const request = counterBudgetRequest(value);
  if (request.action !== 'save')
    throw new CounterBudgetError(
      'Exact reviewed save acknowledgement required.',
      400,
    );
  const input = selected(request);
  let d: Awaited<ReturnType<typeof derive>>;
  try {
    const existing = await recoverExistingCounterBudgetSave(
      db,
      owner,
      request,
      signal,
    );
    if (existing) return existing;
    d = await derive(db, owner, input, signal);
    if (d.reviewSha256 !== request.reviewSha256)
      throw new CounterBudgetError(
        'Reviewed Counter metadata changed. Review the exact terms again.',
      );
    signal.throwIfAborted();
    if (canonical(await d.read()) !== canonical(d.context))
      throw new CounterBudgetError(
        'Counter metadata changed before the save attempt.',
      );
    signal.throwIfAborted();
  } catch (error) {
    if (error instanceof CounterBudgetRecoveryError) throw error;
    throw new CounterBudgetSaveRefusalError(
      input.budgetId,
      request.reviewSha256,
      signal.aborted
        ? 'This request cancelled before attempting its metadata writer; earlier save outcomes are not verified.'
        : error instanceof CounterBudgetError ||
            error instanceof AutoBuyBudgetError
          ? error.message
          : 'Owned Counter metadata could not be reviewed before saving.',
      signal.aborted
        ? 408
        : error instanceof CounterBudgetError ||
            error instanceof AutoBuyBudgetError
          ? error.status
          : 502,
    );
  }
  // From this point cancellation/errors can no longer prove that no write happened.
  try {
    const budget = await retainAutoBuyBudget(db, owner, d.terms);
    signal.throwIfAborted();
    if (!budget) throw new CounterBudgetRecoveryError(input.budgetId);
    let currentContext:
      | 'rechecked-advisory-only'
      | 'changed-or-unavailable-after-write' =
      'changed-or-unavailable-after-write';
    try {
      if (canonical(await d.read()) === canonical(d.context))
        currentContext = 'rechecked-advisory-only';
    } catch {}
    signal.throwIfAborted();
    return savedDto(
      input.budgetId,
      budget,
      currentContext,
      'created-or-recovered-terms',
    );
  } catch {
    throw new CounterBudgetRecoveryError(input.budgetId, signal.aborted);
  }
}
/** Original owned history only. No current Counter/wallet checks or expiry renewal. */
export async function recoverOwnedCounterBudget(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
) {
  if (typeof id !== 'string' || !UUID.test(id))
    throw new CounterBudgetError('Choose the original budget ID.', 400);
  signal.throwIfAborted();
  const budget = await readAutoBuyBudget(db, owner, id);
  signal.throwIfAborted();
  if (!budget)
    throw new CounterBudgetError('Owned budget history not found.', 404);
  return savedDto(id, budget, 'not-checked-history', 'history-read');
}
export type CounterBudgetReview = Awaited<
  ReturnType<typeof reviewOwnedCounterBudget>
>;
export type CounterBudgetSaved = Awaited<
  ReturnType<typeof recoverOwnedCounterBudget>
>;
export { AutoBuyBudgetError };
