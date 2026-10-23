import { afterEach, it, expect, vi } from 'vitest';
import { counterOwnedBudgetFixture } from '../test/counter-owned-budget-fixture';
import { counterAutoBuyCandidateIdentity } from './auto-buy-counter-candidate';
import {
  COUNTER_BUDGET_SAVE_ACK,
  COUNTER_BUDGET_LIMITATIONS,
  counterBudgetRequest,
  reviewOwnedCounterBudget,
  saveOwnedCounterBudget,
  recoverOwnedCounterBudget,
  recoverExistingCounterBudgetSave,
  CounterBudgetRecoveryError,
  type CounterBudgetRequest,
} from './counter-owned-budget';
const fixtures: ReturnType<typeof counterOwnedBudgetFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.sqlite.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-23T12:00:00.000Z'));
  const f = counterOwnedBudgetFixture();
  fixtures.push(f);
  return f;
}
const signal = () => new AbortController().signal;
async function review(f: ReturnType<typeof fixture>) {
  return reviewOwnedCounterBudget(
    f.db,
    'owner',
    { ...f.selection, action: 'review' },
    signal(),
  );
}
async function save(f: ReturnType<typeof fixture>, sha?: string, s = signal()) {
  const reviewSha256 = sha ?? (await review(f)).reviewSha256;
  return saveOwnedCounterBudget(
    f.db,
    'owner',
    {
      ...f.selection,
      action: 'save',
      reviewSha256,
      acknowledgement: COUNTER_BUDGET_SAVE_ACK,
    },
    s,
  );
}
it('derives exact single Counter plan/wallet accounting terms and owner-bound digest without provider calls or a write', async () => {
  const f = fixture(),
    fetch = vi.spyOn(globalThis, 'fetch');
  const r = await review(f),
    identity = await counterAutoBuyCandidateIdentity(
      f.plan,
      f.selection.decisionIdentity,
    );
  expect(r).toEqual({
    format: 'owned-counter-budget-review-v1',
    selection: f.selection,
    terms: {
      id: f.selection.budgetId,
      projectId: f.selection.projectId,
      projectRevision: 1,
      mint: f.plan.ledger.scope.mint,
      tokenDecimals: 6,
      maximumInputLamports: f.selection.maximumInputLamports,
      maximumFeeAndRentLamports: f.selection.maximumFeeAndRentLamports,
      expiresAt: f.selection.expiresAt,
      wallets: [
        {
          address: f.selection.wallet,
          revision: 1,
          maximumInputLamports: f.selection.maximumInputLamports,
          maximumFeeAndRentLamports: f.selection.maximumFeeAndRentLamports,
        },
      ],
      strategies: [
        {
          id: f.plan.id,
          kind: 'Counter',
          sourceSha256: identity.sourceSha256,
          maximumInputLamports: f.selection.maximumInputLamports,
          maximumFeeAndRentLamports: f.selection.maximumFeeAndRentLamports,
        },
      ],
    },
    reviewSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    requiredAcknowledgement: COUNTER_BUDGET_SAVE_ACK,
    scope: 'read-only-accounting-only',
    approvalAllowed: false,
    reservationCreated: false,
    accountingCapacityReserved: false,
    signingAllowed: false,
    executionAllowed: false,
    automaticExecutionAllowed: false,
    sourceVerified: false,
    instructionsVerified: false,
    walletFundsReserved: false,
    limitations: COUNTER_BUDGET_LIMITATIONS,
  });
  expect((await review(f)).reviewSha256).toBe(r.reviewSha256);
  expect(
    f.sqlite.prepare('SELECT count(*) AS n FROM auto_buy_budgets').get(),
  ).toMatchObject({ n: 0 });
  expect(fetch).not.toHaveBeenCalled();
});
it('saves through actual0136 guards only after exact digest and separate acknowledgement, then recovers the original ID', async () => {
  const f = fixture(),
    r = await review(f);
  const saved = await save(f, r.reviewSha256);
  expect(saved).toMatchObject({
    originalId: f.selection.budgetId,
    currentContext: 'rechecked-advisory-only',
    budget: {
      terms: r.terms,
      state: 'open',
      revision: 0,
      heldInputLamports: '0',
    },
    signingAllowed: false,
    executionAllowed: false,
  });
  expect(
    await recoverOwnedCounterBudget(
      f.db,
      'owner',
      f.selection.budgetId,
      signal(),
    ),
  ).toEqual({
    ...saved,
    currentContext: 'not-checked-history',
    disposition: 'history-read',
  });
  expect((await save(f, r.reviewSha256)).originalId).toBe(f.selection.budgetId);
  expect(
    f.sqlite.prepare('SELECT count(*) AS n FROM auto_buy_budgets').get(),
  ).toMatchObject({ n: 1 });
  expect(
    f.sqlite.prepare('SELECT count(*) AS n FROM auto_buy_budget_claims').get(),
  ).toMatchObject({ n: 0 });
});
it.each([
  'owner',
  'projectRevision',
  'planRevision',
  'walletRevision',
  'proof',
  'ignore',
  'state',
] as const)(
  'rejects wrong %s context before a metadata write',
  async (kind) => {
    const f = fixture();
    if (kind === 'projectRevision') f.selection.projectRevision++;
    if (kind === 'planRevision') f.selection.planRevision++;
    if (kind === 'walletRevision') f.selection.walletRevision++;
    if (kind === 'proof')
      f.sqlite.prepare('DELETE FROM wallet_ownership_proofs').run();
    if (kind === 'ignore') {
      f.plan.rules.ignoredWallets = [];
      f.savePlan();
    }
    if (kind === 'state') {
      f.plan.state = 'paused';
      f.savePlan();
    }
    await expect(
      reviewOwnedCounterBudget(
        f.db,
        kind === 'owner' ? 'other' : 'owner',
        { ...f.selection, action: 'review' },
        signal(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      f.sqlite.prepare('SELECT count(*) AS n FROM auto_buy_budgets').get(),
    ).toMatchObject({ n: 0 });
  },
);
it('requires exact original terms/context digest and never accepts browser source hashes or a missing acknowledgement', async () => {
  const f = fixture(),
    r = await review(f);
  expect(() =>
    counterBudgetRequest({
      ...f.selection,
      action: 'review',
      sourceSha256: 'a'.repeat(64),
    }),
  ).toThrow();
  expect(() =>
    counterBudgetRequest({
      ...f.selection,
      action: 'save',
      reviewSha256: r.reviewSha256,
      acknowledgement: false,
    }),
  ).toThrow();
  f.selection.maximumInputLamports = '2';
  await expect(save(f, r.reviewSha256)).rejects.toThrow(/exact terms again/);
  expect(
    f.sqlite.prepare('SELECT count(*) AS n FROM auto_buy_budgets').get(),
  ).toMatchObject({ n: 0 });
});
it('binds non-revision owned wallet context drift into the exact review digest', async () => {
  const f = fixture(),
    r = await review(f);
  f.sqlite
    .prepare(
      "UPDATE workspace_wallets SET updated_at='2026-10-23T11:00:00.000Z'",
    )
    .run();
  await expect(save(f, r.reviewSha256)).rejects.toThrow(/exact terms again/);
});
it('actual0136 insert refuses project changes at the write boundary and recovery error retains the ID', async () => {
  const f = fixture(),
    r = await review(f);
  f.hooks.beforeRun = (sql) => {
    if (sql.startsWith('INSERT INTO auto_buy_budgets'))
      f.sqlite.prepare('UPDATE imported_token_projects SET archived=1').run();
  };
  await expect(save(f, r.reviewSha256)).rejects.toMatchObject({
    originalId: f.selection.budgetId,
    recoveryRequired: true,
  });
  expect(
    f.sqlite.prepare('SELECT count(*) AS n FROM auto_buy_budgets').get(),
  ).toMatchObject({ n: 0 });
});
it('reports original saved history when Counter context changes after the write, without claiming an atomic plan guard', async () => {
  const f = fixture(),
    r = await review(f);
  f.hooks.afterRun = (sql) => {
    if (sql.startsWith('INSERT INTO auto_buy_budgets')) {
      f.plan.state = 'paused';
      f.savePlan();
    }
  };
  const saved = await save(f, r.reviewSha256);
  expect(saved.currentContext).toBe('changed-or-unavailable-after-write');
  expect(saved.budget.terms).toEqual(r.terms);
  expect(saved.originalId).toBe(f.selection.budgetId);
});
it('recovers original expired metadata after a lost reply and archived/current-plan changes without renewal or another insert', async () => {
  const f = fixture(),
    r = await review(f);
  await save(f, r.reviewSha256); // Intentionally discard the successful response.
  f.advance(7200000);
  vi.setSystemTime(f.clock());
  f.sqlite.prepare('UPDATE imported_token_projects SET archived=1').run();
  f.sqlite.prepare('DELETE FROM counter_trade_plans').run();
  f.sqlite.prepare('DELETE FROM wallet_ownership_proofs').run();
  const history = await recoverOwnedCounterBudget(
    f.db,
    'owner',
    f.selection.budgetId,
    signal(),
  );
  expect(history).toMatchObject({
    currentContext: 'not-checked-history',
    budget: { terms: r.terms, createdAt: '2026-10-23T12:00:00.000Z' },
    executionAllowed: false,
  });
  expect(Date.parse(history.budget.terms.expiresAt)).toBeLessThan(Date.now());
  await expect(
    recoverOwnedCounterBudget(f.db, 'other', f.selection.budgetId, signal()),
  ).rejects.toMatchObject({ status: 404 });
  expect(
    f.sqlite.prepare('SELECT count(*) AS n FROM auto_buy_budgets').get(),
  ).toMatchObject({ n: 1 });
});
it('retains possibly-written ID and GET recovery after cancellation during insert', async () => {
  const f = fixture(),
    r = await review(f),
    c = new AbortController();
  f.hooks.afterRun = (sql) => {
    if (sql.startsWith('INSERT INTO auto_buy_budgets'))
      c.abort(Error('reply lost'));
  };
  await expect(save(f, r.reviewSha256, c.signal)).rejects.toBeInstanceOf(
    CounterBudgetRecoveryError,
  );
  const history = await recoverOwnedCounterBudget(
    f.db,
    'owner',
    f.selection.budgetId,
    signal(),
  );
  expect(history.originalId).toBe(f.selection.budgetId);
  expect(history.budget.terms).toEqual(r.terms);
});
it.each([
  'expired',
  'tooLong',
  'noncanonical',
  'unsafe',
  'zero',
  'sum',
] as const)('rejects %s limits without saving', async (kind) => {
  const f = fixture();
  if (kind === 'expired')
    f.selection.expiresAt = new Date(Date.now()).toISOString();
  if (kind === 'tooLong')
    f.selection.expiresAt = new Date(
      Date.now() + 31 * 86400000 + 1,
    ).toISOString();
  if (kind === 'noncanonical') f.selection.maximumInputLamports = '01';
  if (kind === 'unsafe') f.selection.maximumInputLamports = '9007199254740992';
  if (kind === 'zero') f.selection.maximumInputLamports = '0';
  if (kind === 'sum') f.selection.maximumInputLamports = '9007199254740991';
  await expect(review(f)).rejects.toMatchObject({ status: 400 });
});
it('accepts the exact existing31-day expiry boundary without extending it', async () => {
  const f = fixture();
  f.selection.expiresAt = new Date(Date.now() + 31 * 86400000).toISOString();
  const saved = await save(f);
  expect(saved.budget.terms.expiresAt).toBe(f.selection.expiresAt);
});

it('binds prewriter refusal to the exact original ID/digest without mislabelling later uncertainty', async () => {
  const f = fixture(),
    r = await review(f);
  f.selection.maximumInputLamports = '1';
  await expect(save(f, r.reviewSha256)).rejects.toMatchObject({
    format: 'owned-counter-budget-save-refusal-v1',
    originalId: f.selection.budgetId,
    reviewSha256: r.reviewSha256,
    writerAttempted: false,
    recoveryRequired: false,
  });
});

it('returns existing owned immutable terms before current plan or wallet admission, never claiming new review provenance', async () => {
  const f = fixture(),
    r = await review(f);
  await save(f, r.reviewSha256);
  f.sqlite.prepare('DELETE FROM counter_trade_plans').run();
  f.sqlite.prepare('DELETE FROM wallet_ownership_proofs').run();
  f.selection.planRevision = 99;
  f.selection.decisionIdentity = 'new-unretained-decision';
  const history = await save(f, 'b'.repeat(64));
  expect(history).toMatchObject({
    recordKind: 'immutable-budget-terms-only',
    reviewProvenanceStored: false,
    disposition: 'recovered-existing-terms',
    currentContext: 'not-checked-history',
    budget: { terms: r.terms },
  });
  expect(
    f.sqlite.prepare('SELECT count(*) AS n FROM auto_buy_budgets').get(),
  ).toMatchObject({ n: 1 });
});
it('requires original GET when an existing ID has different requested basic terms', async () => {
  const f = fixture(),
    r = await review(f);
  await save(f, r.reviewSha256);
  f.selection.maximumInputLamports = '2';
  await expect(save(f, r.reviewSha256)).rejects.toMatchObject({
    format: 'owned-counter-budget-save-recovery-v1',
    originalId: f.selection.budgetId,
    writerAttempted: 'possible',
    recoveryRequired: true,
  });
  const history = await recoverOwnedCounterBudget(
    f.db,
    'owner',
    f.selection.budgetId,
    signal(),
  );
  expect(history.budget.terms).toEqual(r.terms);
});
it('never returns saved budget:null when insertion succeeds but final readback is missing', async () => {
  const f = fixture(),
    r = await review(f);
  let inserted = false;
  f.hooks.afterRun = (sql) => {
    if (sql.startsWith('INSERT INTO auto_buy_budgets')) inserted = true;
  };
  f.hooks.mapFirst = (sql, result) =>
    inserted && sql.includes('FROM auto_buy_budgets b') ? null : result;
  await expect(save(f, r.reviewSha256)).rejects.toMatchObject({
    format: 'owned-counter-budget-save-recovery-v1',
    originalId: f.selection.budgetId,
    recoveryRequired: true,
  });
  f.hooks.mapFirst = undefined;
  const recovered = await recoverOwnedCounterBudget(
    f.db,
    'owner',
    f.selection.budgetId,
    signal(),
  );
  expect(recovered.budget.terms).toEqual(r.terms);
});
it('reports unsupported retained Counter identity as a bounded409 rather than provider failure', async () => {
  const f = fixture();
  delete f.plan.ledger.decisions[0].source;
  f.savePlan();
  await expect(review(f)).rejects.toMatchObject({ status: 409 });
});

it.each(['error', 'cancel'] as const)(
  'returns bound current-request refusal when the second owned history lookup hits %s before the writer',
  async (kind) => {
    const f = fixture(),
      r = await review(f),
      request: CounterBudgetRequest = {
        ...f.selection,
        action: 'save' as const,
        reviewSha256: r.reviewSha256,
        acknowledgement: COUNTER_BUDGET_SAVE_ACK,
      },
      c = new AbortController();
    expect(
      await recoverExistingCounterBudgetSave(f.db, 'owner', request, c.signal),
    ).toBeNull(); // Route's first lookup.
    if (kind === 'error')
      f.hooks.beforeFirst = (sql) => {
        if (sql.includes('FROM auto_buy_budgets b'))
          throw Error('private storage detail');
      };
    else
      f.hooks.afterFirst = (sql) => {
        if (sql.includes('FROM auto_buy_budgets b'))
          c.abort(Error('cancelled after route admission'));
      };
    await expect(
      saveOwnedCounterBudget(f.db, 'owner', request, c.signal),
    ).rejects.toMatchObject({
      format: 'owned-counter-budget-save-refusal-v1',
      originalId: f.selection.budgetId,
      reviewSha256: r.reviewSha256,
      scope: 'current-request-only',
      priorSaveOutcomeVerified: false,
      writerAttempted: false,
      recoveryRequired: false,
      status: kind === 'error' ? 503 : 408,
    });
    expect(
      f.sqlite.prepare('SELECT count(*) AS n FROM auto_buy_budgets').get(),
    ).toMatchObject({ n: 0 });
  },
);
