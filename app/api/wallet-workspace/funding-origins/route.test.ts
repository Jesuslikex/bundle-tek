import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fundingOriginApiFixture } from '@/test/wallet-funding-origin-api-fixture';
const state = vi.hoisted(() => ({
  user: { userId: 'owner' } as { userId: string } | null,
  db: null as unknown as D1Database,
  rpc: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => state.user,
}));
vi.mock('@/db', () => ({ getD1: () => state.db }));
vi.mock('@/lib/wallet-funding-origin-rpc', () => ({
  fundingOriginRpc: (_endpoint: string, method: string, params: unknown[]) =>
    state.rpc(method, params),
}));
import { env } from '@/lib/server-env';
import { POST } from './route';
import { fundingOriginBatch } from '@/lib/wallet-funding-origin-view';
let f: ReturnType<typeof fundingOriginApiFixture>;
beforeEach(() => {
  f = fundingOriginApiFixture();
  state.db = f.db;
  env.SOLANA_HOLDER_RPC_URL = f.endpoint;
  state.user = { userId: 'owner' };
  state.rpc.mockReset().mockImplementation(f.rpc);
});
afterEach(() => {
  f.close();
  delete env.SOLANA_HOLDER_RPC_URL;
});
const req = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://bundle.test/api/wallet-workspace/funding-origins', {
    method: 'POST',
    headers: {
      origin: 'https://bundle.test',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
it('uses actual ownership and decoder through the signed-in same-origin route', async () => {
  const response = await POST(req({ wallets: f.wallets, context: f.wallets }));
  expect(response.status).toBe(200);
  const body = fundingOriginBatch.parse(await response.json());
  expect(body.wallets[0].funding?.signature).toBe(
    f.records[0].history.data[0].signature,
  );
  expect(body.signingAllowed).toBe(false);
  expect(response.headers.get('cache-control')).toBe('no-store');
});
it('refuses guest, wrong origin, wrong content and extra fields without a provider read', async () => {
  state.user = null;
  expect(
    (await POST(req({ wallets: f.wallets, context: f.wallets }))).status,
  ).toBe(401);
  state.user = { userId: 'owner' };
  expect(
    (
      await POST(
        req(
          { wallets: f.wallets, context: f.wallets },
          { origin: 'https://other.test' },
        ),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await POST(
        req(
          { wallets: f.wallets, context: f.wallets },
          { 'content-type': 'text/plain' },
        ),
      )
    ).status,
  ).toBe(415);
  expect(
    (await POST(req({ wallets: f.wallets, endpoint: 'private' }))).status,
  ).toBe(400);
  expect(state.rpc).not.toHaveBeenCalled();
});
it('rejects over-sized bodies and too many wallets before provider work', async () => {
  expect(
    (await POST(req({ wallets: f.wallets, padding: 'x'.repeat(13000) })))
      .status,
  ).toBe(413);
  expect(
    (await POST(req({ wallets: Array(11).fill(f.wallets[0]) }))).status,
  ).toBe(400);
  expect(state.rpc).not.toHaveBeenCalled();
});
it('returns the gate retry hint and static errors without private provider text', async () => {
  await POST(req({ wallets: f.wallets, context: f.wallets }));
  const blocked = await POST(req({ wallets: f.wallets, context: f.wallets }));
  expect(blocked.status).toBe(429);
  expect(blocked.headers.get('retry-after')).toBe('60');
  f.sqlite.exec('DELETE FROM imported_token_project_gates');
  state.rpc.mockRejectedValue(new Error('fixture-private-provider-secret'));
  const failed = await POST(req({ wallets: f.wallets, context: f.wallets }));
  expect(failed.status).toBe(502);
  expect(await failed.text()).not.toContain('fixture-private-provider-secret');
});

it('does not fall back to indexer or mainnet credentials when the explicit holder setting is absent', async () => {
  delete env.SOLANA_HOLDER_RPC_URL;
  env.SOLANA_INDEXER_RPC_URL = f.endpoint;
  try {
    const result = await POST(req({ wallets: f.wallets, context: f.wallets }));
    expect(result.status).toBe(503);
    expect(state.rpc).not.toHaveBeenCalled();
  } finally {
    delete env.SOLANA_INDEXER_RPC_URL;
  }
});
it('honors an already-cancelled request before any provider work', async () => {
  const c = new AbortController();
  c.abort();
  const request = new Request(req({ wallets: f.wallets, context: f.wallets }), {
    signal: c.signal,
  });
  expect((await POST(request)).status).toBe(408);
  expect(state.rpc).not.toHaveBeenCalled();
});

it('returns 408 when its forty-five-second budget expires during pending provider work', async () => {
  const budget = new AbortController();
  const spy = vi
    .spyOn(AbortSignal, 'timeout')
    .mockImplementation((ms) =>
      ms === 45000 ? budget.signal : new AbortController().signal,
    );
  let release!: (r: unknown) => void;
  state.rpc.mockImplementation(
    () =>
      new Promise<unknown>((r) => {
        release = r;
      }),
  );
  try {
    const response = POST(req({ wallets: f.wallets, context: f.wallets }));
    for (let i = 0; i < 50 && !release; i++) await Promise.resolve();
    expect(release).toBeDefined();
    expect(spy).toHaveBeenCalledWith(45000);
    budget.abort(new DOMException('Timeout', 'TimeoutError'));
    release('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
    expect((await response).status).toBe(408);
    expect(state.rpc).toHaveBeenCalledTimes(1);
  } finally {
    spy.mockRestore();
  }
});
