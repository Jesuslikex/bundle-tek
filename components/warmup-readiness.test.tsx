// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WarmupReadiness } from './warmup-readiness';

const wallet = '11111111111111111111111111111111';
const other = 'SysvarRent111111111111111111111111111111111';
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

function observation(address: string, nativeBalance: string) {
  return {
    address,
    chain: 'Solana',
    observedAt: new Date('2026-10-24T10:00:00.000Z').toISOString(),
    source: 'rpc.example',
    nativeBalance,
    currency: 'SOL',
    block: '123',
    outgoingTransactions: null,
    sampleCount: 0,
    successfulSampleCount: 0,
    oldestObservedAt: null,
    latestObservedAt: null,
    coverage: 'Observation is a point-in-time sample.',
  };
}
function balances(entries: Array<{ address: string; nativeBalance?: string }>) {
  return vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({
      chain: 'Solana',
      results: entries.map((entry) =>
        entry.nativeBalance === undefined
          ? { address: entry.address, error: 'History provider unavailable.' }
          : {
              address: entry.address,
              observation: observation(entry.address, entry.nativeBalance),
            },
      ),
    }),
  );
}
async function mount(feeReserve = '0.01', addresses = [wallet]) {
  await act(async () =>
    root.render(
      <WarmupReadiness
        chain="Solana"
        addresses={addresses}
        walletRevisions={addresses.map((address) => ({ address, revision: 1 }))}
        feeReserve={feeReserve}
      />,
    ),
  );
}
async function click(text: string) {
  const button = Array.from(host.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === text,
  )!;
  expect(button, text).toBeTruthy();
  await act(async () => button.click());
}

it('states the operator linkage and performs no read until asked', async () => {
  const fetcher = balances([{ address: wallet, nativeBalance: '0.02' }]);
  vi.stubGlobal('fetch', fetcher);
  await mount();
  expect(host.textContent).toContain('Wallet readiness');
  expect(host.textContent).toContain(
    'All selected wallets are controlled by you and appear on-chain as one operator.',
  );
  expect(host.textContent).toContain(
    'This check only reads public balances. It never signs, sends or schedules a transaction.',
  );
  expect(host.textContent).toContain(
    'This is a funding check, not an activity generator.',
  );
  expect(fetcher).not.toHaveBeenCalled();
  expect(
    host.querySelector('section')!.hasAttribute('data-warmup-readiness'),
  ).toBe(true);
});

it('reports a funded wallet as ready from one read', async () => {
  const fetcher = balances([{ address: wallet, nativeBalance: '0.02' }]);
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Check wallet readiness');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe('/api/wallet-workspace/warmup');
  expect(host.querySelector('output')!.textContent).toContain(
    '1 of 1 ready, 0 need funding.',
  );
  expect(host.textContent).toContain('0.01203928 SOL');
  expect(host.textContent).toContain('0.02 SOL · ready');
  expect(host.querySelector('[data-status="ready"]')).toBeTruthy();
});

it('shows the exact shortfall and totals it', async () => {
  const fetcher = balances([
    { address: wallet, nativeBalance: '0.012' },
    { address: other, nativeBalance: '0.02' },
  ]);
  vi.stubGlobal('fetch', fetcher);
  await mount('0.01', [wallet, other]);
  await click('Check wallet readiness');
  expect(host.querySelector('output')!.textContent).toContain(
    '1 of 2 ready, 1 need funding.',
  );
  expect(host.textContent).toContain('Needs 0.00003928 SOL');
  expect(host.textContent).toContain('0.00003928 SOL');
  expect(host.querySelector('[data-status="needs-funding"]')).toBeTruthy();
});

it('never counts an unknown read as ready', async () => {
  const fetcher = balances([{ address: wallet }]);
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Check wallet readiness');
  expect(host.querySelector('output')!.textContent).toContain(
    '0 of 1 ready, 0 need funding, 1 unknown.',
  );
  expect(host.textContent).toContain('Unknown reads are not counted as ready.');
  expect(host.textContent).toContain('Balance unknown · no conclusion');
  expect(host.querySelector('[data-status="unknown"]')).toBeTruthy();
});

it('recomputes the requirement from a changed fee reserve without another read', async () => {
  const fetcher = balances([{ address: wallet, nativeBalance: '0.02' }]);
  vi.stubGlobal('fetch', fetcher);
  await mount('0.01');
  await click('Check wallet readiness');
  expect(host.textContent).toContain('0.01203928 SOL');
  await mount('0.03');
  expect(host.textContent).toContain('0.03203928 SOL');
  expect(host.textContent).toContain('Needs 0.01203928 SOL');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('surfaces a refused read without inventing a result', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ error: 'Wait 15 seconds.' }, { status: 429 }),
    ),
  );
  await mount();
  await click('Check wallet readiness');
  expect(host.querySelector('[role="alert"]')!.textContent).toContain(
    'Wait at least 15 seconds',
  );
  expect(host.querySelector('output')!.textContent).toContain(
    'No readiness check for this wallet selection.',
  );
  expect(host.textContent).not.toContain('ready,');
});
