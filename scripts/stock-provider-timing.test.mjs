import test from 'node:test';
import assert from 'node:assert/strict';
import {
  measureStockProvider,
  stockQuoteGaps,
} from './stock-provider-timing.mjs';

test('measures full provider completion and separates gaps from provider latency', async () => {
  const events = [];
  const times = [10, 110, 160, 360, 560, 660];
  const result = { minimumOutAmount: '100000000000000001' };
  for (const phase of ['initial-quote', 'wallet-bound-order', 'fresh-quote'])
    assert.equal(
      await measureStockProvider(
        events,
        phase,
        async () => result,
        () => times.shift(),
      ),
      result,
    );
  assert.deepEqual(stockQuoteGaps(events), {
    measured: true,
    reached: 3,
    initialQuoteDurationMs: 100,
    initialQuoteToOrderDispatchMs: 50,
    initialQuoteToOrderCompletionMs: 250,
    orderDurationMs: 200,
    orderToFreshQuoteDispatchMs: 200,
    freshQuoteDurationMs: 100,
    orderToFreshQuoteCompletionMs: 300,
  });
  assert.equal(result.minimumOutAmount, '100000000000000001');
});

test('retains the original refusal and marks later phases unreached', async () => {
  const events = [],
    error = Error('refused');
  let time = 0;
  await assert.rejects(
    measureStockProvider(
      events,
      'initial-quote',
      async () => {
        throw error;
      },
      () => ++time,
    ),
    (caught) => caught === error,
  );
  assert.equal(events[0].outcome, 'refused');
  assert.equal(stockQuoteGaps(events).orderDurationMs, null);
  await assert.rejects(
    measureStockProvider(events, 'fresh-quote', async () => null),
    /sequence/,
  );
});

test('does not invent historical timing and rejects overlapping, reordered or unfinished observations', () => {
  assert.equal(stockQuoteGaps(undefined).measured, false);
  assert.equal(stockQuoteGaps([]).reached, 0);
  const initial = {
    phase: 'initial-quote',
    startMs: 10,
    endMs: 20,
    outcome: 'returned',
  };
  for (const events of [
    [{ ...initial, endMs: null }],
    [{ ...initial, endMs: 9 }],
    [{ ...initial, startMs: NaN }],
    [
      initial,
      {
        phase: 'wallet-bound-order',
        startMs: 19,
        endMs: 30,
        outcome: 'returned',
      },
    ],
    [
      { ...initial, outcome: 'refused' },
      {
        phase: 'wallet-bound-order',
        startMs: 21,
        endMs: 30,
        outcome: 'returned',
      },
    ],
  ])
    assert.throws(() => stockQuoteGaps(events), /timing evidence/);
});
