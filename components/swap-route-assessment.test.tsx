import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SwapRouteAssessment } from './swap-route-assessment';
import { assessJupiterRoute } from '@/lib/jupiter-route-assessment';
import { routeOrder, routeReview } from '../test/jupiter-route-fixture';
import { readSwapTokenAccountBindings } from '@/lib/swap-token-account-bindings';
import { tokenAccountFixture } from '../test/swap-token-account-fixture';
it('renders separate observed binding provenance and unavailable accounts', async () => {
  const assessment = assessJupiterRoute(routeReview(), routeOrder);
  const bindings = await readSwapTokenAccountBindings(
    assessment,
    routeOrder,
    100,
    async () => ({
      context: { slot: '101' },
      value: [tokenAccountFixture(), null],
    }),
  );
  const html = renderToStaticMarkup(
    <SwapRouteAssessment assessment={assessment} bindings={bindings} />,
  );
  expect(html).toContain('Matched fields');
  expect(html).toContain('Token account bindings');
  expect(html).toContain('observed slot 101');
  expect(html).toContain('Destination: Unavailable');
  expect(html).toContain('Wallet owner: unavailable');
  expect(html).toContain('Delegate: unavailable');
  expect(html).not.toContain('<button');
});
it('renders matched, mismatched and unavailable route evidence without execution controls', () => {
  const matched = renderToStaticMarkup(
    <SwapRouteAssessment
      assessment={assessJupiterRoute(routeReview(), routeOrder)}
    />,
  );
  expect(matched).toContain('Matched fields');
  expect(matched).toContain('1000000');
  expect(matched).toContain('995');
  expect(matched).toContain('Matching fields do not authorize signing');
  expect(matched).not.toContain('<button');
  expect(
    renderToStaticMarkup(
      <SwapRouteAssessment
        assessment={assessJupiterRoute(routeReview({ amount: 1n }), routeOrder)}
      />,
    ),
  ).toContain('Mismatch');
  expect(
    renderToStaticMarkup(
      <SwapRouteAssessment
        assessment={assessJupiterRoute(
          routeReview({ variant: 255 }),
          routeOrder,
        )}
      />,
    ),
  ).toContain('Unavailable');
  expect(renderToStaticMarkup(<SwapRouteAssessment />)).toBe('');
});
