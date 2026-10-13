import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChartExecutionAverages } from './chart-execution-averages';
import {
  acquisitionReceipt,
  acquisitionId,
  acquisitionMint,
} from '../test/imported-sell-acquisition-fixture';
it('shows exact receipt-weighted SOL prices and loaded-history coverage without fabricating USD overlays', () => {
  const html = renderToStaticMarkup(
    <ChartExecutionAverages
      receipts={[acquisitionReceipt(2)]}
      projectId={acquisitionId(1)}
      mint={acquisitionMint}
      decimals={0}
      hasOlder
    />,
  );
  expect(html).toContain('SOL per token');
  expect(html).toContain('Exact SOL/token fraction');
  expect(html).toContain(
    'excludes separate network fees, rent and bundle tips',
  );
  expect(html).toContain('Older receipts remain outside');
  expect(html).toContain('USD chart overlays require');
  expect(html).toContain('No loaded receipts for this side');
});
