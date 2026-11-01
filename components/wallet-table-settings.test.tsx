// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WalletTableSettingsDialog } from './wallet-table-settings';
import { DEFAULT_WALLET_TABLE_SETTINGS } from '@/lib/wallet-table-settings';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (
  props: Partial<Parameters<typeof WalletTableSettingsDialog>[0]>,
) =>
  act(async () => {
    root.render(
      <WalletTableSettingsDialog
        open
        settings={DEFAULT_WALLET_TABLE_SETTINGS}
        onChange={vi.fn()}
        onReset={vi.fn()}
        onClose={vi.fn()}
        {...props}
      />,
    );
  });

it('renders nothing while closed', async () => {
  await render({ open: false });
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});

it('lists the wallet column as always visible and every metric as a toggle', async () => {
  await render({});
  const rows = [...host.querySelectorAll('.wallet-table-settings-row')];
  expect(rows[0].textContent).toContain('Wallet');
  expect(rows[0].textContent).toContain('Always');
  expect(rows[0].querySelector('input')).toBeNull();
  for (const label of ['Balance', 'Volume', 'P&L', 'Launches', 'Funding'])
    expect(host.textContent).toContain(label);
  expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(5);
});

it('toggles only the clicked column and keeps the rest', async () => {
  const onChange = vi.fn();
  await render({ onChange });
  const volume = [
    ...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ][1];
  await act(async () => volume.click());
  expect(onChange).toHaveBeenCalledWith({
    ...DEFAULT_WALLET_TABLE_SETTINGS,
    volume: false,
  });
});

it('reflects hidden columns as unchecked', async () => {
  await render({
    settings: { ...DEFAULT_WALLET_TABLE_SETTINGS, launches: false },
  });
  const boxes = [
    ...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ];
  expect(boxes.map((box) => box.checked)).toEqual([
    true,
    true,
    true,
    false,
    true,
  ]);
});

it('resets and closes through their controls', async () => {
  const onReset = vi.fn();
  const onClose = vi.fn();
  await render({ onReset, onClose });
  const buttons = [...host.querySelectorAll('button')];
  await act(async () =>
    buttons.find((b) => b.textContent === 'Reset')!.click(),
  );
  expect(onReset).toHaveBeenCalledTimes(1);
  await act(async () =>
    buttons.find((b) => b.textContent === 'Close')!.click(),
  );
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('closes on Escape', async () => {
  const onClose = vi.fn();
  await render({ onClose });
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });
  expect(onClose).toHaveBeenCalledTimes(1);
});
