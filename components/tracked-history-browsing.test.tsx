// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { TrackedSignatureBrowser } from './tracked-signature-browser';
import { TrackedTransactionHistory } from './tracked-transaction-history';
import type { TrackedWallet } from '@/lib/tracked-wallet';
import type { SignaturePage } from '@/lib/tracked-signatures';
import type { TrackedTransactionSummary } from '@/lib/tracked-transaction-history';
let host: HTMLDivElement, root: Root;
const wallet: TrackedWallet = {
  address: bs58.encode(new Uint8Array(32).fill(7)),
  network: 'mainnet',
  label: 'Synthetic',
  group: '',
  icon: '',
  favorite: false,
  archived: false,
  updatedAt: '2026-10-23T00:00:00.000Z',
};
function signature(i: number) {
  const b = new Uint8Array(64).fill(7);
  b[0] = i;
  b[1] = i >> 8;
  return bs58.encode(b);
}
function page(count = 26): SignaturePage {
  return {
    address: wallet.address,
    network: 'mainnet',
    source: 'fixture.invalid',
    observedAt: '2026-10-23T12:00:00Z',
    anchor: 500,
    nextCursor: 'older',
    signatures: Array.from({ length: count }, (_, i) => ({
      signature: signature(i),
      slot: 500 - i,
      failed: i === 1,
      blockTime: i === 2 ? null : Date.parse('2026-10-23T00:00:00Z') / 1000 + i,
    })),
  };
}
function saved(count = 26): TrackedTransactionSummary[] {
  return Array.from({ length: count }, (_, i) => ({
    signature: signature(i),
    slot: 500 - i,
    failed: i === 1,
    feeRaw: '5000',
    nativeChangeRaw: '1',
    tokenChangeCount: 0,
    tokensComplete: true,
    observedAt: new Date(
      Date.parse('2026-10-23T00:00:00Z') + i * 1000,
    ).toISOString(),
    capturedUpdatedAt: wallet.updatedAt,
    stale: false,
  }));
}
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
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find(
    (e) => e.textContent === text,
  )!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
}
async function field(label: string, value: string) {
  const input = [...host.querySelectorAll('label')]
    .find((e) => e.textContent?.startsWith(label))!
    .querySelector('input,select')! as HTMLInputElement | HTMLSelectElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      input instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(
      new Event(input instanceof HTMLSelectElement ? 'change' : 'input', {
        bubbles: true,
      }),
    );
  });
}
function table(name: string) {
  return host.querySelector(`table[aria-label="${name}"]`)!;
}

