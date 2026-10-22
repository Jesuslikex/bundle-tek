import { afterEach, expect, it, vi } from 'vitest';
import { fundingOriginApiFixture } from '../test/wallet-funding-origin-api-fixture';
import { readOwnedFundingOrigins } from './wallet-funding-origin-server';
import { WalletRpcError } from './wallet-balances';
const clients: ReturnType<typeof fundingOriginApiFixture>[] = [];
const fixture = (count = 1) => {
  const f = fundingOriginApiFixture(count);
  clients.push(f);
  return f;
};
const signal = () => new AbortController().signal;
afterEach(() => clients.splice(0).forEach((f) => f.close()));
it('composes real signed native evidence with owned revisions, exact calls and no raw payload delivery', async () => {
  const f = fixture();
  const result = await readOwnedFundingOrigins(
    f.db,
    'owner',
    { wallets: f.wallets, context: f.wallets },
    signal(),
    {
      endpoint: f.endpoint,
      rpc: async (method, params) => {
        if (method === 'getTransactionsForAddress')
          expect(params).toEqual([
            f.wallets[0].address,
            {
              transactionDetails: 'full',
              sortOrder: 'asc',
              limit: 1,
              commitment: 'finalized',
              encoding: 'base64',
              maxSupportedTransactionVersion: 0,
            },
          ]);
        if (method === 'getSignatureStatuses')
          expect(params[1]).toEqual({ searchTransactionHistory: true });
        return f.rpc(method, params);
      },
    },
  );
  expect(result.wallets[0].funding?.recipientChangeRaw).toBe('10000');
  expect(result.historyComplete).toBe(false);
  expect(result.signingAllowed).toBe(false);
  expect(result.executionAllowed).toBe(false);
  expect(f.calls).toEqual([
    'getGenesisHash',
    'getTransactionsForAddress',
    'getSignatureStatuses',
  ]);
  expect(JSON.stringify(result)).not.toContain(
    f.records[0].receipt.transaction[0],
  );
  expect(JSON.stringify(result)).not.toContain('fixture-private');
  expect(
    f.queries
      .filter((q) => q.sql.startsWith('SELECT'))
      .every((q) => q.bindings === 2),
  ).toBe(true);
});
it.each([
  "UPDATE workspace_wallets SET owner_id='other'",
  'UPDATE workspace_wallets SET archived=1',
  'UPDATE workspace_wallets SET revision=2',
  "UPDATE workspace_wallets SET chain='Base'",
])(
  'rejects unavailable ownership %s before gate or provider calls',
  async (sql) => {
    const f = fixture();
    f.sqlite.exec(sql);
    await expect(
      readOwnedFundingOrigins(
        f.db,
        'owner',
        { wallets: f.wallets, context: f.wallets },
        signal(),
        {
          endpoint: f.endpoint,
          rpc: f.rpc,
        },
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.calls).toEqual([]);
    expect(f.queries.some((q) => q.sql.startsWith('INSERT'))).toBe(false);
  },
);
it('stops stale roster work after a read and rejects rather than returning the old revision', async () => {
  const f = fixture(2);
  await expect(
    readOwnedFundingOrigins(
      f.db,
      'owner',
      { wallets: f.wallets, context: f.wallets },
      signal(),
      {
        endpoint: f.endpoint,
        rpc: async (method, params) => {
          const result = await f.rpc(method, params);
          if (method === 'getTransactionsForAddress')
            f.sqlite.exec('UPDATE workspace_wallets SET revision=2');
          return result;
        },
      },
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(f.calls).toHaveLength(2);
});
it('keeps the fifteen-second DB gate at its exact boundary without repeating reads', async () => {
  const f = fixture();
  let now = 1800000000000;
  const opts = { endpoint: f.endpoint, rpc: f.rpc, now: () => now };
  await readOwnedFundingOrigins(
    f.db,
    'owner',
    { wallets: f.wallets, context: f.wallets },
    signal(),
    opts,
  );
  now += 14999;
  await expect(
    readOwnedFundingOrigins(
      f.db,
      'owner',
      { wallets: f.wallets, context: f.wallets },
      signal(),
      opts,
    ),
  ).rejects.toMatchObject({ status: 429 });
  expect(f.calls).toHaveLength(3);
  now++;
  await readOwnedFundingOrigins(
    f.db,
    'owner',
    { wallets: f.wallets, context: f.wallets },
    signal(),
    opts,
  );
  expect(f.calls).toHaveLength(6);
});
it('checks mainnet before history and refuses unqualified endpoints without fallback', async () => {
  for (const endpoint of [
    'https://api.mainnet-beta.solana.com',
    'http://solana-mainnet.g.alchemy.com',
    'https://solana-mainnet.g.alchemy.com:8443/v2/a',
  ]) {
    const f = fixture();
    await expect(
      readOwnedFundingOrigins(
        f.db,
        'owner',
        { wallets: f.wallets, context: f.wallets },
        signal(),
        {
          endpoint,
          rpc: f.rpc,
        },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.calls).toHaveLength(0);
  }
  const f = fixture();
  const rpc = vi.fn(async () => 'devnet');
  await expect(
    readOwnedFundingOrigins(
      f.db,
      'owner',
      { wallets: f.wallets, context: f.wallets },
      signal(),
      {
        endpoint: f.endpoint,
        rpc,
      },
    ),
  ).rejects.toMatchObject({ status: 502 });
  expect(rpc).toHaveBeenCalledTimes(1);
});
it('stops on the first provider 429 without calling the next wallet or retrying', async () => {
  const f = fixture(2);
  const rpc = vi.fn(async (method: string, params: unknown[]) => {
    if (method === 'getTransactionsForAddress') throw new WalletRpcError(429);
    return f.rpc(method, params);
  });
  await expect(
    readOwnedFundingOrigins(
      f.db,
      'owner',
      { wallets: f.wallets, context: f.wallets },
      signal(),
      {
        endpoint: f.endpoint,
        rpc,
      },
    ),
  ).rejects.toMatchObject({ status: 429 });
  expect(rpc).toHaveBeenCalledTimes(2);
});
it('keeps malformed or absent oldest history unknown without a transaction lookup', async () => {
  const f = fixture(2);
  f.records[0].history.data = [];
  f.records[1].receipt.transaction[0] = 'invalid';
  const result = await readOwnedFundingOrigins(
    f.db,
    'owner',
    { wallets: f.wallets, context: f.wallets },
    signal(),
    { endpoint: f.endpoint, rpc: f.rpc },
  );
  expect(result.wallets.map((w) => w.reason)).toEqual([
    'no-returned-history',
    'unavailable-oldest-evidence',
  ]);
  expect(f.calls).toEqual([
    'getGenesisHash',
    'getTransactionsForAddress',
    'getTransactionsForAddress',
  ]);
});
it('does not continue after cancellation even when a pending provider ignores abort', async () => {
  const f = fixture(2);
  const controller = new AbortController();
  const rpc = vi.fn(async (method: string, params: unknown[]) => {
    const result = await f.rpc(method, params);
    if (method === 'getTransactionsForAddress') controller.abort();
    return result;
  });
  await expect(
    readOwnedFundingOrigins(
      f.db,
      'owner',
      { wallets: f.wallets, context: f.wallets },
      controller.signal,
      { endpoint: f.endpoint, rpc },
    ),
  ).rejects.toBeDefined();
  expect(rpc).toHaveBeenCalledTimes(2);
});

it('rechecks earlier groups in the full context while reading a later group', async () => {
  const f = fixture(2);
  await expect(
    readOwnedFundingOrigins(
      f.db,
      'owner',
      { wallets: [f.wallets[1]], context: f.wallets },
      signal(),
      {
        endpoint: f.endpoint,
        rpc: async (method, params) => {
          const result = await f.rpc(method, params);
          if (method === 'getTransactionsForAddress')
            f.sqlite
              .prepare(
                'UPDATE workspace_wallets SET revision=2 WHERE address=?',
              )
              .run(f.wallets[0].address);
          return result;
        },
      },
    ),
  ).rejects.toMatchObject({ status: 409 });
});

it('holds a live owner lease beyond fifteen seconds, then starts the cooldown after completion', async () => {
  const f = fixture();
  let now = 1800000000000;
  let release!: (value: unknown) => void;
  let entered = false;
  const rpc = async (method: string, params: unknown[]) => {
    if (method === 'getGenesisHash') {
      entered = true;
      return new Promise<unknown>((resolve) => {
        release = resolve;
      });
    }
    return f.rpc(method, params);
  };
  const first = readOwnedFundingOrigins(
    f.db,
    'owner',
    { wallets: f.wallets, context: f.wallets },
    signal(),
    { endpoint: f.endpoint, rpc, now: () => now },
  );
  for (let i = 0; i < 20 && !entered; i++) await Promise.resolve();
  expect(entered).toBe(true);
  now += 16000;
  await expect(
    readOwnedFundingOrigins(
      f.db,
      'owner',
      { wallets: f.wallets, context: f.wallets },
      signal(),
      { endpoint: f.endpoint, rpc: f.rpc, now: () => now },
    ),
  ).rejects.toMatchObject({ status: 429 });
  release('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
  await first;
  const gate = f.sqlite
    .prepare('SELECT next_allowed_at FROM imported_token_project_gates')
    .get()!;
  expect(gate.next_allowed_at).toBe(now + 15000);
});
it('does not let late cleanup shorten a newer lease', async () => {
  const f = fixture();
  let now = 1800000000000;
  const old = new AbortController();
  let releaseOld!: (value: unknown) => void;
  let releaseNew!: (value: unknown) => void;
  let entered = 0;
  const oldRpc = async () => {
    entered++;
    return new Promise<unknown>((r) => {
      releaseOld = r;
    });
  };
  const oldResult = readOwnedFundingOrigins(
    f.db,
    'owner',
    { wallets: f.wallets, context: f.wallets },
    old.signal,
    { endpoint: f.endpoint, rpc: oldRpc, now: () => now },
  ).catch((e) => e);
  for (let i = 0; i < 20 && entered < 1; i++) await Promise.resolve();
  old.abort();
  now += 61000;
  const next = readOwnedFundingOrigins(
    f.db,
    'owner',
    { wallets: f.wallets, context: f.wallets },
    signal(),
    {
      endpoint: f.endpoint,
      rpc: async (method, params) => {
        if (method === 'getGenesisHash') {
          entered++;
          return new Promise<unknown>((r) => {
            releaseNew = r;
          });
        }
        return f.rpc(method, params);
      },
      now: () => now,
    },
  );
  for (let i = 0; i < 20 && entered < 2; i++) await Promise.resolve();
  expect(entered).toBe(2);
  releaseOld('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
  await oldResult;
  expect(
    f.sqlite
      .prepare('SELECT next_allowed_at FROM imported_token_project_gates')
      .get()!.next_allowed_at,
  ).toBe(now + 60000);
  releaseNew('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
  await next;
});
it('refuses mismatched or partial status observations without treating a request as finality', async () => {
  for (const mode of ['partial', 'wrong-slot', 'confirmed', 'old-context']) {
    const f = fixture();
    const result = readOwnedFundingOrigins(
      f.db,
      'owner',
      { wallets: f.wallets, context: f.wallets },
      signal(),
      {
        endpoint: f.endpoint,
        rpc: async (method, params) => {
          const value = await f.rpc(method, params);
          if (method !== 'getSignatureStatuses') return value;
          const row = value as {
            context: { slot: string };
            value: { slot: string; confirmationStatus: string }[];
          };
          if (mode === 'partial') row.value = [];
          if (mode === 'wrong-slot') row.value[0].slot = '99';
          if (mode === 'confirmed')
            row.value[0].confirmationStatus = 'confirmed';
          if (mode === 'old-context') row.context.slot = '99';
          return row;
        },
      },
    );
    if (mode === 'partial')
      await expect(result).rejects.toMatchObject({ status: 502 });
    else
      expect((await result).wallets[0].reason).toBe(
        'unavailable-oldest-evidence',
      );
  }
});
it('keeps an owned off-curve address unknown without sending it to history', async () => {
  const f = fixture();
  const address = '11111111111111111111111111111111';
  f.sqlite.prepare('UPDATE workspace_wallets SET address=?').run(address);
  const wallets = [{ address, revision: 1 }];
  const result = await readOwnedFundingOrigins(
    f.db,
    'owner',
    { wallets, context: wallets },
    signal(),
    { endpoint: f.endpoint, rpc: f.rpc },
  );
  expect(result.wallets[0].reason).toBe('unsupported-address');
  expect(f.calls).toEqual(['getGenesisHash']);
});
