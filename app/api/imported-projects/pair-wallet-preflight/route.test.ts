import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { pairWalletFixture } from '../../../../test/pair-wallet-fixture';
import type { ImportedPairQuoteDependencies } from '@/lib/imported-pair-quote-service';
const mocks = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: null as unknown as D1Database,
  dependencies: null as unknown as ImportedPairQuoteDependencies,
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
vi.mock('@/lib/imported-pair-wallet-preflight', async (original) => {
  const actual =
    await original<typeof import('@/lib/imported-pair-wallet-preflight')>();
  return {
    ...actual,
    preflightOwnedImportedPairWallet: (
      db: D1Database,
      owner: string,
      input: Parameters<typeof actual.preflightOwnedImportedPairWallet>[2],
      signal: AbortSignal,
    ) =>
      actual.preflightOwnedImportedPairWallet(
        db,
        owner,
        input,
        signal,
        mocks.dependencies,
      ),
  };
});
import { POST } from './route';
let f: Awaited<ReturnType<typeof pairWalletFixture>>;
beforeEach(async () => {
  f = await pairWalletFixture();
  mocks.user = { userId: 'alice' };
  mocks.db = f.db;
  mocks.dependencies = f.dependencies;
  mocks.getDb.mockClear();
});
afterEach(() => f.close());
const request = (
  body: unknown = f.walletRequest,
  headers: Record<string, string> = {},
  suffix = '',
) =>
  new Request(
    'https://bundle.example/api/imported-projects/pair-wallet-preflight' +
      suffix,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
  );
it('uses the real owner-scoped quote, account policy and local SQL gate without signing', async () => {
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toMatchObject({
    format: 'imported-pair-wallet-preflight-v1',
    funding: { canRequestUnsignedOrder: true },
    transactionPrepared: false,
    signingAllowed: false,
    executionAllowed: false,
  });
  const limited = await POST(request());
  expect(limited.status).toBe(429);
  expect(limited.headers.get('retry-after')).toBe('15');
  expect(f.quote).toHaveBeenCalledOnce();
});
it('rejects missing auth, foreign origins, MIME and query fields before selecting a database', async () => {
  mocks.user = null;
  expect((await POST(request())).status).toBe(401);
  mocks.user = { userId: 'alice' };
  expect(
    (await POST(request(f.walletRequest, { origin: 'https://other.example' })))
      .status,
  ).toBe(403);
  expect(
    (await POST(request(f.walletRequest, { 'content-type': 'text/plain' })))
      .status,
  ).toBe(415);
  expect((await POST(request(f.walletRequest, {}, '?wallet=bob'))).status).toBe(
    400,
  );
  expect(mocks.getDb).not.toHaveBeenCalled();
  expect(f.rpc).not.toHaveBeenCalled();
});
it('rejects authority, invalid allowance and malformed input before selecting a database', async () => {
  for (const change of [
    { signingAllowed: true },
    { walletRevision: 0 },
    { feeAndRentLimitRaw: '0' },
    { feeAndRentLimitRaw: '18446744073709551616' },
    { provider: 'https://other.example' },
  ])
    expect(
      (await POST(request({ ...f.walletRequest, ...change }))).status,
    ).toBe(400);
  for (const [body, status] of [
    [' '.repeat(2049), 413],
    [new Uint8Array([255]), 400],
    ['{', 400],
  ] as const) {
    const response = await POST(
      new Request(
        'https://bundle.example/api/imported-projects/pair-wallet-preflight',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        },
      ),
    );
    expect(response.status).toBe(status);
  }
  expect(mocks.getDb).not.toHaveBeenCalled();
  expect(f.rpc).not.toHaveBeenCalled();
});
it('sanitizes provider failures and preserves owned-wallet errors', async () => {
  f.rpc.mockRejectedValueOnce(new Error('private provider configuration'));
  const response = await POST(request());
  expect(response.status).toBe(502);
  expect(JSON.stringify(await response.json())).not.toContain(
    'private provider',
  );
});
it('cancels a stalled request body before database or provider access', async () => {
  const controller = new AbortController(),
    cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ cancel });
  const pending = POST(
    new Request(
      'https://bundle.example/api/imported-projects/pair-wallet-preflight',
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
  const response = await pending;
  expect(response.status).toBe(408);
  expect(cancel).toHaveBeenCalled();
  expect(mocks.getDb).not.toHaveBeenCalled();
  expect(f.rpc).not.toHaveBeenCalled();
});
