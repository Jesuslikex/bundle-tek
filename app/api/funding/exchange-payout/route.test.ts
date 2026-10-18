import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { exchangePayoutApiFixture } from '@/test/exchange-payout-api-fixture';
import { readOwnedExchangeOrder } from '@/lib/exchange-order-service';
import { exchangeOrderAuthority } from '@/lib/exchange-order-review';
const state = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: null as D1Database | null,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => state.user,
}));
vi.mock('@/db', () => ({ getD1: () => state.db }));
vi.mock('@/lib/solana-rpc', () => ({
  getSolanaRpcEndpoint: () => 'https://rpc.example.invalid/private-fixture',
}));
vi.mock('@/lib/wallet-rpc-pacing', () => ({
  paceWalletRpc: vi.fn(async () => {}),
}));
import { POST } from './route';
let f: Awaited<ReturnType<typeof exchangePayoutApiFixture>>,
  fetcher: ReturnType<typeof vi.fn>;
const request = (
  input: unknown = f.input,
  headers: Record<string, string> = {
    origin: 'https://bundle.test',
    'content-type': 'application/json',
  },
) =>
  new Request('https://bundle.test/api/funding/exchange-payout', {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
  });
beforeEach(async () => {
  f = await exchangePayoutApiFixture();
  state.db = f.db;
  state.user = { userId: 'alice' };
  vi.spyOn(Date, 'now').mockReturnValue(f.now);
  fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '');
    return Response.json({
      jsonrpc: '2.0',
      id: 1,
      result: f.result(body.method),
    });
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  f.client.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('retains a real decoded finalized fixture once and returns only the public saved order, with all authority off', async () => {
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = (await response.json()) as { order: Record<string, unknown> };
  expect(body.order).toMatchObject({
    id: f.input.id,
    state: 'payout-verified',
    payoutVerified: true,
    currentSpendabilityVerified: false,
    ...exchangeOrderAuthority,
  });
  expect(fetcher).toHaveBeenCalledTimes(5);
  expect(JSON.stringify(body)).not.toMatch(
    /private-provider-fixture|private-fixture-rate|payinAddress/,
  );
  expect((await POST(request())).status).toBe(200);
  expect(fetcher).toHaveBeenCalledTimes(5);
  expect(
    (
      await f.client.execute(
        'SELECT count(*) AS n FROM exchange_funding_payout_receipts',
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (await readOwnedExchangeOrder(f.db, 'alice', f.input.id))
      .retryCreationAllowed,
  ).toBe(false);
});
it('refuses authentication, origin, MIME, body size, injected signature/URL and changed or foreign order before RPC', async () => {
  state.user = null;
  expect((await POST(request())).status).toBe(401);
  state.user = { userId: 'alice' };
  expect(
    (await POST(request(f.input, { 'content-type': 'application/json' })))
      .status,
  ).toBe(403);
  expect(
    (
      await POST(
        request(f.input, {
          origin: 'https://bundle.test',
          'content-type': 'text/plain',
        }),
      )
    ).status,
  ).toBe(415);
  expect(
    (await POST(request({ ...f.input, padding: 'x'.repeat(2048) }))).status,
  ).toBe(413);
  for (const extra of [
    { signature: f.payout.expected.signature },
    { endpoint: 'https://other.invalid' },
  ])
    expect((await POST(request({ ...f.input, ...extra }))).status).toBe(400);
  expect(
    (await POST(request({ ...f.input, sha256: '0'.repeat(64) }))).status,
  ).toBe(409);
  state.user = { userId: 'bob' };
  expect((await POST(request())).status).toBe(404);
  expect(fetcher).not.toHaveBeenCalled();
});
it('stops on the first provider 429, preserves the order hold and uses an isolated fifteen-second read gate', async () => {
  fetcher.mockResolvedValueOnce(
    new Response('private provider diagnostic', { status: 429 }),
  );
  const response = await POST(request());
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('15');
  expect(JSON.stringify(await response.json())).not.toContain(
    'private provider diagnostic',
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await POST(request())).status).toBe(429);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(
    (
      await f.client.execute(
        'SELECT count(*) AS n FROM exchange_funding_payout_receipts',
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (await readOwnedExchangeOrder(f.db, 'alice', f.input.id))
      .retryCreationAllowed,
  ).toBe(false);
  expect(
    (
      await f.client.execute({
        sql: 'SELECT count(*) AS n FROM wallet_balance_gates WHERE owner_id=?',
        args: ['alice'],
      })
    ).rows[0].n,
  ).toBe(0);
});
it('does not retain a mismatched payout or release its hold', async () => {
  const transaction = structuredClone(f.payout.evidence.transaction);
  transaction.meta.postBalances[1] = '1';
  fetcher.mockImplementation(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '');
    return Response.json({
      jsonrpc: '2.0',
      id: 1,
      result:
        body.method === 'getTransaction' ? transaction : f.result(body.method),
    });
  });
  expect((await POST(request())).status).toBe(409);
  expect(
    (
      await f.client.execute(
        'SELECT count(*) AS n FROM exchange_funding_payout_receipts',
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (await readOwnedExchangeOrder(f.db, 'alice', f.input.id))
      .retryCreationAllowed,
  ).toBe(false);
});

it('does not spend the read gate when a finished provider record lacks a payout reference', async () => {
  f.client.close();
  f = await exchangePayoutApiFixture(false);
  state.db = f.db;
  expect((await POST(request())).status).toBe(409);
  expect(fetcher).not.toHaveBeenCalled();
  expect(
    (await f.client.execute('SELECT count(*) AS n FROM wallet_balance_gates'))
      .rows[0].n,
  ).toBe(0);
});
it('admits one concurrent verification and retains exactly one credit', async () => {
  let begin!: () => void, release!: (value: Response) => void;
  const started = new Promise<void>((resolve) => {
    begin = resolve;
  });
  fetcher.mockImplementationOnce(() => {
    begin();
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  const first = POST(request());
  await started;
  const second = await POST(request());
  expect(second.status).toBe(429);
  expect(fetcher).toHaveBeenCalledTimes(1);
  release(
    Response.json({
      jsonrpc: '2.0',
      id: 1,
      result: f.payout.evidence.genesisBefore,
    }),
  );
  expect((await first).status).toBe(200);
  expect(fetcher).toHaveBeenCalledTimes(5);
  expect(
    (
      await f.client.execute(
        'SELECT count(*) AS n FROM exchange_funding_payout_receipts',
      )
    ).rows[0].n,
  ).toBe(1);
});
it('cancels ignored transport without continuing RPC or retaining a partial receipt', async () => {
  const controller = new AbortController();
  let begin!: () => void, release!: (value: Response) => void;
  const started = new Promise<void>((resolve) => {
    begin = resolve;
  });
  fetcher.mockImplementationOnce(() => {
    begin();
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  const pending = POST(
    new Request('https://bundle.test/api/funding/exchange-payout', {
      method: 'POST',
      headers: {
        origin: 'https://bundle.test',
        'content-type': 'application/json',
      },
      body: JSON.stringify(f.input),
      signal: controller.signal,
    }),
  );
  await started;
  controller.abort();
  expect((await pending).status).toBe(503);
  release(
    Response.json({
      jsonrpc: '2.0',
      id: 1,
      result: f.payout.evidence.genesisBefore,
    }),
  );
  await Promise.resolve();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(
    (
      await f.client.execute(
        'SELECT count(*) AS n FROM exchange_funding_payout_receipts',
      )
    ).rows[0].n,
  ).toBe(0);
});
