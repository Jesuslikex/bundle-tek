import { beforeEach, expect, it, vi } from 'vitest';
import { counterBuyFixture } from '@/test/counter-buy-fixture';
import { routeWallet } from '@/test/jupiter-route-fixture';
const state = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  gate: true,
  preview: vi.fn(),
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
vi.mock('@/lib/counter-owned-preview', async (original) => ({
  ...(await original<typeof import('@/lib/counter-owned-preview')>()),
  previewOwnedCounterBuyBudget: state.preview,
}));
import { POST } from './route';
import {
  CounterPreviewError,
  type CounterBudgetPreview,
} from '@/lib/counter-owned-preview';
function input() {
  const { plan, identity } = counterBuyFixture();
  return {
    projectId: plan.projectId,
    projectRevision: plan.ledger.scope.revision,
    planId: plan.id,
    planRevision: plan.revision,
    decisionIdentity: identity,
    wallet: routeWallet,
    walletRevision: 1,
    maximumSolInputRaw: '1005',
    maximumFeeAndRentRaw: '5000',
    budgetId: '00000000-0000-4000-8000-000000000020',
    budgetRevision: 0,
    strategyId: '00000000-0000-4000-8000-000000000021',
  };
}
function preview(): CounterBudgetPreview {
  return {
    format: 'owned-counter-buy-budget-preview-v1',
    scope: 'read-only-nonreservable-preview',
    ...input(),
    mint: '11111111111111111111111111111111',
    tokenDecimals: 6,
    inputMint: 'So11111111111111111111111111111111111111112',
    packetSha256: 'a'.repeat(64),
    outputTargetRaw: '1000',
    requiredSolInputRaw: '1000',
    maximumQuoteInputRaw: '1005',
    actualSimulatedInputRaw: '1000',
    networkFeeLamports: '5000',
    heldInputLamports: '0',
    heldFeeAndRentLamports: '0',
    remainingInputLamports: '10050',
    remainingFeeAndRentLamports: '50000',
    observedAt: '2026-10-23T12:00:00.000Z',
    sourceTradeCount: 1,
    sourceRecheckedAt: '2026-10-23T12:00:01.000Z',
    sourceValidUntil: '2026-10-23T12:04:59.000Z',
    expiresAt: '2026-10-23T12:00:30.000Z',
    ownerContext: 'rechecked-advisory-only',
    ownershipContextRechecked: true,
    budgetContextRechecked: true,
    sourceRevalidated: true,
    ownerContextVerified: false,
    claimStorageEligibilityVerified: false,
    accountingCapacityReserved: false,
    crossBudgetReplayProtectionVerified: false,
    proposalUseReservationVerified: false,
    programCodeAttested: false,
    reservationCreated: false,
    approvalAllowed: false,
    signingAllowed: false,
    executionAllowed: false,
    automaticExecutionAllowed: false,
    sourceVerified: false,
    instructionsVerified: false,
    walletFundsReserved: false,
    limitations:
      'Read-only nonreservable preview. Owned context and held totals were rechecked, not locked. No active-claim capacity, cross-budget or global proposal-use reservation, claim-storage eligibility, code admission or execution authority is established. This response cannot be retained as a claim.',
  };
}
const request = (
  value: unknown = input(),
  headers: Record<string, string> = {
    'content-type': 'application/json',
    origin: 'https://bundle.test',
  },
) =>
  new Request(
    'https://bundle.test/api/imported-projects/counter-budget-previews',
    {
      method: 'POST',
      headers,
      body: JSON.stringify(value),
    },
  );
