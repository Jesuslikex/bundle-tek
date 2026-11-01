// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WalletDeleteDialog } from './wallet-delete-dialog';

// The dialog portals into document.body, so assertions read the body.
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

const render = (props: Partial<Parameters<typeof WalletDeleteDialog>[0]>) =>
  act(async () => {
    root.render(
      <WalletDeleteDialog
        label="Treasury"
        count={1}
        busy={false}
        error=""
        onClose={vi.fn()}
        onDelete={async () => true}
        {...props}
      />,
    );
  });

const buttons = () => [...document.body.querySelectorAll('button')];
const text = () => document.body.textContent ?? '';

it('names the wallet being deleted and asks to confirm', async () => {
  await render({});
  expect(text()).toContain('Delete wallet');
  expect(text()).toContain('Are you sure you want to delete');
  expect(text()).toContain('Treasury');
});

it('pluralises for a batch', async () => {
  await render({ count: 3 });
  expect(text()).toContain('Delete wallets');
  expect(text()).toContain('these 3 wallets');
  expect(buttons().some((b) => b.textContent === 'Delete 3')).toBe(true);
});

it('warns that deleting does not withdraw funds', async () => {
  await render({});
  expect(text()).toContain('does not withdraw anything');
  expect(text()).toContain('restored');
});

it('closes after a successful delete', async () => {
  const onClose = vi.fn();
  await render({ onClose });
  await act(async () => {
    buttons()
      .find((b) => b.textContent === 'Delete')!
      .click();
    await Promise.resolve();
  });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('stays open when the delete fails', async () => {
  const onClose = vi.fn();
  await render({ onClose, onDelete: async () => false });
  await act(async () => {
    buttons()
      .find((b) => b.textContent === 'Delete')!
      .click();
    await Promise.resolve();
  });
  expect(onClose).not.toHaveBeenCalled();
});

it('shows the error only after a submit', async () => {
  const onDelete = vi.fn(async () => false);
  await render({ error: 'Wallet changed.', onDelete });
  expect(document.body.querySelector('[role="alert"]')).toBeNull();
  await act(async () => {
    buttons()
      .find((b) => b.textContent === 'Delete')!
      .click();
    await Promise.resolve();
  });
  expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
    'Wallet changed.',
  );
});

it('cancels without deleting', async () => {
  const onClose = vi.fn();
  const onDelete = vi.fn(async () => true);
  await render({ onClose, onDelete });
  await act(async () => {
    buttons()
      .find((b) => b.textContent === 'Cancel')!
      .click();
  });
  expect(onDelete).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('omits the withdraw handoff when the caller cannot offer one', async () => {
  await render({});
  expect(buttons().some((b) => b.textContent === 'Withdraw first')).toBe(false);
});

it('offers the withdraw handoff without deleting', async () => {
  const onWithdraw = vi.fn();
  const onDelete = vi.fn(async () => true);
  await render({ onWithdraw, onDelete });
  await act(async () => {
    buttons()
      .find((b) => b.textContent === 'Withdraw first')!
      .click();
  });
  expect(onWithdraw).toHaveBeenCalledTimes(1);
  expect(onDelete).not.toHaveBeenCalled();
});
