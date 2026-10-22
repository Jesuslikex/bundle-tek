// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { BubbleMapPanel } from './bubble-map-panel';

const A = 'Vote111111111111111111111111111111111111111';
const B = 'Stake11111111111111111111111111111111111111';
const T = 'Config1111111111111111111111111111111111111';
const F = 'SysvarRent111111111111111111111111111111111';
afterEach(() => vi.unstubAllGlobals());

it('maps holders and the team wallet only after a click and reports linked supply', async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const fetchMock = vi.fn(async (_path: string, init?: RequestInit) => {
    const { addresses } = JSON.parse(init!.body as string) as {
      addresses: string[];
    };
    expect(addresses).toEqual([A, B, T]);
    const f = {
      funder: F,
      signature: bs58.encode(new Uint8Array(64).fill(1)),
      slot: 1,
    };
    return Response.json({
      network: 'mainnet',
      funders: {
        [A]: { funder: f },
        [B]: { funder: null, reason: 'history-unavailable' },
        [T]: { funder: f },
      },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <BubbleMapPanel
        holders={[
          { owner: A, raw: '400' },
          { owner: B, raw: '100' },
        ]}
        teamWallets={[T]}
        totalSupplyRaw="1000"
      />,
    ),
  );
  expect(fetchMock).not.toHaveBeenCalled();
  expect(container.textContent).toContain(
    'Provider history may be incomplete.',
  );
  await act(async () => container.querySelector('button')!.click());
  expect(container.textContent).toContain('Clustered supply 40.00%');
  expect(container.textContent).toContain(
    'Linked to checked team wallets: 40.00%',
  );
  expect(container.textContent).toContain(
    '1 wallet(s) had no usable funding evidence in this bounded lookup',
  );
  act(() => root.unmount());
});

const emptyResponse = (addresses: string[]) =>
  Response.json({
    network: 'mainnet',
    funders: Object.fromEntries(
      addresses.map((a) => [
        a,
        { funder: null, reason: 'history-unavailable' },
      ]),
    ),
  });
const holderList = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    owner: bs58.encode(new Uint8Array(32).fill(i + 1)),
    raw: '1',
  }));
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
it('shows bounded coverage, cancellable gate progress and no next group after cancel', async () => {
  vi.useFakeTimers();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const fetchMock = vi.fn(async (_: string, init: RequestInit) =>
    emptyResponse(JSON.parse(init.body as string).addresses),
  );
  vi.stubGlobal('fetch', fetchMock);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <BubbleMapPanel
          holders={holderList(33)}
          teamWallets={[]}
          totalSupplyRaw="100"
        />,
      ),
    );
    expect(container.textContent).toContain('32 of 33 holder and team wallets');
    expect(container.textContent).toContain('1 are outside the first 32');
    await act(async () => {
      container.querySelector('button')!.click();
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector('output')?.textContent).toContain(
      '20 of 32 wallets checked. Waiting 10 seconds',
    );
    const cancelButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Cancel funding check',
    )!;
    cancelButton.focus();
    await act(async () => cancelButton.click());
    expect(document.activeElement).toBe(container.querySelector('button'));
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'cancelled',
    );
    expect(container.querySelector('svg')).toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  }
});
it('clears successful maps on input changes, including returning to the previous input', async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const fetchMock = vi.fn(async (_: string, init: RequestInit) =>
    emptyResponse(JSON.parse(init.body as string).addresses),
  );
  vi.stubGlobal('fetch', fetchMock);
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    const props = {
      holders: [{ owner: A, raw: '1' }],
      teamWallets: [],
      totalSupplyRaw: '100',
    };
    await act(async () => root.render(<BubbleMapPanel {...props} />));
    await act(async () => container.querySelector('button')!.click());
    expect(container.querySelector('svg')).not.toBeNull();
    const detail = container.querySelector('details')!;
    expect(detail.textContent).toContain(A);
    expect(detail.textContent).toContain(
      'No history was returned by the provider.',
    );
    await act(async () =>
      root.render(<BubbleMapPanel {...props} totalSupplyRaw="200" />),
    );
    expect(container.querySelector('svg')).toBeNull();
    await act(async () => root.render(<BubbleMapPanel {...props} />));
    expect(container.querySelector('svg')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
  }
});
it('ignores late replies from an unmounted input and keeps HTML errors private', async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  let release!: (value: Response) => void;
  const fetchMock = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValueOnce(
      new Response('<html>private-parser-text</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    );
  vi.stubGlobal('fetch', fetchMock);
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <BubbleMapPanel
          holders={[{ owner: A, raw: '1' }]}
          teamWallets={[]}
          totalSupplyRaw="100"
        />,
      ),
    );
    await act(async () => {
      container.querySelector('button')!.click();
    });
    await act(async () =>
      root.render(
        <BubbleMapPanel
          holders={[{ owner: B, raw: '1' }]}
          teamWallets={[]}
          totalSupplyRaw="100"
        />,
      ),
    );
    await act(async () => {
      release(emptyResponse([A]));
      await flush();
    });
    expect(container.querySelector('svg')).toBeNull();
    await act(async () => container.querySelector('button')!.click());
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).not.toContain('private-parser-text');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
  }
});

