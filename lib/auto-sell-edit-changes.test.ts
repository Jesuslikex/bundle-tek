import { expect, it } from 'vitest';
import { newAutoSellStrategy } from './auto-sell';
import { autoSellEditChanges } from './auto-sell-edit-changes';
const configuration = () => ({
  strategies: [
    { ...newAutoSellStrategy(0), id: 'a', replicationPercent: '10' },
  ],
  session: {
    startDelaySeconds: 0,
    endDurationSeconds: 0,
    endMaxSupplyPercent: '',
  },
});
it('shows changed bounds without hiding the old values', () => {
  const before = configuration(),
    after = structuredClone(before);
  after.session.endMaxSupplyPercent = '5';
  after.strategies[0].replicationPercent = '20';
  expect(autoSellEditChanges(before, after)).toEqual([
    { label: 'Session maximum', before: 'No amount limit', after: '5% supply' },
    { label: 'Counter · Replication', before: '10%', after: '20%' },
  ]);
});
it('makes an equal-price replacement limit order visible as a new intent', () => {
  const before = configuration();
  before.strategies[0].mode = 'limit';
  before.strategies[0].limitOrders = [
    { id: 'old', amount: '1', marketCapUsd: '100' },
  ];
  const after = structuredClone(before);
  after.strategies[0].limitOrders[0].id = 'new';
  expect(autoSellEditChanges(before, after)).toEqual([
    {
      label: 'Counter · Limit orders',
      before: '1. 1 % supply at $100',
      after: '1. 1 % supply at $100 (new order)',
    },
  ]);
});
it('shows removed and new strategy fields rather than treating them as the same name', () => {
  const before = configuration(),
    after = structuredClone(before);
  after.strategies[0].id = 'new';
  const changes = autoSellEditChanges(before, after);
  expect(
    changes.some(
      (change) => change.before === '10%' && change.after === 'Removed',
    ),
  ).toBe(true);
  expect(
    changes.some(
      (change) => change.before === 'Not present' && change.after === '10%',
    ),
  ).toBe(true);
});
it('shows a priority change that can alter which strategy sells first', () => {
  const before = configuration();
  before.strategies.push({
    ...newAutoSellStrategy(1),
    id: 'b',
    replicationPercent: '10',
  });
  const after = structuredClone(before);
  after.strategies.reverse();
  expect(autoSellEditChanges(before, after)).toEqual([
    {
      label: 'Strategy priority',
      before: 'Counter → Counter 2',
      after: 'Counter 2 → Counter',
    },
  ]);
});
