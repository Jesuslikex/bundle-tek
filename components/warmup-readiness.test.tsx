// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WarmupReadiness } from './warmup-readiness';
import type { LaunchChain } from '@/lib/launch-plan';

const wallet = '11111111111111111111111111111111';
const other = 'SysvarRent111111111111111111111111111111111';
let host: HTMLDivElement, root: Root;
const originalClipboard = Object.getOwnPropertyDescriptor(
  navigator,
  'clipboard',
);

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  if (originalClipboard)
    Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
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
async function mount(
  feeReserve = '0.01',
  addresses = [wallet],
  options: { chain?: LaunchChain; revision?: number } = {},
) {
  await act(async () =>
    root.render(
      <WarmupReadiness
        chain={options.chain ?? 'Solana'}
        addresses={addresses}
        walletRevisions={addresses.map((address) => ({
          address,
          revision: options.revision ?? 1,
        }))}
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

function clipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}
async function showAddress() {
  const details = host.querySelector('details')!;
  expect(details).toBeTruthy();
  await act(async () => {
    details.open = true;
  });
  return details;
}
it('reveals and copies the exact selected public address with chain and fee-only guidance, without another read', async () => {
  const fetcher = balances([{ address: wallet, nativeBalance: '0.001' }]);
  const writeText = vi.fn(async (_address: string) => {});
  clipboard(writeText);
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Check wallet readiness');
  const details = await showAddress();
  expect(details.querySelector('code')!.textContent).toBe(wallet);
  expect(details.textContent).toContain('Solana · SOL native balance');
  expect(details.textContent).toContain('Use native SOL for fees');
  expect(host.textContent).toContain(
    'This estimate covers fees and rent only.',
  );
  expect(host.textContent).toContain(
    'It does not include token purchases or a complete trade or launch budget.',
  );
  await click('Copy public address');
  expect(writeText).toHaveBeenCalledExactlyOnceWith(wallet);
  expect(host.textContent).toContain('Public address copied.');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('keeps the full public address available as a manual fallback when clipboard access fails', async () => {
  const fetcher = balances([{ address: wallet, nativeBalance: '0' }]);
  clipboard(
    vi.fn(async () => {
      throw Error('Private clipboard detail');
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Check wallet readiness');
  await showAddress();
  await click('Copy public address');
  expect(host.textContent).toContain(
    'Could not copy. Select and copy the full public address above.',
  );
  expect(host.querySelector('details code')!.textContent).toBe(wallet);
  expect(host.textContent).not.toContain('Private clipboard detail');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('shows manual fallback without a clipboard API instead of inventing copy success', async () => {
  Reflect.deleteProperty(navigator, 'clipboard');
  vi.stubGlobal('fetch', balances([{ address: wallet, nativeBalance: '0' }]));
  await mount();
  await click('Check wallet readiness');
  await showAddress();
  await click('Copy public address');
  expect(host.textContent).toContain('Could not copy.');
  expect(host.textContent).not.toContain('Public address copied.');
});
it('offers no funding amount or verified-readiness claim for an unknown balance', async () => {
  const fetcher = balances([{ address: wallet }]);
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Check wallet readiness');
  const details = await showAddress();
  expect(details.textContent).toContain(
    'No funding amount is recommended while the balance is unknown.',
  );
  expect(details.textContent).not.toContain(
    'If you choose to fund this wallet',
  );
  expect(host.textContent).toContain('Balance unknown · no conclusion');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
for (const context of ['selection', 'chain', 'revision'] as const)
  it(`discards a pending clipboard result after the ${context} changes`, async () => {
    const fetcher = balances([{ address: wallet, nativeBalance: '0' }]);
    vi.stubGlobal('fetch', fetcher);
    let finish!: () => void;
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    clipboard(writeText);
    await mount();
    await click('Check wallet readiness');
    await showAddress();
    await click('Copy public address');
    expect(writeText).toHaveBeenCalledExactlyOnceWith(wallet);
    expect(host.textContent).toContain('Copying address…');
    await mount(
      '0.01',
      context === 'selection' ? [other] : [wallet],
      context === 'chain'
        ? { chain: 'Base' }
        : context === 'revision'
          ? { revision: 2 }
          : {},
    );
    await act(async () => {
      finish();
    });
    expect(host.textContent).not.toContain('Public address copied.');
    expect(host.textContent).not.toContain('Copying address…');
    expect(host.querySelector('details')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
it('does not publish an old clipboard failure into a newly checked wallet revision', async () => {
  const fetcher = balances([{ address: wallet, nativeBalance: '0' }]);
  vi.stubGlobal('fetch', fetcher);
  let reject!: (reason: Error) => void;
  clipboard(
    vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    ),
  );
  await mount();
  await click('Check wallet readiness');
  await showAddress();
  await click('Copy public address');
  await mount('0.01', [wallet], { revision: 2 });
  await click('Check wallet readiness');
  await act(async () => {
    reject(Error('Old failure'));
  });
  expect(host.textContent).not.toContain('Could not copy.');
  expect(host.textContent).not.toContain('Old failure');
  expect(host.textContent).not.toContain('Public address copied.');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('labels Base funding in native ETH rather than SOL', async () => {
  const address = '0x1111111111111111111111111111111111111111';
  const fetcher = vi.fn(async () =>
    Response.json({
      chain: 'Base',
      results: [
        {
          address,
          observation: {
            ...observation(address, '0'),
            chain: 'Base',
            currency: 'ETH',
            blockHash: '0x' + '11'.repeat(32),
            outgoingTransactions: '0',
            sampleCount: null,
            successfulSampleCount: null,
          },
        },
      ],
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount('0.01', [address], { chain: 'Base' });
  await click('Check wallet readiness');
  const details = await showAddress();
  expect(details.textContent).toContain('Base · ETH native balance');
  expect(details.textContent).toContain('Use native ETH for fees');
  expect(details.textContent).not.toContain('SOL');
  expect(details.querySelector('code')!.textContent).toBe(address);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
