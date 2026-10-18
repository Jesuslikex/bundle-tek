// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WalletWarmupPreflight } from './wallet-warmup-preflight';
import { WalletWarmupQuote } from './wallet-warmup-quote';

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

for (const panel of ['preflight', 'quote'] as const) {
  for (const body of ['<html>Service unavailable</html>', 'null']) {
    it(`${panel} shows a usable retry error for ${body === 'null' ? 'null' : 'HTML'} responses`, async () => {
      const fetcher = vi.fn(async () => new Response(body, { status: 502 }));
      vi.stubGlobal('fetch', fetcher);
      await act(async () =>
        root.render(
          panel === 'preflight' ? (
            <WalletWarmupPreflight id="saved-plan" revision={1} />
          ) : (
            <WalletWarmupQuote id="saved-plan" revision={1} cycles={1} />
          ),
        ),
      );
      await act(async () => container.querySelector('button')!.click());
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        panel === 'preflight'
          ? 'Warmup preflight unavailable. Try checking again.'
          : 'Warmup quote unavailable. Try quoting again.',
      );
      expect(container.textContent).not.toMatch(
        /Unexpected token|Cannot read|<html>/,
      );
      expect(container.querySelector('button')!.disabled).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(
        container.querySelector('[aria-label="Warmup swap quote"]'),
      ).toBeNull();
      expect(
        container.querySelector('[aria-label="Warmup preflight observations"]'),
      ).toBeNull();
    });
  }
}

for (const panel of ['preflight', 'quote'] as const) {
  const label =
    panel === 'preflight' ? 'Check warmup preflight' : 'Quote warmup buy';
  const mount = async () =>
    act(async () =>
      root.render(
        panel === 'preflight' ? (
          <WalletWarmupPreflight id="saved-plan" revision={1} />
        ) : (
          <WalletWarmupQuote id="saved-plan" revision={1} cycles={2} />
        ),
      ),
    );
  const click = async (text: string) =>
    act(async () => {
      const button = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === text,
      );
      expect(button).toBeTruthy();
      button!.click();
    });
  it(`${panel} times out without automatic retry and allows a manual retry`, async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    await mount();
    await click(label);
    expect(container.querySelector('output')?.textContent).toContain(
      'No wallet unlock',
    );
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(container.querySelector('[role=alert]')?.textContent).toContain(
      'took too long',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(container.querySelector('button')!.disabled).toBe(false);
    await click(label);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role=alert]')).toBeNull();
  });
  it(`${panel} cancels its read and ignores a late response`, async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    await mount();
    await click(label);
    await click(`Cancel ${panel}`);
    expect(container.querySelector('button')!.disabled).toBe(false);
    await act(async () =>
      finish(
        Response.json({
          id: 'saved-plan',
          revision: 1,
          ...(panel === 'preflight'
            ? { report: preflight() }
            : {
                quote: {
                  executionAllowed: false,
                  cycle: 1,
                  expiresAt: new Date(Date.now() + 5000).toISOString(),
                },
              }),
        }),
      ),
    );
    expect(container.querySelector('[role=alert]')?.textContent).toContain(
      'cancelled',
    );
    expect(container.querySelector('section')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
}
function preflight() {
  return {
    executionAllowed: false,
    status: 'Observed',
    currency: 'SOL',
    requiredPerWallet: '0.013',
    issues: [],
    wallets: [],
    tokens: [],
    observedAt: new Date(Date.now()).toISOString(),
    expiresAt: new Date(Date.now() + 5000).toISOString(),
    limitations: 'Read-only fixture',
  };
}
it('marks preflight observations expired without requesting another read or approving execution', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () =>
    Response.json({ id: 'saved-plan', revision: 1, report: preflight() }),
  );
  vi.stubGlobal('fetch', fetcher);
  await act(async () =>
    root.render(<WalletWarmupPreflight id="saved-plan" revision={1} />),
  );
  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelector('[role=alert]')).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(container.querySelector('[role=alert]')?.textContent).toContain(
    'Preflight observations expired',
  );
  expect(container.querySelector('button')!.disabled).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(
    container.querySelector('[role=alert]')?.closest('details'),
  ).toBeNull();
});
it('keeps Hold and balances visible while technical observations require opening details', async () => {
  const fetcher = vi.fn(async () =>
    Response.json({
      id: 'saved-plan',
      revision: 1,
      report: {
        ...preflight(),
        status: 'Hold',
        issues: ['Insufficient balance.'],
        wallets: [
          {
            address: '11111111111111111111111111111111',
            amount: '0',
            shortfall: '0.013',
          },
        ],
        tokens: [
          {
            address: 'technical-token-address',
            name: 'USD Coin',
            symbol: 'USDC',
            decimals: 6,
            source: 'fixture-provider',
          },
        ],
      },
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  await act(async () =>
    root.render(<WalletWarmupPreflight id="saved-plan" revision={1} />),
  );
  await act(async () => container.querySelector('button')!.click());
  const section = container.querySelector('section')!;
  expect(section.querySelector('h5')?.textContent).toBe('Hold');
  expect(section.querySelector('dl')?.closest('details')).toBeNull();
  expect(section.querySelector('dl')?.textContent).toContain('0.013 SOL');
  const details = section.querySelector('details')!;
  expect(details.open).toBe(false);
  expect(details.textContent).toContain('fixture-provider');
  expect(details.textContent).toContain('technical-token-address');
  expect(details.textContent).toContain('Saved revision 1');
  await act(async () => details.querySelector('summary')!.click());
  expect(details.open).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('keeps raw quote units and provider records inside closed quote details', async () => {
  const fetcher = vi.fn(async () =>
    Response.json({
      id: 'saved-plan',
      revision: 1,
      quote: {
        executionAllowed: false,
        cycle: 1,
        router: 'metis',
        outputMint: 'technical-mint',
        inAmount: '1000000',
        outAmount: '103661',
        minimumOutAmount: '103142',
        limitations: 'Read-only fixture',
        expiresAt: new Date(Date.now() + 30000).toISOString(),
      },
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  await act(async () =>
    root.render(<WalletWarmupQuote id="saved-plan" revision={1} cycles={1} />),
  );
  await act(async () => container.querySelector('button')!.click());
  const details = container.querySelector('details')!;
  expect(details.open).toBe(false);
  expect(details.textContent).toContain('1000000 lamports');
  expect(details.textContent).toContain('technical-mint');
  expect(details.textContent).toContain('metis');
  expect(container.querySelector('section > p')?.closest('details')).toBeNull();
  await act(async () => details.querySelector('summary')!.click());
  expect(details.open).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
