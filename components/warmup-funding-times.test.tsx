// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { WarmupFundingTimes } from './warmup-funding-times';

const wallets = [1, 2].map((n) => ({
  address: bs58.encode(new Uint8Array(32).fill(n)),
  revision: n,
}));
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
async function render(
  addresses = wallets.map((w) => w.address),
  revisions = wallets,
) {
  await act(async () =>
    root.render(
      <WarmupFundingTimes addresses={addresses} walletRevisions={revisions} />,
    ),
  );
}
async function check() {
  const button = [...host.querySelectorAll('button')].find(
    (b) => b.textContent === 'Check recorded funding times',
  )!;
  await act(async () => button.click());
}
function reply(selection = wallets) {
  return {
    format: 'wallet-funding-times-v1',
    network: 'mainnet',
    scope: 'most-recently-saved-native-transfer',
    capturedAt: '2026-10-23T00:00:00.000Z',
    executionAllowed: false,
    wallets: selection.map((w, i) => ({
      ...w,
      reason: null,
      funding: {
        signature: bs58.encode(new Uint8Array(64).fill(i + 1)),
        slot: i + 1,
        blockTime: 100000 + i * 1474,
      },
    })),
  };
}
it('reads only on explicit request, in exact warmup address order with matched current revisions', async () => {
  const expected = [wallets[1], wallets[0]],
    fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('/api/wallet-workspace/funding-times');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ wallets: expected });
      return Response.json(reply(expected));
    }),
    before = JSON.stringify(wallets);
  vi.stubGlobal('fetch', fetcher);
  await render(expected.map((w) => w.address));
  expect(fetcher).not.toHaveBeenCalled();
  await check();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(host.textContent).toContain('1 pair under 30 minutes');
  expect(host.querySelector('ol')!.textContent).toContain('24m 34s apart');
  expect(host.querySelector('ol')!.textContent).toContain(expected[0].address);
  expect(host.querySelector('ol')!.textContent).toContain(expected[1].address);
  expect(JSON.stringify(wallets)).toBe(before);
});

it.each([
  { addresses: [], revisions: [] },
  { addresses: [wallets[0].address], revisions: wallets },
  {
    addresses: wallets.map((w) => w.address),
    revisions: [wallets[0], wallets[0]],
  },
  { addresses: [wallets[0].address, wallets[0].address], revisions: wallets },
  {
    addresses: ['not-a-public-key'],
    revisions: [{ address: 'not-a-public-key', revision: 1 }],
  },
  {
    addresses: [wallets[0].address],
    revisions: [{ ...wallets[0], revision: 0 }],
  },
  {
    addresses: Array.from({ length: 21 }, (_, i) =>
      bs58.encode(new Uint8Array(32).fill(i + 1)),
    ),
    revisions: Array.from({ length: 21 }, (_, i) => ({
      address: bs58.encode(new Uint8Array(32).fill(i + 1)),
      revision: 1,
    })),
  },
])(
  'refuses an unavailable or ambiguous roster without a request: %j',
  async ({ addresses, revisions }) => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await render(addresses, revisions);
    expect(host.textContent).toContain(
      'exact wallet revisions are unavailable',
    );
    expect(host.querySelector('button')).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  },
);

it.each(['revision', 'order'] as const)(
  'aborts an old roster on %s change and never revives its late response',
  async (kind) => {
    let release!: (r: Response) => void, sentSignal: AbortSignal | undefined;
    const fetcher = vi.fn((_url: string, init: RequestInit) => {
      sentSignal = init.signal as AbortSignal;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    vi.stubGlobal('fetch', fetcher);
    await render();
    await check();
    await render(
      kind === 'order'
        ? wallets.map((w) => w.address).reverse()
        : wallets.map((w) => w.address),
      kind === 'revision'
        ? wallets.map((w) => ({ ...w, revision: w.revision + 1 }))
        : wallets,
    );
    expect(sentSignal!.aborted).toBe(true);
    await render();
    await act(async () => {
      release(Response.json(reply()));
      await Promise.resolve();
    });
    expect(host.textContent).toContain(
      'No funding-time check for this selection',
    );
    expect(host.querySelector('ol')).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  },
);

it('refuses a same-length roster with a missing revision instead of substituting another wallet', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await render(
    [wallets[0].address, bs58.encode(new Uint8Array(32).fill(3))],
    wallets,
  );
  expect(host.textContent).toContain('exact wallet revisions are unavailable');
  expect(host.querySelector('button')).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
it('aborts a pending funding read when the dialog subtree closes', async () => {
  let captured: AbortSignal | undefined;
  const fetcher = vi.fn((_url: string, init: RequestInit) => {
    captured = init.signal as AbortSignal;
    return new Promise<Response>(() => {});
  });
  vi.stubGlobal('fetch', fetcher);
  await render();
  await check();
  await act(async () => root.render(<div>Closed</div>));
  expect(captured!.aborted).toBe(true);
  expect(fetcher).toHaveBeenCalledOnce();
});
