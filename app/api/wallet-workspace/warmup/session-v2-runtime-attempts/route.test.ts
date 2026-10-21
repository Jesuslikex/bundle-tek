import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { warmupV2RuntimeFixture } from '@/test/warmup-session-v2-runtime-fixture';
import type { WarmupRuntimeProviderDependencies } from '@/lib/wallet-warmup-session-v2-runtime-provider';
const mocks = vi.hoisted(() => ({
  db: null as unknown as D1Database,
  user: { userId: 'owner' } as { userId: string } | null,
  runtime: null as WarmupRuntimeProviderDependencies['runtime'] | null,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/server-env', () => ({
  env: { JUPITER_API_KEY: 'synthetic-key' },
}));
vi.mock(
  '@/lib/wallet-warmup-session-v2-runtime-provider',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@/lib/wallet-warmup-session-v2-runtime-provider')
      >();
    return {
      ...actual,
      createWalletWarmupV2RuntimeProvider: (
        ...args: Parameters<typeof actual.createWalletWarmupV2RuntimeProvider>
      ) =>
        actual.createWalletWarmupV2RuntimeProvider(
          args[0],
          args[1],
          args[2],
          args[3],
          args[4] ?? { runtime: mocks.runtime ?? undefined },
        ),
    };
  },
);
import { GET, POST } from './route';
import type { publicWalletWarmupV2RuntimeAttempt } from '@/lib/wallet-warmup-session-v2-attempts';
type RuntimeResponse = ReturnType<typeof publicWalletWarmupV2RuntimeAttempt>;
let f: Awaited<ReturnType<typeof warmupV2RuntimeFixture>>;
const url =
  'http://localhost/api/wallet-workspace/warmup/session-v2-runtime-attempts';
beforeEach(async () => {
  f = await warmupV2RuntimeFixture();
  mocks.db = f.db;
  mocks.user = { userId: 'owner' };
  mocks.runtime = f.raw.dependencies;
});
afterEach(() => {
  f.client.close();
  vi.restoreAllMocks();
});
const post = (
  body: unknown = { ...f.selection(), runtimeRequested: true },
  origin = 'http://localhost',
  type = 'application/json',
  signal?: AbortSignal,
) =>
  POST(
    new Request(url, {
      method: 'POST',
      headers: { origin, 'content-type': type },
      body: JSON.stringify(body),
      signal,
    }),
  );
it('requires authentication before reading or preparing', async () => {
  mocks.user = null;
  expect((await post()).status).toBe(401);
  expect(
    (await GET(new Request(url + '?id=' + crypto.randomUUID()))).status,
  ).toBe(401);
  expect(f.raw.prepare).not.toHaveBeenCalled();
});
it('rejects cross-origin and non-JSON requests before providers', async () => {
  expect((await post(undefined, 'https://elsewhere.invalid')).status).toBe(403);
  expect((await post(undefined, 'http://localhost', 'text/plain')).status).toBe(
    415,
  );
  expect(f.raw.prepare).not.toHaveBeenCalled();
});
for (const field of [
  'wallet',
  'amount',
  'provider',
  'previewRequested',
  'signature',
] as const)
  it(`refuses client ${field} selectors`, async () => {
    expect(
      (
        await post({
          ...f.selection(),
          runtimeRequested: true,
          [field]: 'not-accepted',
        })
      ).status,
    ).toBe(400);
    expect(f.raw.prepare).not.toHaveBeenCalled();
  });
for (const approval of [undefined, false, 'true'])
  it(`requires a separate literal approval (${String(approval)})`, async () => {
    expect(
      (await post({ ...f.selection(), runtimeRequested: approval })).status,
    ).toBe(400);
    expect(f.raw.prepare).not.toHaveBeenCalled();
  });
it('bounds the JSON body', async () => {
  expect((await post({ padding: 'x'.repeat(2100) })).status).toBe(413);
  expect(f.raw.prepare).not.toHaveBeenCalled();
});
it('persists the real signed-in route result and recovers with GET only after Stop', async () => {
  const input = { ...f.selection(), runtimeRequested: true },
    response = await post(input);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const value = (await response.json()) as RuntimeResponse;
  expect(value).toMatchObject({
    attempt: {
      id: input.id,
      outcome: { kind: 'prepared' },
      signingAllowed: false,
    },
    runtime: {
      mode: 'runtime-observation-v1',
      observation: { codeScans: 2 },
      trustedProgramPolicyEstablished: false,
      signingAllowed: false,
      executionAllowed: false,
    },
  });
  expect(JSON.stringify(value)).not.toContain(
    f.raw.order.preparation.transaction,
  );
  expect(f.raw.prepare).toHaveBeenCalledOnce();
  const calls = f.raw.rpc.mock.calls.length;
  await f.control('stop');
  const recovered = await GET(new Request(url + '?id=' + input.id));
  expect(recovered.status).toBe(200);
  expect(((await recovered.json()) as RuntimeResponse).runtime).toEqual(
    value.runtime,
  );
  expect(f.raw.rpc.mock.calls.length).toBe(calls);
  const again = await post(input);
  expect(again.status).toBe(200);
  expect(f.raw.rpc.mock.calls.length).toBe(calls);
  mocks.user = { userId: 'another-owner' };
  expect((await GET(new Request(url + '?id=' + input.id))).status).toBe(404);
  expect(f.raw.rpc.mock.calls.length).toBe(calls);
});
it('rejects duplicate and unknown GET selectors', async () => {
  const id = crypto.randomUUID();
  for (const query of [
    '?id=' + id + '&id=' + id,
    '?id=' + id + '&provider=x',
    '?id=bad',
    '?journalId=' + id,
  ])
    expect((await GET(new Request(url + query))).status).toBe(400);
  expect(f.raw.prepare).not.toHaveBeenCalled();
});
it('keeps an interrupted original ID without a provider rerun', async () => {
  const controller = new AbortController(),
    input = { ...f.selection(), runtimeRequested: true };
  f.raw.state.onPrepare = () => controller.abort();
  expect(
    (
      await post(
        input,
        'http://localhost',
        'application/json',
        controller.signal,
      )
    ).status,
  ).toBe(408);
  expect(f.raw.prepare).toHaveBeenCalledOnce();
  const calls = f.raw.rpc.mock.calls.length;
  const recovered = await GET(new Request(url + '?id=' + input.id));
  expect(recovered.status).toBe(200);
  expect(
    ((await recovered.json()) as RuntimeResponse).runtime.observation,
  ).toBeNull();
  expect((await post(input)).status).toBe(200);
  expect(f.raw.rpc.mock.calls.length).toBe(calls);
});
