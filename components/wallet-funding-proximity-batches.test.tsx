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
import { noteFundingHistoryRead } from '@/lib/funding-history-window';
import { LaunchWalletFundingTimes } from './launch/launch-wallet-funding-times';
import { largeLayerReviewFixture } from '../test/launch-layer-review-fixture';

const roster = (length: number): WalletFundingSelection =>
  Array.from({ length }, (_, i) => ({
    address: bs58.encode(
      Uint8Array.from({ length: 32 }, (_, j) =>
        j === 0 ? i % 256 : j === 1 ? Math.floor(i / 256) : 6,
      ),
    ),
    revision: 1,
  }));
const signature = bs58.encode(new Uint8Array(64).fill(8));
function saved(wallets: WalletFundingSelection, all: WalletFundingSelection) {
  return Response.json({
    format: 'wallet-funding-times-v1',
    network: 'mainnet',
    scope: 'most-recently-saved-native-transfer',
    capturedAt: new Date(
      Date.parse('2026-10-23T00:00:00.000Z') +
        Math.floor(
          all.findIndex((w) => w.address === wallets[0].address) / 100,
        ) *
          10000,
    ).toISOString(),
    executionAllowed: false,
    wallets: wallets.map((w) => {
      const i = all.findIndex((a) => a.address === w.address),
        known = i === 99 || i === 100;
      return {
        ...w,
        funding: known
          ? {
              signature,
              slot: 100,
              blockTime: 1700000000 + (i === 100 ? 1474 : 0),
            }
          : null,
        reason: known ? null : 'no-retained-receipt',
      };
    }),
  });
}
function provider(
  wallets: WalletFundingSelection,
  context: WalletFundingSelection,
) {
  return Response.json({
    format: 'wallet-funding-origins-v1',
    network: 'mainnet',
    scope: 'oldest-provider-reported-transaction',
    ledgerMetadata: 'provider-reported',
    historyComplete: false,
    signingAllowed: false,
    executionAllowed: false,
    context,
    capturedAt: new Date().toISOString(),
    wallets: wallets.map((w) => ({
      ...w,
      funding: null,
      reason: 'no-returned-history',
    })),
  });
}
function Harness({
  wallets,
  maximum = 500,
}: {
  wallets: WalletFundingSelection;
  maximum?: 100 | 500;
}) {
  const check = useWalletFundingProximity(wallets, maximum);
  return (
    <>
      <WalletFundingProximityPanel check={check} count={wallets.length} />
      {wallets.slice(98, 102).map((w) => (
        <WalletFundingProximityBadge
          key={w.address}
          check={check}
          address={w.address}
        />
      ))}
    </>
  );
}
let host: HTMLDivElement,
  root: Root,
  epoch = 0;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-10-23T12:00:00Z'));
  const offset = (epoch += 1000000);
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now() + offset);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function mount(
  wallets: WalletFundingSelection,
  maximum: 100 | 500 = 500,
) {
  await act(async () =>
    root.render(<Harness wallets={wallets} maximum={maximum} />),
  );
}
function button(text: string) {
  return [...host.querySelectorAll('button')].find(
    (b) => b.textContent === text,
  )!;
}
async function click(text = 'Check recorded funding times') {
  expect(button(text)).toBeTruthy();
  await act(async () => button(text).click());
}
async function chooseProvider() {
  await act(async () =>
    host.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1].click(),
  );
}

