// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import {
  useWalletFundingProximity,
  WalletFundingProximityPanel,
  WalletFundingProximityBadge,
} from './wallet-funding-proximity';
import type { WalletFundingSelection } from '@/lib/wallet-funding-time';
import { fundingHistoryNotBefore } from '@/lib/funding-history-window';

const selection = [
  { address: bs58.encode(new Uint8Array(32).fill(1)), revision: 1 },
];
const signature = bs58.encode(new Uint8Array(64).fill(3));
const paths = [
  { name: 'small saved', maximum: 100, source: 'saved' },
  { name: 'small provider', maximum: 100, source: 'provider' },
  { name: '500 saved', maximum: 500, source: 'saved' },
  { name: '500 provider', maximum: 500, source: 'provider' },
] as const;
type Path = (typeof paths)[number];
function Harness({
  wallets,
  maximum,
}: {
  wallets: WalletFundingSelection;
  maximum: 100 | 500;
}) {
  const check = useWalletFundingProximity(wallets, maximum);
  return (
    <>
      <WalletFundingProximityPanel check={check} count={wallets.length} />
      {wallets.map((wallet) => (
        <WalletFundingProximityBadge
          key={wallet.address}
          check={check}
          address={wallet.address}
        />
      ))}
    </>
  );
}
function success(path: Path, wallets = selection): Response {
  const rows = wallets.map((wallet) => ({
    ...wallet,
    reason: null,
    funding: {
      signature,
      slot: 10,
      blockTime: 100000,
      ...(path.source === 'provider'
        ? {
            transactionIndex: 0,
            recipientChangeRaw: '1',
            funders: [bs58.encode(new Uint8Array(32).fill(2))],
          }
        : {}),
    },
  }));
  return Response.json(
    path.source === 'saved'
      ? {
          format: 'wallet-funding-times-v1',
          network: 'mainnet',
          scope: 'most-recently-saved-native-transfer',
          capturedAt: new Date().toISOString(),
          executionAllowed: false,
          wallets: rows,
        }
      : {
          format: 'wallet-funding-origins-v1',
          network: 'mainnet',
          scope: 'oldest-provider-reported-transaction',
          ledgerMetadata: 'provider-reported',
          historyComplete: false,
          signingAllowed: false,
          executionAllowed: false,
          context: wallets,
          capturedAt: new Date().toISOString(),
          wallets: rows,
        },
  );
}
let host: HTMLDivElement,
  root: Root,
  epoch = 0;
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-10-24T12:00:00.000Z'));
  const offset = (epoch += 1000000);
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now() + offset);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetcher);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  fetcher.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function render(path: Path, wallets = selection) {
  await act(async () =>
    root.render(<Harness wallets={wallets} maximum={path.maximum} />),
  );
}
async function choose(source: 'saved' | 'provider') {
  await act(async () =>
    host
      .querySelectorAll<HTMLInputElement>('input[type="radio"]')
      [source === 'saved' ? 0 : 1].click(),
  );
}
function start() {
  return host.querySelector<HTMLButtonElement>('button')!;
}
async function clickStart() {
  await act(async () => start().click());
}
async function setup(path: Path) {
  await render(path);
  if (path.source === 'provider') await choose('provider');
}
async function expireCourtesyGate() {
  await act(async () => vi.advanceTimersByTime(17000));
}
function signIn() {
  return host.querySelector<HTMLAnchorElement>('a[href="/sign-in"]');
}

