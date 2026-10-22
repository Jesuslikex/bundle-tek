// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WalletWarmupEntry } from './wallet-warmup-entry';
import type { ComponentProps } from 'react';

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function mount(
  patch: Partial<ComponentProps<typeof WalletWarmupEntry>> = {},
) {
  const props = {
    loading: false,
    busy: false,
    archived: false,
    visibleCount: 1,
    selectedCount: 0,
    filtered: false,
    onOpen: vi.fn(),
    onShowActive: vi.fn(),
    onClearSelection: vi.fn(),
    ...patch,
  };
  await act(async () => root.render(<WalletWarmupEntry {...props} />));
  return props;
}
const button = (text: string) =>
  Array.from(host.querySelectorAll('button')).find(
    (b) => b.textContent === text,
  )!;
it.each([
  { visibleCount: 1, selectedCount: 0 },
  { visibleCount: 25, selectedCount: 20 },
])(
  'opens only on explicit click for an allowed selection %j',
  async (counts) => {
    const props = await mount(counts);
    expect(props.onOpen).not.toHaveBeenCalled();
    expect(button('Wallet warmup').disabled).toBe(false);
    await act(async () => button('Wallet warmup').click());
    expect(props.onOpen).toHaveBeenCalledTimes(1);
  },
);
it('explains selection without automatically choosing multiple wallets', async () => {
  const props = await mount({ visibleCount: 4 });
  const open = button('Wallet warmup');
  expect(open.disabled).toBe(true);
  expect(
    document.getElementById(open.getAttribute('aria-describedby')!)
      ?.textContent,
  ).toContain('Select 1–20');
  await act(async () => open.click());
  expect(props.onOpen).not.toHaveBeenCalled();
  expect(props.onClearSelection).not.toHaveBeenCalled();
});
it.each([
  { archived: true, action: 'Show active wallets' },
  { visibleCount: 0, filtered: true, action: 'Show all wallets' },
])('offers a view-only escape via $action', async ({ action, ...patch }) => {
  const props = await mount(patch);
  expect(button('Wallet warmup').disabled).toBe(true);
  await act(async () => button(action).click());
  expect(props.onShowActive).toHaveBeenCalledTimes(1);
  expect(props.onOpen).not.toHaveBeenCalled();
});
it('can clear an excessive selection without opening warmup', async () => {
  const props = await mount({ visibleCount: 21, selectedCount: 21 });
  expect(button('Wallet warmup').disabled).toBe(true);
  expect(host.textContent).toContain('up to 20');
  await act(async () => button('Clear selection').click());
  expect(props.onClearSelection).toHaveBeenCalledTimes(1);
  expect(props.onOpen).not.toHaveBeenCalled();
});
it('explains the empty workspace without requesting funding', async () => {
  await mount({ visibleCount: 0 });
  expect(button('Wallet warmup').disabled).toBe(true);
  expect(host.textContent).toContain('Create a wallet or add a public address');
  expect(host.textContent).toContain('No funds are needed');
});
it.each([{ loading: true }, { busy: true }])(
  'blocks actions during workspace requests %j',
  async (patch) => {
    const props = await mount({ ...patch, archived: true });
    expect(button('Wallet warmup').disabled).toBe(true);
    expect(button('Wallet warmup').getAttribute('aria-busy')).toBe('true');
    expect(host.querySelector('output')?.textContent).toContain(
      'loading' in patch
        ? 'Loading wallets'
        : 'A wallet request is in progress',
    );
    expect(
      document.getElementById(
        button('Wallet warmup').getAttribute('aria-describedby')!,
      ),
    ).toBe(host.querySelector('output'));
    expect(host.querySelectorAll('button')).toHaveLength(1);
    await act(async () => button('Wallet warmup').click());
    expect(props.onOpen).not.toHaveBeenCalled();
  },
);

it('replaces pending guidance with the current selection reason without opening or clearing anything', async () => {
  const loading = await mount({
    loading: true,
    busy: true,
    visibleCount: 30,
    selectedCount: 21,
  });
  const status = host.querySelector('output');
  expect(status?.textContent).toContain('Loading wallets');
  const busy = await mount({ busy: true, visibleCount: 30, selectedCount: 21 });
  expect(host.querySelector('output')).toBe(status);
  expect(status?.textContent).toContain('A wallet request is in progress');
  expect(host.querySelectorAll('button')).toHaveLength(1);
  const excessive = await mount({ visibleCount: 30, selectedCount: 21 });
  expect(button('Wallet warmup').getAttribute('aria-busy')).toBe('false');
  expect(status?.textContent).toContain('up to 20');
  expect(button('Clear selection').disabled).toBe(false);
  for (const props of [loading, busy, excessive]) {
    expect(props.onOpen).not.toHaveBeenCalled();
    expect(props.onClearSelection).not.toHaveBeenCalled();
    expect(props.onShowActive).not.toHaveBeenCalled();
  }
});

it('clears the persistent pending status when ready and still requires an explicit click', async () => {
  await mount({ loading: true });
  const status = host.querySelector('output');
  const props = await mount();
  expect(host.querySelector('output')).toBe(status);
  expect(status?.textContent).toBe('');
  expect(button('Wallet warmup').disabled).toBe(false);
  expect(button('Wallet warmup').getAttribute('aria-busy')).toBe('false');
  expect(button('Wallet warmup').getAttribute('aria-describedby')).toBeNull();
  expect(props.onOpen).not.toHaveBeenCalled();
  await act(async () => button('Wallet warmup').click());
  expect(props.onOpen).toHaveBeenCalledTimes(1);
});

it.each([
  {
    archived: true,
    action: 'Show active wallets',
    message: 'Warmup uses active wallets',
  },
  {
    visibleCount: 0,
    filtered: true,
    action: 'Show all wallets',
    message: 'No wallets match this view',
  },
])(
  'restores the existing view-only escape after busy work: $action',
  async ({ action, message, ...patch }) => {
    await mount({ ...patch, busy: true });
    expect(host.querySelectorAll('button')).toHaveLength(1);
    expect(host.querySelector('output')?.textContent).toContain(
      'Warmup options will update',
    );
    const props = await mount(patch);
    expect(host.querySelector('output')?.textContent).toContain(message);
    await act(async () => button(action).click());
    expect(props.onShowActive).toHaveBeenCalledTimes(1);
    expect(props.onOpen).not.toHaveBeenCalled();
  },
);
