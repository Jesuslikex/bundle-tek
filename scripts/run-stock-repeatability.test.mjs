import test from 'node:test';
import assert from 'node:assert/strict';
import { runStockRepeatability } from './run-stock-repeatability.mjs';

test('stops the entire campaign on a rate limit without another asset, retry or replacement attempt', async () => {
  const calls = [];
  const result = await runStockRepeatability(async (input) => {
    calls.push(input);
    return { passed: false, http429: calls.length === 2 ? 1 : 0 };
  });
  assert.deepEqual(calls, [
    { round: 1, asset: 'SOL' },
    { round: 1, asset: 'USDC' },
  ]);
  assert.equal(result.complete, false);
  assert.equal(result.stoppedForRateLimit, true);
  assert.equal(result.results.length, 2);
});
test('keeps ordinary refusals in a fixed alternating six-attempt denominator', async () => {
  const result = await runStockRepeatability(async (input) => ({
    ...input,
    passed: false,
    http429: 0,
  }));
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.results.map((r) => [r.round, r.asset]),
    [
      [1, 'SOL'],
      [1, 'USDC'],
      [2, 'SOL'],
      [2, 'USDC'],
      [3, 'SOL'],
      [3, 'USDC'],
    ],
  );
  assert.equal(result.results.filter((r) => r.passed).length, 0);
});