it.each(paths)(
  'offers an explicit sign-in tab after $name 401, preserves manual retry and clears auth after success',
  async (path) => {
    fetcher.mockResolvedValueOnce(
      new Response('<html>auth expired</html>', { status: 401 }),
    );
    await setup(path);
    expect(fetcher).not.toHaveBeenCalled();
    await clickStart();
    const link = signIn();
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('/sign-in');
    expect(link!.target).toBe('_blank');
    expect(link!.rel).toBe('noopener noreferrer');
    expect(host.textContent).toMatch(/opens? (?:in )?a new tab/i);
    expect(host.textContent).not.toContain('auth expired');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(host.querySelector('pre')).toBeNull();
    if (path.maximum === 500 && path.source === 'provider')
      await expireCourtesyGate();
    let resolve!: (response: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await clickStart();
    expect(signIn()).toBeNull();
    expect(host.querySelector('pre')).toBeNull();
    await act(async () => resolve(success(path)));
    expect(signIn()).toBeNull();
    expect(host.textContent).toContain('Funding evidence reference');
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);

it.each(['text/html', 'application/json'])(
  'classifies a small saved401 immediately without consuming a hanging %s body',
  async (contentType) => {
    const cancel = vi.fn();
    fetcher.mockResolvedValueOnce(
      new Response(new ReadableStream({ cancel }), {
        status: 401,
        headers: { 'content-type': contentType },
      }),
    );
    await setup(paths[0]);
    await clickStart();
    expect(signIn()).not.toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
    expect(start().disabled).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
  },
);

it.each(paths)(
  'clears successful $name evidence when a manual refresh gets401',
  async (path) => {
    await setup(path);
    fetcher.mockResolvedValueOnce(success(path));
    await clickStart();
    expect(host.querySelector('pre')!.textContent).toContain(signature);
    if (path.maximum === 500 && path.source === 'provider')
      await expireCourtesyGate();
    let resolve!: (response: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await clickStart();
    expect(host.querySelector('pre')).toBeNull();
    await act(async () => resolve(new Response('expired', { status: 401 })));
    expect(signIn()).not.toBeNull();
    expect(host.querySelector('pre')).toBeNull();
  },
);

it.each(paths)(
  'does not turn $name non401,403 or malformed data into sign-in recovery',
  async (path) => {
    await setup(path);
    for (const response of [
      new Response('forbidden', { status: 403 }),
      new Response('error', { status: 503 }),
      Response.json({ malformed: true }),
    ]) {
      fetcher.mockResolvedValueOnce(response);
      await clickStart();
      expect(signIn()).toBeNull();
      expect(host.querySelector('[role="alert"]')).not.toBeNull();
      if (path.maximum === 500 && path.source === 'provider')
        await expireCourtesyGate();
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
  },
);

it.each(paths)(
  'discards a late $name401 after selection changes',
  async (path) => {
    let resolve!: (response: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await setup(path);
    await clickStart();
    const signal = fetcher.mock.calls[0][1]!.signal!;
    await render(path, [{ ...selection[0], revision: 2 }]);
    await act(async () => resolve(new Response('expired', { status: 401 })));
    expect(signal.aborted).toBe(true);
    expect(signIn()).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  },
);

it.each(paths)(
  'clears an existing $name sign-in marker on wallet revision changes without resuming a read',
  async (path) => {
    fetcher.mockResolvedValueOnce(new Response('expired', { status: 401 }));
    await setup(path);
    await clickStart();
    expect(signIn()).not.toBeNull();
    await render(path, [{ ...selection[0], revision: 2 }]);
    expect(signIn()).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(host.querySelector('pre')).toBeNull();
  },
);

it.each(paths)(
  'discards a late $name401 after changing source or cancelling the read',
  async (path) => {
    for (const action of ['source', 'cancel'] as const) {
      let resolve!: (response: Response) => void;
      fetcher.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      if (action === 'cancel') {
        await choose(path.source);
        if (path.maximum === 500 && path.source === 'provider')
          await expireCourtesyGate();
      } else await setup(path);
      await clickStart();
      const count = fetcher.mock.calls.length;
      if (action === 'source')
        await choose(path.source === 'saved' ? 'provider' : 'saved');
      else
        await act(async () =>
          [...host.querySelectorAll('button')]
            .find(
              (button) => button.textContent === 'Cancel funding-time check',
            )!
            .click(),
        );
      await act(async () => resolve(new Response('expired', { status: 401 })));
      expect(signIn()).toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(count);
    }
  },
);

it.each(paths)(
  'ignores $name401 after unmount and does not retain it on a fresh mount',
  async (path) => {
    let resolve!: (response: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await setup(path);
    await clickStart();
    const signal = fetcher.mock.calls[0][1]!.signal!;
    await act(async () => root.unmount());
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(new Response('expired', { status: 401 })));
    root = createRoot(host);
    await setup(path);
    expect(signIn()).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  },
);

it('does not reset the500provider courtesy gate when auth fails or the source changes', async () => {
  const path = paths[3];
  fetcher.mockResolvedValueOnce(new Response('expired', { status: 401 }));
  await setup(path);
  await clickStart();
  const deadline = fundingHistoryNotBefore();
  expect(deadline).toBeGreaterThan(performance.now());
  expect(start().disabled).toBe(true);
  await choose('saved');
  await choose('provider');
  expect(signIn()).toBeNull();
  expect(fundingHistoryNotBefore()).toBe(deadline);
  expect(start().disabled).toBe(true);
  await clickStart();
  expect(fetcher).toHaveBeenCalledOnce();
  await expireCourtesyGate();
  expect(start().disabled).toBe(false);
  expect(fetcher).toHaveBeenCalledOnce();
});

it.each(paths)(
  'keeps $name deadline refusal ahead of a late401',
  async (path) => {
    const deadline = new AbortController();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const duration = path.source === 'saved' ? 15000 : 50000;
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((ms) =>
        ms === duration ? deadline.signal : timeout(ms),
      );
    let resolve!: (response: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await setup(path);
    await clickStart();
    expect(timeoutSpy).toHaveBeenCalledWith(duration);
    deadline.abort(new DOMException('Controlled deadline', 'TimeoutError'));
    const cancel = vi.fn();
    await act(async () =>
      resolve(
        new Response(new ReadableStream({ cancel }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    expect(signIn()).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  },
);
it('does not await or expose a refused401 body cancellation', async () => {
  const cancel = vi.fn(() =>
    Promise.reject(Error('private cancellation failure')),
  );
  fetcher.mockResolvedValueOnce(
    new Response(new ReadableStream({ cancel }), { status: 401 }),
  );
  await setup(paths[0]);
  await clickStart();
  expect(signIn()).not.toBeNull();
  expect(cancel).toHaveBeenCalledOnce();
  expect(host.textContent).not.toContain('private cancellation');
  expect(fetcher).toHaveBeenCalledOnce();
});
it('discards a completed first saved batch when the second batch needs sign-in', async () => {
  const wallets = Array.from({ length: 101 }, (_, index) => ({
    address: bs58.encode(
      Uint8Array.from({ length: 32 }, (_, j) => (j === 0 ? index + 1 : 9)),
    ),
    revision: 1,
  }));
  fetcher.mockImplementation(async (_url, init) => {
    const requested = JSON.parse(init!.body as string).wallets;
    return requested.length === 100
      ? success(paths[2], requested)
      : new Response('expired', { status: 401 });
  });
  await render(paths[2], wallets);
  await clickStart();
  expect(signIn()).not.toBeNull();
  expect(host.textContent).toContain('100 of 101 wallets');
  expect(host.textContent).toContain('No partial result was kept');
  expect(host.querySelector('pre')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
