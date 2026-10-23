import { z } from 'zod';
import bs58 from 'bs58';
import type { CounterPlan } from './counter-trade-store';
import type {
  CounterBudgetSelection,
  CounterBudgetReview,
  CounterBudgetSaved,
} from './counter-owned-budget';
import type {
  CounterBudgetPreview,
  CounterBudgetPreviewRequest,
} from './counter-owned-preview';

export const COUNTER_BUY_METADATA_ACK =
  'Save this read-only Auto Buy accounting budget. This does not authorize trades or reserve wallet funds.';
export const COUNTER_BUY_BUDGET_REMINDER = 'bundle.counter-budget-save.v1';
const SOL = 'So11111111111111111111111111111111111111112',
  MAX = 9007199254740991n;
const id = z.uuid(),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  revision = z.number().int().min(1).max(1e9);
const date = z.iso
  .datetime()
  .refine(
    (v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v,
  );
const raw = z
  .string()
  .regex(/^(0|[1-9]\d{0,15})$/)
  .refine((v) => BigInt(v) <= MAX);
const positive = raw.refine((v) => BigInt(v) > 0n);
const tokenRaw = z
  .string()
  .regex(/^(0|[1-9]\d{0,19})$/)
  .refine((v) => BigInt(v) <= (1n << 64n) - 1n);
const address = z
  .string()
  .min(32)
  .max(44)
  .refine((v) => {
    try {
      return bs58.decode(v).length === 32 && bs58.encode(bs58.decode(v)) === v;
    } catch {
      return false;
    }
  });
const limits = {
  maximumInputLamports: positive,
  maximumFeeAndRentLamports: raw,
};
const authority = {
  signingAllowed: z.literal(false),
  executionAllowed: z.literal(false),
  automaticExecutionAllowed: z.literal(false),
  sourceVerified: z.literal(false),
  instructionsVerified: z.literal(false),
  walletFundsReserved: z.literal(false),
};
const metadataAuthority = {
  approvalAllowed: z.literal(false),
  reservationCreated: z.literal(false),
  accountingCapacityReserved: z.literal(false),
  ...authority,
};
const selection = z
  .object({
    budgetId: id,
    projectId: id,
    projectRevision: revision,
    planId: id,
    planRevision: revision,
    decisionIdentity: z.string().min(1).max(512),
    wallet: address,
    walletRevision: revision,
    ...limits,
    expiresAt: date,
  })
  .strict();
const terms = z
  .object({
    id,
    projectId: id,
    projectRevision: revision,
    mint: address,
    tokenDecimals: z.number().int().min(0).max(255),
    ...limits,
    expiresAt: date,
    wallets: z
      .array(z.object({ address, revision, ...limits }).strict())
      .length(1),
    strategies: z
      .array(
        z
          .object({
            id,
            kind: z.literal('Counter'),
            sourceSha256: hash,
            ...limits,
          })
          .strict(),
      )
      .length(1),
  })
  .strict();
const review = z
  .object({
    format: z.literal('owned-counter-budget-review-v1'),
    selection,
    terms,
    reviewSha256: hash,
    requiredAcknowledgement: z.literal(COUNTER_BUY_METADATA_ACK),
    scope: z.literal('read-only-accounting-only'),
    ...metadataAuthority,
    limitations: z.string().min(1).max(4096),
  })
  .strict();
const budget = z
  .object({
    terms,
    inputMint: z.literal(SOL),
    state: z.enum(['open', 'paused', 'stopped']),
    revision: z.number().int().min(0).max(1e9),
    createdAt: date,
    updatedAt: date,
    heldInputLamports: raw,
    heldFeeAndRentLamports: raw,
    remainingInputLamports: raw,
    remainingFeeAndRentLamports: raw,
    uncertainClaims: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    ...authority,
  })
  .strict();
const saved = z
  .object({
    format: z.literal('owned-counter-budget-saved-v1'),
    recordKind: z.literal('immutable-budget-terms-only'),
    reviewProvenanceStored: z.literal(false),
    disposition: z.enum([
      'recovered-existing-terms',
      'history-read',
      'created-or-recovered-terms',
    ]),
    originalId: id,
    budget,
    currentContext: z.enum([
      'rechecked-advisory-only',
      'changed-or-unavailable-after-write',
      'not-checked-history',
    ]),
    scope: z.literal('historical-accounting-record'),
    ...metadataAuthority,
    limitations: z.string().min(1).max(4096),
  })
  .strict();
function fail(): never {
  throw Error(
    'Counter budget metadata differs. Recover the original ID or request a fresh metadata review.',
  );
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );
}
function intrinsic(r: CounterBudgetReview) {
  const s = r.selection,
    t = r.terms,
    w = t.wallets[0],
    strategy = t.strategies[0];
  if (
    t.id !== s.budgetId ||
    t.projectId !== s.projectId ||
    t.projectRevision !== s.projectRevision ||
    t.expiresAt !== s.expiresAt ||
    t.mint === SOL ||
    strategy.id !== s.planId ||
    w.address !== s.wallet ||
    w.revision !== s.walletRevision ||
    [t, w, strategy].some(
      (v) =>
        v.maximumInputLamports !== s.maximumInputLamports ||
        v.maximumFeeAndRentLamports !== s.maximumFeeAndRentLamports ||
        BigInt(v.maximumInputLamports) + BigInt(v.maximumFeeAndRentLamports) >
          MAX,
    )
  )
    fail();
  return r;
}
function current(s: CounterBudgetSelection, plan: CounterPlan, now: number) {
  const proposal = plan.ledger.decisions.find(
    (d) => d.identity === s.decisionIdentity,
  );
  if (
    !Number.isFinite(now) ||
    Date.parse(s.expiresAt) <= now ||
    Date.parse(s.expiresAt) > now + 31 * 86400000 ||
    plan.state !== 'active' ||
    plan.rules.responseSide !== 'Buy' ||
    plan.projectId !== s.projectId ||
    plan.id !== s.planId ||
    plan.revision !== s.planRevision ||
    plan.ledger.scope.revision !== s.projectRevision ||
    proposal?.outcome !== 'proposal' ||
    proposal.proposalTokenRaw === null
  )
    fail();
}
export function admitCounterBudgetReview(
  value: unknown,
  expected: CounterBudgetSelection,
  plan: CounterPlan,
  now = Date.now(),
): CounterBudgetReview {
  try {
    const r = intrinsic(z.object({ review }).strict().parse(value).review);
    const s = selection.parse(expected);
    current(s, plan, now);
    if (
      canonical(r.selection) !== canonical(s) ||
      r.terms.mint !== plan.ledger.scope.mint ||
      r.terms.tokenDecimals !== plan.ledger.scope.decimals
    )
      fail();
    return r;
  } catch {
    return fail();
  }
}
export function admitCounterBudgetSaved(
  value: unknown,
  expected: CounterBudgetReview,
): CounterBudgetSaved {
  try {
    const r = intrinsic(review.parse(expected)),
      s = z.object({ saved }).strict().parse(value).saved,
      b = s.budget;
    if (
      s.originalId !== r.selection.budgetId ||
      canonical(b.terms) !== canonical(r.terms) ||
      b.updatedAt < b.createdAt ||
      BigInt(b.heldInputLamports) + BigInt(b.remainingInputLamports) !==
        BigInt(b.terms.maximumInputLamports) ||
      BigInt(b.heldFeeAndRentLamports) +
        BigInt(b.remainingFeeAndRentLamports) !==
        BigInt(b.terms.maximumFeeAndRentLamports)
    )
      fail();
    return s;
  } catch {
    return fail();
  }
}
const preview = z
  .object({
    format: z.literal('owned-counter-buy-budget-preview-v1'),
    scope: z.literal('read-only-nonreservable-preview'),
    budgetId: id,
    budgetRevision: z.number().int().min(0).max(1e9),
    strategyId: id,
    projectId: id,
    projectRevision: revision,
    planId: id,
    planRevision: revision,
    decisionIdentity: z.string().min(1).max(512),
    wallet: address,
    walletRevision: revision,
    mint: address,
    tokenDecimals: z.number().int().min(0).max(255),
    inputMint: z.literal(SOL),
    packetSha256: hash,
    outputTargetRaw: tokenRaw.refine((v) => BigInt(v) > 0n),
    requiredSolInputRaw: positive,
    maximumQuoteInputRaw: positive,
    maximumSolInputRaw: positive,
    maximumFeeAndRentRaw: raw,
    actualSimulatedInputRaw: positive,
    networkFeeLamports: raw,
    heldInputLamports: raw,
    heldFeeAndRentLamports: raw,
    remainingInputLamports: raw,
    remainingFeeAndRentLamports: raw,
    observedAt: date,
    sourceTradeCount: z.number().int().min(1).max(1000),
    sourceRecheckedAt: date,
    sourceValidUntil: date,
    expiresAt: date,
    ownerContext: z.literal('rechecked-advisory-only'),
    ownershipContextRechecked: z.literal(true),
    budgetContextRechecked: z.literal(true),
    sourceRevalidated: z.literal(true),
    ownerContextVerified: z.literal(false),
    claimStorageEligibilityVerified: z.literal(false),
    accountingCapacityReserved: z.literal(false),
    crossBudgetReplayProtectionVerified: z.literal(false),
    proposalUseReservationVerified: z.literal(false),
    programCodeAttested: z.literal(false),
    reservationCreated: z.literal(false),
    approvalAllowed: z.literal(false),
    ...authority,
    limitations: z.string().min(1).max(4096),
  })
  .strict();
