import { expect, it } from 'vitest';
import { autoSellActivityLabel, autoSellEndLabel } from './auto-sell-display';
import type { AutoSellLogEntry } from './auto-sell-runner';
it.each([
  ['Max amount sold', 'Maximum accounted amount reached'],
  ['All limit orders filled', 'All limit targets processed'],
  ['Duration reached', 'Duration reached'],
  [null, 'stopped'],
])(
  'labels original engine end reason without changing it: %s',
  (reason, expected) => {
    expect(autoSellEndLabel(reason, 'stopped')).toBe(expected);
  },
);
it('does not present the executor submit response as a finalized sale', () => {
  const entry: AutoSellLogEntry = {
    at: 0,
    strategyId: 'a',
    kind: 'sell',
    text: 'Counter: sold 5000000 raw from DEMO.',
    signature: 'synthetic',
  };
  const before = structuredClone(entry);
  expect(autoSellActivityLabel(entry)).toBe(
    'Counter: submitted 5000000 raw from DEMO. Finality not verified.',
  );
  expect(entry).toEqual(before);
});
it.each([
  [
    'DCA ended: Max amount sold. Other strategies keep running.',
    'DCA ended: Maximum accounted amount reached. Other strategies keep running.',
  ],
  [
    'Limit Orders ended: All limit orders filled. Other strategies keep running.',
    'Limit Orders ended: All limit targets processed. Other strategies keep running.',
  ],
  ['Session duration reached.', 'Session duration reached.'],
])('maps only original informational end labels: %s', (text, expected) => {
  expect(
    autoSellActivityLabel({ at: 0, strategyId: null, kind: 'info', text }),
  ).toBe(expected);
});
it('preserves error and uncertain-outcome text for recovery', () => {
  const text =
    'Outcome unknown. Check signature synthetic in preparation history.';
  expect(
    autoSellActivityLabel({ at: 0, strategyId: 'a', kind: 'error', text }),
  ).toBe(text);
});
it('only rewrites the engine submission suffix, preserving a future custom name', () => {
  const text = 'My: sold 1 raw from NAME: sold 5 raw from DEMO.';
  expect(
    autoSellActivityLabel({ at: 0, strategyId: 'a', kind: 'sell', text }),
  ).toBe(
    'My: sold 1 raw from NAME: submitted 5 raw from DEMO. Finality not verified.',
  );
});
