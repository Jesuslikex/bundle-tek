// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
import { WalletCleanupPanel } from './wallet-cleanup-panel';
import {
  createVault,
  encryptVault,
  VAULT_STORAGE_KEY,
} from '@/lib/browser-wallet-vault';
import { prepareWalletCleanupSells } from '@/lib/wallet-cleanup-server';
import { inspectWalletCleanup, type WalletCleanup } from '@/lib/wallet-cleanup';
import type { WalletFolder, WorkspaceWallet } from '@/lib/wallet-workspace';
import type { WalletBalance } from '@/lib/wallet-balance-format';
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
const wallet = (
  address: string,
  label: string,
  folderId = '',
  tags: string[] = [],
): WorkspaceWallet => ({
  chain: 'Solana',
  address,
  folderId,
  tags,
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
const pickerButton = (text: string) =>
  Array.from(
    container
      .querySelector('[role="dialog"][aria-label^="Select "]')!
      .querySelectorAll('button'),
  ).find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
function setValue(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}
const field = (label: string) =>
  container.querySelector(
    `input[aria-label="${label}"]`,
  ) as HTMLInputElement;

const balance = (address: string, raw: string) => ({
  chain: 'Solana' as const,
  address,
  raw,
  amount: raw,
  currency: 'SOL',
  decimals: 9,
  blockNumber: 1,
  blockHash: null,
  observedAt: '2026-10-27T00:00:00.000Z',
  snapshotId: 'snap',
  source: 'rpc',
  commitment: 'confirmed',
});

async function mount(
  sellers = 0,
  balancesOf?: (f: ReturnType<typeof cleanupFixture>) => WalletBalance[],
  folders: WalletFolder[] = [],
) {
  const f = cleanupFixture();
  const wallets = [
    wallet(f.wallet, 'Launch 1', folders[0]?.id ?? ''),
    wallet(f.destination, 'Funder'),
  ];
  await act(async () =>
    root.render(
      <WalletCleanupPanel
        wallets={wallets}
        selected={wallets.slice(0, sellers)}
        balances={balancesOf?.(f)}
        folders={folders}
      />,
    ),
  );
  return { f, wallets };
}

async function openDialog(
  sellers = 0,
  balancesOf?: (f: ReturnType<typeof cleanupFixture>) => WalletBalance[],
) {
  const mounted = await mount(sellers, balancesOf);
  await act(async () => button('Configure').click());
  return mounted;
}

/** Run with a prepared sell document served back by the mocked route. */
async function reviewedBatch() {
  const { f, wallets } = await openDialog(1);
  const {
    sells: [sell],
  } = await prepareWalletCleanupSells(
    {
      batchId: '11111111-1111-4111-8111-111111111111',
      wallet: f.wallet,
      walletRevision: 1,
      destination: f.destination,
    },
    'key',
    AbortSignal.timeout(10000),
    f.fetcher,
    f.sell.deps,
  );
  const row = (
    state: WalletCleanup['state'],
    signature: string | null = null,
  ) =>
    ({
      id: sell.id,
      batchId: sell.batchId,
      wallet: sell.wallet,
      walletRevision: 1,
      state,
      signature,
      document: sell,
      receipt: null,
      failure: null,
      createdAt: sell.preparedAt,
      updatedAt: sell.preparedAt,
    }) satisfies WalletCleanup;
  const session = await createVault('correct passphrase');
  session.payload.wallets.push((await f.session(f.owner)).payload.wallets[0]);
  localStorage.setItem(VAULT_STORAGE_KEY, await encryptVault(session));
  const actions: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  let sentTransaction = '';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).endsWith('/cleanup/holdings'))
        return Response.json({
          mint: f.buy.mint,
          supplyRaw: '1000000',
          decimals: 2,
          balances: { [wallets[0].address]: '250000' },
        });
      const body = JSON.parse(init.body as string);
      actions.push(body.action);
      bodies.push(body);
      if (body.action === 'run')
        return Response.json({
          batchId: sell.batchId,
          stage: 'sell',
          plan: {
            input_wallet_pubkeys: [wallets[0].address],
            output_wallet_pubkeys: [f.destination],
            min_delay_ms: 1,
            max_delay_ms: 1,
            double_buy_pct: 0,
            fake_tip_pct: 0,
          },
          rounds: [{ round: 1, seller: f.wallet, buyer: f.destination }],
          cleanups: [row('awaiting_signature')],
          errors: [],
          empty: [],
          remaining: 0,
        });
      if (body.action === 'begin_signing')
        return Response.json({ cleanups: [row('signing')] });
      if (body.action === 'reject_signing')
        return Response.json({ cleanup: row('cancelled') });
      if (body.action === 'register') {
        const signed = await inspectWalletCleanup(
          sell,
          body.transaction,
          true,
        );
        return Response.json({ cleanup: row('signed', signed.signature) });
      }
      if (body.action === 'submit') {
        sentTransaction = body.transaction;
        const signed = await inspectWalletCleanup(
          sell,
          body.transaction,
          true,
        );
        return Response.json({ cleanup: row('submitted', signed.signature) });
      }
      return Response.json({ error: 'unexpected' }, { status: 400 });
    }),
  );
  // Sellers come from the roster selection, buyers from the picker.
  await act(async () => button('Select (0)').click());
  await act(async () => {
    container
      .querySelector<HTMLInputElement>('[aria-label="Select Funder"]')
      ?.click();
  });
  await act(async () => {
    pickerButton('Confirm (1)').click();
  });
  await act(async () => {
    button('Run').click();
    await settle();
  });
  const inputs = Array.from(container.querySelectorAll('input'));
  const checkbox = inputs.filter((i) => i.type === 'checkbox').at(-1)!;
  const password = inputs.find((i) => i.type === 'password')!;
  await act(async () => checkbox.click());
  return {
    f,
    sell,
    wallets,
    actions,
    bodies,
    password,
    sent: () => sentTransaction,
  };
}

