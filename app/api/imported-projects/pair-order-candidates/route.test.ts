import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { pairOrderFixture } from '../../../../test/pair-order-fixture';
import type { ImportedPairOrderDependencies } from '@/lib/imported-pair-order-candidate';
const mocks = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: null as unknown as D1Database,
  dependencies: null as unknown as ImportedPairOrderDependencies,
  getDb: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({
  getD1: () => {
    mocks.getDb();
    return mocks.db;
  },
}));
vi.mock('@/lib/imported-pair-order-candidate', async (original) => {
  const actual =
    await original<typeof import('@/lib/imported-pair-order-candidate')>();
  return {
    ...actual,
    prepareOwnedImportedPairOrder: (
      db: D1Database,
      owner: string,
      input: Parameters<typeof actual.prepareOwnedImportedPairOrder>[2],
      signal: AbortSignal,
    ) =>
      actual.prepareOwnedImportedPairOrder(
        db,
        owner,
        input,
        signal,
        mocks.dependencies,
      ),
  };
});
import { POST } from './route';
let f: Awaited<ReturnType<typeof pairOrderFixture>>;
beforeEach(async () => {
  f = await pairOrderFixture();
  mocks.user = { userId: 'alice' };
  mocks.db = f.db;
  mocks.dependencies = f.orderDependencies;
  mocks.getDb.mockClear();
});
afterEach(() => f.close());
const request = (
  body: unknown = f.orderRequest,
  headers: Record<string, string> = {},
  suffix = '',
) =>
  new Request(
    'https://bundle.example/api/imported-projects/pair-order-candidates' +
      suffix,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
  );
it('constructs and independently checks a real decoded wallet-bound candidate without creating approval', async () => {
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toMatchObject({
    format: 'imported-pair-order-candidate-v1',
    candidatePrepared: true,
    economicSimulationVerified: true,
    approvalCreated: false,
    reservationCreated: false,
    signingAllowed: false,
    executionAllowed: false,
    review: { assessment: { topLevelInstructionsChecked: true } },
  });
  const second = await POST(request());
  expect(second.status).toBe(429);
  expect(second.headers.get('retry-after')).toBe('15');
  expect(f.prepare).toHaveBeenCalledOnce();
});
it('requires authentication, same origin and exact JSON MIME/query before database access', async () => {
  mocks.user = null;
  expect((await POST(request())).status).toBe(401);
  mocks.user = { userId: 'alice' };
  expect(
    (await POST(request(f.orderRequest, { origin: 'https://foreign.example' })))
      .status,
  ).toBe(403);
  expect(
    (await POST(request(f.orderRequest, { 'content-type': 'text/plain' })))
      .status,
  ).toBe(415);
  expect(
    (await POST(request(f.orderRequest, {}, '?wallet=other'))).status,
  ).toBe(400);
  expect(mocks.getDb).not.toHaveBeenCalled();
  expect(f.prepare).not.toHaveBeenCalled();
});
it('refuses missing preparation intent, client authority and oversized or invalid UTF-8 input before database access', async () => {
  for (const edit of [
    { prepareUnsigned: false },
    { signingAllowed: true },
    { transaction: 'untrusted' },
    { owner: 'bob' },
    { walletRevision: 0 },
  ])
    expect((await POST(request({ ...f.orderRequest, ...edit }))).status).toBe(
      400,
    );
  for (const [body, status] of [
    [' '.repeat(2049), 413],
    [new Uint8Array([255]), 400],
    ['{', 400],
  ] as const) {
    expect(
      (
        await POST(
          new Request(
            'https://bundle.example/api/imported-projects/pair-order-candidates',
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body,
            },
          ),
        )
      ).status,
    ).toBe(status);
  }
  expect(mocks.getDb).not.toHaveBeenCalled();
  expect(f.prepare).not.toHaveBeenCalled();
});
it('keeps provider failure details private and leaves no approval state', async () => {
  f.prepare.mockRejectedValueOnce(new Error('private provider configuration'));
  const response = await POST(request());
  expect(response.status).toBe(502);
  expect(JSON.stringify(await response.json())).not.toContain(
    'private provider',
  );
  expect(
    f.sqlite
      .prepare('SELECT count(*) AS n FROM imported_token_project_events')
      .get(),
  ).toMatchObject({ n: 0 });
});
it('cancels a stalled request body without a database read or unsigned provider request', async () => {
  const controller = new AbortController(),
    cancel = vi.fn(),
    stream = new ReadableStream<Uint8Array>({ cancel });
  const pending = POST(
    new Request(
      'https://bundle.example/api/imported-projects/pair-order-candidates',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: stream,
        signal: controller.signal,
        duplex: 'half',
      } as RequestInit,
    ),
  );
  controller.abort();
  expect((await pending).status).toBe(408);
  expect(cancel).toHaveBeenCalled();
  expect(mocks.getDb).not.toHaveBeenCalled();
  expect(f.prepare).not.toHaveBeenCalled();
});
it.each(['economic', 'provider'] as const)(
  'rejects %s simulation failure without leaking provider data or approval',
  async (mode) => {
    if (mode === 'economic')
      f.orderState.onSimulation = (response) => {
        response.value.accounts.pop();
      };
    else {
      const original = f.rpc.getMockImplementation()!;
      f.rpc.mockImplementation(async (method, params) => {
        if (method === 'simulateTransaction')
          throw Error('private rpc endpoint');
        return original(method, params);
      });
    }
    const response = await POST(request());
    expect(response.status).toBe(mode === 'economic' ? 409 : 502);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain('private rpc');
    expect(body).not.toHaveProperty('order');
    expect(
      f.sqlite
        .prepare('SELECT count(*) AS n FROM imported_token_project_events')
        .get(),
    ).toMatchObject({ n: 0 });
  },
);
