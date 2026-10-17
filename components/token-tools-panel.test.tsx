// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { TokenToolsPanel } from './token-tools-panel';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import { prepareSupplyAction } from '@/lib/token-supply-action-server';
import {
  chain,
  input,
  MINT,
  signal,
  SUPPLY,
  WALLET,
} from '../test/token-supply-fixture';

const OTHER = bs58.encode(new Uint8Array(32).fill(21));
const RECIPIENT = bs58.encode(new Uint8Array(32).fill(30));
const wallet = (address: string, label: string): WorkspaceWallet => ({
  chain: 'Solana',
  address,
  folderId: '',
  label,
  role: 'Deployer' as WorkspaceWallet['role'],
  archived: false,
  revision: 1,
  updatedAt: '2026-10-17T00:00:00.000Z',
});
let root: Root, container: HTMLDivElement;
const responses: ((url: string, body: unknown) => unknown)[] = [];
const requests: { url: string; body: Record<string, unknown> | null }[] = [];
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  responses.length = 0;
  requests.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit = {}) => {
      const body = options.body ? JSON.parse(options.body as string) : null;
      requests.push({ url, body });
      const next = responses.shift();
      if (!next) throw new Error('unexpected request ' + url);
      return new Response(JSON.stringify(next(url, body)), { status: 200 });
    }),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const button = (text: string) =>
  [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  )!;
const click = (el: Element) =>
  act(async () => {
    (el as HTMLElement).click();
    // Let fetch, response validation and SHA-256 checks settle.
    await new Promise((r) => setTimeout(r, 30));
  });
async function type(el: Element, value: string) {
  await act(async () => {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? 'change' : 'input', {
        bubbles: true,
      }),
    );
  });
}
const labelled = (text: string) => {
  const label = [...container.querySelectorAll('label')].find(
    (l) => l.textContent?.trim() === text,
  )!;
  return label.htmlFor
    ? document.getElementById(label.htmlFor)!
    : label.querySelector('input,select,textarea')!;
};

it('plans a send by % of supply across wallets and hands each leg to a reviewed withdrawal', async () => {
  await act(async () =>
    root.render(
      <TokenToolsPanel
        wallets={[wallet(WALLET, 'Dev'), wallet(OTHER, 'Holder 1')]}
      />,
    ),
  );
  await click(button('Open token tools'));
  await type(labelled('Token mint'), MINT);
  const boxes = container.querySelectorAll('fieldset input[type=checkbox]');
  await click(boxes[0]);
  await click(boxes[1]);
  responses.push(() => ({
    snapshot: {
      mint: MINT,
      program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      decimals: 6,
      supplyRaw: SUPPLY.toString(),
      slot: 9,
      balances: [
        { address: WALLET, raw: '10000000000000' }, // 1%
        { address: OTHER, raw: '30000000000000' }, // 3%
      ],
    },
  }));
  await click(button('Load supply and balances'));
  expect(requests[0].body).toEqual({ mint: MINT, wallets: [WALLET, OTHER] });
  expect(container.textContent).toContain('selected wallets hold 40000000');
  await type(labelled('Recipient'), RECIPIENT);
  await type(labelled('Amount (% of total supply)'), '3.5');
  await click(button('Review distribution'));
  expect(container.textContent).toContain('2 transfers · 35000000 tokens');
  expect(container.textContent).toContain(`Holder 1 → ${RECIPIENT}: 30000000`);
  expect(container.textContent).toContain(`Dev → ${RECIPIENT}: 5000000`);
  await click(button('Review transfer'));
  const withdrawal = container.querySelector(
    'section[aria-label="Mainnet Solana withdrawals"]',
  )!;
  expect(withdrawal).toBeTruthy();
  expect(
    (
      withdrawal.querySelector(
        'input[placeholder="Solana recipient address"]',
      ) as HTMLInputElement
    ).value,
  ).toBe(RECIPIENT);
  expect(
    (withdrawal.querySelector('input[placeholder="0.01"]') as HTMLInputElement)
      .value,
  ).toBe('30000000');
  // Nothing was prepared or signed by planning alone.
  expect(requests).toHaveLength(1);
});

it('blocks a send the selected wallets cannot cover', async () => {
  await act(async () =>
    root.render(<TokenToolsPanel wallets={[wallet(WALLET, 'Dev')]} />),
  );
  await click(button('Open token tools'));
  await type(labelled('Token mint'), MINT);
  await click(container.querySelector('fieldset input[type=checkbox]')!);
  responses.push(() => ({
    snapshot: {
      mint: MINT,
      program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      decimals: 6,
      supplyRaw: SUPPLY.toString(),
      slot: 9,
      balances: [{ address: WALLET, raw: '1' }],
    },
  }));
  await click(button('Load supply and balances'));
  await type(labelled('Recipient'), RECIPIENT);
  await type(labelled('Amount (% of total supply)'), '1');
  await click(button('Review distribution'));
  expect(container.querySelector('[role=alert]')?.textContent).toMatch(
    /do not hold enough/,
  );
});

it('prepares a burn only after the irreversible acknowledgement and gates signing on approval', async () => {
  const document = await prepareSupplyAction(
    input('burn'),
    signal(),
    chain('burn').fetcher,
  );
  await act(async () =>
    root.render(<TokenToolsPanel wallets={[wallet(WALLET, 'Dev')]} />),
  );
  await click(button('Open token tools'));
  await click(button('Burn'));
  await type(labelled('Token mint'), MINT);
  await type(labelled('Amount (% of total supply)'), '1');
  expect(button('Prepare burn').disabled).toBe(true);
  await click(
    [...container.querySelectorAll('label')]
      .find((l) => l.textContent?.includes('cannot be undone'))!
      .querySelector('input')!,
  );
  responses.push(() => ({
    action: {
      id: document.id,
      wallet: WALLET,
      walletRevision: 1,
      kind: 'burn',
      mint: MINT,
      state: 'awaiting_signature',
      signature: null,
      document,
      receipt: null,
      createdAt: document.preparedAt,
      updatedAt: document.preparedAt,
    },
  }));
  await click(button('Prepare burn'));
  expect(requests[0].body).toMatchObject({
    action: 'prepare',
    kind: 'burn',
    wallet: WALLET,
    walletRevision: 1,
    mint: MINT,
    percent: '1',
    acknowledgeIrreversible: true,
  });
  expect(container.textContent).toContain('10000000 tokens (1% of supply');
  expect(button('Sign in this browser').disabled).toBe(true);
  await type(labelled('Vault password'), 'pw');
  expect(button('Sign in this browser').disabled).toBe(true);
  await click(
    [...container.querySelectorAll('label')]
      .find((l) => l.textContent?.includes('approve signing'))!
      .querySelector('input')!,
  );
  expect(button('Sign in this browser').disabled).toBe(false);
});
