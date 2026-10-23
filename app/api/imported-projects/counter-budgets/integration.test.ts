import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { counterOwnedBudgetFixture } from '@/test/counter-owned-budget-fixture';
import { COUNTER_BUDGET_SAVE_ACK } from '@/lib/counter-owned-budget';
import {
  admitCounterBudgetReview,
  admitCounterBudgetSaved,
} from '@/lib/counter-buy-budget-view';

const state = vi.hoisted(() => ({
  user: { userId: 'owner' } as { userId: string } | null,
  db: null as D1Database | null,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => state.user,
}));
vi.mock('@/db', () => ({
  getD1: () => {
    if (!state.db) throw Error('Disposable fixture not initialized');
    return state.db;
  },
}));
import { GET, POST } from './route';

let f: ReturnType<typeof counterOwnedBudgetFixture>;
const origin = 'http://localhost:4193';
const url = `${origin}/api/imported-projects/counter-budgets`;
function post(value: unknown, signal?: AbortSignal) {
  return POST(
    new Request(url, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(value),
      signal,
    }),
  );
}
function recover() {
  return GET(new Request(`${url}?id=${f.selection.budgetId}`));
}
function count(table: 'auto_buy_budgets' | 'auto_buy_budget_claims') {
  return (
    f.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
      n: number;
    }
  ).n;
}
async function review() {
  const response = await post({ ...f.selection, action: 'review' });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return admitCounterBudgetReview(await response.json(), f.selection, f.plan);
}
function saveBody(reviewSha256: string) {
  return {
    ...f.selection,
    action: 'save',
    reviewSha256,
    acknowledgement: COUNTER_BUDGET_SAVE_ACK,
  };
}
beforeEach(() => {
  f = counterOwnedBudgetFixture();
  state.db = f.db;
  state.user = { userId: 'owner' };
});
afterEach(() => {
  state.db = null;
  f.sqlite.close();
});

it('composes the real review, explicit save and historical GET with browser DTO admission and no claim', async () => {
  const reviewed = await review();
  expect(count('auto_buy_budgets')).toBe(0);
  expect(count('auto_buy_budget_claims')).toBe(0);
  const { acknowledgement: _unchecked, ...unchecked } = saveBody(
    reviewed.reviewSha256,
  );
  expect((await post(unchecked)).status).toBe(400);
  expect(count('auto_buy_budgets')).toBe(0);
  const savedResponse = await post(saveBody(reviewed.reviewSha256));
  expect(savedResponse.status).toBe(200);
  const saved = admitCounterBudgetSaved(await savedResponse.json(), reviewed);
  expect(saved.originalId).toBe(f.selection.budgetId);
  expect(saved.recordKind).toBe('immutable-budget-terms-only');
  expect(saved.reviewProvenanceStored).toBe(false);
  expect(saved.disposition).toBe('created-or-recovered-terms');
  expect(saved.currentContext).toBe('rechecked-advisory-only');
  expect(saved.budget.terms).toEqual(reviewed.terms);
  expect(saved.budget.heldInputLamports).toBe('0');
  expect(saved.budget.heldFeeAndRentLamports).toBe('0');
  expect(saved.signingAllowed).toBe(false);
  expect(saved.executionAllowed).toBe(false);
  expect(saved.reservationCreated).toBe(false);
  expect(count('auto_buy_budgets')).toBe(1);
  expect(count('auto_buy_budget_claims')).toBe(0);
  const originalCreatedAt = saved.budget.createdAt;
  // Real SQL rows change; historical recovery deliberately does not re-admit them.
  f.sqlite.exec('UPDATE workspace_wallets SET archived=1,revision=revision+1');
  f.plan.state = 'ended';
  f.savePlan();
  f.advance(3600001);
  const recoveredResponse = await recover();
  expect(recoveredResponse.status).toBe(200);
  const recovered = admitCounterBudgetSaved(
    await recoveredResponse.json(),
    reviewed,
  );
  expect(recovered.currentContext).toBe('not-checked-history');
  expect(recovered.disposition).toBe('history-read');
  expect(recovered.budget.createdAt).toBe(originalCreatedAt);
  expect(recovered.budget.terms.expiresAt).toBe(f.selection.expiresAt);
  const writes: string[] = [];
  f.hooks.beforeRun = (sql) => writes.push(sql);
  // Historical terms recovery precedes plan/wallet/expiry admission and the gate.
  // It deliberately does not claim that this new digest was previously approved.
  const retried = await post({
    ...saveBody('f'.repeat(64)),
    decisionIdentity: 'new-nonpersisted-decision',
  });
  expect(retried.status).toBe(200);
  const oldTerms = admitCounterBudgetSaved(await retried.json(), reviewed);
  expect(oldTerms.disposition).toBe('recovered-existing-terms');
  expect(oldTerms.reviewProvenanceStored).toBe(false);
  expect(oldTerms.currentContext).toBe('not-checked-history');
  expect(oldTerms.budget.createdAt).toBe(originalCreatedAt);
  expect(writes).toEqual([]);
  expect(count('auto_buy_budgets')).toBe(1);
  state.user = { userId: 'other' };
  expect((await recover()).status).toBe(404);
});

it('refuses changed reviewed limits before insertion and preserves the original ID', async () => {
  const reviewed = await review();
  const response = await post({
    ...saveBody(reviewed.reviewSha256),
    maximumInputLamports: '999999999',
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    format: 'owned-counter-budget-save-refusal-v1',
    originalId: f.selection.budgetId,
    reviewSha256: reviewed.reviewSha256,
    writerAttempted: false,
    recoveryRequired: false,
    scope: 'current-request-only',
    priorSaveOutcomeVerified: false,
  });
  expect(count('auto_buy_budgets')).toBe(0);
  expect((await recover()).status).toBe(404);
  expect(count('auto_buy_budget_claims')).toBe(0);
});

