// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://bundle.test"}
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { exchangeFundingReviewFixture } from '../../test/exchange-funding-review-fixture';
import { MainnetFundingExecution } from './mainnet-funding-execution';
import { validateFunding } from '@/lib/funding-plan';
import bs58 from 'bs58';
vi.mock('../native-withdrawal-panel', () => ({
  NativeWithdrawalPanel: (props: {
    initialWallet: string;
    wallets: { revision: number }[];
  }) => (
    <output
      data-transfer-review
      data-wallet-revision={props.wallets[0].revision}
    >
      {props.initialWallet}
    </output>
  ),
}));
let host: HTMLDivElement,
  root: Root,
  f: ReturnType<typeof exchangeFundingReviewFixture>;
const button = (name: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === name);
const flush = () => new Promise((r) => setTimeout(r, 0));
beforeEach(async () => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  f = exchangeFundingReviewFixture();
  f.plan.document.source = 'Wallet';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ wallets: [f.funder] })),
  );
  await act(async () =>
    root.render(<MainnetFundingExecution plan={f.plan} enabled />),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('loads exactly one public metadata request on an explicit double click', async () => {
  expect(fetch).not.toHaveBeenCalled();
  await act(async () => {
    button('Load saved mainnet funder')!.click();
    button('Load saved mainnet funder')?.click();
    await flush();
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/wallet-workspace');
  expect(host.querySelector('[data-transfer-review]')?.textContent).toBe(
    f.funder.address,
  );
});
it('replaces an HTML failure with a fixed message and does not mount transfer review', async () => {
  vi.mocked(fetch).mockResolvedValue(
    new Response('<html>https://private.test/secret</html>', { status: 502 }),
  );
  await act(async () => {
    button('Load saved mainnet funder')!.click();
    await flush();
  });
  expect(host.querySelector('[role=alert]')?.textContent).toBe(
    'Saved funding source could not be loaded. Try loading it again.',
  );
  expect(host.textContent).not.toContain('/secret');
  expect(host.querySelector('[data-transfer-review]')).toBeNull();
});
it('cancels a pending read and ignores its late response', async () => {
  let release!: (r: Response) => void;
  vi.mocked(fetch).mockImplementation(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  await act(async () => {
    button('Load saved mainnet funder')!.click();
    await flush();
  });
  expect(button('Cancel source loading')).toBeDefined();
  await act(async () => button('Cancel source loading')!.click());
  await act(async () => {
    release(Response.json({ wallets: [f.funder] }));
    await flush();
  });
  expect(host.textContent).toContain('Source loading cancelled');
  expect(host.querySelector('[data-transfer-review]')).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('ends a stalled read after ten seconds even if the transport ignores abort', async () => {
  let release!: (r: Response) => void;
  vi.mocked(fetch).mockImplementation(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  vi.useFakeTimers();
  await act(async () => {
    button('Load saved mainnet funder')!.click();
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(host.textContent).toContain('Source loading timed out');
  expect(button('Load saved mainnet funder')).toBeDefined();
  await act(async () => {
    release(Response.json({ wallets: [f.funder] }));
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(host.querySelector('[data-transfer-review]')).toBeNull();
});
it('keeps a newly loaded result when an older cancelled request settles later', async () => {
  let release!: (r: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  await act(async () => {
    button('Load saved mainnet funder')!.click();
    await flush();
  });
  button('Cancel source loading')!.focus();
  await act(async () => button('Cancel source loading')!.click());
  expect(document.activeElement).toBe(button('Load saved mainnet funder'));
  await act(async () => {
    button('Load saved mainnet funder')!.click();
    await flush();
  });
  expect(host.querySelector('[data-transfer-review]')?.textContent).toBe(
    f.funder.address,
  );
  await act(async () => {
    release(new Response('<html>old private error</html>', { status: 502 }));
    await flush();
  });
  expect(host.querySelector('[role=alert]')).toBeNull();
  expect(host.querySelector('[data-transfer-review]')?.textContent).toBe(
    f.funder.address,
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('cancels a stalled body after headers without leaving the reader locked', async () => {
  const cancelled = vi.fn();
  const response = new Response(
    new ReadableStream({
      start(s) {
        s.enqueue(new TextEncoder().encode('{'));
      },
      cancel: cancelled,
    }),
    { headers: { 'content-type': 'application/json' } },
  );
  vi.mocked(fetch).mockResolvedValue(response);
  vi.useFakeTimers();
  await act(async () => {
    button('Load saved mainnet funder')!.click();
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(host.textContent).toContain('Source loading timed out');
  expect(cancelled).toHaveBeenCalledOnce();
  expect(response.body!.locked).toBe(false);
  expect(host.querySelector('[data-transfer-review]')).toBeNull();
});
it.each([401, 403, 429])(
  'uses fixed HTTP %s errors without reading provider diagnostics',
  async (status) => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ error: 'https://private.test/secret' }, { status }),
    );
    await act(async () => {
      button('Load saved mainnet funder')!.click();
      await flush();
    });
    expect(host.textContent).not.toContain('/secret');
    expect(host.querySelector('[role=alert]')?.textContent).toBe(
      status === 429
        ? 'Saved funding source could not be loaded. Try loading it again.'
        : 'Sign in again before loading the saved funding source.',
    );
    expect(host.querySelector('[data-transfer-review]')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);
it('invalidates a pending source on a changed saved revision without requiring a parent key', async () => {
  let release!: (r: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  await act(async () => {
    button('Load saved mainnet funder')!.click();
    await flush();
  });
  const signal = vi.mocked(fetch).mock.calls[0][1]!.signal!;
  await act(async () =>
    root.render(
      <MainnetFundingExecution
        plan={{ ...f.plan, revision: f.plan.revision + 1 }}
        enabled
      />,
    ),
  );
  expect(signal.aborted).toBe(true);
  await act(async () => {
    release(Response.json({ wallets: [f.funder] }));
    await flush();
  });
  expect(host.querySelector('[data-transfer-review]')).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('loads the exact proxy leg source and preserves leg selection across temporary disabling', async () => {
  const proxy = {
    ...f.funder,
    address: bs58.encode(new Uint8Array(32).fill(10)),
    role: 'Recipient' as const,
  };
  f.plan = {
    ...f.plan,
    document: validateFunding({
      ...f.plan.document,
      recipients: [
        { ...f.plan.document.recipients[0], proxies: [proxy.address] },
      ],
    }),
  };
  vi.mocked(fetch).mockResolvedValue(
    Response.json({ wallets: [f.funder, proxy] }),
  );
  await act(async () =>
    root.render(<MainnetFundingExecution plan={f.plan} enabled />),
  );
  const leg = host.querySelectorAll('select')[1];
  await act(async () => {
    leg.value = '2';
    leg.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => {
    button('Load leg 2 source wallet')!.click();
    await flush();
  });
  expect(host.querySelector('[data-transfer-review]')?.textContent).toBe(
    proxy.address,
  );
  await act(async () =>
    root.render(<MainnetFundingExecution plan={f.plan} enabled={false} />),
  );
  expect(host.querySelector('[data-transfer-review]')).toBeNull();
  await act(async () =>
    root.render(<MainnetFundingExecution plan={f.plan} enabled />),
  );
  expect(button('Load leg 2 source wallet')).toBeDefined();
  expect(host.querySelector('[data-transfer-review]')).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([
  'same',
  'changed',
  'http',
  'cancel',
  'missing',
  'archived',
  'duplicate',
] as const)(
  'keeps the original transfer review mounted through a %s source recheck',
  async (outcome) => {
    await act(async () => {
      button('Load saved mainnet funder')!.click();
      await flush();
    });
    const original = host.querySelector('[data-transfer-review]');
    expect(original).not.toBeNull();
    let release!: (r: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    await act(async () => {
      button('Recheck saved source')!.click();
      await flush();
    });
    expect(host.querySelector('[data-transfer-review]')).toBe(original);
    if (outcome === 'cancel')
      await act(async () => button('Cancel source loading')!.click());
    await act(async () => {
      release(
        outcome === 'http'
          ? new Response('<html>private</html>', { status: 502 })
          : Response.json({
              wallets:
                outcome === 'missing'
                  ? []
                  : outcome === 'duplicate'
                    ? [f.funder, f.funder]
                    : [
                        {
                          ...f.funder,
                          revision:
                            f.funder.revision + (outcome === 'changed' ? 1 : 0),
                          archived: outcome === 'archived',
                        },
                      ],
            }),
      );
      await flush();
    });
    expect(host.querySelector('[data-transfer-review]')).toBe(original);
    expect(original?.getAttribute('data-wallet-revision')).toBe(
      String(f.funder.revision),
    );
    if (['changed', 'missing', 'archived', 'duplicate'].includes(outcome))
      expect(host.textContent).toContain(
        'Keep this transfer review for recovery',
      );
    if (outcome === 'same') {
      expect(host.querySelector('[role=alert]')).toBeNull();
      expect(host.textContent).toContain(
        'Saved source details still match the open review.',
      );
    }
    if (outcome === 'http')
      expect(host.querySelector('[role=alert]')?.textContent).toBe(
        'Saved funding source could not be loaded. Try loading it again.',
      );
    expect(fetch).toHaveBeenCalledTimes(2);
  },
);
it('aborts pending metadata when disabled and never revives it after re-enabling', async () => {
  let release!: (r: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  await act(async () => {
    button('Load saved mainnet funder')!.click();
    await flush();
  });
  const signal = vi.mocked(fetch).mock.calls[0][1]!.signal!;
  await act(async () =>
    root.render(<MainnetFundingExecution plan={f.plan} enabled={false} />),
  );
  expect(signal.aborted).toBe(true);
  await act(async () => {
    release(Response.json({ wallets: [f.funder] }));
    await flush();
  });
  await act(async () =>
    root.render(<MainnetFundingExecution plan={f.plan} enabled />),
  );
  expect(host.querySelector('[data-transfer-review]')).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('clears an old source error when a different recipient is selected', async () => {
  f.plan = {
    ...f.plan,
    document: validateFunding({
      ...f.plan.document,
      recipients: [
        ...f.plan.document.recipients,
        { address: bs58.encode(new Uint8Array(32).fill(12)), amount: '0.1' },
      ],
    }),
  };
  await act(async () =>
    root.render(<MainnetFundingExecution plan={f.plan} enabled />),
  );
  vi.mocked(fetch).mockResolvedValue(
    new Response('<html>private</html>', { status: 502 }),
  );
  await act(async () => {
    button('Load saved mainnet funder')!.click();
    await flush();
  });
  expect(host.querySelector('[role=alert]')).not.toBeNull();
  await act(async () => {
    const select = host.querySelector('select')!;
    select.value = '2';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(host.querySelector('[role=alert]')).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('explains a missing saved leg instead of displaying a silent load button', async () => {
  await act(async () =>
    root.render(
      <MainnetFundingExecution
        plan={{ ...f.plan, document: { ...f.plan.document, items: [] } }}
        enabled
      />,
    ),
  );
  expect(host.textContent).toContain('saved funding route is unavailable');
  expect(button('Load saved mainnet funder')).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
});
