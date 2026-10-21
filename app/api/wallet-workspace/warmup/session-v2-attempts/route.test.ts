import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { warmupV2AttemptProviderFixture } from '@/test/warmup-session-v2-attempt-provider-fixture';
import { warmupV2Saved } from '@/lib/wallet-warmup-session-v2-view';
import {
  warmupV2AttemptView,
  recoverWarmupV2AttemptView,
} from '@/lib/wallet-warmup-session-v2-attempt-view';
import { publicWalletWarmupV2Consent } from '@/lib/wallet-warmup-session-v2-public';
import type { publicWalletWarmupV2Attempt } from '@/lib/wallet-warmup-session-v2-attempts';
const mocks = vi.hoisted(() => ({
  db: null as unknown as D1Database,
  user: { userId: 'owner' } as { userId: string } | null,
  key: 'synthetic-key',
  simulate: vi.fn(),
  inventory: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/server-env', () => ({
  env: {
    get JUPITER_API_KEY() {
      return mocks.key;
    },
  },
}));
vi.mock('@/lib/imported-swap-simulation', async (original) => ({
  ...(await original<typeof import('@/lib/imported-swap-simulation')>()),
  simulateImportedSwap: mocks.simulate,
}));
vi.mock('@/lib/warmup-sell-inventory', async (original) => ({
  ...(await original<typeof import('@/lib/warmup-sell-inventory')>()),
  inspectWarmupSellInventory: mocks.inventory,
}));
vi.mock('@/lib/wallet-rpc-pacing', () => ({ paceWalletRpc: async () => {} }));
import { GET, POST } from './route';
let f: Awaited<ReturnType<typeof warmupV2AttemptProviderFixture>>,
  fetcher: ReturnType<typeof vi.fn>;