it('checks every one of 500 selected wallets in five unchanged API requests and compares across the boundary', async () => {
  const wallets = roster(500),
    fetcher = vi.fn(async (_input, init) => {
      const requested = JSON.parse(init.body).wallets;
      expect(requested.length).toBeLessThanOrEqual(100);
      return saved(requested, wallets);
    });
  vi.stubGlobal('fetch', fetcher);
  await mount(wallets);
  expect(fetcher).not.toHaveBeenCalled();
  await click();
  expect(fetcher).toHaveBeenCalledTimes(5);
  expect(
    fetcher.mock.calls.flatMap((c) => JSON.parse(c[1].body).wallets),
  ).toEqual(wallets);
  expect(host.textContent).toContain('2 of 500 recorded times');
  expect(host.textContent).toContain('498 unknown');
  expect(host.textContent).toContain('1 pair under 30 minutes');
  expect(host.textContent).toContain('24m 34s apart');
  expect(host.textContent).toContain(wallets[99].address);
  expect(host.textContent).toContain(wallets[100].address);
  expect(host.textContent).toContain('5 separate funding batches');
  expect(host.textContent).toContain('not one atomic');
  expect(host.textContent).toContain('checked wallets 401 to 500');
  const clocks = [...host.querySelectorAll('details')].filter(
    (detail) =>
      detail.querySelector('summary')?.textContent === '24m 34s apart',
  );
  expect(clocks[0].textContent).toContain('Funding batch 1');
  expect(clocks[1].textContent).toContain('Funding batch 2');
  expect(clocks[1].textContent).toContain(
    new Date('2026-10-23T00:00:10.000Z').toLocaleString(),
  );
});
it('keeps the existing 100-wallet path bounded when the opt-in is absent', async () => {
  vi.stubGlobal('fetch', vi.fn());
  await mount(roster(101), 100);
  expect(button('Check recorded funding times').disabled).toBe(true);
  await click();
  expect(fetch).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Select up to 100 wallets');
});
it('refuses 501 selected wallets without silently truncating', async () => {
  vi.stubGlobal('fetch', vi.fn());
  await mount(roster(501));
  expect(button('Check recorded funding times').disabled).toBe(true);
  expect(host.textContent).toContain('Select up to 500 wallets');
  expect(fetch).not.toHaveBeenCalled();
});
it('discards completed cross-batch evidence when a revision changes and on return', async () => {
  const wallets = roster(101);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input, init) =>
      saved(JSON.parse(init.body).wallets, wallets),
    ),
  );
  await mount(wallets);
  await click();
  expect(host.textContent).toContain('24m 34s apart');
  await mount(wallets.map((w, i) => (i === 100 ? { ...w, revision: 2 } : w)));
  expect(host.textContent).not.toContain('24m 34s apart');
  await mount(wallets);
  expect(host.textContent).not.toContain('24m 34s apart');
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('cancels a pending later batch and rejects its late response without keeping the first batch', async () => {
  const wallets = roster(101);
  let finish!: (response: Response) => void, signal!: AbortSignal;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(async (_input, init) =>
      saved(JSON.parse(init.body).wallets, wallets),
    )
    .mockImplementationOnce((_input, init) => {
      signal = init.signal;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    });
  vi.stubGlobal('fetch', fetcher);
  await mount(wallets);
  await click();
  await click('Cancel funding-time check');
  expect(signal.aborted).toBe(true);
  await act(async () => finish(saved(wallets.slice(100), wallets)));
  expect(host.textContent).not.toContain('separate funding batches');
  expect(host.textContent).not.toContain('24m 34s apart');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each([401, 409, 429, 503])(
  'keeps every result unknown after a later saved batch returns %s',
  async (status) => {
    const wallets = roster(101),
      fetcher = vi
        .fn()
        .mockImplementationOnce(async (_input, init) =>
          saved(JSON.parse(init.body).wallets, wallets),
        )
        .mockResolvedValueOnce(
          Response.json({ error: 'private-provider-value' }, { status }),
        );
    vi.stubGlobal('fetch', fetcher);
    await mount(wallets);
    await click();
    expect(host.textContent).toContain('stopped after 100 of 101 wallets');
    expect(host.textContent).toContain('No partial result');
    expect(host.textContent).not.toContain('private-provider-value');
    expect(host.textContent).not.toContain('24m 34s apart');
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);
it.each([101, 500])(
  'retains original ten-wallet provider requests and 100-wallet contexts for %s selected wallets',
  async (count) => {
    const wallets = roster(count),
      fetcher = vi.fn(async (url, init) => {
        expect(url).toBe('/api/wallet-workspace/funding-origins');
        const body = JSON.parse(init.body);
        expect(body.wallets.length).toBeLessThanOrEqual(10);
        expect(body.context.length).toBeLessThanOrEqual(100);
        return provider(body.wallets, body.context);
      });
    vi.stubGlobal('fetch', fetcher);
    await mount(wallets);
    await chooseProvider();
    expect(fetcher).not.toHaveBeenCalled();
    await click('Check provider funding history');
    await act(async () => vi.advanceTimersByTimeAsync(1000000));
    expect(fetcher).toHaveBeenCalledTimes(Math.ceil(count / 10));
    expect(
      fetcher.mock.calls.flatMap((c) => JSON.parse(c[1].body).wallets),
    ).toEqual(wallets);
    expect(host.textContent).toContain(`0 of ${count} provider-reported times`);
    expect(host.textContent).toContain(
      `${Math.ceil(count / 100)} separate funding batches`,
    );
  },
);
it.each(['cancel', 'revision', 'source'])(
  'discards provider results on %s during the inter-context wait',
  async (change) => {
    const wallets = roster(101),
      fetcher = vi.fn(async (_url, init) => {
        const body = JSON.parse(init.body);
        return provider(body.wallets, body.context);
      });
    vi.stubGlobal('fetch', fetcher);
    await mount(wallets);
    await chooseProvider();
    await click('Check provider funding history');
    await act(async () => vi.advanceTimersByTimeAsync(9 * 17000));
    expect(fetcher).toHaveBeenCalledTimes(10);
    expect(host.textContent).toContain('100 of 101 wallets checked');
    if (change === 'cancel') await click('Cancel funding-time check');
    else if (change === 'revision')
      await mount(
        wallets.map((w, i) => (i === 100 ? { ...w, revision: 2 } : w)),
      );
    else
      await act(async () =>
        host
          .querySelectorAll<HTMLInputElement>('input[type="radio"]')[0]
          .click(),
      );
    await act(async () => vi.advanceTimersByTimeAsync(17000));
    expect(fetcher).toHaveBeenCalledTimes(10);
    expect(host.textContent).not.toContain('separate funding batches');
    if (change === 'source') {
      await chooseProvider();
      expect(fetcher).toHaveBeenCalledTimes(10);
    }
  },
);
it('respects the same launch-panel courtesy gate, re-enabling without an automatic request', async () => {
  const wallets = roster(1),
    fetcher = vi.fn(async (_input, init) => {
      const body = JSON.parse(init.body);
      return provider(body.wallets, body.context);
    });
  vi.stubGlobal('fetch', fetcher);
  await mount(wallets);
  await chooseProvider();
  noteFundingHistoryRead();
  await click('Check provider funding history');
  expect(fetcher).not.toHaveBeenCalled();
  expect(button('Check provider funding history').disabled).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(17000));
  expect(button('Check provider funding history').disabled).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
  await click('Check provider funding history');
  expect(fetcher).toHaveBeenCalledOnce();
});
it('coordinates the actual launch and table panels without an early read or a stranded control', async () => {
  const envelope = await largeLayerReviewFixture(),
    wallets = roster(1),
    fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      return provider(body.wallets, body.context);
    });
  vi.stubGlobal('fetch', fetcher);
  await act(async () =>
    root.render(
      <>
        <Harness wallets={wallets} />
        <LaunchWalletFundingTimes envelope={envelope} />
      </>,
    ),
  );
  const radios = host.querySelectorAll<HTMLInputElement>('input[type="radio"]');
  await act(async () => {
    radios[1].click();
    radios[3].click();
  });
  await click('Check provider funding history');
  expect(fetcher).toHaveBeenCalledOnce();
  await click('Check provider launch funding times');
  expect(fetcher).toHaveBeenCalledOnce();
  expect(button('Check provider launch funding times').disabled).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(17000));
  expect(button('Check provider launch funding times').disabled).toBe(false);
  expect(fetcher).toHaveBeenCalledOnce();
  await click('Check provider launch funding times');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('disables a malformed runtime capacity rather than exposing an inert enabled button', async () => {
  vi.stubGlobal('fetch', vi.fn());
  await mount(roster(1), 200 as 100);
  expect(button('Check recorded funding times').disabled).toBe(true);
  expect(host.textContent).toContain('wallet capacity is unavailable');
  await click();
  expect(fetch).not.toHaveBeenCalled();
});
