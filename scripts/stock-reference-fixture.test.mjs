import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STOCK_REFERENCE_POOL_MAX,
  stockReferenceFixture,
  stockReferenceHash,
  stockReferencePool,
} from './stock-reference-fixture.mjs';

test('pins each asset before the sample and detects modified reference identity', () => {
  const references = {
    SOL: '11111111111111111111111111111111',
    USDC: 'So11111111111111111111111111111111111111112',
  };
  const fixture = {
    format: 'stock-public-reference-fixture-v1',
    readOnly: true,
    references,
    referenceHashes: Object.fromEntries(
      Object.entries(references).map(([k, v]) => [k, stockReferenceHash(v)]),
    ),
  };
  assert.equal(
    stockReferenceFixture(JSON.stringify(fixture), 'SOL'),
    references.SOL,
  );
  assert.equal(
    stockReferenceFixture(JSON.stringify(fixture), 'USDC'),
    references.USDC,
  );
  fixture.references.USDC = references.SOL;
  assert.throws(() => stockReferenceFixture(JSON.stringify(fixture), 'USDC'));
});

test('refuses absent, malformed, wrong-format and non-read-only fixtures', () => {
  for (const fixture of [
    {},
    { format: 'stock-public-reference-fixture-v1', readOnly: false },
    {
      format: 'stock-public-reference-fixture-v1',
      readOnly: true,
      references: { SOL: 'not an address' },
    },
  ])
    assert.throws(() => stockReferenceFixture(JSON.stringify(fixture), 'SOL'));
});

const poolOf = (references) => ({
  format: 'stock-public-reference-pool-v1',
  readOnly: true,
  references,
  referenceHashes: Object.fromEntries(
    Object.entries(references).map(([k, v]) => [
      k,
      v.map((key) => stockReferenceHash(key)),
    ]),
  ),
});

test('a pool yields every pinned candidate in order; a single fixture yields one', () => {
  const sol = [
    '11111111111111111111111111111111',
    'So11111111111111111111111111111111111111112',
  ];
  const usdc = ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'];
  const pool = poolOf({ SOL: sol, USDC: usdc });
  assert.deepEqual(stockReferencePool(JSON.stringify(pool), 'SOL'), sol);
  assert.deepEqual(stockReferencePool(JSON.stringify(pool), 'USDC'), usdc);
  const single = {
    format: 'stock-public-reference-fixture-v1',
    readOnly: true,
    references: { SOL: sol[0] },
    referenceHashes: { SOL: stockReferenceHash(sol[0]) },
  };
  assert.deepEqual(stockReferencePool(JSON.stringify(single), 'SOL'), [sol[0]]);
});

test('refuses modified, duplicate, oversized, empty or non-read-only pools', () => {
  const key = '11111111111111111111111111111111';
  const modified = poolOf({ SOL: [key] });
  modified.references.SOL = ['So11111111111111111111111111111111111111112'];
  const duplicate = poolOf({ SOL: [key, key] });
  const oversized = poolOf({
    SOL: Array.from(
      { length: STOCK_REFERENCE_POOL_MAX + 1 },
      (_, i) => key.slice(0, 31) + '123456789ABCDEFGHJ'[i],
    ),
  });
  const empty = poolOf({ SOL: [] });
  const writable = { ...poolOf({ SOL: [key] }), readOnly: false };
  const shortHashes = poolOf({ SOL: [key] });
  shortHashes.referenceHashes.SOL = [];
  for (const fixture of [
    modified,
    duplicate,
    oversized,
    empty,
    writable,
    shortHashes,
  ])
    assert.throws(() => stockReferencePool(JSON.stringify(fixture), 'SOL'));
  assert.throws(() =>
    stockReferencePool(JSON.stringify(poolOf({ SOL: [key] })), 'USDC'),
  );
});
