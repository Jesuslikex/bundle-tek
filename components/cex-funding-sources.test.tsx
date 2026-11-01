// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CexFundingSourcesDialog } from './cex-funding-sources';
import {
  CEX_FUNDING_PROVIDER,
  type CexFundingSource,
} from '@/lib/cex-funding-sources';

const source = (id: string, available = true): CexFundingSource => ({
  id,
  name: id.toUpperCase(),
  available,
  provider: CEX_FUNDING_PROVIDER,
});

const CATALOG = [
  source('binance'),
  source('coinbase'),
  source('kraken', false),
];

// The dialog portals into document.body.
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
  props: Partial<Parameters<typeof CexFundingSourcesDialog>[0]>,
) =>
  act(async () => {
    root.render(
      <CexFundingSourcesDialog
        sources={CATALOG}
        selected={[]}
        onClose={vi.fn()}
        onChange={vi.fn()}
        onConfirm={vi.fn()}
        {...props}
      />,
    );
  });

const buttons = () => [...document.body.querySelectorAll('button')];
const text = () => document.body.textContent ?? '';

it('lists only the offered sources and shows the count', async () => {
  await render({});
  expect(text()).toContain('Select the CEXs you want to use');
  expect(text()).toContain('(0/2)');
  expect(text()).toContain('BINANCE');
  expect(text()).toContain('COINBASE');
  expect(text()).not.toContain('KRAKEN');
});

it('reflects an existing selection', async () => {
  await render({ selected: ['binance'] });
  expect(text()).toContain('(1/2)');
  expect(
    buttons()
      .find((b) => b.textContent?.includes('BINANCE'))!
      .getAttribute('aria-pressed'),
  ).toBe('true');
});

it('toggles a single source', async () => {
  const onChange = vi.fn();
  await render({ onChange });
  await act(async () => {
    buttons()
      .find((b) => b.textContent?.includes('COINBASE'))!
      .click();
  });
  expect(onChange).toHaveBeenCalledWith(['coinbase']);
});

it('selects all through the Select All row', async () => {
  const onChange = vi.fn();
  await render({ onChange });
  await act(async () => {
    buttons()
      .find((b) => b.textContent?.includes('Select All'))!
      .click();
  });
  expect(onChange).toHaveBeenCalledWith(['binance', 'coinbase']);
});

it('blocks Confirm until something is selected', async () => {
  const onConfirm = vi.fn();
  await render({ onConfirm });
  const confirm = () => buttons().find((b) => b.textContent === 'Confirm')!;
  expect((confirm() as HTMLButtonElement).disabled).toBe(true);
  await act(async () => confirm().click());
  expect(onConfirm).not.toHaveBeenCalled();
});

it('makes Confirm available with a selection', async () => {
  const onConfirm = vi.fn();
  await render({ selected: ['binance'], onConfirm });
  const confirm = buttons().find((b) => b.textContent === 'Confirm')!;
  expect((confirm as HTMLButtonElement).disabled).toBe(false);
  await act(async () => confirm.click());
  expect(onConfirm).toHaveBeenCalledTimes(1);
});

it('says so when the catalog is empty', async () => {
  await render({ sources: [] });
  expect(text()).toContain('No CEX sources are configured');
  expect(
    (buttons().find((b) => b.textContent === 'Confirm') as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

it('cancels without confirming', async () => {
  const onClose = vi.fn();
  const onConfirm = vi.fn();
  await render({ onClose, onConfirm });
  await act(async () => {
    buttons()
      .find((b) => b.textContent === 'Cancel')!
      .click();
  });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onConfirm).not.toHaveBeenCalled();
});
