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
  previewOwnedCounterBuy: state.preview,
}));
import { POST } from './route';
import { CounterPreviewError } from '@/lib/counter-owned-preview';
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
  };
}
const request = (
  value: unknown = input(),
  headers: Record<string, string> = {
    'content-type': 'application/json',
    origin: 'https://bundle.test',
  },
) =>
  new Request('https://bundle.test/api/imported-projects/counter-previews', {
    method: 'POST',
    headers,
    body: JSON.stringify(value),
  });
beforeEach(() => {
  state.user = { userId: 'alice' };
  state.gate = true;
  state.preview.mockReset();
  state.writes.mockClear();
  state.preview.mockResolvedValue({
    format: 'owned-counter-buy-preview-v1',
    signingAllowed: false,
    approvalAllowed: false,
    executionAllowed: false,
  });
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
    (await POST(request(input(), { 'content-type': 'text/plain' }))).status,
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
  expect(await response.json()).toEqual({
    preview: {
      format: 'owned-counter-buy-preview-v1',
      signingAllowed: false,
      approvalAllowed: false,
      executionAllowed: false,
    },
  });
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
