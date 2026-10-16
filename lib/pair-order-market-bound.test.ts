import { expect, it } from 'vitest';
import {
  pairOrderMarketBound,
  readPairOrderMarketBound,
} from './pair-order-market-bound';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { ImportedPairQuote } from './imported-trade-pair';
import type { SolanaPairPreparation } from './warmup-swap-quote';
import type { SavedTokenMarket } from './token-market';
const now = Date.UTC(2026, 9, 16),
  stamp = new Date(now).toISOString();
function setup(side: 'Buy' | 'Sell' = 'Buy', input = '100', output = '10') {
  const asset = (address: string) => ({
    address,
    decimals: 0,
    amountPolicy: { kind: 'unscaled' },
  });
  const q = {
    side,
    pair: {
      base: asset('base'),
      quote: asset('quote'),
      projectRevision: 1,
      mintPolicy: { recheckUnixTimestamp: '1' },
    },
  } as ImportedPairQuote;
  const order = { inAmount: input, outAmount: output } as SolanaPairPreparation;
  const observation = (address: string, priceUsd: string) =>
    ({
      chain: 'Solana',
      address,
      projectRevision: 1,
      observedAt: stamp,
      source: 'api.dexscreener.com',
      pairs: [{ address: address + '-pool', priceUsd }],
    }) as SavedTokenMarket;
  return {
    q,
    order,
    base: observation('base', '10'),
    counter: observation('quote', '1'),
  };
}
it.each([
  ['Buy', '1020', '100', false],
  ['Buy', '1021', '100', true],
  ['Buy', '900', '100', false],
  ['Sell', '100', '980', false],
  ['Sell', '100', '979', true],
  ['Sell', '100', '1100', false],
] as const)(
  'warns only on worse %s expected price: %s/%s',
  (side, input, output, required) => {
    const { q, order, base, counter } = setup(side, input, output);
    expect(pairOrderMarketBound(q, order, base, counter, now)).toMatchObject({
      available: true,
      acknowledgementRequired: required,
    });
  },
);
it('converts quote asset USD price instead of assuming a stablecoin peg', () => {
  const { q, order, base, counter } = setup();
  counter.pairs[0].priceUsd = '2';
  expect(pairOrderMarketBound(q, order, base, counter, now)).toMatchObject({
    available: true,
    orderImpliedBasePriceUsd: '20.000000000000000000',
    acknowledgementRequired: true,
  });
});
it.each([
  'missing-base',
  'missing-quote',
  'stale',
  'future',
  'revision',
  'address',
  'quote-stale',
  'scaled',
  'price-null',
] as const)('discloses unavailable %s market comparison', (mode) => {
  const { q, order, base, counter } = setup();
  if (mode === 'stale') base.observedAt = new Date(now - 300001).toISOString();
  if (mode === 'future') base.observedAt = new Date(now + 1).toISOString();
  if (mode === 'revision') base.projectRevision = 2;
  if (mode === 'address') base.address = 'other';
  if (mode === 'quote-stale')
    counter.observedAt = new Date(now - 300001).toISOString();
  if (mode === 'scaled')
    q.pair.base.amountPolicy = {
      kind: 'scaled-ui-v1',
      multiplierHex: '3ff0000000000000',
      nextMultiplierHex: '3ff0000000000000',
      effectiveTimestamp: '1',
    };
  if (mode === 'price-null') base.pairs[0].priceUsd = null;
  const result = pairOrderMarketBound(
    q,
    order,
    mode === 'missing-base' ? null : base,
    mode === 'missing-quote' ? null : counter,
    now,
  );
  expect(result).toMatchObject({
    available: false,
    acknowledgementRequired: false,
  });
  expect('reason' in result && result.reason.length).toBeGreaterThan(0);
});
it('handles exact micro prices and amounts without floating point or exponent notation', () => {
  const { q, order, base, counter } = setup(
    'Sell',
    '10000000000000000000',
    '9799999999999999999',
  );
  base.pairs[0].priceUsd = '0.000000000000000001';
  counter.pairs[0].priceUsd = '0.000000000000000001';
  expect(pairOrderMarketBound(q, order, base, counter, now)).toMatchObject({
    available: true,
    acknowledgementRequired: true,
    differenceBps: '-200',
  });
});
it('allows exactly five minutes and retains the earlier USD-source expiry', () => {
  const { q, order, base, counter } = setup();
  counter.observedAt = new Date(now - 300000).toISOString();
  expect(pairOrderMarketBound(q, order, base, counter, now)).toMatchObject({
    available: true,
    expiresAt: stamp,
  });
});
it('reads the stats collection for the current owner/revisions and never substitutes another owner or archived quote', async () => {
  const { q, order, base, counter } = setup();
  q.pair.projectId = 'base-project';
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(
      'CREATE TABLE imported_token_projects(owner_id TEXT,id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER); CREATE TABLE imported_market_observations(owner_id TEXT,project_id TEXT,document TEXT,observed_at TEXT)',
    );
    for (const [owner, id, obs] of [
      ['alice', 'base-project', base],
      ['alice', 'quote-project', counter],
      [
        'bob',
        'other-project',
        { ...counter, pairs: [{ ...counter.pairs[0], priceUsd: '10000' }] },
      ],
    ] as const) {
      sqlite
        .prepare('INSERT INTO imported_token_projects VALUES(?,?,?,?,?,0)')
        .run(owner, id, 'Solana', obs.address, 1);
      sqlite
        .prepare('INSERT INTO imported_market_observations VALUES(?,?,?,?)')
        .run(owner, id, JSON.stringify([obs]), obs.observedAt);
    }
    const db = {
      prepare(sql: string) {
        let values: SQLInputValue[] = [];
        return {
          bind(...args: SQLInputValue[]) {
            values = args;
            return this;
          },
          async first() {
            return sqlite.prepare(sql).get(...values) ?? null;
          },
        };
      },
    } as unknown as D1Database;
    expect(
      await readPairOrderMarketBound(db, 'alice', q, order, now),
    ).toMatchObject({
      available: true,
      quotePriceUsd: '1',
      orderImpliedBasePriceUsd: '10.000000000000000000',
      acknowledgementRequired: false,
    });
    sqlite.exec(
      "UPDATE imported_token_projects SET archived=1 WHERE id='quote-project'",
    );
    expect(
      await readPairOrderMarketBound(db, 'alice', q, order, now),
    ).toMatchObject({
      available: false,
      reason: expect.stringContaining('exact pair asset'),
    });
    sqlite.exec(
      "UPDATE imported_token_projects SET revision=2 WHERE id='base-project'",
    );
    expect(
      await readPairOrderMarketBound(db, 'alice', q, order, now),
    ).toMatchObject({ available: false });
  } finally {
    sqlite.close();
  }
});
