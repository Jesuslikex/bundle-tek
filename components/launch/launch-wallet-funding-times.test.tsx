// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { largeLayerReviewFixture } from '../../test/launch-layer-review-fixture';
import { LaunchWalletFundingTimes } from './launch-wallet-funding-times';
import { launchFundingRoster } from '@/lib/launch-wallet-funding';
import type { LaunchLayerEnvelope } from '@/lib/launch-layer-terms';
import type { WalletFundingSelection } from '@/lib/wallet-funding-time';

let host: HTMLDivElement, root: Root, envelope: LaunchLayerEnvelope;
// Each provider test advances its own monotonic epoch, independent of shuffle order.
let providerTestEpoch = 1000000000;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  envelope = await largeLayerReviewFixture();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const signature = bs58.encode(new Uint8Array(64).fill(4));
function reply(
  wallets: WalletFundingSelection,
  known: Map<string, number> = new Map(),
) {
  return Response.json({
    format: 'wallet-funding-times-v1',
    network: 'mainnet',
    scope: 'most-recently-saved-native-transfer',
    capturedAt: '2026-10-23T00:00:00.000Z',
    executionAllowed: false,
    wallets: wallets.map((w) => ({
      ...w,
      funding: known.has(w.address)
        ? { signature, slot: 100, blockTime: known.get(w.address) }
        : null,
      reason: known.has(w.address) ? null : 'no-retained-receipt',
    })),
  });
}
async function mount(value = envelope) {
  await act(async () =>
    root.render(<LaunchWalletFundingTimes envelope={value} />),
  );
}
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find(
    (b) => b.textContent === text,
  )!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
}
async function open() {
  await act(async () => host.querySelector('summary')!.click());
}

it('does not fetch on mount, disclosure or source change; unknown funding stays unknown', async () => {
  const fetcher = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) =>
    reply(JSON.parse(init!.body as string).wallets),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await open();
  expect(fetcher).not.toHaveBeenCalled();
  await click('Check recorded launch funding times');
  expect(fetcher).toHaveBeenCalledOnce();
  expect(host.textContent).toContain('0 known funding times');
  expect(host.textContent).toContain('unknown');
  expect(host.textContent).toContain('not an atomic current-state snapshot');
  expect(host.textContent).not.toContain('apart from');
  await act(async () =>
    [...host.querySelectorAll('label')]
      .find((l) => l.textContent?.includes('Provider history'))!
      .querySelector('input')!
      .click(),
  );
  expect(fetcher).toHaveBeenCalledOnce();
  expect(host.textContent).not.toContain('0 known funding times');
  expect(host.textContent).toContain('17-second spacing');
  expect(host.querySelector('input[type="password"]')).toBeNull();
});
it('shows a red-gap comparison across response batches, pages all observations and keeps the launch unchanged', async () => {
  const template = envelope.terms.roles.front[0];
  envelope.terms.roles.front = Array.from({ length: 150 }, (_, i) => ({
    ...template,
    wallet: {
      ...template.wallet,
      address: bs58.encode(
        Uint8Array.from({ length: 32 }, (_, j) =>
          j === 0 ? i : j === 1 ? 173 : 8,
        ),
      ),
    },
  }));
  const before = JSON.stringify(envelope),
    wallets = launchFundingRoster(envelope).wallets;
  const known = new Map([
    [wallets[99].address, 1700000000],
    [wallets[100].address, 1700001474],
  ]);
  const fetcher = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) =>
    reply(JSON.parse(init!.body as string).wallets, known),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await open();
  await click('Check recorded launch funding times');
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain('24m 34s apart');
  expect(
    host.querySelectorAll('ol[aria-label="Close launch funding pairs"] li'),
  ).toHaveLength(1);
  expect(
    host.querySelectorAll('ul[aria-label="Launch funding observations"] li'),
  ).toHaveLength(25);
  await click('Next funding observations');
  expect(host.textContent).toContain('Wallets 26');
  expect(JSON.stringify(envelope)).toBe(before);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('cancels a pending read without retaining a late result or starting another request', async () => {
  let resolve!: (response: Response) => void,
    requested!: WalletFundingSelection,
    signal!: AbortSignal;
  const fetcher = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
    requested = JSON.parse(init!.body as string).wallets;
    signal = init!.signal!;
    return new Promise<Response>((r) => {
      resolve = r;
    });
  });
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await open();
  await click('Check recorded launch funding times');
  await click('Cancel launch funding check');
  expect(signal.aborted).toBe(true);
  await act(async () => resolve(reply(requested)));
  expect(host.textContent).toContain('No partial result was kept');
  expect(host.textContent).not.toContain('known funding times');
  expect(fetcher).toHaveBeenCalledOnce();
});
it('cancels when the exact review changes and returning to the old review does not revive evidence', async () => {
  let resolve!: (response: Response) => void,
    requested!: WalletFundingSelection,
    signal!: AbortSignal;
  const fetcher = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
    requested = JSON.parse(init!.body as string).wallets;
    signal = init!.signal!;
    return new Promise<Response>((r) => {
      resolve = r;
    });
  });
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await open();
  await click('Check recorded launch funding times');
  const changed = structuredClone(envelope);
  changed.terms.delays.frontToBackDelayMs++;
  await mount(changed);
  expect(signal.aborted).toBe(true);
  await act(async () => resolve(reply(requested)));
  await mount(envelope);
  expect(host.textContent).not.toContain('known funding times');
  expect(fetcher).toHaveBeenCalledOnce();
});
it('refuses duplicate role wallets instead of checking a truncated or guessed roster', async () => {
  envelope.terms.roles.front[0].wallet = {
    ...envelope.terms.roles.funder.wallet,
  };
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await mount();
  expect(host.textContent).toContain(
    'exact launch-wallet roster is unavailable',
  );
  expect(host.querySelector('button')).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});

