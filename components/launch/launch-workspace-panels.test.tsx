// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { LaunchWorkspacePanels } from './launch-workspace-panels';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

test('renders the four panels and links to existing flows', () => {
  const onFund = vi.fn();
  const onOpenWallets = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <LaunchWorkspacePanels
        chain="Solana"
        onFund={onFund}
        onOpenWallets={onOpenWallets}
      />,
    ),
  );
  const text = host.textContent ?? '';
  expect(text).toContain('Funding Wallet');
  expect(text).toContain('Auto Sell');
  expect(text).toContain('Sniper Guard');
  expect(text).toContain('Cleanup');
  expect(text).toContain('buy rounds');
  const buttons = [...host.querySelectorAll('button')];
  act(() => buttons.find((b) => b.textContent === 'Fund wallets')?.click());
  act(() => buttons.find((b) => b.textContent === 'My wallets')?.click());
  act(() => buttons.find((b) => b.textContent === 'Configure')?.click());
  // The card leaves a hash so the wallet workspace opens the dialog on arrival.
  expect(window.location.hash).toBe('#cleanup');
  expect(onFund).toHaveBeenCalledOnce();
  // Both the wallet link and the Cleanup card route to the wallet workspace.
  expect(onOpenWallets).toHaveBeenCalledTimes(2);
  act(() => root.unmount());
  host.remove();
});
test('offers Fund all and Return all only on Solana with a picked funder', () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = (chain: 'Solana' | 'Base') =>
    act(() =>
      root.render(
        <LaunchWorkspacePanels
          chain={chain}
          onFund={() => {}}
          onOpenWallets={() => {}}
        />,
      ),
    );
  window.localStorage.removeItem('bundle:funder:Solana');
  render('Solana');
  expect(host.textContent).not.toContain('Fund all');
  window.localStorage.setItem(
    'bundle:funder:Solana',
    '11111111111111111111111111111112',
  );
  window.dispatchEvent(new Event('bundle:funder-change'));
  render('Solana');
  expect(host.textContent).toContain('Fund all');
  expect(host.textContent).toContain('Return all');
  render('Base');
  expect(host.textContent).not.toContain('Fund all');
  act(() => root.unmount());
  host.remove();
  window.localStorage.removeItem('bundle:funder:Solana');
});
