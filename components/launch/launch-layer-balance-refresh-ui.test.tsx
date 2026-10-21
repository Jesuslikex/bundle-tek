// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://bundle.test"}
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LaunchLayerNativeCoverage } from './launch-layer-native-coverage';
import { layerBalanceRefreshFixture } from '../../test/launch-layer-balance-refresh-fixture';
import { layerSolRefreshGroups } from '@/lib/launch-layer-balance-refresh';

let data: Awaited<ReturnType<typeof layerBalanceRefreshFixture>>,
  host: HTMLDivElement,
  root: Root;
const button = (name: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === name)!;
const posts = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([, options]) => options?.method === 'POST');
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function requestedAddresses(options?: RequestInit): string[] {
  expect(typeof options?.body).toBe('string');
  return (JSON.parse(options!.body as string) as { addresses: string[] })
    .addresses;
}
async function until(assertion: () => void) {
  await vi.waitFor(
    async () => {
      await act(async () => {
        await flush();
      });
      assertion();
    },
    { timeout: 3000, interval: 10 },
  );
}
async function click(name: string) {
  await act(async () => {
    button(name).click();
    await flush();
  });
}
beforeEach(async () => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  data = await layerBalanceRefreshFixture();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options?: RequestInit) =>
      options?.method === 'POST'
        ? Response.json({
            snapshot: await data.refresh(requestedAddresses(options)),
          })
        : Response.json({ evidence: await data.read() }),
    ),
  );
  await act(async () =>
    root.render(
      <LaunchLayerNativeCoverage plan={data.plan} disabled={false} />,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('refreshes only on request through exact owned endpoints and confirms storage before completion', async () => {
  expect(fetch).not.toHaveBeenCalled();
  const start = button('Refresh SOL observations');
  start.focus();
  await act(async () => {
    button('Refresh SOL observations').click();
    button('Load saved SOL observations').click();
  });
  await until(() => expect(host.textContent).toContain('Refresh complete.'));
  expect(document.activeElement).toBe(start);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(posts()).toHaveLength(1);
  const [url, options] = posts()[0];
  expect(url).toBe('/api/wallet-workspace/balances');
  expect(options).toMatchObject({
    cache: 'no-store',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
  });
  expect(JSON.parse(options!.body as string)).toEqual({
    chain: 'Solana',
    addresses: layerSolRefreshGroups(data.plan.envelope)[0],
  });
  expect(host.querySelector('progress')!.value).toBe(7);
  expect(host.querySelectorAll('tbody tr')).toHaveLength(7);
  expect(host.textContent).toContain('9007199.254740993');
  expect(host.textContent).toContain('Nothing is transferred or signed');
  expect(data.evidence.signingAllowed).toBe(false);
  expect(
    vi
      .mocked(fetch)
      .mock.calls.every(
        ([target]) =>
          typeof target === 'string' &&
          (target.startsWith('/api/launch/layers?') ||
            target === '/api/wallet-workspace/balances'),
      ),
  ).toBe(true);
});
it.each([105, 500])(
  'runs %s wallets in paced groups with retained progress, paging and no mixed-bank total',
  async (count) => {
    data = await layerBalanceRefreshFixture(count);
    await act(async () =>
      root.render(
        <LaunchLayerNativeCoverage plan={data.plan} disabled={false} />,
      ),
    );
    vi.useFakeTimers();
    await act(async () => {
      button('Refresh SOL observations').click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(posts()).toHaveLength(1);
    expect(host.querySelector('progress')!.value).toBe(100);
    expect(host.textContent).toContain('Waiting at least 15 seconds');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14999);
    });
    expect(posts()).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      if (count === 500) await vi.advanceTimersByTimeAsync(45000);
    });
    expect(posts()).toHaveLength(Math.ceil(count / 100));
    expect(host.querySelector('progress')!.value).toBe(count);
    expect(host.textContent).toContain('Refresh complete.');
    expect(host.textContent).toContain('no combined SOL balance is shown');
    expect(host.querySelectorAll('tbody tr')).toHaveLength(25);
    const before = vi.mocked(fetch).mock.calls.length;
    await act(async () => button('Next comparison wallets').click());
    expect(host.textContent).toContain(`page 2 of ${Math.ceil(count / 25)}`);
    const pageOutput = host.querySelector('output[tabindex="-1"]');
    expect(document.activeElement).toBe(pageOutput);
    expect(
      host
        .querySelector('[aria-label="Wallet SOL observation comparison"]')
        ?.getAttribute('tabindex'),
    ).toBe('0');
    expect(fetch).toHaveBeenCalledTimes(before);
    if (count === 105) {
      for (let page = 3; page <= 5; page++) {
        button('Next comparison wallets').focus();
        await act(async () => button('Next comparison wallets').click());
        expect(document.activeElement).toBe(pageOutput);
        expect(pageOutput?.textContent).toContain(`page ${page} of 5`);
      }
      expect(button('Next comparison wallets').disabled).toBe(true);
    }
    button('Previous comparison wallets').focus();
    await act(async () => button('Previous comparison wallets').click());
    expect(document.activeElement).toBe(pageOutput);
    const role = host.querySelector('select')!;
    await act(async () => {
      role.value = 'front';
      role.dispatchEvent(new Event('change', { bubbles: true }));
    });
    button('Clear observation filters').focus();
    await act(async () => button('Clear observation filters').click());
    expect(document.activeElement).toBe(pageOutput);
    expect(button('Clear observation filters')).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(before);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(posts()).toHaveLength(Math.ceil(count / 100));
  },
);
it('keeps unknown reads recoverable by GET after cancellation without redoing the provider POST', async () => {
  let release!: (response: Response) => void;
  vi.mocked(fetch).mockImplementation(async (_url, options) =>
    options?.method === 'POST'
      ? new Promise<Response>((resolve) => {
          release = resolve;
        })
      : Response.json({ evidence: await data.read() }),
  );
  await click('Refresh SOL observations');
  await until(() => expect(posts()).toHaveLength(1));
  await click('Cancel balance refresh');
  expect(host.textContent).toContain('may still have been retained');
  const snapshot = await data.refresh(
    layerSolRefreshGroups(data.plan.envelope)[0],
  );
  await act(async () => {
    release(Response.json({ snapshot }));
    await flush();
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(host.querySelector('table')).toBeNull();
  await click('Load saved SOL observations');
  await until(() => expect(host.querySelectorAll('tbody tr')).toHaveLength(7));
  expect(posts()).toHaveLength(1);
  expect(fetch).toHaveBeenCalledTimes(3);
});
it('cancels a prior source without requiring a parent React key and ignores its late response', async () => {
  let release!: (response: Response) => void;
  vi.mocked(fetch).mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await click('Refresh SOL observations');
  const signal = vi.mocked(fetch).mock.calls[0][1]!.signal!;
  const next = { ...data.plan, id: '00000000-0000-4000-8000-000000000099' };
  await act(async () =>
    root.render(<LaunchLayerNativeCoverage plan={next} disabled={false} />),
  );
  expect(signal.aborted).toBe(true);
  await act(async () => {
    release(Response.json({ evidence: data.evidence }));
    await flush();
  });
  expect(posts()).toHaveLength(0);
  expect(host.querySelector('table')).toBeNull();
  expect(host.querySelector('[role=alert]')).toBeNull();
});
it('stops on the first 429 without exposing raw errors or scheduling a retry', async () => {
  vi.mocked(fetch).mockImplementation(async (_url, options) =>
    options?.method === 'POST'
      ? new Response('<html>https://private.test/secret</html>', {
          status: 429,
        })
      : Response.json({ evidence: data.evidence }),
  );
  await click('Refresh SOL observations');
  await until(() =>
    expect(host.textContent).toContain('shared balance refresh limit'),
  );
  expect(host.textContent).not.toContain('/secret');
  expect(posts()).toHaveLength(1);
  vi.useFakeTimers();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000);
  });
  expect(posts()).toHaveLength(1);
});
it('times out before a stalled source check can start a provider read', async () => {
  let release!: (response: Response) => void;
  vi.mocked(fetch).mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  vi.useFakeTimers();
  await act(async () => {
    button('Refresh SOL observations').click();
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(host.textContent).toContain('Balance refresh timed out');
  await act(async () => {
    release(Response.json({ evidence: data.evidence }));
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(posts()).toHaveLength(0);
  expect(host.querySelector('table')).toBeNull();
});
it('does not publish completion if storage does not retain the returned balances', async () => {
  vi.mocked(fetch).mockImplementation(async (_url, options) => {
    if (options?.method === 'POST') {
      const snapshot = await data.refresh(requestedAddresses(options));
      data.evidence.rows[0].observation!.raw = '1';
      return Response.json({ snapshot });
    }
    return Response.json({ evidence: data.evidence });
  });
  await click('Refresh SOL observations');
  await until(() => expect(host.querySelector('[role=alert]')).not.toBeNull());
  expect(host.textContent).not.toContain('Refresh complete.');
  expect(host.querySelector('progress')!.value).toBe(0);
  expect(host.querySelector('table')).toBeNull();
  expect(posts()).toHaveLength(1);
});
it('leaves historical plans disabled with no provider calls', async () => {
  await act(async () =>
    root.render(
      <LaunchLayerNativeCoverage
        plan={{ ...data.plan, current: false }}
        disabled={false}
      />,
    ),
  );
  expect(button('Refresh SOL observations').disabled).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});
it.each(['finish', 'cancel', 'elsewhere'] as const)(
  'keeps keyboard focus through %s without stealing it from elsewhere',
  async (outcome) => {
    let release!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation(async (_url, options) =>
      options?.method === 'POST'
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : Response.json({ evidence: await data.read() }),
    );
    const start = button('Refresh SOL observations');
    start.focus();
    await click('Refresh SOL observations');
    await until(() => expect(posts()).toHaveLength(1));
    expect(document.activeElement).toBe(
      host.querySelector('[aria-label="SOL observation status"]'),
    );
    const outside = document.createElement('button');
    host.appendChild(outside);
    if (outcome === 'elsewhere') outside.focus();
    else button('Cancel balance refresh').focus();
    if (outcome === 'cancel') {
      await click('Cancel balance refresh');
      expect(document.activeElement).toBe(start);
    }
    const snapshot = await data.refresh(
      layerSolRefreshGroups(data.plan.envelope)[0],
    );
    await act(async () => {
      release(Response.json({ snapshot }));
      await flush();
    });
    if (outcome !== 'cancel')
      await until(() =>
        expect(host.textContent).toContain('Refresh complete.'),
      );
    expect(document.activeElement).toBe(
      outcome === 'elsewhere' ? outside : start,
    );
    expect(posts()).toHaveLength(1);
  },
);
