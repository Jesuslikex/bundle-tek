// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BubbleMapPanel } from './bubble-map-panel';

const A = 'Vote111111111111111111111111111111111111111';
const B = 'Stake11111111111111111111111111111111111111';
const T = 'Config1111111111111111111111111111111111111';
const F = 'SysvarRent111111111111111111111111111111111';
afterEach(() => vi.unstubAllGlobals());

it('maps holders and the team wallet only after a click and reports linked supply', async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const fetchMock = vi.fn(async (_path: string, init?: RequestInit) => {
    const { addresses } = JSON.parse(init!.body as string) as {
      addresses: string[];
    };
    expect(addresses).toEqual([A, B, T]);
    const f = { funder: F, signature: 's', slot: 1 };
    return Response.json({
      funders: {
        [A]: { funder: f },
        [B]: { funder: null },
        [T]: { funder: f },
      },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <BubbleMapPanel
        holders={[
          { owner: A, raw: '400' },
          { owner: B, raw: '100' },
        ]}
        teamWallets={[T]}
        totalSupplyRaw="1000"
      />,
    ),
  );
  expect(fetchMock).not.toHaveBeenCalled();
  expect(container.textContent).toContain(
    'Provider history may be incomplete.',
  );
  await act(async () => container.querySelector('button')!.click());
  expect(container.textContent).toContain('Clustered supply 40.00%');
  expect(container.textContent).toContain(
    'Linked to your team wallets: 40.00%',
  );
  expect(container.textContent).toContain(
    '1 wallet(s) had no usable funding evidence in this bounded lookup',
  );
  act(() => root.unmount());
});
