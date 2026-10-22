// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MainnetFundingRoutes } from './mainnet-funding-routes';
import { MainnetFundingHistoryPanel } from './mainnet-funding-history';
import { fundingRouteFixture } from '../../test/mainnet-funding-route-fixture';
import {
  createFundingRouteSource,
  decodeFundingRouteHistory,
} from '@/lib/mainnet-funding-route-history';
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', webcrypto);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function button(text: string) {
  const value = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(text),
  );
  if (!value) throw Error('Missing ' + text);
  return value;
}
it('shows missing allocations and exact proxy amounts without inventing a required balance or final delivery', async () => {
  const fixture = await fundingRouteFixture();
  fixture.page.progress = { revision: 1, records: [] };
  const view = await decodeFundingRouteHistory(fixture.source, fixture.page);
  await act(async () => root.render(<MainnetFundingRoutes view={view} />));
  expect(
    container.querySelectorAll(
      'ul[aria-label="Planned funding recipients"] > li',
    ),
  ).toHaveLength(2);
  expect(container.textContent).toContain('0 / 3');
  expect(container.textContent).toContain('0 / 2');
  expect(container.textContent).toContain('No retained attempt for this step');
  expect(container.textContent).toContain('0.0101');
  expect(container.textContent).toContain(
    'Final recipient receipt not confirmed',
  );
  expect(container.textContent).toContain(
    'current balances or launch readiness',
  );
  expect(container.querySelector('button')).toBeNull();
});
it('counts final recipient allocations once while keeping intermediate receipts separate', async () => {
  const fixture = await fundingRouteFixture();
  if (fixture.page.progress.unavailable) throw Error();
  const first = fixture.page.progress.records[0];
  first.state = 'finalized';
  first.signature = 'synthetic-first';
  first.receipt = {
    slot: 100,
    observedAt: first.createdAt,
    deliveredRaw: first.amountRaw,
    networkFeeLamports: '5000',
    accountRentLamports: '0',
    transferFeeRaw: null,
  };
  let view = await decodeFundingRouteHistory(fixture.source, fixture.page);
  await act(async () => root.render(<MainnetFundingRoutes view={view} />));
  const counts = () =>
    [...container.querySelectorAll('section > dl > div')].map(
      (d) => d.textContent,
    );
  expect(counts()).toContain('Matching receipts (latest attempts)1 / 3');
  expect(counts()).toContain('Final recipient receipts (latest attempts)0 / 2');
  const final = fixture.page.progress.records[1];
  final.state = 'finalized';
  final.signature = 'synthetic-final';
  final.receipt = { ...first.receipt, deliveredRaw: final.amountRaw };
  view = await decodeFundingRouteHistory(fixture.source, fixture.page);
  await act(async () => root.render(<MainnetFundingRoutes view={view} />));
  expect(counts()).toContain('Matching receipts (latest attempts)2 / 3');
  expect(counts()).toContain('Final recipient receipts (latest attempts)1 / 2');
  expect(counts()).toContain(
    'Receipted allocations (SOL, latest attempts)0.01',
  );
});
it('pages100 planned recipients locally and restores exact status focus without any request', async () => {
  const fixture = await fundingRouteFixture();
  const view = await decodeFundingRouteHistory(fixture.source, fixture.page);
  // Presentation fixture only; model/source admission is tested independently.
  view.routes = Array.from({ length: 100 }, (_, i) => ({
    ...view.routes[0],
    item: i + 1,
  }));
  vi.stubGlobal('fetch', vi.fn());
  await act(async () => root.render(<MainnetFundingRoutes view={view} />));
  const rows = () =>
    container.querySelectorAll(
      'ul[aria-label="Planned funding recipients"] > li',
    );
  const status = container.querySelector(
    'output[aria-label="Saved funding route page"]',
  );
  expect(rows()).toHaveLength(25);
  for (let n = 2; n <= 4; n++) {
    await act(async () => button('Next funding').click());
    expect(document.activeElement).toBe(status);
    expect(status?.textContent).toContain(`page ${n} of 4`);
  }
  expect(rows()[24].textContent).toContain('Recipient 100');
  expect(button('Next funding').disabled).toBe(true);
  await act(async () => button('Previous funding').click());
  expect(status?.textContent).toContain('page 3 of 4');
  expect(document.activeElement).toBe(status);
  expect(fetch).not.toHaveBeenCalled();
});
it('integrates valid routes into the real panel and withholds only the route view for an inconsistent source', async () => {
  const fixture = await fundingRouteFixture();
  let response = {
    ...fixture.page,
    revision: null,
    routeSource: fixture.source,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(response)),
  );
  await act(async () =>
    root.render(
      <MainnetFundingHistoryPanel
        id={fixture.plan.id}
        revision={1}
        name="Synthetic routes"
      />,
    ),
  );
  await act(async () => button('Open mainnet').click());
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.textContent).toContain(
      'Saved funding routes · revision 1',
    );
  });
  expect(
    container.querySelectorAll(
      'ul[aria-label="Planned funding recipients"] > li',
    ),
  ).toHaveLength(2);
  response = {
    ...response,
    routeSource: { ...fixture.source, termsSha256: 'a'.repeat(64) },
  };
  await act(async () => button('Reload mainnet').click());
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.textContent).toContain(
      'Exact native SOL routes are unavailable',
    );
  });
  expect(
    container.querySelector('ul[aria-label="Planned funding recipients"]'),
  ).toBeNull();
  expect(container.textContent).toContain('3 unresolved steps');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('labels a mismatched receipt consistently and never calls it a matching delivery', async () => {
  const fixture = await fundingRouteFixture();
  if (fixture.page.progress.unavailable) throw Error();
  const r = fixture.page.progress.records[2];
  r.state = 'finalized';
  r.signature = 'synthetic-only-mismatch';
  r.receipt = {
    slot: 100,
    observedAt: r.createdAt,
    deliveredRaw: '19999999',
    networkFeeLamports: '5000',
    accountRentLamports: '0',
    transferFeeRaw: null,
  };
  const view = await decodeFundingRouteHistory(fixture.source, fixture.page);
  await act(async () => root.render(<MainnetFundingRoutes view={view} />));
  expect(container.textContent).toContain(
    'Receipt amount differs from saved transfer',
  );
  expect(container.textContent).not.toContain('Finalized delivery verified');
  expect(container.textContent).not.toContain(
    'Final recipient receipt matches',
  );
  expect(container.textContent).toContain('not a cumulative transfer ledger');
});

it('distinguishes the historical evidence revision from the newer saved source and timestamp', async () => {
  const fixture = await fundingRouteFixture();
  fixture.page.currentRevision = 2;
  const updatedAt = '2026-10-22T00:00:00.000Z';
  const source = await createFundingRouteSource(
    { ...fixture.plan, revision: 2, updatedAt },
    1,
  );
  const view = await decodeFundingRouteHistory(source, fixture.page);
  await act(async () => root.render(<MainnetFundingRoutes view={view} />));
  expect(container.textContent).toContain('Historical funding revision 1');
  expect(container.textContent).toContain('source revision 2');
  expect(container.textContent).toContain(
    'not credited to the current revision',
  );
  expect(container.textContent).toContain('Funding evidence revision 1');
  expect(
    container.querySelector('time[datetime="' + updatedAt + '"]'),
  ).not.toBeNull();
});
