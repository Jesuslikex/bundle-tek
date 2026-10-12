import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { SupplyHistoryChart } from './saved-supply-monitor';
import { captureSupply, type SupplyHistoryRow } from '@/lib/supply-history';
import { supplyFixture, supplyScope } from '../test/supply-history-fixture';
vi.stubGlobal('React', React);
it('renders the saved supply percentage chart without implying continuous movement coverage', () => {
  const first: SupplyHistoryRow = {
      id: 'first',
      sequence: 1,
      scopeId: 'a'.repeat(64),
      document: captureSupply(supplyFixture(), supplyScope, 1, null),
    },
    second: SupplyHistoryRow = {
      id: 'second',
      sequence: 2,
      scopeId: first.scopeId,
      document: captureSupply(supplyFixture(1), supplyScope, 1, first),
    };
  const html = renderToStaticMarkup(
    <SupplyHistoryChart items={[second, first]} />,
  );
  expect(html).toContain('Team supply percentage across 2 saved observations');
  expect(html).toContain('not every on-chain movement');
  expect(html).not.toContain('NaN');
  expect(
    renderToStaticMarkup(<SupplyHistoryChart items={[first]} />),
  ).toContain('Save a second supply read');
});