it('does not report zero team links when team wallets are outside the sample', async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const fetchMock = vi.fn(async (_: string, init: RequestInit) =>
    emptyResponse(JSON.parse(init.body as string).addresses),
  );
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers();
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <BubbleMapPanel
          holders={holderList(32)}
          teamWallets={[T]}
          totalSupplyRaw="100"
        />,
      ),
    );
    expect(container.textContent).toContain(
      '0 of 1 valid team wallets are included',
    );
    await act(async () => {
      container.querySelector('button')!.click();
      await flush();
    });
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(container.textContent).toContain(
      'Team-wallet links were not checked',
    );
    expect(container.textContent).not.toContain(
      'Linked to checked team wallets: 0.00%',
    );
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
  }
});
it('deduplicates valid team wallets, excludes non-Solana entries and reports them', async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const fetchMock = vi.fn(async (_: string, init: RequestInit) => {
    expect(JSON.parse(init.body as string).addresses).toEqual([A, T]);
    return emptyResponse([A, T]);
  });
  vi.stubGlobal('fetch', fetchMock);
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <BubbleMapPanel
          holders={[{ owner: A, raw: '1' }]}
          teamWallets={[T, T, '0x1234']}
          totalSupplyRaw="100"
        />,
      ),
    );
    expect(container.textContent).toContain(
      '2 invalid or duplicate entries were excluded',
    );
    await act(async () => container.querySelector('button')!.click());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector('svg')).not.toBeNull();
  } finally {
    act(() => root.unmount());
  }
});
it('refuses conflicting duplicate holder amounts before any provider read', async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <BubbleMapPanel
          holders={[
            { owner: A, raw: '1' },
            { owner: A, raw: '2' },
          ]}
          teamWallets={[]}
          totalSupplyRaw="100"
        />,
      ),
    );
    expect(container.textContent).toContain('Holder balances disagree');
    expect(container.querySelector('button')!.disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
  }
});

it('ignores a late reading-phase result after Cancel and a new explicit check', async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  let release!: (value: Response) => void;
  const fetchMock = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValueOnce(emptyResponse([A]));
  vi.stubGlobal('fetch', fetchMock);
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <BubbleMapPanel
          holders={[{ owner: A, raw: '1' }]}
          teamWallets={[]}
          totalSupplyRaw="100"
        />,
      ),
    );
    await act(async () => container.querySelector('button')!.click());
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((b) => b.textContent === 'Cancel funding check')!
        .click(),
    );
    await act(async () => container.querySelector('button')!.click());
    expect(container.querySelector('details')?.textContent).toContain(
      'No history was returned',
    );
    await act(async () => {
      release(
        Response.json({
          network: 'mainnet',
          funders: {
            [A]: {
              funder: {
                funder: F,
                signature: bs58.encode(new Uint8Array(64).fill(1)),
                slot: 1,
              },
            },
          },
        }),
      );
      await flush();
    });
    expect(container.querySelector('details')?.textContent).toContain(
      'No history was returned',
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
  }
});

it.each(['', '0', '-1', '1.2', '1e3'])(
  'refuses unusable supply %s before spending any provider reads',
  async (totalSupplyRaw) => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <BubbleMapPanel
            holders={[{ owner: A, raw: '1' }]}
            teamWallets={[]}
            totalSupplyRaw={totalSupplyRaw}
          />,
        ),
      );
      expect(container.textContent).toContain(
        'A positive total supply is required',
      );
      expect(container.querySelector('button')!.disabled).toBe(true);
      await act(async () => container.querySelector('button')!.click());
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  },
);
