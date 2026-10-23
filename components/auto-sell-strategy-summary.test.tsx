import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { newAutoSellStrategy, type AutoSellStrategy } from '@/lib/auto-sell';
import { AutoSellStrategySummary } from './auto-sell-strategy-summary';
vi.stubGlobal('React', React);
const view = (patch: Partial<AutoSellStrategy> = {}) => {
  const strategy = {
    ...newAutoSellStrategy(0),
    replicationPercent: '20',
    ...patch,
  };
  const original = structuredClone(strategy);
  const html = renderToStaticMarkup(
    <AutoSellStrategySummary strategy={strategy} />,
  );
  expect(strategy).toEqual(original);
  expect(html).not.toContain('<button');
  expect(html).not.toContain('P&amp;L');
  expect(html).not.toContain('Finalized');
  return html;
};
it.each([
  [{ kind: 'rate', percent: '40' }, '40% chance per eligible outside buy'],
  [
    { kind: 'min-sol', amount: '0.001234567' },
    'Outside buy of at least 0.001234567 SOL',
  ],
  [
    { kind: 'min-token', amount: '9007199254.740993' },
    'Outside buy of at least 9007199254.740993 tokens',
  ],
] as const)(
  'shows Counter sizing and the exact %s trigger units',
  (trigger, label) => {
    const html = view({ trigger });
    expect(html).toContain('Counter Trading');
    expect(html).toContain('20% of each eligible outside buy');
    expect(html).toContain(label);
  },
);
it('keeps exact fixed and range DCA amounts and interval units visible', () => {
  expect(
    view({
      mode: 'dca',
      amountUnit: 'tokens',
      dcaAmount: '9007199254.740993',
      dcaIntervalSeconds: 3661,
    }),
  ).toContain('9007199254.740993 tokens');
  const html = view({
    mode: 'dca',
    dcaRandomized: true,
    dcaMinAmount: '0.000001',
    dcaMaxAmount: '2',
    dcaIntervalSeconds: 3661,
  });
  expect(html).toContain('0.000001% of supply to 2% of supply');
  expect(html).toContain('Minimum interval: 01:01:01 (hours:minutes:seconds)');
});
it('describes configured limit targets without calling them sales or filled orders', () => {
  const html = view({
    mode: 'limit',
    amountUnit: 'tokens',
    limitOrders: [
      { id: 'one', amount: '123.000001', marketCapUsd: '25000' },
      { id: 'two', amount: '2', marketCapUsd: '30000' },
    ],
  });
  expect(html).toContain('2 targets using token amounts');
  expect(html).toContain(
    'First target: 123.000001 tokens at $25000 market cap',
  );
  expect(html).not.toContain('filled');
  expect(html).not.toContain('Sold');
});
it('keeps incomplete drafts explicit and escapes user-provided strings', () => {
  expect(
    view({ mode: 'dca', dcaAmount: '', dcaIntervalSeconds: -1 }),
  ).toContain('Set a valid interval');
  expect(view({ mode: 'limit', limitOrders: [] })).toContain(
    'Add a market-cap target',
  );
  const html = view({ replicationPercent: '<script>alert(1)</script>' });
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;script&gt;');
});
it('labels editing settings as unapplied instead of an active approved configuration', () => {
  const html = renderToStaticMarkup(
    <AutoSellStrategySummary strategy={newAutoSellStrategy(0)} draft />,
  );
  expect(html).toContain('Draft settings: not applied to this run');
  expect(html.replace(/<[^>]*>/g, '')).toContain(
    'Counter Trading: Set a replication factor',
  );
  expect(html).toContain('<fieldset');
});
