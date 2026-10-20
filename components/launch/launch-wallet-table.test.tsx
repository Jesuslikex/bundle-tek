// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { LaunchWalletTable } from './launch-wallet-table';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

test('lists developer plus an even holder split', () => {
  const onOpenWallets = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <LaunchWalletTable
        plan={{
          developerBuy: 5,
          holdersBuy: 20,
          holderCount: 4,
          mode: 'Block-0',
          scheduled: false,
          launchpad: 'Pump.fun',
          currency: 'SOL',
        }}
        onOpenWallets={onOpenWallets}
      />,
    ),
  );
  const cells = [...host.querySelectorAll('tbody tr')].map((r) =>
    [...r.querySelectorAll('td')].map((c) => c.textContent),
  );
  expect(cells).toHaveLength(5);
  expect(cells[0]).toEqual(['0', 'Developer', 'Assigned at funding', '5%']);
  expect(cells[1][3]).toBe('5%');
  act(() => host.querySelector('button')?.click());
  expect(onOpenWallets).toHaveBeenCalledOnce();
  act(() => root.unmount());
  host.remove();
});
