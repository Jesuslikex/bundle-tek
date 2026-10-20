// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AutoSell } from './auto-sell-modal';
import type { ImportedTokenProject } from '@/lib/imported-token-project';

let host: HTMLDivElement, root: Root;
const project = {
  id: 'p1',
  revision: 1,
  document: {
    token: {
      chain: 'Solana',
      address: 'Mint111111111111111111111111111111111111111',
      decimals: 6,
      totalSupplyRaw: '1000000000000000',
    },
  },
} as unknown as ImportedTokenProject;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('offline');
    }),
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const button = (text: string) =>
  [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  )!;
const click = async (text: string) => {
  await act(async () => button(text).click());
};

it('switches between Counter, DCA and Limit Orders', async () => {
  await act(async () =>
    root.render(<AutoSell project={project} wallets={[]} locked={false} />),
  );
  await click('Auto Sell');
  expect(host.textContent).toContain('Replication Factor');
  await click('◷ DCA');
  expect(host.textContent).toContain('Interval');
  expect(host.textContent).toContain('Fixed Amount');
  expect(host.textContent).not.toContain('Replication Factor');
  expect(host.textContent).not.toContain('Whitelist');
  expect(host.querySelector('[aria-label="DCA strategy"]')).not.toBeNull();
  await click('Randomized');
  expect(host.textContent).toContain('Min Amount');
  expect(host.textContent).toContain('Max Amount');
  await click('⇡ Limit Orders');
  expect(host.querySelectorAll('[aria-label$="market cap"]')).toHaveLength(1);
  await click('+ Add Order');
  expect(host.querySelectorAll('[aria-label$="market cap"]')).toHaveLength(2);
  await click('Token amount');
  expect(host.textContent).toContain('Tokens');
  expect(button('Run 1 Strategy').disabled).toBe(true);
});
