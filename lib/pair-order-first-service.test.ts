import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { TokenMarket } from './token-market';
import { pairQuoteMint } from '../test/imported-pair-quote-fixture';
import { pairWalletTokenAccount } from '../test/pair-wallet-fixture';
import { pairOrderFixture } from '../test/pair-order-fixture';
import { authorizePairOrderAfterRecheck } from './pair-order-authorization';
import {
  quoteOwnedImportedPair,
  createPairOrderQuoteScope,
} from './imported-pair-quote-service';
import {
  approveOwnedPairOrderFirstReview,
  prepareOwnedPairOrderFirstReview,
  readOwnedPairOrderFirstReview,
  pairOrderFirstRequest,
} from './pair-order-first-service';
let f: Awaited<ReturnType<typeof pairOrderFixture>> | undefined;
afterEach(() => {
  f?.close();
  f = undefined;
});
it.each(['third', 'changed-request', 'expired', 'forged'] as const)(
  'fails closed on %s quote continuations without removing the public rate gate',
  async (mode) => {
    const { v } = await setup();
    const provider = {
      ...v.orderDependencies,
      quoteScope: mode === 'forged' ? {} : createPairOrderQuoteScope(),
    };
    const input = v.request;
    if (mode === 'forged') {
      await expect(
        quoteOwnedImportedPair(
          v.db,
          'alice',
          input,
          new AbortController().signal,
          provider,
        ),
      ).rejects.toThrow(/continuation/);
      return;
    }
    await quoteOwnedImportedPair(
      v.db,
      'alice',
      input,
      new AbortController().signal,
      provider,
    );
    await expect(
      quoteOwnedImportedPair(
        v.db,
        'alice',
        input,
        new AbortController().signal,
        v.orderDependencies,
      ),
    ).rejects.toMatchObject({ status: 429 });
    if (mode === 'expired') v.clock.now += 25000;
    if (mode === 'third')
      await quoteOwnedImportedPair(
        v.db,
        'alice',
        input,
        new AbortController().signal,
        provider,
      );
    await expect(
      quoteOwnedImportedPair(
        v.db,
        'alice',
        mode === 'changed-request' ? { ...input, amount: '0.00000002' } : input,
        new AbortController().signal,
        provider,
      ),
    ).rejects.toThrow(/continuation/);
  },
);
async function setup() {
  const v = (f = await pairOrderFixture());
  v.sqlite.exec(
    'CREATE TABLE imported_market_observations(owner_id TEXT,project_id TEXT,document TEXT,observed_at TEXT)',
  );
  v.sqlite.exec(
    readFileSync(
      new URL('../drizzle/0089_pair_order_first_reviews.sql', import.meta.url),
      'utf8',
    ).replaceAll('--> statement-breakpoint', ''),
  );
  const request = { ...v.orderRequest, absoluteMinimumRaw: null };
  const run = () =>
    prepareOwnedPairOrderFirstReview(
      v.db,
      'alice',
      request,
      new AbortController().signal,
      v.orderDependencies,
    );
  return { v, request, run };
}
it('enforces exact owned consent and one authorization per review in the local database', async () => {
  const { v, run } = await setup();
  for (const file of [
    '0013_fresh_sandman',
    '0090_pair_order_first_authorizations',
    '0091_pair_order_independent_price_consent',
  ])
    v.sqlite.exec(
      readFileSync(
        new URL(`../drizzle/${file}.sql`, import.meta.url),
        'utf8',
      ).replaceAll('--> statement-breakpoint', ''),
    );
  v.sqlite
    .prepare('INSERT INTO wallet_ownership_proofs VALUES (?,?,?,?,?)')
    .run(
      'alice',
      'Solana',
      v.wallet,
      new Date(v.clock.now).toISOString(),
      'test-proof',
    );
  const saved = await run(),
    record = await readOwnedPairOrderFirstReview(v.db, 'alice', saved.id),
    r = saved.review;
  const consent = {
    reviewSha256: r.sha256,
    packetSha256: r.packetSha256,
    approvedMinimumOutputRaw: r.minimumOutputRaw,
    approveExactOrder: true as const,
    acknowledgeIndependentDifference: false,
    acknowledgeUnavailableIndependentPrice: true,
  };
  const auth = await authorizePairOrderAfterRecheck(
    r,
    consent,
    record.candidate.review,
    async () => ({
      packetSha256: r.packetSha256,
      sourceSnapshotSha256: record.candidate.review.sourceSnapshotSha256,
      runtimeSha256: 'a'.repeat(64),
      minimumSlot: record.candidate.review.minimumSlot,
      maximumSlot: record.candidate.review.maximumSlot,
      ownedContextUnchanged: true,
      custodyAndBalancesUnchanged: true,
      originalLifetimeValid: true,
      twoCompleteCodeScansMatched: true,
      trustedProgramPolicyEstablished: true,
      applicationReservationsChecked: true,
    }),
    new AbortController().signal,
    () => v.clock.now,
  );
  const insert = (doc: typeof auth, owner = 'alice') =>
    v.sqlite
      .prepare(
        'INSERT INTO pair_order_first_authorizations VALUES (?,?,?,?,?,?)',
      )
      .run(
        doc.id,
        saved.id,
        owner,
        JSON.stringify(doc),
        doc.createdAt,
        doc.expiresAt,
      );
  expect(() => insert({ ...auth, minimumOutputRaw: '1' })).toThrow(/ownership/);
  expect(() =>
    insert({
      ...auth,
      consent: { ...auth.consent, approvedMinimumOutputRaw: '1' },
    }),
  ).toThrow(/consent/);
  expect(() => insert(auth, 'bob')).toThrow(/ownership/);
  expect(() =>
    insert({ ...auth, expiresAt: new Date(v.clock.now + 5001).toISOString() }),
  ).toThrow();
  for (const ack of [false, undefined, null, 1, 'true']) {
    const changed = {
      ...auth,
      id: crypto.randomUUID(),
      consent: { ...auth.consent, acknowledgeUnavailableIndependentPrice: ack },
    };
    expect(() => insert(changed as typeof auth)).toThrow(/acknowledgement/);
  }
  insert(auth);
  expect(() => insert({ ...auth, id: crypto.randomUUID() })).toThrow(/UNIQUE/);
  expect(() =>
    v.sqlite.exec(
      'UPDATE pair_order_first_authorizations SET owner_id=owner_id',
    ),
  ).toThrow(/Immutable/);
  expect(() =>
    v.sqlite.exec('DELETE FROM pair_order_first_authorizations'),
  ).toThrow(/Immutable/);
});
it('captures a server baseline, prepares once, then quotes again before review and stores immutable owned evidence', async () => {
  const { v, run } = await setup();
  const stages: string[] = [];
  const quote = v.quote.getMockImplementation()!,
    prepare = v.prepare.getMockImplementation()!;
  v.quote.mockImplementation(async (...args) => {
    stages.push('quote');
    return quote(...args);
  });
  v.prepare.mockImplementation(async (...args) => {
    stages.push('order');
    return prepare(...args);
  });
  const saved = await run();
  expect(stages).toEqual(['quote', 'order', 'quote']);
  expect(saved.review.minimumOutputRaw).toBe('995000');
  expect(
    (await readOwnedPairOrderFirstReview(v.db, 'alice', saved.id)).review,
  ).toEqual(saved.review);
  await expect(
    readOwnedPairOrderFirstReview(v.db, 'bob', saved.id),
  ).rejects.toMatchObject({ status: 404 });
  expect(() =>
    v.sqlite.exec('UPDATE pair_order_first_reviews SET sha256=sha256'),
  ).toThrow(/Immutable/);
  expect(() => v.sqlite.exec('DELETE FROM pair_order_first_reviews')).toThrow(
    /Immutable/,
  );
  const consent = {
    reviewSha256: saved.review.sha256,
    packetSha256: saved.review.packetSha256,
    approvedMinimumOutputRaw: '995000',
    approveExactOrder: true as const,
    acknowledgeIndependentDifference: false,
    acknowledgeUnavailableIndependentPrice: true,
  };
  await expect(
    approveOwnedPairOrderFirstReview(
      v.db,
      'alice',
      saved.id,
      consent,
      v.clock.now,
    ),
  ).rejects.toMatchObject({
    status: 409,
    message: expect.stringContaining('disabled'),
  });
  await expect(
    approveOwnedPairOrderFirstReview(
      v.db,
      'alice',
      saved.id,
      consent,
      Date.parse(saved.review.expiresAt),
    ),
  ).rejects.toThrow(/new review/);
});
it('accepts an independent preview difference only as a new review, without weakening the fresh minimum', async () => {
  const { v, run } = await setup();
  const quote = v.quote.getMockImplementation()!;
  let count = 0;
  v.quote.mockImplementation(async (...args) => {
    const q = await quote(...args);
    return ++count === 1
      ? { ...q, outAmount: '1100000', minimumOutAmount: '1094500' }
      : q;
  });
  const saved = await run();
  expect(saved.review.acknowledgementRequired).toBe(true);
  expect(saved.review.minimumOutputRaw).toBe('995000');
});
it('rejects one unit below the fresh reference, with no saved review', async () => {
  const { v, run } = await setup();
  const quote = v.quote.getMockImplementation()!;
  let count = 0;
  v.quote.mockImplementation(async (...args) => {
    const q = await quote(...args);
    return ++count === 2 ? { ...q, minimumOutAmount: '995001' } : q;
  });
  await expect(run()).rejects.toMatchObject({ status: 409 });
  expect(
    v.sqlite
      .prepare('SELECT count(*) AS n FROM pair_order_first_reviews')
      .get()!.n,
  ).toBe(0);
});
it('rejects changed ownership at the storage boundary', async () => {
  const { v, run } = await setup();
  v.orderState.onSimulation = () => {
    v.sqlite.exec('UPDATE workspace_wallets SET archived=1');
  };
  await expect(run()).rejects.toThrow();
  expect(
    v.sqlite
      .prepare('SELECT count(*) AS n FROM pair_order_first_reviews')
      .get()!.n,
  ).toBe(0);
});
it.each([
  {},
  { absoluteMinimumRaw: '0' },
  { absoluteMinimumRaw: '18446744073709551616' },
  { absoluteMinimumRaw: 1 },
  { absoluteMinimumRaw: null, enableSigning: true },
])('rejects malformed or extra request fields', async (extra) => {
  const { v } = await setup();
  expect(() =>
    pairOrderFirstRequest({ ...v.orderRequest, ...extra }),
  ).toThrow();
});