it('opens public history explicitly and filters/pages/sorts loaded records without requests, preserving inspection identity', async () => {
  const fixture = page(),
    open = vi.fn(),
    fetcher = vi.fn(async () =>
      Response.json({ page: fixture, stale: false, executionAllowed: false }),
    );
  vi.stubGlobal('fetch', fetcher);
  await act(async () =>
    root.render(<TrackedSignatureBrowser wallet={wallet} onOpen={open} />),
  );
  expect(fetcher).not.toHaveBeenCalled();
  await click('Browse public activity');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(
    table('Public finalized signatures').querySelectorAll('tbody tr'),
  ).toHaveLength(25);
  await click('Next public activity display page');
  expect(table('Public finalized signatures').textContent).toContain(
    'Time unavailable',
  );
  await act(async () =>
    (
      table('Public finalized signatures').querySelector(
        'button',
      ) as HTMLButtonElement
    ).click(),
  );
  expect(open).toHaveBeenLastCalledWith(signature(2), false);
  await field('Public activity time order', 'oldest');
  await field('Public activity status', 'failed');
  expect(
    table('Public finalized signatures').querySelectorAll('tbody tr'),
  ).toHaveLength(1);
  await act(async () =>
    (
      table('Public finalized signatures').querySelector(
        'button',
      ) as HTMLButtonElement
    ).click(),
  );
  expect(open).toHaveBeenLastCalledWith(signature(1), false);
  await field('Public activity status', 'all');
  await field('Public activity from date', '2026-10-23');
  await field('Public activity through date', '2026-10-23');
  expect(host.textContent).toContain('25 matching of 26 loaded');
  expect(table('Public finalized signatures').textContent).not.toContain(
    'Time unavailable',
  );
  await field('Public activity signature search', signature(10));
  expect(
    table('Public finalized signatures').querySelectorAll('tbody tr'),
  ).toHaveLength(1);
  await field('Public activity signature search', 'no-matching-signature');
  expect(host.textContent).toContain('No loaded public records match');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('keeps provider older-page growth separate from display paging and preserves an exact inspection', async () => {
  const first = page(25),
    next = page(50),
    open = vi.fn();
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
    Response.json({
      page: init?.method === 'POST' ? next : first,
      stale: false,
      executionAllowed: false,
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  await act(async () =>
    root.render(<TrackedSignatureBrowser wallet={wallet} onOpen={open} />),
  );
  await click('Browse public activity');
  await click('Load older public activity');
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain('50 matching of 50 loaded');
  await click('Next public activity display page');
  expect(
    table('Public finalized signatures').querySelectorAll('tbody tr'),
  ).toHaveLength(25);
  const expected = table('Public finalized signatures')
    .querySelector('code')!
    .getAttribute('title');
  await act(async () =>
    (
      table('Public finalized signatures').querySelector(
        'button',
      ) as HTMLButtonElement
    ).click(),
  );
  expect(open).toHaveBeenLastCalledWith(expected, false);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('rekeys public context, aborts pending reads and does not expose the prior wallet records', async () => {
  const fixture = page(1),
    open = vi.fn(),
    another = { ...wallet, address: bs58.encode(new Uint8Array(32).fill(8)) };
  let resolveSecond!: (response: Response) => void;
  const fetcher = vi.fn((url: string, _init?: RequestInit) =>
    url.includes(another.address)
      ? new Promise<Response>((resolve) => {
          resolveSecond = resolve;
        })
      : Promise.resolve(
          Response.json({
            page: fixture,
            stale: false,
            executionAllowed: false,
          }),
        ),
  );
  vi.stubGlobal('fetch', fetcher);
  await act(async () =>
    root.render(<TrackedSignatureBrowser wallet={wallet} onOpen={open} />),
  );
  await click('Browse public activity');
  await act(async () =>
    root.render(<TrackedSignatureBrowser wallet={another} onOpen={open} />),
  );
  expect(host.querySelector('table')).toBeNull();
  const secondSignal = fetcher.mock.calls[1][1]?.signal;
  await click('Close public activity');
  expect(secondSignal?.aborted).toBe(true);
  await act(async () =>
    resolveSecond(
      Response.json({ page: fixture, stale: false, executionAllowed: false }),
    ),
  );
  expect(host.querySelector('table')).toBeNull();
});

it('filters saved observation times locally, retains provider pagination and passes the saved flag after paging', async () => {
  const items = saved(26),
    open = vi.fn();
  const fetcher = vi.fn(async (url: string) =>
    Response.json({
      items: url.includes('cursor=older') ? saved(51).slice(26) : items,
      nextCursor: url.includes('cursor=older') ? null : 'older',
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  await act(async () =>
    root.render(
      <TrackedTransactionHistory
        wallet={wallet}
        onOpen={open}
        onClose={() => {}}
      />,
    ),
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('not transaction block time');
  expect(host.textContent).toContain('Browse public activity');
  await click('Next saved observations display page');
  await act(async () =>
    (
      table('Saved transaction observations').querySelector(
        'button',
      ) as HTMLButtonElement
    ).click(),
  );
  expect(open).toHaveBeenLastCalledWith(signature(0), true);
  await field('Saved observations time order', 'oldest');
  await field('Saved observations status', 'failed');
  expect(
    table('Saved transaction observations').querySelectorAll('tbody tr'),
  ).toHaveLength(1);
  await field('Saved observations from date', '2026-10-23');
  await field('Saved observations through date', '2026-10-23');
  await field('Saved observations signature search', 'no-match');
  expect(host.textContent).toContain('No loaded saved observations match');
  expect(fetcher).toHaveBeenCalledTimes(1);
  await click('Clear saved observations filters');
  await click('Load older saved transactions');
  expect(host.textContent).toContain('51 matching of 51 loaded');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('clears an earlier saved-history error and exposes loading during a successful external refresh', async () => {
  const open = vi.fn();
  let complete!: (response: Response) => void;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ error: 'Temporary history failure' }, { status: 503 }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
  vi.stubGlobal('fetch', fetcher);
  const render = (revision: number) => (
    <TrackedTransactionHistory
      wallet={wallet}
      onOpen={open}
      onClose={() => {}}
      refreshVersion={revision}
    />
  );
  await act(async () => root.render(render(0)));
  expect(host.textContent).toContain('Temporary history failure');
  await act(async () => root.render(render(1)));
  expect(host.textContent).not.toContain('Temporary history failure');
  expect(host.textContent).toContain('Loading saved transactions');
  await act(async () =>
    complete(Response.json({ items: saved(1), nextCursor: null })),
  );
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(
    table('Saved transaction observations').querySelectorAll('tbody tr'),
  ).toHaveLength(1);
  expect(host.textContent).not.toContain('Loading saved transactions');
});

it('shows reversed UTC ranges distinctly from empty saved history', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ items: saved(1), nextCursor: null })),
  );
  await act(async () =>
    root.render(
      <TrackedTransactionHistory
        wallet={wallet}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    ),
  );
  await field('Saved observations from date', '2026-10-24');
  await field('Saved observations through date', '2026-10-23');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'end date',
  );
  expect(host.textContent).not.toContain(
    'No saved transaction observations yet',
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('labels UTC rows and unknown saved timestamps without displaying Invalid Date', async () => {
  const items = saved(2);
  items[1].observedAt = 'malformed-timestamp';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ items, nextCursor: null })),
  );
  await act(async () =>
    root.render(
      <TrackedTransactionHistory
        wallet={wallet}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    ),
  );
  expect(table('Saved transaction observations').textContent).toContain(
    'observed (UTC)',
  );
  expect(table('Saved transaction observations').textContent).toContain(
    '2026-10-23 00:00:00.000 UTC',
  );
  expect(table('Saved transaction observations').textContent).toContain(
    'Time unavailable',
  );
  expect(host.textContent).not.toContain('Invalid Date');
  expect(host.querySelector('fieldset legend')?.textContent).toBe(
    'Saved observations filters',
  );
  expect(
    [...host.querySelectorAll('fieldset legend')].some(
      (e) => e.textContent === 'Saved observations display pages',
    ),
  ).toBe(true);
  await field('Saved observations from date', '2026-10-23');
  expect(
    table('Saved transaction observations').querySelectorAll('tbody tr'),
  ).toHaveLength(1);
  expect(fetch).toHaveBeenCalledTimes(1);
});
