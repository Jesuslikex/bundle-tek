// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WalletCleanupPanel } from './wallet-cleanup-panel';
import {
  createVault,
  encryptVault,
  VAULT_STORAGE_KEY,
} from '@/lib/browser-wallet-vault';
import { prepareWalletCleanup } from '@/lib/wallet-cleanup-server';
import { inspectWalletCleanup, type WalletCleanup } from '@/lib/wallet-cleanup';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import { cleanupFixture } from '../test/wallet-cleanup-fixture';

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  localStorage.clear();
});
const wallet = (address: string, label: string): WorkspaceWallet => ({
  chain: 'Solana',
  address,
  folderId: '',
  label,
  role: 'Recipient',
  archived: false,
  revision: 1,
  updatedAt: '2026-10-17T00:00:00Z',
});
const button = (text: string) =>
  Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(text),
  ) as HTMLButtonElement;
const settle = () => new Promise((r) => setTimeout(r, 20));
function setValue(
  element: HTMLInputElement | HTMLSelectElement,
  value: string,
) {
  const proto =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
  element.dispatchEvent(
    new Event(element instanceof HTMLSelectElement ? 'change' : 'input', {
      bubbles: true,
    }),
  );
}

async function reviewedBatch() {
  const f = cleanupFixture();
  const review = (await prepareWalletCleanup(
    {
      batchId: '11111111-1111-4111-8111-111111111111',
      wallet: f.wallet,
      walletRevision: 1,
      destination: f.destination,
      keepLamports: 0n,
    },
    AbortSignal.timeout(10000),
    f.fetcher,
  ))!;
  const row = (
    state: WalletCleanup['state'],
    signature: string | null = null,
  ) =>
    ({
      id: review.id,
      batchId: review.batchId,
      wallet: review.wallet,
      walletRevision: 1,
      state,
      signature,
      document: review,
      receipt: null,
      failure: null,
      createdAt: review.preparedAt,
      updatedAt: review.preparedAt,
    }) satisfies WalletCleanup;
  const session = await createVault('correct passphrase');
  session.payload.wallets.push((await f.session(f.owner)).payload.wallets[0]);
  localStorage.setItem(VAULT_STORAGE_KEY, await encryptVault(session));
  const actions: string[] = [];
  let sentTransaction = '';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      actions.push(body.action);
      if (body.action === 'prepare') {
        expect(body.destination).toBe(f.destination);
        expect(body.wallets).toEqual([{ address: f.wallet, revision: 1 }]);
        return Response.json({
          batchId: review.batchId,
          cleanups: [row('awaiting_signature')],
          errors: [],
          empty: [],
        });
      }
      if (body.action === 'begin_signing')
        return Response.json({ cleanups: [row('signing')] });
      if (body.action === 'reject_signing')
        return Response.json({ cleanup: row('cancelled') });
      if (body.action === 'register') {
        const signed = await inspectWalletCleanup(
          review,
          body.transaction,
          true,
        );
        return Response.json({ cleanup: row('signed', signed.signature) });
      }
      if (body.action === 'submit') {
        sentTransaction = body.transaction;
        const signed = await inspectWalletCleanup(
          review,
          body.transaction,
          true,
        );
        return Response.json({ cleanup: row('submitted', signed.signature) });
      }
      return Response.json({ error: 'unexpected' }, { status: 400 });
    }),
  );
  const wallets = [
    wallet(f.wallet, 'Launch 1'),
    wallet(f.destination, 'Funder'),
  ];
  await act(async () =>
    root.render(
      <WalletCleanupPanel wallets={wallets} selected={[wallets[0]]} />,
    ),
  );
  await act(async () => button('Open cleanup').click());
  const select = container.querySelector('select')!;
  expect(Array.from(select.options).map((o) => o.value)).toEqual([
    '',
    f.destination,
  ]);
  await act(async () => setValue(select, f.destination));
  await act(async () => {
    button('Scan and review cleanup').click();
    await settle();
  });
  expect(container.textContent).toContain('holds tokens (sell first)');
  expect(container.textContent).toContain('frozen');
  expect(container.querySelector('output')?.textContent).toContain(
    'rent from 3 accounts',
  );
  const approve = button('Approve and send 1 transaction');
  expect(approve.disabled).toBe(true);
  const [checkbox, password] = Array.from(
    container.querySelectorAll('input'),
  ).filter((i) => i.type === 'checkbox' || i.type === 'password');
  await act(async () => checkbox.click());
  expect(actions).toEqual(['prepare']);
  return { f, review, actions, password, sent: () => sentTransaction };
}

it('signs and sends each reviewed packet once only after explicit approval', async () => {
  const { review, actions, password, sent } = await reviewedBatch();
  await act(async () =>
    setValue(password as HTMLInputElement, 'correct passphrase'),
  );
  await act(async () => {
    button('Approve and send').click();
    for (let i = 0; i < 100 && !sent(); i++) await settle();
    await settle();
  });
  expect(actions).toEqual(['prepare', 'begin_signing', 'register', 'submit']);
  await expect(
    inspectWalletCleanup(review, sent(), true),
  ).resolves.toBeTruthy();
  expect(container.textContent).toContain(
    '1 of 1 cleanup transactions submitted',
  );
  expect(button('Check outcomes')).toBeTruthy();
}, 30000);

it('releases the signing reservation when the vault does not unlock', async () => {
  const { actions, password, sent } = await reviewedBatch();
  await act(async () =>
    setValue(password as HTMLInputElement, 'wrong passphrase'),
  );
  await act(async () => {
    button('Approve and send').click();
    for (let i = 0; i < 100 && actions.length < 3; i++) await settle();
    await settle();
  });
  expect(sent()).toBe('');
  expect(container.querySelector('[role="alert"]')?.textContent).toMatch(
    /unlock vault/,
  );
  expect(actions).toEqual(['prepare', 'begin_signing', 'reject_signing']);
  expect(container.textContent).toContain('cancelled');
}, 30000);

it('needs selected wallets and a destination before scanning', async () => {
  const f = cleanupFixture();
  const wallets = [
    wallet(f.wallet, 'Launch 1'),
    wallet(f.destination, 'Funder'),
  ];
  await act(async () =>
    root.render(<WalletCleanupPanel wallets={wallets} selected={[]} />),
  );
  await act(async () => button('Open cleanup').click());
  expect(container.textContent).toContain('Select the wallets to clean up');
  expect(button('Scan and review cleanup').disabled).toBe(true);
});
