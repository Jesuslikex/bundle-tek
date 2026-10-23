import { beforeEach, it, expect, vi } from 'vitest';
import {
  COUNTER_BUDGET_SAVE_ACK,
  COUNTER_BUDGET_LIMITATIONS,
  CounterBudgetError,
  CounterBudgetSaveRefusalError,
  CounterBudgetRecoveryError,
  type CounterBudgetReview,
  type CounterBudgetSaved,
  type CounterBudgetSelection,
} from '@/lib/counter-owned-budget';
import { AUTO_BUY_BUDGET_AUTHORITY } from '@/lib/auto-buy-budget';
const state = vi.hoisted(() => ({
  user: { userId: 'owner' } as { userId: string } | null,
  gate: true,
  review: vi.fn(),
  save: vi.fn(),
  recover: vi.fn(),
  existing: vi.fn(),
  writes: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => state.user,
}));
vi.mock('@/db', () => ({
  getD1: () => ({
    prepare: () => ({
      bind: (...values: unknown[]) => ({
        run: async () => {
          state.writes(values);
          return { meta: { changes: state.gate ? 1 : 0 } };
        },
      }),
    }),
  }),
}));
vi.mock('@/lib/counter-owned-budget', async (original) => ({
  ...(await original<typeof import('@/lib/counter-owned-budget')>()),
  reviewOwnedCounterBudget: state.review,
  saveOwnedCounterBudget: state.save,
  recoverOwnedCounterBudget: state.recover,
  recoverExistingCounterBudgetSave: state.existing,
}));
import { POST, GET } from './route';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const selection: CounterBudgetSelection = {
  budgetId: id(30),
  projectId: id(1),
  projectRevision: 1,
  planId: id(2),
  planRevision: 2,
  decisionIdentity: 'proposal',
  wallet: '11111111111111111111111111111111',
  walletRevision: 1,
  maximumInputLamports: '1000',
  maximumFeeAndRentLamports: '100',
  expiresAt: '2026-10-24T12:00:00.000Z',
};
const authority = {
  approvalAllowed: false as const,
  reservationCreated: false as const,
  accountingCapacityReserved: false as const,
  ...AUTO_BUY_BUDGET_AUTHORITY,
};
const review: CounterBudgetReview = {
  format: 'owned-counter-budget-review-v1',
  selection,
  terms: {
    id: selection.budgetId,
    projectId: selection.projectId,
    projectRevision: 1,
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    tokenDecimals: 6,
    maximumInputLamports: '1000',
    maximumFeeAndRentLamports: '100',
    expiresAt: selection.expiresAt,
    wallets: [
      {
        address: selection.wallet,
        revision: 1,
        maximumInputLamports: '1000',
        maximumFeeAndRentLamports: '100',
      },
    ],
    strategies: [
      {
        id: selection.planId,
        kind: 'Counter',
        sourceSha256: 'b'.repeat(64),
        maximumInputLamports: '1000',
        maximumFeeAndRentLamports: '100',
      },
    ],
  },
  reviewSha256: 'a'.repeat(64),
  requiredAcknowledgement: COUNTER_BUDGET_SAVE_ACK,
  scope: 'read-only-accounting-only',
  ...authority,
  limitations: COUNTER_BUDGET_LIMITATIONS,
};
const saved: CounterBudgetSaved = {
  format: 'owned-counter-budget-saved-v1',
  recordKind: 'immutable-budget-terms-only',
  reviewProvenanceStored: false,
  disposition: 'created-or-recovered-terms',
  originalId: selection.budgetId,
  budget: {
    terms: review.terms,
    inputMint: 'So11111111111111111111111111111111111111112',
    state: 'open',
    revision: 0,
    createdAt: '2026-10-23T12:00:00.000Z',
    updatedAt: '2026-10-23T12:00:00.000Z',
    heldInputLamports: '0',
    heldFeeAndRentLamports: '0',
    remainingInputLamports: '1000',
    remainingFeeAndRentLamports: '100',
    uncertainClaims: 0,
    ...AUTO_BUY_BUDGET_AUTHORITY,
  },
  currentContext: 'rechecked-advisory-only',
  scope: 'historical-accounting-record',
  ...authority,
  limitations: COUNTER_BUDGET_LIMITATIONS,
};
const reviewInput = () => ({ ...selection, action: 'review' });
const saveInput = () => ({
  ...selection,
  action: 'save',
  reviewSha256: review.reviewSha256,
  acknowledgement: COUNTER_BUDGET_SAVE_ACK,
});
const request = (
  value: unknown = reviewInput(),
  headers: Record<string, string> = {
    'content-type': 'application/json',
    origin: 'https://bundle.test',
  },
) =>
  new Request('https://bundle.test/api/imported-projects/counter-budgets', {
    method: 'POST',
    headers,
    body: JSON.stringify(value),
  });
