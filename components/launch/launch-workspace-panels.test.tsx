// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { LaunchWorkspacePanels } from './launch-workspace-panels';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

test('renders the three panels and links to existing flows', () => {
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
  const buttons = [...host.querySelectorAll('button')];
  act(() => buttons.find((b) => b.textContent === 'Fund wallets')?.click());
  act(() => buttons.find((b) => b.textContent === 'My wallets')?.click());
  expect(onFund).toHaveBeenCalledOnce();
  expect(onOpenWallets).toHaveBeenCalledOnce();
  act(() => root.unmount());
  host.remove();
});
