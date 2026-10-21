import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { warmupSessionProviderFixture } from '@/test/warmup-session-provider-fixture';
import { readWalletWarmupSessionPreparation } from '@/lib/wallet-warmup-session-preparation';
import type { publicWalletWarmupSessionPreparation } from '@/lib/wallet-warmup-session-preparation-public';
import { retainWalletWarmupSessionSettlement } from '@/lib/wallet-warmup-session-settlement-storage';
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
vi.mock('@/lib/imported-swap-simulation', () => ({
  simulateImportedSwap: mocks.simulate,
}));
vi.mock('@/lib/warmup-sell-inventory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/warmup-sell-inventory')>()),
  inspectWarmupSellInventory: mocks.inventory,
}));
vi.mock('@/lib/wallet-rpc-pacing', () => ({ paceWalletRpc: async () => {} }));
import { GET, POST } from './route';
let f: Awaited<ReturnType<typeof warmupSessionProviderFixture>>,
  fetcher: ReturnType<typeof vi.fn>;
const url = 'http://localhost/api/wallet-workspace/warmup/session-preparations';
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  f = await warmupSessionProviderFixture();
  mocks.db = f.db;
  mocks.user = { userId: 'owner' };
  mocks.key = 'synthetic-key';
  mocks.simulate
    .mockReset()
    .mockImplementation(async (order) => f.simulation(order));
  mocks.inventory.mockReset();
  fetcher = vi.fn(async (input) => {
    const request = new URL(String(input));
    expect(request.origin + request.pathname).toBe(
      'https://api.jup.ag/swap/v2/order',
    );
    return Response.json(f.quote(request));
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  f?.client.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function post(
  body: unknown = f.input(),
  headers: Record<string, string | undefined> = {
    origin: 'http://localhost',
    'content-type': 'application/json',
  },
  signal?: AbortSignal,
) {
  const requestHeaders = new Headers();
  for (const [k, v] of Object.entries(headers))
    if (v !== undefined) requestHeaders.set(k, v);
  return POST(
    new Request(url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(body),
      signal,
    }),
  );
}
it('uses the real quote/envelope parsers and native SQL to retain one exact unsigned packet, with no bytes in the public DTO', async () => {
  const input = f.input(),
    response = await post(input);
  expect(response.status).toBe(200);
  const value = (await response.json()) as {
    preparation: ReturnType<typeof publicWalletWarmupSessionPreparation>;
  };
  expect(value.preparation).toMatchObject({
    id: input.id,
    journalId: input.journalId,
    side: 'Buy',
    wallet: f.packets.wallet,
    inAmountRaw: '1000000',
    packetAvailability: 'retained',
    simulation: {
      succeeded: true,
      inputAmountMatches: null,
      minimumOutputCovered: true,
    },
    signingAllowed: false,
    executionAllowed: false,
    automaticExecutionAllowed: false,
    instructionsVerified: false,
  });
  expect(JSON.stringify(value)).not.toContain(
    f.packets.buy.approval.transaction,
  );
  expect(JSON.stringify(value)).not.toContain('plan_document');
  expect(Object.keys(value.preparation)).not.toContain('transaction');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await f.count()).toEqual([1, 1, 1]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(mocks.simulate).toHaveBeenCalledTimes(1);
  const retained = await readWalletWarmupSessionPreparation(
    f.db,
    'owner',
    input.id,
    new AbortController().signal,
  );
  expect(retained?.packet?.transaction).toBe(
    f.packets.buy.approval.transaction,
  );
  vi.setSystemTime(Date.now() + 120000);
  mocks.key = '';
  const recovered = await GET(new Request(url + '?id=' + input.id));
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toEqual(value);
  expect((await post(input)).status).toBe(200);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('requires sign-in before storage or providers and isolates owner recovery', async () => {
  const input = f.input();
  expect((await post(input)).status).toBe(200);
  mocks.user = { userId: 'other' };
  expect((await GET(new Request(url + '?id=' + input.id))).status).toBe(404);
  expect((await post({ ...input, id: crypto.randomUUID() })).status).toBe(409);
  mocks.user = null;
  expect((await post(input)).status).toBe(401);
  expect((await GET(new Request(url + '?id=' + input.id))).status).toBe(401);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([
  {},
  { origin: 'http://elsewhere', 'content-type': 'application/json' },
  { origin: 'http://localhost', 'content-type': 'text/html' },
])(
  'refuses origin/media admission %j without a provider call',
  async (headers) => {
    expect([403, 415]).toContain((await post(f.input(), headers)).status);
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it.each([
  null,
  {},
  [],
  { wallet: '11111111111111111111111111111111' },
  { prepareRequested: false },
  { amount: '1' },
])('refuses incomplete or extra HTTP fields %j', async (extra) => {
  const body =
    extra === null || Array.isArray(extra) ? extra : { ...f.input(), ...extra };
  // Empty object here also exercises the explicit flag removal.
  if (extra && Object.keys(extra).length === 0 && !Array.isArray(extra))
    delete (body as Record<string, unknown>).prepareRequested;
  expect((await post(body)).status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
});
it('bounds streamed JSON and refuses duplicate or unrelated GET parameters', async () => {
  expect((await post({ ...f.input(), padding: 'x'.repeat(2200) })).status).toBe(
    413,
  );
  for (const query of [
    'id=bad',
    'id=' + crypto.randomUUID() + '&id=' + crypto.randomUUID(),
    'id=' + crypto.randomUUID() + '&extra=x',
  ])
    expect((await GET(new Request(url + '?' + query))).status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
});
it('a competing request is held by the owner cooldown, while exact saved-ID recovery bypasses providers', async () => {
  let release!: (r: Response) => void;
  fetcher.mockImplementationOnce(
    async () =>
      new Promise<Response>((r) => {
        release = r;
      }),
  );
  const input = f.input(),
    first = post(input);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  const second = await post(input);
  expect(second.status).toBe(429);
  expect(second.headers.get('retry-after')).toBe('30');
  const request = new URL(String(fetcher.mock.calls[0][0]));
  release(Response.json(f.quote(request)));
  expect((await first).status).toBe(200);
  expect((await post(input)).status).toBe(200);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await f.count()).toEqual([1, 1, 1]);
});
it('returns the first committed result after the database reply is lost, with no second quote', async () => {
  mocks.db = {
    prepare: f.db.prepare.bind(f.db),
    batch: async (statements: Parameters<D1Database['batch']>[0]) => {
      await f.db.batch(statements);
      throw Error('Synthetic lost write response');
    },
  } as unknown as D1Database;
  const input = f.input();
  expect((await post(input)).status).toBe(200);
  expect((await post(input)).status).toBe(200);
  expect(await f.count()).toEqual([1, 1, 1]);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each(['pause', 'stop'] as const)(
  'rolls back the whole preparation when %s changes the head during simulation',
  async (control) => {
    mocks.simulate.mockImplementationOnce(async (order) => {
      await f.append(control);
      return f.simulation(order);
    });
    expect((await post()).status).toBe(409);
    expect(await f.count()).toEqual([0, 0, 0]);
  },
);
it.each([
  'amount',
  'failed-simulation',
  'tokens',
  'minimum',
  'fees',
  'native-debit',
  'expiry',
  'plan',
  'wallet',
] as const)('refuses %s evidence without retaining a packet', async (kind) => {
  if (kind === 'amount')
    fetcher.mockImplementationOnce(async (input) => {
      const result = f.quote(new URL(String(input)));
      return Response.json({ ...result, inAmount: '2' });
    });
  else
    mocks.simulate.mockImplementationOnce(async (order) => {
      const simulation = f.simulation(order);
      if (kind === 'failed-simulation') simulation.succeeded = false;
      if (kind === 'tokens') simulation.tokensComplete = false;
      if (kind === 'minimum') simulation.minimumOutputCovered = false;
      if (kind === 'fees') simulation.networkFeeLamports = '10000001';
      if (kind === 'native-debit') simulation.nativeChangeRaw = '-11000001';
      if (kind === 'expiry') vi.setSystemTime(Date.now() + 61000);
      if (kind === 'plan')
        await f.db
          .prepare('UPDATE wallet_warmup_plans SET updated_at=?')
          .bind(new Date(Date.now() + 1).toISOString())
          .run();
      if (kind === 'wallet')
        await f.db.prepare('UPDATE workspace_wallets SET archived=1').run();
      return simulation;
    });
  expect([409, 502, 408]).toContain((await post()).status);
  expect(await f.count()).toEqual([0, 0, 0]);
});
it('does not double-count the independently observed network fee and provider network estimate', async () => {
  f.client.close();
  f = await warmupSessionProviderFixture('0.000005');
  mocks.db = f.db;
  expect((await post()).status).toBe(200);
  expect(await f.count()).toEqual([1, 1, 1]);
});
it('fails before providers when key, guard or exact current plan is unavailable', async () => {
  mocks.key = '';
  expect((await post()).status).toBe(503);
  mocks.key = 'synthetic-key';
  await f.db.prepare('DROP TRIGGER wallet_warmup_session_packet_finish').run();
  expect((await post()).status).toBe(503);
  expect(fetcher).not.toHaveBeenCalled();
});
it('sanitizes provider HTML/errors and keeps pre-aborted requests away from providers', async () => {
  fetcher.mockRejectedValueOnce(Error('PRIVATE_URL_TOKEN HTML <html>'));
  const response = await post();
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toContain(
    'PRIVATE_URL_TOKEN',
  );
  const c = new AbortController();
  c.abort();
  expect((await post(f.input(), undefined, c.signal)).status).toBe(408);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('returns a competing preparation recovery ID and preserves the database signing refusal', async () => {
  const input = f.input();
  expect((await post(input)).status).toBe(200);
  const other = await post({ ...input, id: crypto.randomUUID() });
  expect(other.status).toBe(409);
  expect(((await other.json()) as { recoveryId: string }).recoveryId).toBe(
    input.id,
  );
  await expect(
    f.db
      .prepare(
        "INSERT INTO warmup_signing_intents(id,owner_id,preparation_id,wallet_address,signature,state,document,created_at,updated_at) VALUES(?,?,?,?,NULL,'reviewed',?,?,?)",
      )
      .bind(
        crypto.randomUUID(),
        'owner',
        input.id,
        f.packets.wallet,
        '{}',
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run(),
  ).rejects.toThrow('Session-bound signing is not enabled');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
async function sellInput() {
  f.client.close();
  f = await warmupSessionProviderFixture('0.01', false);
  mocks.db = f.db;
  const buy = await retainWalletWarmupSessionSettlement(
    f.db,
    'owner',
    f.request(),
    new AbortController().signal,
    f.fetcher,
    f.clock,
  );
  f.setJournal(buy.journal);
  f.advance(15000);
  vi.setSystemTime(Date.now() + 15000);
  const action = JSON.parse(buy.journal.sourceDocument).review.actions[1].id;
  const journal = await f.append('begin-review', action);
  mocks.inventory.mockImplementation(async (_wallet, _mint, _signal, amount) =>
    f.inventory(amount),
  );
  return {
    id: crypto.randomUUID(),
    journalId: journal.id,
    version: journal.version,
    headSha256: journal.headSha256,
    prepareRequested: true,
  };
}
it('prepares the exact remaining Sell lot after synthetic finalized Buy evidence, preserving nullable wrapped-SOL output comparison', async () => {
  const input = await sellInput(),
    response = await post(input);
  expect(response.status).toBe(200);
  const value = (await response.json()) as {
    preparation: ReturnType<typeof publicWalletWarmupSessionPreparation>;
  };
  expect(value.preparation).toMatchObject({
    side: 'Sell',
    inAmountRaw: '101',
    packetAvailability: 'retained',
    simulation: { inputAmountMatches: true, minimumOutputCovered: null },
    signingAllowed: false,
  });
  expect(mocks.inventory).toHaveBeenCalledWith(
    f.packets.wallet,
    f.packets.mint,
    expect.any(AbortSignal),
    '0.000101',
  );
  expect(await f.count()).toEqual([1, 2, 1]);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('refuses a changed lot before fetching a new order', async () => {
  const input = await sellInput();
  await f.db
    .prepare("UPDATE warmup_buy_receipts SET remaining_raw='100'")
    .run();
  expect([409, 503]).toContain((await post(input)).status);
  expect(fetcher).not.toHaveBeenCalled();
  expect(mocks.inventory).not.toHaveBeenCalled();
  expect(await f.count()).toEqual([0, 1, 0]);
});
it.each(['frozen', 'decimals', 'amount'] as const)(
  'refuses %s sell inventory before requesting an order',
  async (kind) => {
    const input = await sellInput();
    mocks.inventory.mockImplementationOnce(async () => {
      const result = f.inventory('0.000101');
      if (kind === 'frozen') result.amountCovered = false;
      if (kind === 'decimals') result.decimals = 9;
      if (kind === 'amount') result.requestedRaw = '100';
      return result;
    });
    expect((await post(input)).status).toBe(409);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await f.count()).toEqual([0, 1, 0]);
  },
);
it('the atomic write refuses lot consumption after the final provider source read', async () => {
  const input = await sellInput();
  mocks.db = {
    prepare: f.db.prepare.bind(f.db),
    batch: async (statements) => {
      await f.db
        .prepare("UPDATE warmup_buy_receipts SET remaining_raw='100'")
        .run();
      return f.db.batch(statements);
    },
  } as D1Database;
  expect((await post(input)).status).toBe(409);
  expect(await f.count()).toEqual([0, 1, 0]);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('aborts an open quote body without saving or retrying', async () => {
  const c = new AbortController(),
    cancel = vi.fn();
  fetcher.mockImplementationOnce(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'));
          },
          cancel,
        }),
        { status: 200 },
      ),
  );
  const pending = post(f.input(), undefined, c.signal);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  c.abort();
  expect((await pending).status).toBe(408);
  expect(await f.count()).toEqual([0, 0, 0]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledTimes(1);
});
