import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stockReferenceFixture,
  stockReferenceHash,
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
