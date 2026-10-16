import { afterEach, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { quoteOwnedImportedPair } from './imported-pair-quote-service';
import {
  importedPairQuoteFixture,
  pairQuoteMint,
} from '../test/imported-pair-quote-fixture';
import { address } from '@solana/kit-v1';
import {
  parseImportedPairQuote,
  importedPairSha256,
} from './imported-trade-pair';
import { SWAP_TOKEN, SWAP_TOKEN_2022 } from './swap-token-program-evidence';
let fixture: ReturnType<typeof importedPairQuoteFixture> | undefined;
afterEach(() => {
  fixture?.close();
  fixture = undefined;
  vi.useRealTimers();
});
const signal = () => new AbortController().signal;
it.each(['stable', 'crossed'] as const)(
  'bounds a scheduled stock multiplier transition when the quote is %s',
  async (mode) => {
    const now = Math.floor(Date.now() / 1000) * 1000;
    // The mock provider and service must share this same fixed clock. Real
    // provider time can otherwise drift past the service's future-time bound.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const f = (fixture = importedPairQuoteFixture());
    f.dependencies.now = () => now;
    f.clockState.unixTimestamp = String(now / 1000);
    f.mints[1] = pairQuoteMint(8, SWAP_TOKEN_2022, [
      {
        __kind: 'ScaledUiAmountConfig',
        authority: address('11111111111111111111111111111111'),
        multiplier: 1,
        newMultiplier: 2,
        newMultiplierEffectiveTimestamp: BigInt(now / 1000 + 10),
      },
    ]);
    if (mode === 'crossed') {
      const original = f.quote.getMockImplementation()!;
      f.quote.mockImplementation(async (...args) => {
        const q = await original(...args);
        f.clockState.unixTimestamp = String(now / 1000 + 10);
        return q;
      });
    }
    const pending = quoteOwnedImportedPair(
      f.db,
      'alice',
      f.request,
      signal(),
      f.dependencies,
    );
    if (mode === 'crossed')
      await expect(pending).rejects.toMatchObject({ status: 409 });
    else {
      const result = await pending;
      expect(
        Date.parse(result.pair.expiresAt) - Date.parse(result.pair.observedAt),
      ).toBe(9000);
    }
  },
);
it.each(['Buy', 'Sell'] as const)(
  'quotes %s with independent base and quote scales and binds the original UI budget',
  async (side) => {
    const f = (fixture = importedPairQuoteFixture(side));
    const extension = (multiplier: number) => ({
      __kind: 'ScaledUiAmountConfig' as const,
      authority: address('11111111111111111111111111111111'),
      multiplier,
      newMultiplier: multiplier,
      newMultiplierEffectiveTimestamp: 0n,
    });
    f.mints[0] = pairQuoteMint(6, SWAP_TOKEN_2022, [extension(0.5)]);
    f.mints[1] = pairQuoteMint(8, SWAP_TOKEN_2022, [extension(2)]);
    const result = await quoteOwnedImportedPair(
      f.db,
      'alice',
      { ...f.request, amount: '1' },
      signal(),
      f.dependencies,
    );
    expect(result).toMatchObject({
      inputRaw: side === 'Buy' ? '50000000' : '2000000',
      inputAmount: '1',
      requestedInputAmount: '1',
      inputRounding: 'conservative-down-v1',
      outputAmount: side === 'Buy' ? '0.5' : '0.02',
      minimumOutputAmount: side === 'Buy' ? '0.4975' : '0.0199',
      signingAllowed: false,
      executionAllowed: false,
    });
    expect(
      await parseImportedPairQuote(result, { ...f.selection, amount: '1' }),
    ).toEqual(result);
    for (const change of [
      (v: typeof result) => {
        v.requestedInputAmount = '2';
      },
      (v: typeof result) => {
        v.inputAmount = '2';
      },
      (v: typeof result) => {
        v.pair.quote.amountPolicy = { kind: 'unscaled' };
      },
      (v: typeof result) => {
        v.pair.mintPolicy.recheckUnixTimestamp = String(
          BigInt(v.pair.mintPolicy.unixTimestamp) - 1n,
        );
      },
    ]) {
      const mutated = structuredClone(result);
      change(mutated);
      mutated.pair.sha256 = await importedPairSha256(mutated.pair);
      await expect(
        parseImportedPairQuote(mutated, { ...f.selection, amount: '1' }),
      ).rejects.toThrow();
    }
  },
);
it.each(['initial', 'recheck'] as const)(
  'binds the public mainnet TSLAX extension profile at the %s boundary without authorizing execution',
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
    const pending = quoteOwnedImportedPair(
      f.db,
      'alice',
      f.request,
      signal(),
      f.dependencies,
    );
    if (boundary === 'initial')
      expect(await pending).toMatchObject({
        format: 'imported-pair-quote-v2',
        signingAllowed: false,
        executionAllowed: false,
        pair: {
          issuerVerified: false,
          quote: { amountPolicy: { kind: 'scaled-ui-v1' } },
        },
      });
    else
      await expect(pending).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('policy'),
      });
    expect(f.quote).toHaveBeenCalledOnce();
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
it('checks UI precision before reads and raw u64 limits after reading the multiplier', async () => {
  let f = (fixture = importedPairQuoteFixture());
  for (const amount of ['0', '0.000000001'])
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
  await expect(
    quoteOwnedImportedPair(
      f.db,
      'alice',
      { ...f.request, amount: '184467440737.09551616' },
      signal(),
      f.dependencies,
    ),
  ).rejects.toMatchObject({ status: 400 });
  expect(f.rpc).toHaveBeenCalledTimes(3);
  expect(f.quote).not.toHaveBeenCalled();
  f.close();
  f = fixture = importedPairQuoteFixture();
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
