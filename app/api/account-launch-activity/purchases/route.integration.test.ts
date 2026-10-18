import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { Client } from '@libsql/client';
import { pumpPurchaseHttpFixture } from '@/test/pump-purchase-http-fixture';
import { preflightOwnedPumpCreate } from '@/lib/owned-pump-preflight';
import {
  validatedLaunchPurchaseView,
  validatedLaunchPurchaseHistory,
} from '@/lib/account-launch-purchases';
const m = vi.hoisted(() => ({
  user: { userId: 'alice' },
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({ getChatGPTUser: async () => m.user }));
vi.mock('@/db', () => ({ getD1: () => m.db }));
vi.mock('@/lib/owned-pump-preflight', async (original) => ({
  ...(await original<typeof import('@/lib/owned-pump-preflight')>()),
  preflightOwnedPumpCreate: vi.fn(),
}));
vi.mock('@/lib/pump-group-code-identity', async (original) => ({
  ...(await original<typeof import('@/lib/pump-group-code-identity')>()),
  collectPumpProgramIdentities: vi.fn(),
}));
import { GET, POST } from './route';
const clients: Client[] = [];
let f: Awaited<ReturnType<typeof pumpPurchaseHttpFixture>>;
const url = 'https://bundle.example/api/account-launch-activity/purchases';
beforeAll(async () => {
  f = await pumpPurchaseHttpFixture(
    vi.mocked(preflightOwnedPumpCreate),
    clients,
  );
  m.db = f.db;
}, 120000);
afterAll(() => {
  for (const c of clients) c.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it('runs exact owner HTTP preview/save/reload through real receipt/terminal/SQL services and client admission without RPC or submission', async () => {
  const reads = f.reads.length,
    sends = f.sends.length,
    selection = {
      reviewId: f.reviewId,
      mint: f.mint,
      receiptId: f.receiptId,
      receiptSha256: f.receiptSha256,
    };
  const get = await GET(
    new Request(`${url}?reviewId=${f.reviewId}&receiptId=${f.receiptId}`),
  );
  expect(get.status).toBe(200);
  expect(get.headers.get('cache-control')).toBe('no-store');
  const preview = await validatedLaunchPurchaseView(
    await get.json(),
    selection,
  );
  expect(preview.plan.sources).toHaveLength(18);
  expect(preview.saved).toBe(false);
  const before = (await f.client.execute('SELECT * FROM pump_launch_reviews'))
    .rows;
  const body = {
    reviewId: f.reviewId,
    receiptId: f.receiptId,
    planSha256: preview.plan.sha256,
    policy: 'reviewed-buy-shares-v1',
    approved: true,
  };
  const post = () =>
    POST(
      new Request(url, {
        method: 'POST',
        headers: {
          origin: 'https://bundle.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
    );
  const save = await post();
  expect(save.status).toBe(200);
  const saved = await validatedLaunchPurchaseView(await save.json(), selection);
  expect(saved.saved).toBe(true);
  expect(JSON.stringify(saved)).not.toContain(
    f.group.signedEvidence!.packets[0].transaction,
  );
  const retry = await post();
  expect(retry.status).toBe(200);
  expect(
    await validatedLaunchPurchaseView(await retry.json(), selection),
  ).toEqual(saved);
  const history = await GET(new Request(url + '?reviewId=' + f.reviewId));
  expect(history.status).toBe(200);
  const result = await validatedLaunchPurchaseHistory(
    await history.json(),
    selection,
  );
  expect(result.sources).toHaveLength(18);
  expect(result.executionAllowed).toBe(false);
  expect(
    (
      await f.client.execute(
        'SELECT count(*) AS n FROM pump_purchase_cost_sources',
      )
    ).rows[0].n,
  ).toBe(18);
  expect(
    (await f.client.execute('SELECT * FROM pump_launch_reviews')).rows,
  ).toEqual(before);
  m.user = { userId: 'bob' };
  expect((await GET(new Request(url + '?reviewId=' + f.reviewId))).status).toBe(
    404,
  );
  expect(f.reads.length).toBe(reads);
  expect(f.sends.length).toBe(sends);
}, 120000);
