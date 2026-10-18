// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VolumeBundlePlanner } from './volume-bundle-planner';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';

const address = '11111111111111111111111111111111';
const second = 'So11111111111111111111111111111111111111112';
const wallet = (patch: Partial<WorkspaceWallet> = {}): WorkspaceWallet => ({
  chain: 'Solana',
  address,
  folderId: '',
  label: 'Wallet one',
  role: 'Recipient',
  revision: 1,
  archived: false,
  updatedAt: '',
  ...patch,
});
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Planner must not call an API');
    }),
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(wallets = [wallet()], locked = false) {
  await act(async () =>
    root.render(<VolumeBundlePlanner wallets={wallets} locked={locked} />),
  );
}
const preview = () =>
  host.querySelector('[aria-label="Bundle budget preview"]');
const button = () =>
  [...host.querySelectorAll('button')].find(
    (b) => b.textContent === 'Preview bundle budget',
  )!;
async function selectAndPreview() {
  await act(async () =>
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  await act(async () => button().click());
  expect(preview()).not.toBeNull();
}
it('requires an explicit wallet selection before enabling the budget preview', async () => {
  await render();
  expect(button().disabled).toBe(true);
  expect(host.textContent).toContain('Select at least one wallet');
  expect(fetch).not.toHaveBeenCalled();
});
it('preserves a reviewed preview when equivalent wallet objects are refreshed', async () => {
  await render();
  await selectAndPreview();
  const text = preview()!.textContent;
  await render([wallet()]);
  expect(preview()!.textContent).toBe(text);
  expect(fetch).not.toHaveBeenCalled();
});
it('keeps the preview when only an unselected wallet changes', async () => {
  await render([wallet(), wallet({ address: second })]);
  await selectAndPreview();
  const text = preview()!.textContent;
  await render([wallet(), wallet({ address: second, revision: 2 })]);
  expect(preview()?.textContent).toBe(text);
});
it.each(['revision', 'archived', 'network', 'missing'] as const)(
  'invalidates a preview and removes stale selection after a wallet is %s',
  async (change) => {
    await render();
    await selectAndPreview();
    const changed =
      change === 'missing'
        ? []
        : [
            wallet(
              change === 'revision'
                ? { revision: 2 }
                : change === 'archived'
                  ? { archived: true }
                  : { chain: 'Base' },
            ),
          ];
    await render(changed);
    expect(preview()).toBeNull();
    expect(host.querySelector('input[type="checkbox"]:checked')).toBeNull();
    expect(button().disabled).toBe(true);
    expect(host.textContent).toContain('preview again');
    await render([wallet()]);
    expect(preview()).toBeNull();
    expect(host.querySelector('input[type="checkbox"]:checked')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  },
);
it('clears preview on lock, preserves amounts and requires a new preview after unlock', async () => {
  await render();
  await selectAndPreview();
  await render([wallet()], true);
  expect(preview()).toBeNull();
  expect(button().disabled).toBe(true);
  expect(
    [...host.querySelectorAll<HTMLInputElement>('input')].every(
      (input) => input.disabled || input.closest('fieldset')?.disabled,
    ),
  ).toBe(true);
  expect(
    host.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!.value,
  ).toBe('1');
  await render([wallet()], false);
  expect(preview()).toBeNull();
  expect(button().disabled).toBe(false);
  await act(async () => button().click());
  expect(preview()).not.toBeNull();
  expect(host.textContent).not.toContain('preview again');
  expect(fetch).not.toHaveBeenCalled();
});
it('keeps unchanged selections when another selected wallet revision changes', async () => {
  const roster = [wallet(), wallet({ address: second, label: 'Wallet two' })];
  await render(roster);
  await act(async () => {
    host
      .querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
      .forEach((input) => input.click());
  });
  await act(async () => button().click());
  await render([
    wallet(),
    wallet({ address: second, label: 'Wallet two', revision: 2 }),
  ]);
  expect(preview()).toBeNull();
  const boxes = host.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  expect(boxes[0].checked).toBe(true);
  expect(boxes[1].checked).toBe(false);
  await act(async () => button().click());
  expect(preview()).not.toBeNull();
});
it('does not publish an estimate for a wallet without a current positive revision', async () => {
  await render([wallet({ revision: 0 })]);
  expect(host.querySelector('input[type="checkbox"]')).toBeNull();
  expect(button().disabled).toBe(true);
});
it('keeps arithmetic-only boundaries visible and makes no API calls', async () => {
  await render();
  await selectAndPreview();
  expect(preview()!.textContent).toContain('10 bundles, 20 trades');
  expect(preview()!.textContent).toContain('0.001 SOL');
  expect(host.textContent).toContain('Nothing is reserved or spent');
  expect(fetch).not.toHaveBeenCalled();
});
it('reveals and focuses an invalid required field hidden in Timing', async () => {
  await render();
  const details = host.querySelector('details')!;
  const minutes = details.querySelector<HTMLInputElement>('input')!;
  details.open = false;
  minutes.value = '';
  await act(async () => {
    expect(host.querySelector('form')!.reportValidity()).toBe(false);
  });
  expect(details.open).toBe(true);
  expect(document.activeElement).toBe(minutes);
  expect(preview()).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