it('names a 501-wallet capacity limit without asking the user to reopen the same review', async () => {
  const template = envelope.terms.roles.front[0];
  let index = 0;
  const member = () => ({
    ...template,
    wallet: {
      ...template.wallet,
      address: bs58.encode(
        Uint8Array.from({ length: 32 }, (_, j) =>
          j === 0 ? index % 256 : j === 1 ? Math.floor(index / 256) : 9,
        ),
      ),
    },
  });
  const next = () => {
    const result = member();
    index++;
    return result;
  };
  envelope.terms.roles.funder = next();
  envelope.terms.roles.developer = next();
  envelope.terms.roles.front = Array.from({ length: 200 }, next);
  envelope.terms.roles.back = Array.from({ length: 200 }, next);
  envelope.terms.roles.temporary = Array.from({ length: 97 }, next);
  envelope.terms.roles.holders = Array.from({ length: 2 }, next);
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await mount();
  expect(host.textContent).toContain('at most 500 assigned wallets');
  expect(host.textContent).toContain('contains 501');
  expect(host.textContent).not.toContain('Reopen');
  expect(fetcher).not.toHaveBeenCalled();
});

it('explains provider failures, shows verified waiting progress and retains a monotonic cooldown across review remounts', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let now = (providerTestEpoch += 1000000);
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const advance = async (milliseconds: number) => {
    now += milliseconds;
    await act(async () => vi.advanceTimersByTimeAsync(milliseconds));
  };
  let status = 401;
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (status !== 200) return new Response('PRIVATE-DETAIL', { status });
    const request = JSON.parse(init!.body as string);
    return Response.json({
      format: 'wallet-funding-origins-v1',
      network: 'mainnet',
      scope: 'oldest-provider-reported-transaction',
      ledgerMetadata: 'provider-reported',
      historyComplete: false,
      signingAllowed: false,
      executionAllowed: false,
      context: request.context,
      capturedAt: '2026-10-23T00:00:00.000Z',
      wallets: request.wallets.map(
        (wallet: { address: string; revision: number }) => ({
          ...wallet,
          funding: null,
          reason: 'no-returned-history',
        }),
      ),
    });
  });
  vi.stubGlobal('fetch', fetcher);
  const source = async (name: string) =>
    act(async () =>
      [...host.querySelectorAll('label')]
        .find((label) => label.textContent?.includes(name))!
        .querySelector('input')!
        .click(),
    );
  const checkButton = () =>
    [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Check provider launch funding times',
    )!;
  try {
    await mount();
    await open();
    await source('Provider history');
    for (const [code, reason] of [
      [401, 'Sign in'],
      [409, 'references changed'],
      [503, 'Saved receipts'],
      [408, 'timed out'],
    ] as const) {
      if (code !== 401) await advance(17000);
      status = code;
      await click('Check provider launch funding times');
      expect(host.textContent).toContain(reason);
      expect(host.textContent).not.toContain('PRIVATE-DETAIL');
      expect(checkButton().disabled).toBe(true);
      if (code === 401)
        expect(host.querySelector('a[href="/sign-in"]')).not.toBeNull();
    }
    expect(fetcher).toHaveBeenCalledTimes(4);
    await advance(17000);
    status = 200;
    await click('Check provider launch funding times');
    expect(host.textContent).toContain('10 of 62 wallets read');
    expect(host.textContent).toContain('waiting for provider spacing');
    await click('Cancel launch funding check');
    expect(host.textContent).toContain('No partial result was kept');
    await source('Saved receipts');
    expect(host.textContent).not.toContain('cancelled after');
    const changed = structuredClone(envelope);
    changed.terms.delays.frontToBackDelayMs++;
    await mount(changed);
    await open();
    await source('Provider history');
    expect(checkButton().disabled).toBe(true);
    expect(host.textContent).toContain('Provider history cooldown');
    expect(fetcher).toHaveBeenCalledTimes(5);
    await advance(17000);
    expect(checkButton().disabled).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(5);
  } finally {
    vi.clearAllTimers();
    clock.mockRestore();
    vi.useRealTimers();
  }
});