const url = 'http://localhost/api/wallet-workspace/warmup/session-v2-attempts';
beforeEach(async () => {
  f = await warmupV2AttemptProviderFixture();
  mocks.db = f.db;
  mocks.user = { userId: 'owner' };
  mocks.key = 'synthetic-key';
  mocks.simulate
    .mockReset()
    .mockImplementation(async (order) => f.simulation(order));
  mocks.inventory.mockReset();
  fetcher = vi.fn(async (input) => {
    const parsed = new URL(String(input));
    expect(parsed.origin + parsed.pathname).toBe(
      'https://api.jup.ag/swap/v2/order',
    );
    return Response.json(f.quote(parsed));
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  f?.client.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('uses the exact provider fee bound at the original reserve, without double-counting network fees', async () => {
  f.client.close();
  f = await warmupV2AttemptProviderFixture('0.000005');
  mocks.db = f.db;
  const response = await post();
  expect(response.status).toBe(200);
  const value = (await response.json()) as {
    attempt: ReturnType<typeof publicWalletWarmupV2Attempt>;
  };
  expect(value.attempt).toMatchObject({
    outcome: { kind: 'prepared' },
    preview: {
      estimatedFeesLamports: '5000',
      feeUpperBoundLamports: '5000',
      fees: { boundLamports: '5000' },
    },
  });
});
it.each([429, 503] as const)(
  'records HTTP%s as provider availability rather than an evidence mismatch',
  async (status) => {
    fetcher.mockResolvedValue(Response.json({ private: 'detail' }, { status }));
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      attempt: {
        outcome: {
          kind: 'refused',
          refusalCode:
            status === 429 ? 'provider-limited' : 'provider-unavailable',
        },
      },
    });
  },
);
it('retains provider timeouts as availability failures without exposing their text', async () => {
  mocks.simulate.mockRejectedValue(
    new DOMException('private timeout details', 'TimeoutError'),
  );
  const response = await post();
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain('private timeout details');
  expect(JSON.parse(text).attempt.outcome.refusalCode).toBe(
    'provider-unavailable',
  );
});
it('uses database result time when the worker clock is ahead, without changing the original finish', async () => {
  const finish = f.v2Journal.consent.terms.sessionExpiresAt;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 10000);
  const response = await post();
  expect(response.status).toBe(200);
  const value = (await response.json()) as {
    attempt: ReturnType<typeof publicWalletWarmupV2Attempt>;
  };
  expect(value.attempt.outcome?.kind).toBe('prepared');
  const sql = await f.db
    .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at")
    .first<{ at: string }>();
  expect(value.attempt.outcome!.createdAt <= sql!.at).toBe(true);
  expect(Date.parse(value.attempt.outcome!.createdAt)).toBeLessThan(
    Date.now() - 5000,
  );
  expect(value.attempt.originalHead.journal.sessionExpiresAt).toBe(finish);
});
it('discovers original IDs without a local reminder or provider call, including after Stop', async () => {
  const input = f.input();
  await post(input);
  const before = fetcher.mock.calls.length;
  await f.control('stop');
  const response = await GET(
    new Request(url + '?journalId=' + input.journalId),
  );
  expect(response.status).toBe(200);
  const value = await response.json();
  expect(value).toMatchObject({
    page: {
      journalId: input.journalId,
      requests: [{ id: input.id, sequence: 1, attempt: 1 }],
      nextBefore: null,
      signingAllowed: false,
    },
  });
  expect(fetcher.mock.calls.length).toBe(before);
  expect(
    (
      await GET(
        new Request(url + '?journalId=' + input.journalId + '&before=14400'),
      )
    ).status,
  ).toBe(400);
  mocks.user = { userId: 'another-owner' };
  expect(
    (await GET(new Request(url + '?journalId=' + input.journalId))).status,
  ).toBe(404);
});
const post = (
  body: unknown = f.input(),
  origin = 'http://localhost',
  type = 'application/json',
) =>
  POST(
    new Request(url, {
      method: 'POST',
      headers: { origin, 'content-type': type },
      body: JSON.stringify(body),
    }),
  );
async function counts() {
  return Promise.all(
    [
      'wallet_warmup_session_v2_attempts',
      'wallet_warmup_session_v2_attempt_outcomes',
      'warmup_swap_preparations',
    ].map(
      async (t) =>
        (
          await f.db
            .prepare(
              `SELECT count(*) AS n FROM ${t}${t === 'warmup_swap_preparations' ? ' WHERE plan_id=?' : ''}`,
            )
            .bind(
              ...(t === 'warmup_swap_preparations'
                ? [f.v2Journal.manifest.planId]
                : []),
            )
            .first<{ n: number }>()
        )?.n,
    ),
  );
}
it('composes real quote/envelope/native SQL/client admission with one provider run and historical recovery after Stop', async () => {
  const input = f.input(),
    response = await post(input);
  expect(response.status).toBe(200);
  const value = (await response.json()) as {
    attempt: ReturnType<typeof publicWalletWarmupV2Attempt>;
  };
  expect(value.attempt).toMatchObject({
    id: input.id,
    outcome: { kind: 'prepared' },
    preview: { inAmountRaw: '1000000' },
    signingAllowed: false,
  });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(mocks.simulate).toHaveBeenCalledOnce();
  expect(await counts()).toEqual([1, 1, 0]);
  expect(
    await f.db
      .prepare('SELECT count(*) AS n FROM warmup_swap_preparations')
      .first(),
  ).toEqual({ n: 2 });
  const privateRow = await f.db
    .prepare(
      'SELECT unsigned_transaction FROM wallet_warmup_session_v2_attempt_outcomes',
    )
    .first<{ unsigned_transaction: string }>();
  expect(privateRow?.unsigned_transaction).toBeTruthy();
  expect(JSON.stringify(value)).not.toContain(privateRow?.unsigned_transaction);
  const publicConsent = await publicWalletWarmupV2Consent(
    f.db,
    'owner',
    f.v2Journal.consent,
    new AbortController().signal,
  );
  const consent = await warmupV2Saved(
    { consent: publicConsent },
    { id: f.v2Journal.consent.id, planId: f.v2Journal.manifest.planId },
  );
  const admitted = await recoverWarmupV2AttemptView(value, input.id, consent);
  expect(admitted.attempt.preview?.inAmountRaw).toBe('1000000');
  await f.control('stop');
  const recovered = await GET(new Request(url + '?id=' + input.id));
  expect(recovered.status).toBe(200);
  expect(
    await warmupV2AttemptView(await recovered.json(), admitted.marker, consent),
  ).toEqual(admitted.attempt);
  mocks.key = '';
  expect((await post(input)).status).toBe(200);
  expect(fetcher).toHaveBeenCalledOnce();
});
it.each([
  { wallet: 'bad' },
  { amount: '1' },
  { previewRequested: false },
  { extra: true },
])(
  'rejects unapproved/client-selected input %j before provider/storage',
  async (extra) => {
    expect((await post({ ...f.input(), ...extra })).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await counts()).toEqual([0, 0, 0]);
  },
);
it('requires authentication, same origin and JSON', async () => {
  mocks.user = null;
  expect((await post()).status).toBe(401);
  expect(
    (await GET(new Request(url + '?id=' + crypto.randomUUID()))).status,
  ).toBe(401);
  mocks.user = { userId: 'owner' };
  expect((await post(f.input(), 'https://wrong.example')).status).toBe(403);
  expect((await post(f.input(), 'http://localhost', 'text/plain')).status).toBe(
    415,
  );
  expect(await counts()).toEqual([0, 0, 0]);
});
it('refuses an unconfigured provider before consuming an attempt', async () => {
  mocks.key = '';
  expect((await post()).status).toBe(503);
  expect(fetcher).not.toHaveBeenCalled();
  expect(await counts()).toEqual([0, 0, 0]);
});
it('a reservation appearing during simulation prevents atomic publication and leaves saved-only pending recovery', async () => {
  mocks.simulate.mockImplementation(async (order) => {
    await f.db
      .prepare('INSERT INTO solana_execution_reservations VALUES(?,?,?)')
      .bind('owner', f.packets.wallet, 'unknown')
      .run();
    return f.simulation(order);
  });
  const response = await post();
  expect(response.status).toBe(200);
  expect(
    (
      (await response.json()) as {
        attempt: ReturnType<typeof publicWalletWarmupV2Attempt>;
      }
    ).attempt.outcome,
  ).toBeNull();
  expect(await counts()).toEqual([1, 0, 0]);
});
it('never returns raw HTML or provider text', async () => {
  fetcher.mockResolvedValue(
    new Response('<html>secret provider detail</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    }),
  );
  const response = await post();
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain('<html>');
  expect(text).not.toContain('secret provider detail');
  expect(JSON.parse(text).attempt.outcome.kind).toBe('refused');
});
it.each([
  '?id=bad',
  '?id=00000000-0000-4000-8000-000000000000&id=00000000-0000-4000-8000-000000000000',
  '?id=00000000-0000-4000-8000-000000000000&wallet=bad',
])('refuses invalid saved-only query %s', async (query) => {
  expect((await GET(new Request(url + query))).status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
});
it('rejects a packet-hash REPLACE collision before SQLite can delete an earlier outcome', async () => {
  const original = f.input();
  expect((await post(original)).status).toBe(200);
  const first = await f.db
    .prepare(
      'SELECT * FROM wallet_warmup_session_v2_attempt_outcomes WHERE attempt_id=?',
    )
    .bind(original.id)
    .first<Record<string, string>>();
  expect(first?.kind).toBe('prepared');
  await new Promise((resolve) => setTimeout(resolve, 30100));
  const { prepareWalletWarmupV2Attempt } =
    await import('@/lib/wallet-warmup-session-v2-attempts');
  const controller = new AbortController(),
    { previewRequested: _approval, ...next } = f.input();
  const pending = await prepareWalletWarmupV2Attempt(
    f.db,
    'owner',
    next,
    true,
    controller.signal,
    'synthetic-key',
    () => async () => {
      controller.abort();
      throw Error('synthetic cancellation');
    },
  );
  expect(pending.outcome).toBeNull();
  const summary = JSON.parse(first!.summary_document);
  summary.expiresAt = pending.lease.expires_at;
  const values = (hash: string) => {
    const document = structuredClone(summary);
    document.transaction.sha256 = hash;
    return [
      'owner',
      next.id,
      'prepared',
      JSON.stringify(document),
      first!.unsigned_transaction,
      hash,
      first!.fee_document,
      null,
      new Date().toISOString(),
      pending.lease.expires_at,
      'a'.repeat(64),
    ];
  };
  await expect(
    f.db
      .prepare(
        'INSERT OR REPLACE INTO wallet_warmup_session_v2_attempt_outcomes VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(...values(first!.packet_sha256))
      .run(),
  ).rejects.toThrow('expired or changed');
  expect(
    await f.db
      .prepare(
        'SELECT * FROM wallet_warmup_session_v2_attempt_outcomes WHERE attempt_id=?',
      )
      .bind(original.id)
      .first(),
  ).toEqual(first);
  const numeric = values('c'.repeat(64));
  const numericSummary = JSON.parse(String(numeric[3]));
  numericSummary.simulation.minimumOutputCovered = 1;
  numeric[3] = JSON.stringify(numericSummary);
  await expect(
    f.db
      .prepare(
        'INSERT INTO wallet_warmup_session_v2_attempt_outcomes VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(...numeric)
      .run(),
  ).rejects.toThrow('expired or changed');
  // SQL cannot hash bytes: a distinct digest is the otherwise admissible raw-SQL control.
  await f.db
    .prepare(
      'INSERT OR REPLACE INTO wallet_warmup_session_v2_attempt_outcomes VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    )
    .bind(...values('c'.repeat(64)))
    .run();
  expect(
    await f.db
      .prepare(
        'SELECT count(*) AS n FROM wallet_warmup_session_v2_attempt_outcomes',
      )
      .first(),
  ).toEqual({ n: 2 });
}, 45000);
it.each([400, 422])(
  'keeps HTTP%s provider rejection distinct from availability',
  async (status) => {
    fetcher.mockResolvedValue(Response.json({ private: 'detail' }, { status }));
    const response = await post();
    expect(response.status).toBe(200);
    expect(
      (
        (await response.json()) as {
          attempt: { outcome: { refusalCode: string } };
        }
      ).attempt.outcome.refusalCode,
    ).toBe(status === 400 ? 'provider-refused' : 'provider-unavailable');
  },
);
it('does not mislabel an internal TypeError as provider availability', async () => {
  mocks.simulate.mockRejectedValue(new TypeError('private programmer detail'));
  const response = await post();
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain('private programmer detail');
  expect(JSON.parse(text).attempt.outcome.refusalCode).toBe('evidence-refused');
});
it.each([false, true])(
  'saved-buy Sell preview requires an explicit remaining balance (null=%s)',
  async (nullRemaining) => {
    f.client.close();
    const { warmupV2SavedBuyAttemptProviderFixture } =
      await import('@/test/warmup-session-v2-attempt-provider-fixture');
    f = await warmupV2SavedBuyAttemptProviderFixture(nullRemaining);
    mocks.db = f.db;
    mocks.inventory.mockImplementation(
      async (_wallet, _mint, _signal, amount) => f.inventory(amount),
    );
    const response = await post();
    if (nullRemaining) {
      expect(response.status).toBe(409);
      expect(fetcher).not.toHaveBeenCalled();
      expect(await counts()).toEqual([0, 0, 0]);
    } else {
      expect(response.status).toBe(200);
      const value = (await response.json()) as {
        attempt: ReturnType<typeof publicWalletWarmupV2Attempt>;
      };
      expect(value.attempt).toMatchObject({
        outcome: { kind: 'prepared' },
        preview: {
          side: 'Sell',
          inAmountRaw: '101',
          outputMint: 'So11111111111111111111111111111111111111112',
        },
      });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(mocks.inventory).toHaveBeenCalledOnce();
    }
  },
  15000,
);
