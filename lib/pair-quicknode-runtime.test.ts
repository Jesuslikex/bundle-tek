import { afterEach, expect, it, vi } from 'vitest';
import { pairRuntimeFixture } from '../test/pair-runtime-fixture';
import { pairQuoteClock } from '../test/imported-pair-quote-fixture';
import { PAIR_RENT } from './pair-rent-evidence';
import { createPairReadRpc } from './pair-read-rpc';
import {
  createStockPairEvidenceRpc,
  stockPairAccountLimit,
  PAIR_CLOCK,
} from './pair-stock-clock';
import { previewOwnedImportedPairRuntime } from './imported-pair-runtime';
vi.mock('./wallet-rpc-pacing', () => ({
  paceWalletRpc: vi.fn(async () => {}),
}));
const endpoint = 'https://fixture.quiknode.pro/private-fixture/';
let fixture: Awaited<ReturnType<typeof pairRuntimeFixture>> | undefined;
let reader: ReturnType<typeof createPairReadRpc> | undefined;
afterEach(() => {
  reader?.close();
  fixture?.close();
  reader = undefined;
  fixture = undefined;
});

it.each([
  [endpoint, 5],
  ['https://rpc.example.test/', 100],
  ['https://fixture.quiknode.pro.example.test/', 100],
  ['http://fixture.quiknode.pro/', 100],
  ['https://user@fixture.quiknode.pro/', 100],
] as const)(
  'scopes the five-account profile to the admitted QuickNode URL %s',
  (url, cap) => {
    expect(stockPairAccountLimit(url)).toBe(cap);
  },
);

it.each([
  [endpoint, '100', 100],
  ['https://rpc.example.test/', '5', 5],
  [endpoint, '', 5],
] as const)(
  'applies the configured stock account limit for %s (%s)',
  (url, configured, cap) => {
    expect(stockPairAccountLimit(url, configured)).toBe(cap);
  },
);

it.each(['6', '0', '100 ', 'many'])(
  'refuses unsupported stock account limit %s',
  (configured) => {
    expect(() => stockPairAccountLimit(endpoint, configured)).toThrow(
      'Stock runtime account limit must be 5 or 100.',
    );
  },
);

async function run(mode = 'ok') {
  const f = (fixture = await pairRuntimeFixture());
  const wire: { method: string; params: unknown[] }[] = [];
  let simulated = false;
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (typeof init?.body !== 'string')
      throw Error('Expected JSON request body.');
    const body = JSON.parse(init.body);
    const messages = Array.isArray(body) ? body : [body];
    const replies = await Promise.all(
      messages.map(
        async (m: { id: string; method: string; params: unknown[] }) => {
          wire.push(m);
          const config = m.params[1] as
            | {
                minContextSlot?: number;
                dataSlice?: { offset: number; length: number };
              }
            | undefined;
          let result: unknown;
          if (m.method === 'getMultipleAccounts') {
            const keys = m.params[0] as string[];
            if (keys.length > 5)
              throw Error('Provider rejects more than five accounts.');
            const slot = config?.minContextSlot ?? 100;
            result = {
              context: { slot: String(slot) },
              value: keys.map((key) => {
                let raw: unknown =
                  key === PAIR_CLOCK
                    ? pairQuoteClock(slot, String(f.clock.now / 1000))
                    : key === PAIR_RENT
                      ? f.state.rentAccount
                      : key === f.wallet
                        ? f.state.walletAccount
                        : (f.mints[
                            f.mintEvidence.mints.findIndex(
                              (mint) => mint.address === key,
                            )
                          ] ??
                          f.accounts[f.atas.indexOf(key)] ??
                          f.orderState.otherAccounts.get(key) ??
                          f.programs.get(key) ??
                          null);
                raw = structuredClone(raw);
                if (
                  mode === 'code-change' &&
                  simulated &&
                  f.programs.has(key)
                ) {
                  const account = raw as { data: string[] };
                  const bytes = Buffer.from(account.data[0], 'base64');
                  bytes[100] ^= 1;
                  account.data[0] = bytes.toString('base64');
                }
                if (raw && typeof raw === 'object' && !('lamports' in raw))
                  raw = { ...raw, lamports: '1000000' };
                if (mode === 'custody' && simulated && key === f.wallet)
                  (raw as { lamports: string }).lamports = '999999999';
                if (raw && config?.dataSlice) {
                  const account = raw as { data: string[] };
                  const { offset, length } = config.dataSlice;
                  account.data[0] = Buffer.from(account.data[0], 'base64')
                    .subarray(offset, offset + length)
                    .toString('base64');
                }
                return raw;
              }),
            };
          } else {
            result = await f.rpc(m.method, m.params);
            if (m.method === 'simulateTransaction') simulated = true;
          }
          return { jsonrpc: '2.0', id: m.id, result };
        },
      ),
    );
    return Response.json(Array.isArray(body) ? replies : replies[0]);
  });
  const signal = new AbortController().signal;
  reader = createPairReadRpc(
    endpoint,
    signal,
    fetcher as typeof fetch,
    'configured',
    5,
  );
  const scope = createStockPairEvidenceRpc(
    reader.rpc,
    reader.programRpc,
    () => f.clock.now,
    { endpoint, signal },
  );
  const work = previewOwnedImportedPairRuntime(
    f.db,
    'alice',
    f.runtimeRequest,
    signal,
    {
      ...f.runtimeDependencies,
      rpc: scope.rpc,
      programRpc: scope.programRpc,
    },
  );
  return { f, scope, wire, work };
}
it('runs the owned runtime through the real five-account transport, shared scope, both code scans and simulation', async () => {
  const f = await run();
  const result = await f.work;
  expect(result.runtime.signingAllowed).toBe(false);
  expect(result.runtime.codeIdentityObserved).toBe(true);
  expect(f.wire.filter((m) => m.method === 'simulateTransaction')).toHaveLength(
    1,
  );
  expect(
    f.wire
      .filter((m) => m.method === 'getMultipleAccounts')
      .every((m) => (m.params[0] as string[]).length <= 5),
  ).toBe(true);
  expect(f.scope.partitions.length).toBeGreaterThan(2);
  expect(f.scope.observations.length).toBeGreaterThan(2);
  expect(result.clockObservations).toEqual(f.scope.observations);
  expect(
    result.runtime.maximumSlot - result.runtime.minimumSlot,
  ).toBeLessThanOrEqual(32);
});
it('refuses a changed writable wallet after simulation through the same capped transport', async () => {
  const f = await run('custody');
  await expect(f.work).rejects.toThrow();
  expect(f.wire.filter((m) => m.method === 'simulateTransaction')).toHaveLength(
    1,
  );
});
it('refuses changed final program bytes instead of reusing the first scan', async () => {
  const f = await run('code-change');
  await expect(f.work).rejects.toThrow();
  expect(f.wire.filter((m) => m.method === 'simulateTransaction')).toHaveLength(
    1,
  );
});
