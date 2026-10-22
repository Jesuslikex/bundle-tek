import { afterEach, expect, it, vi } from 'vitest';
import { walletFundingTimeFixture } from '@/test/wallet-funding-time-fixture';
import { walletFundingTimes } from '@/lib/wallet-funding-time';
const state = vi.hoisted(() => ({
  user: { userId: 'owner' } as { userId: string } | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => state.user,
}));
vi.mock('@/db', () => ({ getD1: () => state.db }));
import { POST } from './route';
const request = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/wallet-workspace/funding-times', {
    method: 'POST',
    headers: {
      origin: 'http://localhost',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
afterEach(() => {
  state.user = { userId: 'owner' };
});
it('requires auth, origin, JSON and an exact bounded selection before reading storage', async () => {
  state.db = {
    prepare() {
      throw Error('Must not read');
    },
  } as unknown as D1Database;
  state.user = null;
  expect((await POST(request({}))).status).toBe(401);
  state.user = { userId: 'owner' };
  expect(
    (await POST(request({}, { origin: 'https://foreign.example' }))).status,
  ).toBe(403);
  expect(
    (await POST(request({}, { 'content-type': 'text/plain' }))).status,
  ).toBe(415);
  expect((await POST(request({ wallets: [] }))).status).toBe(400);
  expect((await POST(request({ text: 'x'.repeat(13000) }))).status).toBe(413);
});
it('uses the actual route, SQL projection and receipt decoder without exposing packet bytes', async () => {
  const f = await walletFundingTimeFixture();
  try {
    state.db = f.db;
    const selection = f.wallet();
    await f.seed();
    const result = await POST(request({ wallets: [selection] }));
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    const body = walletFundingTimes.parse(await result.json());
    expect(body.wallets[0].funding?.blockTime).toBeTypeOf('number');
    expect(body.executionAllowed).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(
      /transaction|seed|privateKey|owner_id/,
    );
    state.user = { userId: 'other' };
    expect((await POST(request({ wallets: [selection] }))).status).toBe(409);
  } finally {
    f.sqlite.close();
  }
});
