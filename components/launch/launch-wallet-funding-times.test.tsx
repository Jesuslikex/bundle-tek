// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { largeLayerReviewFixture } from '../../test/launch-layer-review-fixture';
import { LaunchWalletFundingTimes } from './launch-wallet-funding-times';
import { launchFundingRoster } from '@/lib/launch-wallet-funding';
import type { LaunchLayerEnvelope } from '@/lib/launch-layer-terms';
import {
  walletFundingTimes,
  type WalletFundingSelection,
} from '@/lib/wallet-funding-time';

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
  const fetcher = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
    const requested = JSON.parse(init!.body as string).wallets;
    const response = walletFundingTimes.parse(
      await reply(requested, known).json(),
    );
    response.capturedAt =
      requested[0].address === wallets[0].address
        ? '2026-10-23T00:00:00.000Z'
        : '2026-10-23T00:01:00.000Z';
    return Response.json(response);
  });
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
  for (let page = 0; page < 3; page++) await click('Next funding observations');
  const secondGroupRow = host.querySelector(
    'ul[aria-label="Launch funding observations"] li',
  )!;
  expect(secondGroupRow.textContent).toContain('Funding check group 2');
  expect(secondGroupRow.querySelector('time')?.dateTime).toBe(
    '2026-10-23T00:01:00.000Z',
  );
  expect(secondGroupRow.textContent).toContain('24m 34s apart');
  expect(JSON.stringify(envelope)).toBe(before);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('explains missing and unusable saved receipts without treating unknown wallets as unfunded', async () => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const response = walletFundingTimes.parse(
      await reply(JSON.parse(init!.body as string).wallets).json(),
    );
    response.wallets[1].reason = 'unavailable-evidence';
    return Response.json(response);
  });
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await open();
  await click('Check recorded launch funding times');
  const rows = host.querySelectorAll(
    'ul[aria-label="Launch funding observations"] li',
  );
  expect(rows[0].textContent).toContain(
    'No retained successful native SOL receipt was found.',
  );
  expect(rows[1].textContent).toContain(
    'The most recently saved receipt could not establish a usable funding time.',
  );
  expect(rows[0].textContent).toContain(
    'Other funding not captured in saved receipts may exist; this is not proof that the wallet was never funded.',
  );
  expect(rows[0].textContent).toContain('Saved-record check');
  expect(rows[0].querySelector('time')?.dateTime).toBe(
    '2026-10-23T00:00:00.000Z',
  );
  expect(rows[0].textContent).toContain('not the funding block time');
  expect(rows[0].getAttribute('title')).toBeNull();
  expect(fetcher).toHaveBeenCalledOnce();
});

it('explains all provider unknown reasons and labels aggregate capture time without claiming exact per-wallet reads', async () => {
  envelope.terms.roles.front = envelope.terms.roles.front.slice(0, 6);
  expect(launchFundingRoster(envelope).wallets.length).toBeGreaterThan(10);
  expect(launchFundingRoster(envelope).wallets.length).toBeLessThanOrEqual(20);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const reasons = [
    'no-returned-history',
    'unavailable-oldest-evidence',
    'unsupported-native-transaction',
    'not-zero-to-positive-funding',
    'unsupported-address',
  ];
  let now = (providerTestEpoch += 1000000),
    calls = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
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
      capturedAt:
        ++calls === 1 ? '2026-10-23T00:00:00.000Z' : '2026-10-23T00:01:00.000Z',
      wallets: request.wallets.map(
        (wallet: WalletFundingSelection[number], i: number) => ({
          ...wallet,
          funding: null,
          reason: reasons[i % reasons.length],
        }),
      ),
    });
  });
  vi.stubGlobal('fetch', fetcher);
  try {
    await mount();
    await open();
    await act(async () =>
      [...host.querySelectorAll('label')]
        .find((label) => label.textContent?.includes('Provider history'))!
        .querySelector('input')!
        .click(),
    );
    await click('Check provider launch funding times');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(
      host.querySelector('ul[aria-label="Launch funding observations"]'),
    ).toBeNull();
    now += 17000;
    await act(async () => vi.advanceTimersByTimeAsync(17000));
    const rows = host.querySelectorAll(
      'ul[aria-label="Launch funding observations"] li',
    );
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const text of [
      'The provider returned no transaction history.',
      'The oldest returned evidence could not be validated.',
      'The oldest returned transaction type is not supported by the funding history check.',
      'The oldest returned transaction does not establish an initial SOL deposit. Later transactions were not checked.',
      'Provider history is not available for this wallet type.',
    ])
      expect(host.textContent).toContain(text);
    expect(rows[0].textContent).toContain(
      'Latest provider capture in this group',
    );
    expect(rows[0].textContent).toContain(
      'Individual wallet reads may be earlier.',
    );
    expect(rows[0].textContent).toContain(
      'not proof that the wallet was never funded',
    );
    expect(rows[0].querySelector('time')?.dateTime).toBe(
      '2026-10-23T00:01:00.000Z',
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    vi.clearAllTimers();
    clock.mockRestore();
    vi.useRealTimers();
  }
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

it('exposes the original saved funding reference without another read or changing launch terms', async () => {
  const wallets = launchFundingRoster(envelope).wallets;
  const before = JSON.stringify(envelope);
  const fetcher = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) =>
    reply(
      JSON.parse(init!.body as string).wallets,
      new Map([[wallets[0].address, 1700000000]]),
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await open();
  await click('Check recorded launch funding times');
  const rows = host.querySelectorAll(
    'ul[aria-label="Launch funding observations"] li',
  );
  const first = rows[0];
  expect(first.textContent).toContain(signature);
  expect(first.textContent).toContain(wallets[0].address);
  const link = first.querySelector('a');
  expect(link?.href).toBe('https://solscan.io/tx/' + signature);
  expect(link?.rel).toContain('noreferrer');
  expect(link?.getAttribute('referrerpolicy')).toBe('no-referrer');
  const details = first.querySelector('details');
  expect(details).toBeTruthy();
  await act(async () => details!.querySelector('summary')!.click());
  expect(fetcher).toHaveBeenCalledOnce();
  expect(rows[1].querySelector('a')).toBeNull();
  expect(JSON.stringify(envelope)).toBe(before);
});
