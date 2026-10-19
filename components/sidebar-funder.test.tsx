// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { SidebarFunder } from './sidebar-funder';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  localStorage.clear();
});

const wallet = (address: string, label: string, archived = false) => ({
  chain: 'Solana',
  address,
  folderId: '',
  label,
  role: 'Funding',
  archived,
  revision: 1,
  updatedAt: '',
});

async function render(response: Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response),
  );
  const host = document.createElement('div');
  document.body.appendChild(host);
  const onOpen = vi.fn();
  await act(async () => {
    createRoot(host).render(
      <SidebarFunder chain="Solana" onOpenWallets={onOpen} />,
    );
  });
  await act(async () => {});
  return { host, onOpen };
}

test('lists active wallets for the chain and remembers the pick', async () => {
  const { host } = await render(
    Response.json({
      wallets: [
        wallet('So1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', 'Main'),
        wallet('So1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2', 'Old', true),
      ],
    }),
  );
  const select = host.querySelector('select')!;
  expect(select.options).toHaveLength(2);
  expect(select.options[1].textContent).toContain('Main');
  await act(async () => {
    select.value = select.options[1].value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(localStorage.getItem('bundle:funder:Solana')).toBe(
    'So1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
  );
});

test('signed-out users get a prompt that opens wallets', async () => {
  const { host, onOpen } = await render(new Response(null, { status: 401 }));
  const button = host.querySelector('button')!;
  expect(button.textContent).toBe('Sign in to pick a funder');
  await act(async () => button.click());
  expect(onOpen).toHaveBeenCalled();
});
