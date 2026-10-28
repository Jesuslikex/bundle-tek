import { beforeEach, expect, it, vi } from 'vitest';
import { nativeWithdrawalFixture } from '../../../../test/native-withdrawal-fixture';
import {
  WITHDRAWAL_OWNER_SCOPE_HEADER,
  withdrawalOwnerScope,
} from '@/lib/native-withdrawal-owner-scope';
const mock = vi.hoisted(() => ({
  user: 'alice' as string | null,
  exact: null as unknown,
  reads: 0,
  dbCalls: 0,
  lastSql: '',
  lastArgs: [] as unknown[],
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () =>
    mock.user ? { userId: mock.user, email: 'fixture@example.test' } : null,
}));
vi.mock('@/db', () => ({
  getD1: () => (
    mock.dbCalls++,
    {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () => {
            mock.reads++;
            mock.lastSql = sql;
            mock.lastArgs = args;
            if (sql.includes('AND id=?'))
              return args.length === 3 &&
                args[0] === 'alice' &&
                args[1] ===
                  (mock.exact as { wallet_address: string }).wallet_address &&
                args[2] === (mock.exact as { id: string }).id
                ? mock.exact
                : null;
            return null;
          },
          all: async () => {
            mock.reads++;
            return { results: [] };
          },
        }),
      }),
    }
  ),
}));
import { GET, POST } from './route';
beforeEach(() => {
  mock.user = 'alice';
  mock.exact = null;
  mock.reads = 0;
  mock.dbCalls = 0;
  mock.lastSql = '';
  mock.lastArgs = [];
});
async function fixture() {
  const f = await nativeWithdrawalFixture();
  mock.exact = {
    id: f.review.id,
    wallet_address: f.wallet,
    wallet: f.wallet,
    walletRevision: f.review.walletRevision,
    state: 'cancelled',
    signature: null,
    document: JSON.stringify(f.review),
    receipt: null,
    failureReceipt: null,
    createdAt: f.review.preparedAt,
    updatedAt: f.review.preparedAt,
  };
  const scope = await withdrawalOwnerScope('alice');
  const query = `wallet=${f.wallet}&withdrawalId=${f.review.id}`;
  const request = (q: string, header: string | null = scope) =>
    new Request(`http://localhost/api/wallet-workspace/withdrawals?${q}`, {
      headers:
        header === null ? {} : { [WITHDRAWAL_OWNER_SCOPE_HEADER]: header },
    });
  return { f, scope, query, request };
}
it('returns only the exact owner and wallet scoped validated row', async () => {
  const { f, scope, query, request } = await fixture();
  const response = await GET(request(query));
  expect(response.status).toBe(200);
  expect(response.headers.get(WITHDRAWAL_OWNER_SCOPE_HEADER)).toBe(scope);
  expect(await response.json()).toMatchObject({
    withdrawal: { id: f.review.id },
  });
  expect(mock.reads).toBe(1);
});
it('rejects missing, mismatched or signed-out owner scopes before exact database access', async () => {
  const { query, request } = await fixture();
  expect((await GET(request(query, null))).status).toBe(400);
  expect(
    (await GET(request(query, await withdrawalOwnerScope('bob')))).status,
  ).toBe(409);
  mock.user = null;
  expect((await GET(request(query))).status).toBe(401);
  expect(mock.reads).toBe(0);
});
it('rejects malformed, duplicate, or cursor-mixed exact queries', async () => {
  const { f, query, request } = await fixture();
  for (const q of [
    `${query}&cursor=${f.review.id}`,
    `${query}&withdrawalId=${f.review.id}`,
    `${query}&wallet=${f.wallet}`,
    `wallet=${f.wallet}&withdrawalId=invalid`,
    `${query}&leg=1`,
  ])
    expect((await GET(request(q))).status).toBe(400);
  expect(mock.reads).toBe(0);
});
it('does not return a row belonging to another owner or wallet', async () => {
  const { f, query, request } = await fixture();
  mock.user = 'bob';
  expect(
    (await GET(request(query, await withdrawalOwnerScope('bob')))).status,
  ).toBe(404);
  mock.user = 'alice';
  expect(
    (
      await GET(
        request(
          `wallet=11111111111111111111111111111111&withdrawalId=${f.review.id}`,
        ),
      )
    ).status,
  ).toBe(404);
});
it('retains unscoped legacy history reads', async () => {
  const { f, request } = await fixture();
  const response = await GET(request(`wallet=${f.wallet}`, null));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ withdrawals: [] });
});
it('keeps exact reads constrained to the requested funding scope', async () => {
  const { f, query, request } = await fixture();
  const response = await GET(
    request(`${query}&planId=${f.review.id}&revision=1&item=1&leg=1`),
  );
  expect(response.status).toBe(404);
  expect(mock.lastSql).toContain("json_extract(document,'$.funding.planId')=?");
  expect(mock.lastSql).toContain("json_extract(document,'$.funding.leg')=?");
  expect(mock.lastArgs).toEqual([
    'alice',
    f.wallet,
    f.review.id,
    f.review.id,
    1,
    1,
    1,
  ]);
});
it.each([
  'prepare',
  'begin_signing',
  'reject_signing',
  'register',
  'submit',
  'recover',
  'cancel',
])(
  'rejects stale owner scope for %s before parsing or database work, even with a shared wallet',
  async (action) => {
    const { f, scope } = await fixture();
    mock.user = 'bob';
    const request = new Request(
      'http://localhost/api/wallet-workspace/withdrawals',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [WITHDRAWAL_OWNER_SCOPE_HEADER]: scope,
        },
        body: JSON.stringify({
          action,
          wallet: f.wallet,
          walletRevision: f.review.walletRevision,
          id: f.review.id,
        }),
      },
    );
    const response = await POST(request);
    expect(response.status).toBe(409);
    expect(request.bodyUsed).toBe(false);
    expect(response.headers.get(WITHDRAWAL_OWNER_SCOPE_HEADER)).toBe(
      await withdrawalOwnerScope('bob'),
    );
    expect(mock.dbCalls).toBe(0);
    expect(mock.reads).toBe(0);
  },
);
it('keeps legacy unscoped POST callers compatible', async () => {
  const response = await POST(
    new Request('http://localhost/api/wallet-workspace/withdrawals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'not-an-action' }),
    }),
  );
  expect(response.status).toBe(400);
  expect(response.headers.get(WITHDRAWAL_OWNER_SCOPE_HEADER)).toBe(
    await withdrawalOwnerScope('alice'),
  );
  expect(mock.dbCalls).toBe(0);
});
