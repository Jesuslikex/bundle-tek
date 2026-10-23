// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WarmupWalletHistory } from './warmup-wallet-history';
import { warmupUiFixture } from '../test/warmup-ui-fixture';

let host: HTMLDivElement,
  root: Root,
  fixture: ReturnType<typeof warmupUiFixture>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture = warmupUiFixture();
  vi.stubGlobal('fetch', vi.fn(fixture.fetcher));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function mount(revision = 1, address = fixture.wallet) {
  await act(async () =>
    root.render(
      <WarmupWalletHistory
        chain="Solana"
        addresses={[address]}
        walletRevisions={[{ address, revision }]}
      />,
    ),
  );
}
async function click(label = 'Check wallet history') {
  const button = [...host.querySelectorAll('button')].find(
    (b) => b.textContent === label,
  )!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
}
it('does no request on mount or opening history; an explicit read renders bounded evidence', async () => {
  await mount();
  host.querySelector('details')!.open = true;
  expect(fetch).not.toHaveBeenCalled();
  await click();
  expect(host.textContent).toContain('0.02 SOL');
  expect(host.textContent).toContain('Wallet age: unknown');
  expect(fetch).toHaveBeenCalledOnce();
});
it('discards a completed result after a revision changes and cannot resurrect it on return', async () => {
  await mount();
  await click();
  expect(host.textContent).toContain('0.02 SOL');
  await mount(2);
  expect(host.textContent).not.toContain('0.02 SOL');
  await mount(1);
  expect(host.textContent).not.toContain('0.02 SOL');
  expect(fetch).toHaveBeenCalledOnce();
});
it.each(['revision', 'address'])(
  'aborts pending %s context and rejects its late original success',
  async (field) => {
    let finish!: (response: Response) => void;
    let signal!: AbortSignal;
    vi.stubGlobal(
      'fetch',
      vi.fn((_input, init) => {
        signal = init.signal;
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }),
    );
    await mount();
    await click();
    await mount(
      field === 'revision' ? 2 : 1,
      field === 'address'
        ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
        : fixture.wallet,
    );
    expect(signal.aborted).toBe(true);
    await act(async () =>
      finish(
        await fixture.fetcher('/api/wallet-workspace/warmup', {
          method: 'POST',
        }),
      ),
    );
    expect(host.textContent).not.toContain('0.02 SOL');
    expect(fetch).toHaveBeenCalledOnce();
  },
);
it('handles in-place revision edits without losing the binding', async () => {
  const props = {
    chain: 'Solana' as const,
    addresses: [fixture.wallet],
    walletRevisions: [{ address: fixture.wallet, revision: 1 }],
  };
  await act(async () => root.render(<WarmupWalletHistory {...props} />));
  await click();
  props.walletRevisions[0].revision = 2;
  await act(async () => root.render(<WarmupWalletHistory {...props} />));
  expect(host.textContent).not.toContain('0.02 SOL');
});
it.each([401, 404, 409, 429, 503])(
  'provides manual recovery for %s without exposing server errors',
  async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: 'secret-provider-url' }, { status }),
      ),
    );
    await mount();
    await click();
    expect(host.querySelector('[role="alert"]')).toBeTruthy();
    expect(host.textContent).not.toContain('secret-provider-url');
    expect(host.querySelector('a[href="/sign-in"]') !== null).toBe(
      status === 401,
    );
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(fetch).toHaveBeenCalledOnce();
  },
);
it('cancels without late success, timers or hidden retries and permits a new explicit read', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    )
    .mockImplementation(fixture.fetcher);
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click();
  await click('Cancel history check');
  await act(async () =>
    finish(
      await fixture.fetcher('/api/wallet-workspace/warmup', { method: 'POST' }),
    ),
  );
  expect(host.textContent).toContain('History check cancelled');
  expect(host.textContent).not.toContain('0.02 SOL');
  await click();
  expect(host.textContent).toContain('0.02 SOL');
  expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(host.textContent).not.toContain('took too long');
});
it('bounds a pending body by the whole request deadline and allows explicit recovery', async () => {
  const cancel = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
  await mount();
  await click();
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(cancel).toHaveBeenCalledOnce();
  expect(host.textContent).toContain('Wallet history took too long');
  expect(host.textContent).not.toContain('0.02 SOL');
  expect(fetch).toHaveBeenCalledOnce();
});
it.each(['cancel', 'success', 'timeout'])(
  'keeps keyboard focus after %s and never reenters a pending request',
  async (action) => {
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    await mount();
    const button = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Check wallet history',
    )!;
    button.focus();
    await click();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await act(async () => button.click());
    expect(fetch).toHaveBeenCalledOnce();
    const cancel = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Cancel history check',
    )!;
    cancel.focus();
    if (action === 'cancel') await click('Cancel history check');
    else if (action === 'success')
      await act(async () =>
        finish(
          await fixture.fetcher('/api/wallet-workspace/warmup', {
            method: 'POST',
          }),
        ),
      );
    else await act(async () => vi.advanceTimersByTimeAsync(30000));
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-disabled')).toBe('false');
    expect(fetch).toHaveBeenCalledOnce();
  },
);
it('keeps one live status mounted across idle, pending and complete states', async () => {
  await mount();
  const live = host.querySelector('output[aria-live="polite"]')!;
  expect(live.textContent).toContain('No activity-history check');
  await click();
  expect(host.querySelector('output[aria-live="polite"]')).toBe(live);
  expect(live.textContent).toContain('History checked for 1 wallet');
});
it.each(['chain', 'unmount'])(
  'aborts and discards a pending result on %s',
  async (change) => {
    let signal!: AbortSignal, finish!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn((_input, init) => {
        signal = init.signal;
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }),
    );
    await mount();
    await click();
    await act(async () =>
      root.render(
        change === 'unmount' ? null : (
          <WarmupWalletHistory
            chain="Base"
            addresses={['0x0000000000000000000000000000000000000001']}
            walletRevisions={[
              {
                address: '0x0000000000000000000000000000000000000001',
                revision: 1,
              },
            ]}
          />
        ),
      ),
    );
    expect(signal.aborted).toBe(true);
    await act(async () =>
      finish(
        await fixture.fetcher('/api/wallet-workspace/warmup', {
          method: 'POST',
        }),
      ),
    );
    expect(host.textContent).not.toContain('0.02 SOL');
    expect(fetch).toHaveBeenCalledOnce();
  },
);