beforeEach(() => {
  state.user = { userId: 'alice' };
  state.gate = true;
  state.preview.mockReset();
  state.writes.mockClear();
  state.preview.mockResolvedValue(preview());
});
it('requires authentication and same origin before database/provider work', async () => {
  state.user = null;
  expect((await POST(request())).status).toBe(401);
  state.user = { userId: 'alice' };
  expect(
    (
      await POST(
        request(input(), {
          'content-type': 'application/json',
          origin: 'https://other.test',
        }),
      )
    ).status,
  ).toBe(403);
  expect(state.writes).not.toHaveBeenCalled();
  expect(state.preview).not.toHaveBeenCalled();
});
it('validates exact body and content type before quota/provider work', async () => {
  expect((await POST(request({ ...input(), sign: true }))).status).toBe(400);
  expect(
    (
      await POST(
        request({
          ...input(),
          claimId: '00000000-0000-4000-8000-000000000022',
        }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await POST(
        request(input(), {
          'content-type': 'text/plain',
          origin: 'https://bundle.test',
        }),
      )
    ).status,
  ).toBe(415);
  expect((await POST(request('x'.repeat(2100)))).status).toBe(413);
  expect(state.writes).not.toHaveBeenCalled();
  expect(state.preview).not.toHaveBeenCalled();
});
it('admits one explicit preview under the authenticated owner and returns no-store', async () => {
  const value = input(),
    response = await POST(request(value));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const result = (await response.json()) as { preview: CounterBudgetPreview };
  expect(result).toEqual({ preview: preview() });
  expect(result).not.toHaveProperty('candidate');
  expect(result.preview).not.toHaveProperty('claim');
  expect(result.preview).not.toHaveProperty('claimId');
  expect(state.preview).toHaveBeenCalledWith(
    expect.anything(),
    'alice',
    value,
    expect.any(AbortSignal),
  );
  expect(state.writes).toHaveBeenCalledOnce();
});
it('does not call providers while gated or retry a failed preview', async () => {
  state.gate = false;
  expect((await POST(request())).status).toBe(429);
  expect(state.preview).not.toHaveBeenCalled();
  state.gate = true;
  state.preview.mockRejectedValueOnce(
    Error('https://private.test/?api-key=secret'),
  );
  const response = await POST(request());
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain('private.test');
  expect(state.preview).toHaveBeenCalledOnce();
});
it('preserves owned-context rejection without exposing provider details', async () => {
  state.preview.mockRejectedValueOnce(
    new CounterPreviewError('Counter context changed.', 409),
  );
  expect((await POST(request())).status).toBe(409);
});

it('requires an explicit matching origin and rejects query parameters before database work', async () => {
  expect(
    (await POST(request(input(), { 'content-type': 'application/json' })))
      .status,
  ).toBe(403);
  const q = new Request(
    'https://bundle.test/api/imported-projects/counter-budget-previews?sign=true',
    {
      method: 'POST',
      headers: {
        origin: 'https://bundle.test',
        'content-type': 'application/json',
      },
      body: JSON.stringify(input()),
    },
  );
  expect((await POST(q)).status).toBe(400);
  expect(state.writes).not.toHaveBeenCalled();
});
it('bounds UTF-8 bytes instead of characters and rejects malformed bytes', async () => {
  const req = (bytes: Uint8Array) =>
    new Request(
      'https://bundle.test/api/imported-projects/counter-budget-previews',
      {
        method: 'POST',
        headers: {
          origin: 'https://bundle.test',
          'content-type': 'application/json',
        },
        body: new Uint8Array(bytes).buffer,
      },
    );
  const oversized = await POST(
    req(new TextEncoder().encode(JSON.stringify('é'.repeat(1100)))),
  );
  expect(oversized.status).toBe(413);
  const malformed = await POST(req(new Uint8Array([123, 255, 125])));
  expect(malformed.status).toBe(400);
  expect(state.writes).not.toHaveBeenCalled();
  expect(state.preview).not.toHaveBeenCalled();
});
it('cancels a pending body read immediately on caller abort without charging the gate', async () => {
  const c = new AbortController(),
    cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
    },
    cancel,
  });
  const r = new Request(
    'https://bundle.test/api/imported-projects/counter-budget-previews',
    {
      method: 'POST',
      headers: {
        origin: 'https://bundle.test',
        'content-type': 'application/json',
      },
      body: stream,
      duplex: 'half',
      signal: c.signal,
    } as RequestInit,
  );
  const pending = POST(r);
  await new Promise((resolve) => setTimeout(resolve, 5));
  c.abort();
  expect((await pending).status).toBe(408);
  expect(cancel).toHaveBeenCalledOnce();
  expect(state.writes).not.toHaveBeenCalled();
  expect(state.preview).not.toHaveBeenCalled();
});
it('cancels an oversized chunked body and never retries its provider operation', async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(2049));
    },
    cancel,
  });
  const r = new Request(
    'https://bundle.test/api/imported-projects/counter-budget-previews',
    {
      method: 'POST',
      headers: {
        origin: 'https://bundle.test',
        'content-type': 'application/json',
      },
      body: stream,
      duplex: 'half',
    } as RequestInit,
  );
  expect((await POST(r)).status).toBe(413);
  expect(cancel).toHaveBeenCalledOnce();
  expect(state.preview).not.toHaveBeenCalled();
});
it('returns a missing-owned-budget refusal without creating or retrying anything', async () => {
  state.preview.mockRejectedValueOnce(
    new CounterPreviewError('Owned Auto Buy budget not found.', 404),
  );
  expect((await POST(request())).status).toBe(404);
  expect(state.preview).toHaveBeenCalledOnce();
  expect(state.writes).toHaveBeenCalledOnce();
});