it('posts Proxima’s cleanup payload and signs each packet once', async () => {
  const { f, sell, actions, bodies, password, sent } = await reviewedBatch();
  const run = bodies.find((b) => b.action === 'run')!;
  expect(Object.keys(run)).toEqual([
    'action',
    'input_wallet_pubkeys',
    'output_wallet_pubkeys',
    'min_delay_ms',
    'max_delay_ms',
    'double_buy_pct',
    'fake_tip_pct',
  ]);
  expect(run.input_wallet_pubkeys).toEqual([f.wallet]);
  expect(run.output_wallet_pubkeys).toEqual([f.destination]);
  expect(run.min_delay_ms).toBe(16000);
  expect(run.max_delay_ms).toBe(16000);
  expect(container.textContent).toContain('Buyback');
  expect(container.textContent).toContain('16s');
  await act(async () => setValue(password, 'correct passphrase'));
  await act(async () => {
    button('Sign & send').click();
    for (let i = 0; i < 100 && !sent(); i++) await settle();
    await settle();
  });
  expect(actions).toEqual(['run', 'begin_signing', 'register', 'submit']);
  await expect(inspectWalletCleanup(sell, sent(), true)).resolves.toBeTruthy();
  expect(container.textContent).toContain(
    '0 of 1 settled',
  );
}, 30000);

it('does not claim the batch when the vault does not unlock', async () => {
  const { actions, password, sent } = await reviewedBatch();
  await act(async () => setValue(password, 'wrong passphrase'));
  await act(async () => {
    button('Sign & send').click();
    for (let i = 0; i < 100 && actions.length < 3; i++) await settle();
    await settle();
  });
  expect(sent()).toBe('');
  expect(container.querySelector('[role="alert"]')?.textContent).toMatch(
    /unlock vault/,
  );
  // The vault is opened before begin_signing, so a bad passphrase never
  // reserves the batch and there is nothing to release.
  expect(actions).toEqual(['run']);
}, 30000);

it('shows Proxima’s validation copy before calling the route', async () => {
  await openDialog();
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => {
    button('Run').click();
    await settle();
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    'Please select at least one input wallet (seller)',
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

it('rejects an empty buyer list after the sellers are chosen', async () => {
  await openDialog(1);
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => button('Select (0)').click());
  await act(async () => pickerButton('Cancel').click());
  await act(async () => {
    button('Run').click();
    await settle();
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    'Please select at least one output wallet (buyer)',
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

it('rejects a min delay under half a second', async () => {
  await openDialog(1);
  vi.stubGlobal('fetch', vi.fn());
  await act(async () => button('Select (0)').click());
  await act(async () => pickerButton('Cancel').click());
  await act(async () => setValue(field('Delay seconds'), '0'));
  await act(async () => {
    button('Run').click();
    await settle();
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    'Min delay must be at least 0.5 seconds',
  );
});

it('switches to a min and max delay pair in random mode', async () => {
  await openDialog();
  await act(async () => button('Random').click());
  expect(field('Min Delay seconds')).toBeTruthy();
  expect(field('Max Delay seconds')).toBeTruthy();
  expect(container.textContent).toContain(
    'Random delay between each cleanup round.',
  );
});

it('opens advanced options with both percentages', async () => {
  await openDialog();
  await act(async () => container.querySelector('summary')!.click());
  expect(field('Double Buy %')).toBeTruthy();
  expect(field('Alternative Routing')).toBeTruthy();
});

it('disables buyers that hold no SOL in the picker', async () => {
  await openDialog(1, (f) => [
    balance(f.wallet, '500000000'),
    balance(f.destination, '0'),
  ]);
  await act(async () => button('Select (0)').click());
  const row = (label: string) =>
    container.querySelector<HTMLInputElement>(`[aria-label="Select ${label}"]`)!;
  expect(row('Launch 1').disabled).toBe(false);
  expect(row('Funder').disabled).toBe(true);
});

it('shows share of token supply and the token balance in the picker', async () => {
  const { f } = await mount(1);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        mint: f.buy.mint,
        supplyRaw: '1000000',
        decimals: 2,
        balances: { [f.wallet]: '250000' },
      }),
    ),
  );
  await act(async () => button('Configure').click());
  await settle();
  await act(async () => button('Select (0)').click());
  await settle();
  const picker = container.querySelector('[role="dialog"][aria-label^="Select "]')!;
  expect(picker.textContent).toMatch(/2[.,]500/);
  await act(async () => {
    picker.querySelector<HTMLInputElement>('[aria-label="Select Launch 1"]')!.click();
  });
  expect(pickerButton('Confirm (1)').textContent).toBe('Confirm (1) - 25.0%');
});

it('sorts picker rows by token balance and flips the direction', async () => {
  const { f } = await mount(1);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        mint: f.buy.mint,
        supplyRaw: '1000000',
        decimals: 2,
        balances: { [f.wallet]: '250000', [f.destination]: '900000' },
      }),
    ),
  );
  await act(async () => button('Configure').click());
  await settle();
  await act(async () => button('Select (0)').click());
  await settle();
  const picker = container.querySelector('[role="dialog"][aria-label^="Select "]')!;
  const names = () =>
    Array.from(picker.querySelectorAll('[aria-label^="Select "]'))
      .map((l) => l.getAttribute('aria-label') ?? '')
      .filter((l) => l !== 'Select all wallets')
      .map((l) => l.replace('Select ', ''));
  const head = Array.from(picker.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === 'Token Balance',
  )!;
  await act(async () => head.click());
  expect(names()[0]).toBe('Launch 1');
  await act(async () => head.click());
  expect(names()[0]).toBe('Funder');
});

