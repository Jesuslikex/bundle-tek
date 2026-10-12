import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { SupplyMovementEvidencePanel } from './supply-movement-evidence';
import { captureSupply, type SupplyHistoryRow } from '@/lib/supply-history';
import { supplyFixture, supplyScope } from '../test/supply-history-fixture';
it('offers explicit bounded continuation and explains retained timestamps and foreground pauses', () => {
  const previous: SupplyHistoryRow = {
    id: 'before',
    scopeId: 'scope',
    sequence: 1,
    document: captureSupply(supplyFixture(), supplyScope, 1, null),
  };
  const row: SupplyHistoryRow = {
    id: 'after',
    scopeId: 'scope',
    sequence: 2,
    document: captureSupply(supplyFixture(1), supplyScope, 1, previous),
  };
  const html = renderToStaticMarkup(
    <SupplyMovementEvidencePanel
      projectId="project"
      revision={1}
      row={row}
      wallet={supplyScope.wallets[0].address}
    />,
  );
  for (const text of [
    'Continue index inspection',
    'Stop index inspection',
    '20 pages per start',
    '30 seconds between pages',
    'retains its original observation time',
    'going offline',
    'off',
  ])
    expect(html).toContain(text);
  expect(html).toContain('<output>');
  expect(html).not.toContain('Sign transaction');
});