it('re-arms an early cooldown timer and enables a new explicit check only after the monotonic deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let now = (providerTestEpoch += 1000000);
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const fetcher = vi.fn(async () => new Response('PRIVATE', { status: 401 }));
  vi.stubGlobal('fetch', fetcher);
  const button = () =>
    [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Check provider launch funding times',
    )!;
  try {
    await mount();
    await open();
    await act(async () =>
      [...host.querySelectorAll('label')]
        .find((l) => l.textContent?.includes('Provider history'))!
        .querySelector('input')!
        .click(),
    );
    await click('Check provider launch funding times');
    expect(button().disabled).toBe(true);
    now += 16999;
    await act(async () => vi.advanceTimersByTimeAsync(17000));
    expect(button().disabled).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    now++;
    await act(async () => vi.advanceTimersByTimeAsync(25));
    expect(button().disabled).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
  } finally {
    vi.clearAllTimers();
    clock.mockRestore();
    vi.useRealTimers();
  }
});

it('synchronizes another open panel on an explicit click without stranding its button or starting an early provider read', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let now = (providerTestEpoch += 1000000);
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now),
    fetcher = vi.fn(async () => new Response('private', { status: 401 }));
  vi.stubGlobal('fetch', fetcher);
  const panels = () => [
    ...host.querySelectorAll<HTMLDetailsElement>(':scope > details'),
  ];
  const button = (panel: HTMLDetailsElement) =>
    [...panel.querySelectorAll('button')].find(
      (b) => b.textContent === 'Check provider launch funding times',
    )!;
  try {
    await act(async () =>
      root.render(
        <>
          <LaunchWalletFundingTimes envelope={envelope} />
          <LaunchWalletFundingTimes envelope={envelope} />
        </>,
      ),
    );
    for (const panel of panels())
      await act(async () => {
        panel.querySelector('summary')!.click();
        [...panel.querySelectorAll('label')]
          .find((l) => l.textContent?.includes('Provider history'))!
          .querySelector('input')!
          .click();
      });
    const [first, second] = panels();
    await act(async () => button(second).click());
    expect(fetcher).toHaveBeenCalledOnce();
    await act(async () =>
      root.render(
        <>
          <LaunchWalletFundingTimes envelope={structuredClone(envelope)} />
          <LaunchWalletFundingTimes envelope={envelope} />
        </>,
      ),
    );
    expect(button(first).disabled).toBe(false);
    await act(async () => button(first).click());
    expect(button(first).disabled).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    now += 17000;
    await act(async () => vi.advanceTimersByTimeAsync(17000));
    expect(button(first).disabled).toBe(false);
    await act(async () => button(first).click());
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    vi.clearAllTimers();
    clock.mockRestore();
    vi.useRealTimers();
  }
});