it('actual 0136 SQL refuses a wallet race at INSERT and GET distinguishes the absent outcome', async () => {
  const reviewed = await review();
  f.hooks.beforeRun = (sql) => {
    if (sql.startsWith('INSERT INTO auto_buy_budgets(')) {
      f.hooks.beforeRun = undefined;
      f.sqlite.exec('UPDATE workspace_wallets SET revision=revision+1');
    }
  };
  const response = await post(saveBody(reviewed.reviewSha256));
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    format: 'owned-counter-budget-save-recovery-v1',
    originalId: f.selection.budgetId,
    writerAttempted: 'possible',
    recoveryRequired: true,
  });
  expect(count('auto_buy_budgets')).toBe(0);
  expect((await recover()).status).toBe(404);
  expect(count('auto_buy_budget_claims')).toBe(0);
});

it('admits saved history with an honest advisory when the actual Counter context changes after commit', async () => {
  const reviewed = await review();
  f.hooks.afterRun = (sql) => {
    if (sql.startsWith('INSERT INTO auto_buy_budgets(')) {
      f.hooks.afterRun = undefined;
      f.plan.state = 'ended';
      f.savePlan();
    }
  };
  const response = await post(saveBody(reviewed.reviewSha256));
  expect(response.status).toBe(200);
  const saved = admitCounterBudgetSaved(await response.json(), reviewed);
  expect(saved.currentContext).toBe('changed-or-unavailable-after-write');
  expect(saved.budget.terms).toEqual(reviewed.terms);
  expect(count('auto_buy_budgets')).toBe(1);
  expect((await post({ ...f.selection, action: 'review' })).status).toBe(409);
  const recovered = await recover();
  expect(recovered.status).toBe(200);
  expect(
    admitCounterBudgetSaved(await recovered.json(), reviewed).originalId,
  ).toBe(f.selection.budgetId);
  expect(count('auto_buy_budget_claims')).toBe(0);
});

it('retains one real row through a lost INSERT reply and through cancellation after commit', async () => {
  const reviewed = await review();
  const controller = new AbortController();
  f.hooks.afterRun = (sql) => {
    if (sql.startsWith('INSERT INTO auto_buy_budgets(')) {
      f.hooks.afterRun = undefined;
      controller.abort();
      throw Error('Synthetic lost reply after real SQLite commit');
    }
  };
  const response = await post(
    saveBody(reviewed.reviewSha256),
    controller.signal,
  );
  expect(response.status).toBe(408);
  expect(await response.json()).toMatchObject({
    format: 'owned-counter-budget-save-recovery-v1',
    originalId: f.selection.budgetId,
    writerAttempted: 'possible',
    recoveryRequired: true,
  });
  expect(count('auto_buy_budgets')).toBe(1);
  const recoveredResponse = await recover();
  expect(recoveredResponse.status).toBe(200);
  const recovered = admitCounterBudgetSaved(
    await recoveredResponse.json(),
    reviewed,
  );
  expect(recovered.budget.terms).toEqual(reviewed.terms);
  expect(recovered.signingAllowed).toBe(false);
  const writes: string[] = [];
  f.hooks.beforeRun = (sql) => writes.push(sql);
  // An existing exact terms ID recovers before the gate without another INSERT.
  const retried = await post(saveBody(reviewed.reviewSha256));
  expect(retried.status).toBe(200);
  const existing = admitCounterBudgetSaved(await retried.json(), reviewed);
  expect(existing.disposition).toBe('recovered-existing-terms');
  expect(existing.reviewProvenanceStored).toBe(false);
  expect(existing.budget.createdAt).toBe(recovered.budget.createdAt);
  expect(writes).toEqual([]);
  // A genuinely new ID still hits the original, actual shared SQL gate.
  expect(
    (
      await post({
        ...saveBody(reviewed.reviewSha256),
        budgetId: '00000000-0000-4000-8000-000000000031',
      })
    ).status,
  ).toBe(429);
  expect(count('auto_buy_budgets')).toBe(1);
  expect(count('auto_buy_budget_claims')).toBe(0);
});

it('treats a null post-INSERT readback as unknown and recovers the actual committed original row', async () => {
  const reviewed = await review();
  let inserted = false;
  f.hooks.afterRun = (sql) => {
    if (sql.startsWith('INSERT INTO auto_buy_budgets(')) inserted = true;
  };
  f.hooks.mapFirst = (sql, result) =>
    inserted && sql.includes('FROM auto_buy_budgets') ? null : result;
  const response = await post(saveBody(reviewed.reviewSha256));
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    format: 'owned-counter-budget-save-recovery-v1',
    originalId: f.selection.budgetId,
    writerAttempted: 'possible',
    recoveryRequired: true,
  });
  expect(count('auto_buy_budgets')).toBe(1);
  f.hooks.mapFirst = undefined;
  const recoveredResponse = await recover();
  expect(recoveredResponse.status).toBe(200);
  const saved = admitCounterBudgetSaved(
    await recoveredResponse.json(),
    reviewed,
  );
  expect(saved.disposition).toBe('history-read');
  expect(saved.reviewProvenanceStored).toBe(false);
  expect(saved.budget.terms).toEqual(reviewed.terms);
  expect(count('auto_buy_budget_claims')).toBe(0);
});