it('reads the exact quote mint on the server alongside preparation, pins its evidence, and uses the selected base pool', async () => {
  const { v, request } = await setup();
  // Synthetic unscaled quote asset for this branch. The normal fixture retains real TSLAX scaling.
  v.mints[1] = { ...v.mints[1], ...pairQuoteMint(8, v.mints[1].owner) };
  v.accounts[1] = pairWalletTokenAccount(
    request.quoteMint,
    v.wallet,
    v.mints[1].owner,
    '500000000',
    [{ __kind: 'ImmutableOwner' }],
  );
  const stamp = new Date(v.clock.now).toISOString();
  const pool = (address: string, priceUsd: string) => ({
    address,
    priceUsd,
    dex: 'test',
    url: 'https://dexscreener.com/solana/' + address,
    quoteSymbol: 'USD',
    liquidityUsd: 100,
    volume24hUsd: null,
    change24h: null,
    marketCapUsd: null,
  });
  const counter: TokenMarket = {
    chain: 'Solana',
    address: request.quoteMint,
    observedAt: stamp,
    source: 'api.dexscreener.com',
    pairs: [pool(request.quoteMint, '150')],
    returnedPairCount: 1,
    quoteOnlyPairCount: 0,
    executionAllowed: false,
  };
  const base = {
    ...counter,
    address: v.baseMint,
    projectRevision: 1,
    pairs: [pool(v.wallet, '999999'), pool(v.baseMint, '1')],
  };
  v.sqlite
    .prepare('INSERT INTO imported_market_observations VALUES(?,?,?,?)')
    .run('alice', request.id, JSON.stringify([base]), stamp);
  expect(
    v.sqlite
      .prepare(
        'SELECT count(*) AS n FROM imported_token_projects WHERE address=?',
      )
      .get(request.quoteMint),
  ).toMatchObject({ n: 0 });
  let release: (value: TokenMarket) => void = () => {};
  const waiting = new Promise<TokenMarket>((resolve) => {
    release = resolve;
  });
  const observe = vi.fn(async () => waiting);
  let prepared: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    prepared = resolve;
  });
  const original = v.prepare.getMockImplementation()!;
  v.prepare.mockImplementation(async (...args) => {
    prepared();
    return original(...args);
  });
  const pending = prepareOwnedPairOrderFirstReview(
    v.db,
    'alice',
    { ...request, marketPair: v.baseMint },
    new AbortController().signal,
    { ...v.orderDependencies, observeQuoteMarket: observe },
  );
  await started;
  release(counter);
  const result = await pending;
  expect(observe).toHaveBeenCalledWith(
    { chain: 'Solana', address: request.quoteMint },
    expect.any(AbortSignal),
  );

  expect(result.review).toMatchObject({
    marketPair: v.baseMint,
    marketComparison: {
      available: true,
      baseMarketPair: v.baseMint,
      basePriceUsd: '1',
      quotePriceUsd: '150',
      quoteObservation: counter,
    },
  });
  await expect(
    approveOwnedPairOrderFirstReview(
      v.db,
      'alice',
      result.id,
      {
        reviewSha256: result.review.sha256,
        packetSha256: result.review.packetSha256,
        approvedMinimumOutputRaw: result.review.minimumOutputRaw,
        approveExactOrder: true,
        acknowledgeIndependentDifference: true,
        acknowledgeUnavailableIndependentPrice: false,
      },
      v.clock.now,
    ),
  ).rejects.toThrow('Stock signing is disabled');
  expect(observe).toHaveBeenCalledOnce();
});
it.each(['not-a-pool', 1, {}, ' ' + '11111111111111111111111111111111'])(
  'rejects malformed or noncanonical market selection %s',
  (marketPair) => {
    expect(() =>
      pairOrderFirstRequest({
        id: '11111111-1111-4111-8111-111111111111',
        revision: 1,
        wallet: '11111111111111111111111111111111',
        walletRevision: 1,
        amount: '1',
        quoteMint: 'So11111111111111111111111111111111111111112',
        side: 'Buy',
        feeAndRentLimitRaw: '10000',
        prepareUnsigned: true,
        absoluteMinimumRaw: null,
        marketPair,
      }),
    ).toThrow();
  },
);

it('keeps real scaled TSLAX quote units unavailable and does not request a USD conversion', async () => {
  const { v, request } = await setup();
  const observe = vi.fn();
  const stamp = new Date(v.clock.now).toISOString();
  const base = {
    chain: 'Solana',
    address: v.baseMint,
    observedAt: stamp,
    source: 'api.dexscreener.com',
    projectRevision: 1,
    pairs: [{ address: v.baseMint, priceUsd: '1' }],
  };
  v.sqlite
    .prepare('INSERT INTO imported_market_observations VALUES(?,?,?,?)')
    .run('alice', request.id, JSON.stringify([base]), stamp);
  const result = await prepareOwnedPairOrderFirstReview(
    v.db,
    'alice',
    { ...request, marketPair: v.baseMint },
    new AbortController().signal,
    { ...v.orderDependencies, observeQuoteMarket: observe },
  );
  expect(result.review.marketComparison).toMatchObject({
    available: false,
    reason: expect.stringContaining('scaled-token'),
  });
  expect(observe).not.toHaveBeenCalled();
});
