import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ImportedAcquisitionReview } from './imported-acquisition-review';
import { acquisitionBasketFixture } from '../test/imported-acquisition-basket-fixture';
it('shows each captured source, total input and exact fee-inclusive basis without signing controls', () => {
  const a = acquisitionBasketFixture();
  const html = renderToStaticMarkup(
    <ImportedAcquisitionReview acquisition={a} />,
  );
  for (const source of a.allocations)
    expect(html).toContain(source.buyReceiptId);
  expect(html).toContain('Total assigned input 3');
  expect(html).toContain('0.000000101');
  expect(html).toContain('0.000000068');
  expect(html).toContain('0.000000033');
  expect(html).toContain('must commit together');
  expect(html).not.toContain('<button');
  const single = renderToStaticMarkup(
    <ImportedAcquisitionReview acquisition={a.allocations[0]} />,
  );
  expect(single).toContain('Total assigned input 2');
  expect(single).not.toContain(a.allocations[1].buyReceiptId);
});
