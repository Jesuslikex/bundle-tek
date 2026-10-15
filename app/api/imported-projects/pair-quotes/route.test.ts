import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { importedPairQuoteFixture } from '../../../../test/imported-pair-quote-fixture';
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
vi.mock('@/lib/imported-pair-quote-service', async (original) => {
  const actual =
    await original<typeof import('@/lib/imported-pair-quote-service')>();
  return {
    ...actual,
    quoteOwnedImportedPair: (
      db: D1Database,
      owner: string,
      input: Parameters<typeof actual.quoteOwnedImportedPair>[2],
      signal: AbortSignal,
    ) =>
      actual.quoteOwnedImportedPair(
        db,
        owner,
        input,
        signal,
        mocks.dependencies,
      ),
  };
});
import { POST } from './route';
let f: ReturnType<typeof importedPairQuoteFixture>;
beforeEach(() => {
  f = importedPairQuoteFixture();
  mocks.user = { userId: 'alice' };
  mocks.db = f.db;
  mocks.dependencies = f.dependencies;
  mocks.getDb.mockClear();
});
afterEach(() => f.close());
const request = (
  body: unknown = f.request,
  headers: Record<string, string> = {},
  suffix = '',
) =>
  new Request('http://localhost/api/imported-projects/pair-quotes' + suffix, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
it('uses the real owned route and SQL gate for an explicitly labelled quote without preparing or signing anything', async () => {
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const result = await response.json();
  expect(result).toMatchObject({
    inputRaw: '1',
    inputAmount: '0.00000001',
    signingAllowed: false,
    executionAllowed: false,
    balancesChecked: false,
    pair: { quote: { symbol: 'TSLAX', decimals: 8 } },
  });
  expect((await POST(request())).status).toBe(429);
  expect(f.quote).toHaveBeenCalledOnce();
});
it('reports real stock mint incompatibility as 409 before requesting a quote', async () => {
  const snapshot = JSON.parse(
    readFileSync('test/tslax-mainnet-mint-20261015.json', 'utf8'),
  );
  f.mints[1] = snapshot.account;
  const response = await POST(request());
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: expect.stringContaining('scaled amounts'),
  });
  expect(f.quote).not.toHaveBeenCalled();
});
it('keeps transport failures separate from unsupported policy responses', async () => {
  f.rpc.mockRejectedValueOnce(new Error('private provider text'));
  const response = await POST(request());
  expect(response.status).toBe(502);
  expect(JSON.stringify(await response.json())).not.toContain(
    'private provider text',
  );
  expect(f.quote).not.toHaveBeenCalled();
});
it.each(['missing', 'base64'] as const)(
  'reports %s mint RPC data as unavailable rather than unsupported token policy',
  async (mode) => {
    const original = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation(async (method, params) => {
      if (method === 'getMultipleAccounts')
        return {
          context: { slot: '101' },
          value: [
            f.mints[0],
            mode === 'missing'
              ? null
              : {
                  ...f.mints[1],
                  data: ['invalid-base64%', 'base64'],
                },
          ],
        };
      return original(method, params);
    });
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain(
      'scaled amounts',
    );
    expect(f.quote).not.toHaveBeenCalled();
  },
);
it('rejects missing auth, cross-origin and invalid MIME/URL/body fields before provider work', async () => {
  mocks.user = null;
  expect((await POST(request())).status).toBe(401);
  mocks.user = { userId: 'alice' };
  expect(
    (await POST(request(f.request, { origin: 'https://foreign.example' })))
      .status,
  ).toBe(403);
  expect(
    (await POST(request(f.request, { 'content-type': 'text/plain' }))).status,
  ).toBe(415);
  expect((await POST(request(f.request, {}, '?owner=bob'))).status).toBe(400);
  for (const extra of [
    { owner: 'bob' },
    { signingAllowed: true },
    { wallet: f.baseMint },
    { provider: 'https://other.example' },
    { quoteDecimals: 9 },
  ])
    expect((await POST(request({ ...f.request, ...extra }))).status).toBe(400);
  expect(f.rpc).not.toHaveBeenCalled();
  expect(f.quote).not.toHaveBeenCalled();
});
it('keeps ownership, revision and input precision checks ahead of provider reads', async () => {
  mocks.user = { userId: 'bob' };
  expect((await POST(request())).status).toBe(404);
  mocks.user = { userId: 'alice' };
  expect((await POST(request({ ...f.request, revision: 2 }))).status).toBe(409);
  expect(
    (await POST(request({ ...f.request, amount: '0.000000001' }))).status,
  ).toBe(400);
  expect(f.rpc).not.toHaveBeenCalled();
});
it('bounds bytes and rejects invalid UTF-8 JSON before selecting a database', async () => {
  for (const [body, status] of [
    [' '.repeat(1601), 413],
    [new Uint8Array([255]), 400],
    ['{', 400],
  ] as const) {
    const response = await POST(
      new Request('http://localhost/api/imported-projects/pair-quotes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    );
    expect(response.status).toBe(status);
  }
  expect(mocks.getDb).not.toHaveBeenCalled();
  expect(f.rpc).not.toHaveBeenCalled();
});
it('cancels a stalled streamed body and does not reach storage or providers', async () => {
  const controller = new AbortController(),
    cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ pull() {}, cancel });
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    duplex: 'half',
    signal: controller.signal,
  };
  const pending = POST(
    new Request('http://localhost/api/imported-projects/pair-quotes', init),
  );
  await Promise.resolve();
  await Promise.resolve();
  controller.abort();
  expect((await pending).status).toBe(408);
  expect(cancel).toHaveBeenCalled();
  expect(mocks.getDb).not.toHaveBeenCalled();
  expect(f.rpc).not.toHaveBeenCalled();
});