const history = (
  query = `id=${selection.budgetId}`,
  headers?: Record<string, string>,
) =>
  new Request(
    `https://bundle.test/api/imported-projects/counter-budgets?${query}`,
    { headers },
  );
beforeEach(() => {
  state.user = { userId: 'owner' };
  state.gate = true;
  state.writes.mockClear();
  state.existing.mockReset().mockResolvedValue(null);
  state.review.mockReset().mockResolvedValue(review);
  state.save.mockReset().mockResolvedValue(saved);
  state.recover.mockReset().mockResolvedValue({
    ...saved,
    currentContext: 'not-checked-history',
    disposition: 'history-read',
  });
});
it('requires authentication and explicit same-origin POST before any owned reads or writes', async () => {
  state.user = null;
  expect((await POST(request())).status).toBe(401);
  expect((await GET(history())).status).toBe(401);
  state.user = { userId: 'owner' };
  expect(
    (await POST(request(reviewInput(), { 'content-type': 'application/json' })))
      .status,
  ).toBe(403);
  expect(
    (await GET(history(undefined, { origin: 'https://other.test' }))).status,
  ).toBe(403);
  expect(state.writes).not.toHaveBeenCalled();
  expect(state.review).not.toHaveBeenCalled();
});
it('reviews exact metadata without consuming the save gate and returns its full typed DTO no-store', async () => {
  const r = await POST(request());
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(await r.json()).toEqual({ review });
  expect(state.review).toHaveBeenCalledWith(
    expect.anything(),
    'owner',
    reviewInput(),
    expect.any(AbortSignal),
  );
  expect(state.writes).not.toHaveBeenCalled();
  expect(state.save).not.toHaveBeenCalled();
});
it('saves the exact acknowledged digest once using the existing owner gate', async () => {
  const r = await POST(request(saveInput()));
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ saved });
  expect(state.writes).toHaveBeenCalledOnce();
  expect(state.save).toHaveBeenCalledOnce();
  expect(state.save).toHaveBeenCalledWith(
    expect.anything(),
    'owner',
    saveInput(),
    expect.any(AbortSignal),
  );
});
it('returns an exact bound writer-not-attempted refusal when save pacing denies access', async () => {
  state.gate = false;
  const r = await POST(request(saveInput()));
  expect(r.status).toBe(429);
  expect(r.headers.get('retry-after')).toBe('15');
  expect(await r.json()).toEqual({
    format: 'owned-counter-budget-save-refusal-v1',
    originalId: selection.budgetId,
    reviewSha256: review.reviewSha256,
    scope: 'current-request-only',
    priorSaveOutcomeVerified: false,
    writerAttempted: false,
    recoveryRequired: false,
    error: 'Wait 15 seconds between metadata saves or provider previews.',
  });
  expect(state.save).not.toHaveBeenCalled();
});
it('distinguishes bound prewriter context refusal from uncertain potentially-written recovery', async () => {
  state.save.mockRejectedValueOnce(
    new CounterBudgetSaveRefusalError(
      selection.budgetId,
      review.reviewSha256,
      'Review changed.',
      409,
    ),
  );
  let r = await POST(request(saveInput()));
  expect(r.status).toBe(409);
  expect(await r.json()).toMatchObject({
    format: 'owned-counter-budget-save-refusal-v1',
    originalId: selection.budgetId,
    reviewSha256: review.reviewSha256,
    writerAttempted: false,
    recoveryRequired: false,
  });
  state.save.mockRejectedValueOnce(
    new CounterBudgetRecoveryError(selection.budgetId, true),
  );
  r = await POST(request(saveInput()));
  expect(r.status).toBe(408);
  const body = await r.json();
  expect(body).toMatchObject({
    originalId: selection.budgetId,
    recoveryRequired: true,
  });
  expect(body).toMatchObject({
    format: 'owned-counter-budget-save-recovery-v1',
    writerAttempted: 'possible',
  });
  expect(state.save).toHaveBeenCalledTimes(2);
});
it('recovers original historical metadata with only the ID and without a save gate or current-context claim', async () => {
  const r = await GET(history());
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(await r.json()).toEqual({
    saved: {
      ...saved,
      currentContext: 'not-checked-history',
      disposition: 'history-read',
    },
  });
  expect(state.recover).toHaveBeenCalledWith(
    expect.anything(),
    'owner',
    selection.budgetId,
    expect.any(AbortSignal),
  );
  expect(state.writes).not.toHaveBeenCalled();
});
it('rejects extra fields, bad acknowledgement, nonJSON and ambiguous recovery queries', async () => {
  expect(
    (await POST(request({ ...saveInput(), acknowledgement: false }))).status,
  ).toBe(400);
  expect(
    (await POST(request({ ...reviewInput(), sourceSha256: 'b'.repeat(64) })))
      .status,
  ).toBe(400);
  expect(
    (
      await POST(
        request(reviewInput(), {
          origin: 'https://bundle.test',
          'content-type': 'text/plain',
        }),
      )
    ).status,
  ).toBe(415);
  expect(
    (await GET(history(`id=${selection.budgetId}&id=${selection.budgetId}`)))
      .status,
  ).toBe(400);
  expect(
    (await GET(history(`id=${selection.budgetId}&sign=true`))).status,
  ).toBe(400);
  expect(state.writes).not.toHaveBeenCalled();
});
it('bounds UTF8 bytes, rejects malformed UTF8 and cancels pending body reads', async () => {
  const make = (body: BodyInit, c?: AbortController) =>
    new Request('https://bundle.test/api/imported-projects/counter-budgets', {
      method: 'POST',
      headers: {
        origin: 'https://bundle.test',
        'content-type': 'application/json',
      },
      body,
      duplex: 'half',
      signal: c?.signal,
    } as RequestInit);
  const oversized = await POST(
    make(new TextEncoder().encode(JSON.stringify('é'.repeat(1100))).buffer),
  );
  expect(oversized.status).toBe(413);
  const malformed = await POST(make(new Uint8Array([123, 255, 125]).buffer));
  expect(malformed.status).toBe(400);
  const c = new AbortController(),
    cancel = vi.fn(),
    stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
      },
      cancel,
    });
  const pending = POST(make(stream, c));
  await new Promise((resolve) => setTimeout(resolve, 5));
  c.abort();
  expect((await pending).status).toBe(408);
  expect(cancel).toHaveBeenCalledOnce();
  expect(state.writes).not.toHaveBeenCalled();
});
it('sanitizes unexpected errors without retries and preserves owned404 history refusal', async () => {
  state.review.mockRejectedValueOnce(Error('https://private.test/?key=secret'));
  let r = await POST(request());
  expect(r.status).toBe(502);
  expect(await r.text()).not.toContain('private.test');
  expect(state.review).toHaveBeenCalledOnce();
  state.recover.mockRejectedValueOnce(
    new CounterBudgetError('Owned budget history not found.', 404),
  );
  r = await GET(history());
  expect(r.status).toBe(404);
  expect(state.recover).toHaveBeenCalledOnce();
});

it('recovers existing same-ID history before shared save gate even when that gate would refuse a retry', async () => {
  state.gate = false;
  state.existing.mockResolvedValueOnce({
    ...saved,
    currentContext: 'not-checked-history',
    disposition: 'recovered-existing-terms',
  });
  const r = await POST(
    request({
      ...saveInput(),
      planRevision: 99,
      decisionIdentity: 'new-decision',
    }),
  );
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({
    saved: {
      ...saved,
      currentContext: 'not-checked-history',
      disposition: 'recovered-existing-terms',
    },
  });
  expect(state.writes).not.toHaveBeenCalled();
  expect(state.save).not.toHaveBeenCalled();
});
