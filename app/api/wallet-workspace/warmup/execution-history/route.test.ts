import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  solanaFamilyExclusionFixture,
  familyExclusionD1,
} from '@/test/solana-family-exclusion-fixture';
const mocks = vi.hoisted(() => ({
  db: null as unknown as D1Database,
  user: { userId: 'owner' } as { userId: string } | null,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
import * as route from './route';
let sqlite: ReturnType<typeof solanaFamilyExclusionFixture>;
let statements: string[];
beforeEach(() => {
  sqlite = solanaFamilyExclusionFixture();
  statements = [];
  mocks.user = { userId: 'owner' };
  const original = familyExclusionD1(sqlite);
  mocks.db = {
    prepare(sql: string) {
      statements.push(sql);
      if (!/^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql))
        throw Error('No route writes');
      const st = original.prepare(sql);
      const w = {
        bind(...v: unknown[]) {
          st.bind(...v);
          return w;
        },
        first: () => st.first(),
        async all() {
          return { ...(await st.all()), success: true };
        },
      };
      return w;
    },
  } as unknown as D1Database;
});
afterEach(() => {
  sqlite.close();
  vi.restoreAllMocks();
});
const url = 'https://bundle.test/api/wallet-workspace/warmup/execution-history';
it('requires authentication before database access', async () => {
  mocks.user = null;
  const response = await route.GET(new Request(url));
  expect(response.status).toBe(401);
  expect(statements).toEqual([]);
});
it('returns actual owned empty metadata with no-store and all authority off', async () => {
  const response = await route.GET(new Request(url));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toMatchObject({
    format: 'wallet-warmup-execution-inventory-v1',
    rows: [],
    quota: {
      remainingProposals: 128,
      capacityReserved: false,
      pruningSupported: false,
    },
    executionAllowed: false,
    signingAllowed: false,
  });
  expect(route).not.toHaveProperty('POST');
});
it.each([
  '?cursor=',
  '?cursor=a&cursor=b',
  '?owner=other',
  '?status=root-recorded',
  '?limit=500',
  '?cursor=' + 'x'.repeat(257),
])('rejects unsupported or malformed query %s before SQL', async (query) => {
  const response = await route.GET(new Request(url + query));
  expect(response.status).toBe(400);
  expect(statements).toEqual([]);
});
it('refuses partial installed storage with sanitized unavailable output', async () => {
  sqlite.exec('DROP TRIGGER warmup_proposal_chunk_no_delete');
  const response = await route.GET(new Request(url));
  expect(response.status).toBe(503);
  expect(await response.text()).not.toMatch(/sqlite|trigger|SELECT|private/);
});
it('returns cancellation without a retry or write', async () => {
  const c = new AbortController();
  c.abort();
  const response = await route.GET(new Request(url, { signal: c.signal }));
  expect(response.status).toBe(408);
  expect(statements).toEqual([]);
});
it('refuses a request body even when invoked outside the normal GET transport', async () => {
  const response = await route.GET(
    new Request(url, { method: 'POST', body: '{}' }),
  );
  expect(response.status).toBe(400);
  expect(statements).toEqual([]);
});
