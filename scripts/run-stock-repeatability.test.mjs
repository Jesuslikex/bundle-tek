import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runStockRepeatability,
  stockCampaignSummary,
} from './run-stock-repeatability.mjs';

test('retains a failed summary without turning malformed or over-budget attempts into a pass', () => {
  const receipts = [
    { maximumRollingRpcMethods: 10, reason: 'private provider detail' },
  ];
  const result = stockCampaignSummary({ complete: true }, receipts);
  assert.equal(result.summary, null);
  assert.match(result.summaryError, /failed validation/);
  assert.equal(result.summaryError.includes('private provider detail'), false);
  assert.equal(receipts[0].maximumRollingRpcMethods, 10);
  assert.deepEqual(stockCampaignSummary({ complete: false }, receipts), {
    summary: null,
    summaryError: null,
  });
});

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
test('stops the fixed campaign on a parsed RPC 429 with HTTP 200', async () => {
  const calls = [];
  const result = await runStockRepeatability(async (input) => {
    calls.push(input);
    return { passed: false, http429: 0, rpcRateLimited: calls.length === 2 };
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
