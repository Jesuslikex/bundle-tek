import { afterEach, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { quoteOwnedImportedPair } from './imported-pair-quote-service';
import { importedPairQuoteFixture } from '../test/imported-pair-quote-fixture';
import { SWAP_TOKEN, SWAP_TOKEN_2022 } from './swap-token-program-evidence';
let fixture: ReturnType<typeof importedPairQuoteFixture> | undefined;
afterEach(() => {
  fixture?.close();
  fixture = undefined;
});
const signal = () => new AbortController().signal;
it.each(['initial', 'recheck'] as const)(
  'refuses the public mainnet TSLAX extension profile at the %s boundary without treating raw units as stock UI amounts',
  async (boundary) => {
    const f = (fixture = importedPairQuoteFixture());
    const snapshot = JSON.parse(
      readFileSync('test/tslax-mainnet-mint-20261015.json', 'utf8'),
    );
    expect(snapshot.provenance.mint).toBe(f.asset.address);
    expect(snapshot.account.owner).toBe(SWAP_TOKEN_2022);
    if (boundary === 'initial') f.mints[1] = snapshot.account;
    else {
      const original = f.quote.getMockImplementation()!;
      f.quote.mockImplementation(async (...args) => {
        const quote = await original(...args);
        f.mints[1] = snapshot.account;
        return quote;
      });
    }
    await expect(
      quoteOwnedImportedPair(
        f.db,
        'alice',
        f.request,
        signal(),
        f.dependencies,
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('scaled amounts'),
    });
    expect(f.quote.mock.calls.length).toBe(boundary === 'initial' ? 0 : 1);
    expect(
      f.sqlite
        .prepare('SELECT count(*) AS n FROM imported_token_project_events')
        .get(),
    ).toMatchObject({ n: 0 });
  },
);
it.each([
  { side: 'Buy' as const, program: SWAP_TOKEN },
  { side: 'Sell' as const, program: SWAP_TOKEN },
  { side: 'Buy' as const, program: SWAP_TOKEN_2022 },
  { side: 'Sell' as const, program: SWAP_TOKEN_2022 },
])(
  'quotes $side in synthetic unscaled catalog/base units with quote program $program and no wallet material',
  async ({ side, program }) => {
    const f = (fixture = importedPairQuoteFixture(side, program));
    const result = await quoteOwnedImportedPair(
      f.db,
      'alice',
      f.request,
      signal(),
      f.dependencies,
    );
    expect(result).toMatchObject({
      side,
      inputRaw: '1',
      signingAllowed: false,
      executionAllowed: false,
      balancesChecked: false,
      pair: {
        base: { address: f.baseMint, decimals: 6 },
        quote: {
          address: f.asset.address,
          decimals: 8,
          symbol: 'TSLAX',
          program,
        },
        issuerVerified: false,
        catalogSnapshot: '2026-10-09',
      },
    });
    expect(result.inputAmount).toBe(side === 'Buy' ? '0.00000001' : '0.000001');
    expect(result.outputAmount).toBe(side === 'Buy' ? '1' : '0.01');
    expect(result.minimumOutputAmount).toBe(
      side === 'Buy' ? '0.995' : '0.00995',
    );
    const requested = f.fetcher.mock.calls[0][0];
    const url = new URL(
      typeof requested === 'string' || requested instanceof URL
        ? requested
        : requested.url,
    );
    expect(url.searchParams.get('inputMint')).toBe(
      side === 'Buy' ? f.asset.address : f.baseMint,
    );
    expect(url.searchParams.get('outputMint')).toBe(
      side === 'Buy' ? f.baseMint : f.asset.address,
    );
    expect(url.searchParams.has('taker')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('provider-material');
    expect(result.quote).not.toHaveProperty('preparation');
    expect(f.rpc.mock.calls.map((c) => c[0])).toEqual([
      'getGenesisHash',
      'getSlot',
      'getMultipleAccounts',
      'getMultipleAccounts',
      'getGenesisHash',
    ]);
    expect(
      f.sqlite
        .prepare('SELECT count(*) AS n FROM imported_token_project_events')
        .get(),
    ).toMatchObject({ n: 0 });
  },
);
it('rejects foreign, changed, archived and unknown-quote contexts before any provider call', async () => {
  const f = (fixture = importedPairQuoteFixture());
  for (const [owner, input, status] of [
    ['bob', f.request, 404],
    ['alice', { ...f.request, revision: 2 }, 409],
    ['alice', { ...f.request, quoteMint: f.baseMint }, 400],
  ] as const)
    await expect(
      quoteOwnedImportedPair(f.db, owner, input, signal(), f.dependencies),
    ).rejects.toMatchObject({ status });
  f.sqlite
    .prepare('UPDATE imported_token_projects SET archived=1 WHERE id=?')
    .run(f.id);
  await expect(
    quoteOwnedImportedPair(f.db, 'alice', f.request, signal(), f.dependencies),
  ).rejects.toMatchObject({ status: 409 });
  expect(f.rpc).not.toHaveBeenCalled();
  expect(f.quote).not.toHaveBeenCalled();
});
it('checks stock precision and u64 input exactly before provider reads', async () => {
  const f = (fixture = importedPairQuoteFixture());
  for (const amount of ['0', '0.000000001', '184467440737.09551616'])
    await expect(
      quoteOwnedImportedPair(
        f.db,
        'alice',
        { ...f.request, amount },
        signal(),
        f.dependencies,
      ),
    ).rejects.toMatchObject({ status: 400 });
  expect(f.rpc).not.toHaveBeenCalled();
  const result = await quoteOwnedImportedPair(
    f.db,
    'alice',
    { ...f.request, amount: '184467440737.09551615' },
    signal(),
    f.dependencies,
  );
  expect(result.inputRaw).toBe('18446744073709551615');
  expect(result.inputAmount).toBe('184467440737.09551615');
});
it('retains the existing manual-read rate gate and does not start a second provider request', async () => {
  const f = (fixture = importedPairQuoteFixture());
  await quoteOwnedImportedPair(
    f.db,
    'alice',
    f.request,
    signal(),
    f.dependencies,
  );
  const calls = f.rpc.mock.calls.length;
  await expect(
    quoteOwnedImportedPair(f.db, 'alice', f.request, signal(), f.dependencies),
  ).rejects.toMatchObject({ status: 429 });
  expect(f.rpc).toHaveBeenCalledTimes(calls);
  expect(f.quote).toHaveBeenCalledOnce();
});
it.each(['precision', 'program'] as const)(
  'refuses fresh mint %s substitution before quoting',
  async (mode) => {
    const f = (fixture = importedPairQuoteFixture());
    const raw = f.mints[1];
    const bytes = Uint8Array.from(atob(raw.data[0]), (c) => c.charCodeAt(0));
    if (mode === 'precision') bytes[44] = 9;
    else f.mints[0].owner = SWAP_TOKEN;
    raw.data[0] = btoa(String.fromCharCode(...bytes));
    await expect(
      quoteOwnedImportedPair(
        f.db,
        'alice',
        f.request,
        signal(),
        f.dependencies,
      ),
    ).rejects.toThrow('precision/program');
    expect(f.quote).not.toHaveBeenCalled();
  },
);
it.each(['initial', 'final'] as const)(
  'checks mainnet at the %s boundary and does not return wrong-network quotes',
  async (boundary) => {
    const f = (fixture = importedPairQuoteFixture()),
      original = f.rpc.getMockImplementation()!;
    let genesisReads = 0;
    f.rpc.mockImplementation(async (method, params) => {
      if (
        method === 'getGenesisHash' &&
        ++genesisReads === (boundary === 'initial' ? 1 : 2)
      )
        return 'wrong-network';
      return original(method, params);
    });
    await expect(
      quoteOwnedImportedPair(
        f.db,
        'alice',
        f.request,
        signal(),
        f.dependencies,
      ),
    ).rejects.toMatchObject({ status: 502 });
    expect(f.quote.mock.calls.length).toBe(boundary === 'initial' ? 0 : 1);
  },
);
it.each(['project', 'policy'] as const)(
  'rejects a %s change during a quote without saving any project/history mutation',
  async (mode) => {
    const f = (fixture = importedPairQuoteFixture());
    const original = f.quote.getMockImplementation()!;
    f.quote.mockImplementation(async (...args) => {
      const q = await original(...args);
      if (mode === 'project')
        f.sqlite
          .prepare('UPDATE imported_token_projects SET revision=2 WHERE id=?')
          .run(f.id);
      else {
        const raw = f.mints[0];
        const bytes = Uint8Array.from(atob(raw.data[0]), (c) =>
          c.charCodeAt(0),
        );
        bytes[44] = 7;
        raw.data[0] = btoa(String.fromCharCode(...bytes));
      }
      return q;
    });
    await expect(
      quoteOwnedImportedPair(
        f.db,
        'alice',
        f.request,
        signal(),
        f.dependencies,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      f.sqlite
        .prepare('SELECT count(*) AS n FROM imported_token_project_events')
        .get(),
    ).toMatchObject({ n: 0 });
  },
);
it('terminates a non-cooperative quote on cancellation and starts no later mint recheck', async () => {
  const f = (fixture = importedPairQuoteFixture()),
    entered = Promise.withResolvers<void>(),
    delayed = Promise.withResolvers<never>();
  f.quote.mockImplementation(async () => {
    entered.resolve();
    return delayed.promise;
  });
  const controller = new AbortController(),
    pending = quoteOwnedImportedPair(
      f.db,
      'alice',
      f.request,
      controller.signal,
      f.dependencies,
    );
  await entered.promise;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ status: 408 });
  delayed.reject(new Error('Mock provider settled after cancellation'));
  await expect(delayed.promise).rejects.toThrow('settled after cancellation');
  expect(
    f.rpc.mock.calls.filter((c) => c[0] === 'getMultipleAccounts'),
  ).toHaveLength(1);
});
it.each(['provider-expiry', 'context-expiry', 'return-expiry'] as const)(
  'classifies %s as a stale observation instead of a provider outage',
  async (mode) => {
    const f = (fixture = importedPairQuoteFixture()),
      original = f.quote.getMockImplementation()!;
    let clock = Date.now(),
      clockReads = 0;
    f.dependencies.now = () =>
      clock + (mode === 'return-expiry' && ++clockReads >= 4 ? 31000 : 0);
    f.quote.mockImplementation(async (...args) => {
      const quote = await original(...args);
      if (mode === 'provider-expiry')
        quote.expiresAt = new Date(clock - 1).toISOString();
      else if (mode === 'context-expiry') clock += 31000;
      return quote;
    });
    await expect(
      quoteOwnedImportedPair(
        f.db,
        'alice',
        f.request,
        signal(),
        f.dependencies,
      ),
    ).rejects.toMatchObject({ status: 409 });
  },
);
