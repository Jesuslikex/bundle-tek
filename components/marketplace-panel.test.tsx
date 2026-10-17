// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MarketplacePanel } from './marketplace-panel';
import { marketplaceFixture } from '../test/marketplace-fixture';
import {
  marketplaceFilters,
  selectMarketplaceInventory,
} from '../lib/marketplace-catalog';
let root: Root, container: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<MarketplacePanel />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('marks a previously displayed snapshot expired using its own server expiry', async () => {
  vi.useFakeTimers();
  const data = selectMarketplaceInventory(
    marketplaceFixture(),
    marketplaceFilters.parse({}),
    Date.now(),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(data)),
  );
  await submit();
  await act(async () => vi.advanceTimersByTime(60000));
  expect(container.textContent).toContain('Expired. Refresh inventory.');
});

it('rejects responses that claim purchase authority or contain unexpected fields', async () => {
  const data = selectMarketplaceInventory(
    marketplaceFixture(),
    marketplaceFilters.parse({}),
    Date.now(),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ...data, purchaseEnabled: true })),
  );
  await submit();
  expect(container.querySelector('table')).toBeNull();
  expect(container.querySelector('[role=alert]')?.textContent).toBe(
    'Inventory response was invalid.',
  );
});
async function submit() {
  await act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}
it('starts with explicit unavailable checkout and no invented catalog or purchase button', () => {
  expect(container.textContent).toContain('Checkout unavailable');
  expect(container.querySelector('table')).toBeNull();
  expect(container.querySelectorAll('button')).toHaveLength(1);
});
it('handles an HTML error without showing parser text and offers sign-in on 401', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('<html>private</html>', { status: 502 })),
  );
  await submit();
  expect(container.querySelector('[role=alert]')?.textContent).toBe(
    'Inventory could not be loaded. Try again later.',
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({}, { status: 401 })),
  );
  await submit();
  expect(container.querySelector('a')?.getAttribute('href')).toBe('/sign-in');
});
it('separates unavailable sign-in from unavailable inventory', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ code: 'AUTH_UNAVAILABLE' }, { status: 503 }),
    ),
  );
  await submit();
  expect(container.querySelector('[role=alert]')?.textContent).toBe(
    'Bundle sign-in is temporarily unavailable. Try again later.',
  );
});
it('renders provider coverage and exact totals, then clears stale rows when filters change', async () => {
  const data = selectMarketplaceInventory(
    marketplaceFixture(),
    marketplaceFilters.parse({}),
    Date.now(),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(data)),
  );
  await submit();
  expect(container.textContent).toContain('Partial provider coverage');
  expect(container.textContent).toContain('3.300000003 SOL');
  await act(async () => {
    const select = container.querySelector('select')!;
    select.value = '50';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(container.querySelector('table')).toBeNull();
});
it('does not publish an old request after filters change', async () => {
  let resolve!: (r: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    ),
  );
  await submit();
  await act(async () => {
    container
      .querySelector('select')!
      .dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => {
    resolve(
      Response.json(
        selectMarketplaceInventory(
          marketplaceFixture(),
          marketplaceFilters.parse({}),
          Date.now(),
        ),
      ),
    );
  });
  expect(container.querySelector('table')).toBeNull();
});