it('filters picker rows by token balance bounds', async () => {
  const { f } = await mount(1);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        mint: f.buy.mint,
        supplyRaw: '1000000',
        decimals: 2,
        balances: { [f.wallet]: '250000', [f.destination]: '900000' },
      }),
    ),
  );
  await act(async () => button('Configure').click());
  await settle();
  await act(async () => button('Select (0)').click());
  await settle();
  const picker = container.querySelector('[role="dialog"][aria-label^="Select "]')!;
  const rows = () =>
    Array.from(picker.querySelectorAll('[aria-label^="Select "]'))
      .map((l) => l.getAttribute('aria-label') ?? '')
      .filter((l) => l !== 'Select all wallets');
  expect(rows()).toHaveLength(2);
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Filter Token %"]')!.click(),
  );
  await settle();
  const min = document.querySelector<HTMLInputElement>('[aria-label="Min Token %"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!;
    setter.call(min, '5000');
    min.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  expect(rows()).toEqual(['Select Funder']);
});

it('filters picker rows by folder', async () => {
  const folder: WalletFolder = {
    id: 'f1',
    name: 'Sellers',
    color: '#4FA671',
    chain: 'Solana',
    archived: false,
    revision: 1,
    updatedAt: '2026-10-27T00:00:00.000Z',
  };
  const { f } = await mount(1, undefined, [folder]);
  void f;
  await act(async () => button('Configure').click());
  await settle();
  await act(async () => button('Select (0)').click());
  await settle();
  const picker = container.querySelector('[role="dialog"][aria-label^="Select "]')!;
  const rows = () =>
    Array.from(picker.querySelectorAll('[aria-label^="Select "]'))
      .map((l) => l.getAttribute('aria-label') ?? '')
      .filter((l) => l !== 'Select all wallets');
  expect(rows()).toHaveLength(2);
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Filter by folder"]')!.click(),
  );
  await settle();
  await act(async () =>
    document.querySelector<HTMLInputElement>('[aria-label="Folder Sellers"]')!.click(),
  );
  await settle();
  expect(rows()).toEqual(['Select Launch 1']);
});

it('filters picker rows to purchased wallets', async () => {
  const { f } = await mount(1);
  await act(async () => button('Configure').click());
  await settle();
  await act(async () => button('Select (0)').click());
  await settle();
  const picker = container.querySelector('[role="dialog"][aria-label^="Select "]')!;
  const rows = () =>
    Array.from(picker.querySelectorAll('[aria-label^="Select "]'))
      .map((l) => l.getAttribute('aria-label') ?? '')
      .filter((l) => l !== 'Select all wallets');
  expect(rows()).toHaveLength(2);
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Filter by folder"]')!.click(),
  );
  await settle();
  await act(async () =>
    document
      .querySelector<HTMLInputElement>('[aria-label="Purchased wallets only"]')!
      .click(),
  );
  await settle();
  expect(rows()).toEqual([]);
  void f;
});

it('closes the picker on Escape before the dialog', async () => {
  await openDialog();
  await act(async () => button('Select (0)').click());
  const dialog = container.querySelector('[role="dialog"]')!;
  await act(async () => {
    dialog.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });
  expect(container.textContent).not.toContain('Select Input Wallets');
  expect(container.textContent).toContain('Fixed delay between each cleanup round.');
  await act(async () => {
    dialog.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });
  expect(container.textContent).not.toContain('Delay Between Rounds');
});
