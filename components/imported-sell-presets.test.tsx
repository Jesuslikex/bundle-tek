import { it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ImportedSellPresets } from './imported-sell-presets';
import { importedBalanceReviewFixture } from '../test/imported-balance-review-fixture';
it('shows explicit exact balance percentages while preserving fresh preparation and approval requirements', () => {
  const fixture = importedBalanceReviewFixture();
  const html = renderToStaticMarkup(
    <ImportedSellPresets
      {...fixture}
      locked={false}
      onAmountChange={() => {
        throw new Error('Render must not change amount');
      }}
    />,
  );
  expect(html).toContain('25%');
  expect(html).toContain('MAX');
  expect(html).toContain('observed unfrozen token units');
  expect(html).toContain('explicit signing approval');
  expect(html).not.toContain('disabled=""');
});
it('disables all selections for expired evidence, unsupported inventory and active save/signing locks', () => {
  const fixture = importedBalanceReviewFixture();
  const rows = [
    { ...fixture, locked: true },
    {
      context: fixture.context,
      report: {
        ...fixture.report,
        preparationSupported: false,
        blockedExtensions: ['mint: transferHook'],
      },
      locked: false,
    },
    { ...importedBalanceReviewFixture(Date.now() - 60001), locked: false },
  ];
  for (const props of rows)
    expect(
      renderToStaticMarkup(
        <ImportedSellPresets {...props} onAmountChange={() => {}} />,
      ).match(/\sdisabled=""/g) ?? [],
    ).toHaveLength(4);
});