export function admitCounterBudgetPreview(
  value: unknown,
  plan: CounterPlan,
  request: CounterBudgetPreviewRequest,
  original: CounterBudgetSaved,
  now = Date.now(),
): CounterBudgetPreview {
  try {
    const p = z.object({ preview }).strict().parse(value).preview,
      b = saved.parse(original).budget,
      t = b.terms;
    const source = plan.ledger.decisions.find(
      (d) => d.identity === request.decisionIdentity,
    );
    current(
      {
        budgetId: request.budgetId,
        projectId: request.projectId,
        projectRevision: request.projectRevision,
        planId: request.planId,
        planRevision: request.planRevision,
        decisionIdentity: request.decisionIdentity,
        wallet: request.wallet,
        walletRevision: request.walletRevision,
        maximumInputLamports: t.maximumInputLamports,
        maximumFeeAndRentLamports: t.maximumFeeAndRentLamports,
        expiresAt: t.expiresAt,
      },
      plan,
      now,
    );
    for (const [key, v] of Object.entries(request))
      if (p[key as keyof typeof p] !== v) fail();
    if (
      b.state !== 'open' ||
      b.revision !== request.budgetRevision ||
      t.id !== request.budgetId ||
      request.strategyId !== request.planId ||
      t.strategies[0].id !== request.strategyId ||
      t.wallets[0].address !== request.wallet ||
      t.wallets[0].revision !== request.walletRevision ||
      t.projectId !== plan.projectId ||
      t.projectRevision !== plan.ledger.scope.revision ||
      t.mint !== p.mint ||
      t.mint !== plan.ledger.scope.mint ||
      t.tokenDecimals !== p.tokenDecimals ||
      p.tokenDecimals !== plan.ledger.scope.decimals ||
      p.outputTargetRaw !== source?.proposalTokenRaw
    )
      fail();
    const input = BigInt(p.maximumSolInputRaw),
      fee = BigInt(p.maximumFeeAndRentRaw),
      required = BigInt(p.requiredSolInputRaw),
      quote = BigInt(p.maximumQuoteInputRaw);
    if (
      input > BigInt(t.maximumInputLamports) ||
      fee > BigInt(t.maximumFeeAndRentLamports) ||
      BigInt(p.heldInputLamports) + BigInt(p.remainingInputLamports) !==
        BigInt(t.maximumInputLamports) ||
      BigInt(p.heldFeeAndRentLamports) +
        BigInt(p.remainingFeeAndRentLamports) !==
        BigInt(t.maximumFeeAndRentLamports) ||
      input > BigInt(p.remainingInputLamports) ||
      fee > BigInt(p.remainingFeeAndRentLamports) ||
      required > quote ||
      quote > input ||
      quote > (required * 10050n + 9999n) / 10000n ||
      BigInt(p.actualSimulatedInputRaw) > quote ||
      BigInt(p.networkFeeLamports) > fee
    )
      fail();
    const observed = Date.parse(p.observedAt),
      expires = Date.parse(p.expiresAt),
      checked = Date.parse(p.sourceRecheckedAt),
      validUntil = Date.parse(p.sourceValidUntil);
    const end = plan.ledger.decisions.findIndex(
      (d) => d.identity === request.decisionIdentity,
    );
    let start = end;
    while (start > 0 && plan.ledger.decisions[start - 1].outcome !== 'proposal')
      start--;
    const count = plan.ledger.decisions
      .slice(start, end + 1)
      .filter((d) => BigInt(d.contributionTokenRaw) > 0n).length;
    if (
      observed > now + 1000 ||
      now - observed > 30000 ||
      expires <= now ||
      expires <= observed ||
      expires - observed > 30000 ||
      checked < observed - 1000 ||
      checked > now + 1000 ||
      now - checked > 30000 ||
      validUntil < expires ||
      validUntil > checked + 301000 ||
      expires > Date.parse(t.expiresAt) ||
      p.sourceTradeCount !== count
    )
      fail();
    return p;
  } catch {
    return fail();
  }
}
export function parseCounterBudgetReminder(value: unknown) {
  try {
    const parsed = z
      .object({ format: z.literal('counter-budget-save-reminder-v1'), review })
      .strict()
      .parse(value);
    intrinsic(parsed.review);
    return parsed;
  } catch {
    return fail();
  }
}
export function counterBudgetReminder(reviewed: CounterBudgetReview) {
  return parseCounterBudgetReminder({
    format: 'counter-budget-save-reminder-v1',
    review: reviewed,
  });
}
export function isCounterBudgetPrewriteRefusal(
  value: unknown,
  expected: CounterBudgetReview,
): boolean {
  const parsed = z
    .object({
      format: z.literal('owned-counter-budget-save-refusal-v1'),
      scope: z.literal('current-request-only'),
      priorSaveOutcomeVerified: z.literal(false),
      originalId: id,
      reviewSha256: hash,
      writerAttempted: z.literal(false),
      recoveryRequired: z.literal(false),
      error: z.string().min(1).max(4096),
    })
    .strict()
    .safeParse(value);
  return (
    parsed.success &&
    parsed.data.originalId === expected.selection.budgetId &&
    parsed.data.reviewSha256 === expected.reviewSha256
  );
}
export function counterBudgetSol(raw: string) {
  const n = BigInt(raw);
  return `${n / 1000000000n}.${
    String(n % 1000000000n)
      .padStart(9, '0')
      .replace(/0+$/, '') || '0'
  }`;
}
export function counterBudgetLamports(value: string) {
  if (!/^(0|[1-9]\d{0,6})(?:\.\d{1,9})?$/.test(value)) fail();
  const [whole, fraction = ''] = value.split('.');
  const n = BigInt(whole) * 1000000000n + BigInt(fraction.padEnd(9, '0'));
  if (n > MAX) fail();
  return String(n);
}
