// @vitest-environment jsdom
import bs58 from 'bs58';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VENUE_SNIPER_POLL_MS, VenueLaunchLive } from './venue-launch-live';
import { venueSniperStorageKey } from '@/lib/venue-sniper-guard';

const key = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const sig = (n: number) =>
  bs58.encode(Uint8Array.from({ length: 64 }, (_, i) => (i ? n : 1)));
const id = crypto.randomUUID();
const launch = {
  venue: 'launchlab',
  id,
  state: 'finalized',
  mint: key(50),
  pool: key(40),
  quoteVault: key(43),
  quoteMint: 'So11111111111111111111111111111111111111112',
  quoteSymbol: 'SOL',
  quoteDecimals: 9,
  developer: key(7),
  developerRevision: 2,
  cleanupDestination: key(8),
  signature: sig(4),
};
const buy = (n: number, raw: string) => ({
  signature: sig(n),
  slot: 100 + n,
  blockTime: null,
  signers: [key(9)],
  quoteInRaw: raw,
});

let container: HTMLDivElement, root: Root;
const fetcher = vi.fn();
let polls: unknown[][];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  localStorage.clear();
  polls = [];
  fetcher
    .mockReset()
    .mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/venue-sniper-guard?'))
        return Response.json({ launch });
      if (url === '/api/venue-sniper-guard') {
        const body = JSON.parse(init?.body as string);
        const buys = (polls.shift() ?? []) as ReturnType<typeof buy>[];
        expect(body).toMatchObject({
          action: 'observe',
          venue: 'launchlab',
          id,
        });
        return Response.json({
          buys,
          excludedCount: 0,
          cursor: buys.at(-1)?.signature ?? body.cursor,
          complete: true,
          pending: false,
        });
      }
      if (url === '/api/wallet-workspace/cleanup')
        throw new Error('Nuke must wait for the user.');
      throw new Error('unexpected ' + url);
    });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => {});
};
const button = (text: string) =>
  [...container.querySelectorAll('button')].find(
    (b) => b.textContent === text,
  )!;
const input = (labelText: string) => {
  const label = [...container.querySelectorAll('label')].find((l) =>
    l.textContent?.startsWith(labelText),
  )!;
  return label.querySelector('input,textarea') as HTMLInputElement;
};
function type(el: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('links the live coin and its chart', async () => {
  act(() => root.render(<VenueLaunchLive venue="launchlab" id={id} />));
  await flush();
  expect(container.textContent).toContain('Your coin is live');
  const links = [...container.querySelectorAll('a')].map((a) => a.href);
  expect(links).toContain(`https://dexscreener.com/solana/${launch.mint}`);
  expect(links).toContain(`https://solscan.io/tx/${launch.signature}`);
  expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(
    true,
  );
});

it('watches outside buys, triggers past the threshold and resumes after a reload', async () => {
  act(() => root.render(<VenueLaunchLive venue="launchlab" id={id} />));
  await flush();
  type(input('Trigger when outside buys exceed'), '1');
  polls.push([buy(1, '600000000')]);
  act(() => button('Start Sniper Guard').click());
  await flush();
  expect(container.textContent).toContain('Outside buys 0.6 of 1 SOL');
  const saved = JSON.parse(
    localStorage.getItem(venueSniperStorageKey('launchlab', id))!,
  );
  expect(saved).toMatchObject({ status: 'watching', cursor: sig(1) });

  // Reload: the guard resumes from its saved cursor.
  act(() => root.unmount());
  root = createRoot(container);
  polls.push([buy(2, '400000001')]);
  act(() => root.render(<VenueLaunchLive venue="launchlab" id={id} />));
  await flush();
  const observes = fetcher.mock.calls.filter(
    ([url]) => url === '/api/venue-sniper-guard',
  );
  expect(JSON.parse(String(observes.at(-1)![1].body)).cursor).toBe(sig(1));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'Sniper Guard triggered',
  );
  expect(container.textContent).toContain('Prepare developer sell');
  // Triggering never prepares or sends a sell by itself.
  expect(
    fetcher.mock.calls.some(([url]) => url === '/api/wallet-workspace/cleanup'),
  ).toBe(false);
  const count = fetcher.mock.calls.length;
  await act(async () => {
    vi.advanceTimersByTime(VENUE_SNIPER_POLL_MS * 3);
  });
  expect(fetcher.mock.calls.length).toBe(count);
});

it('ends at the watch window and can be stopped', async () => {
  act(() => root.render(<VenueLaunchLive venue="launchlab" id={id} />));
  await flush();
  type(input('Trigger when outside buys exceed'), '5');
  type(input('Watch for'), '5');
  act(() => button('Start Sniper Guard').click());
  await flush();
  await act(async () => {
    vi.advanceTimersByTime(6000);
  });
  await flush();
  expect(container.textContent).toContain('watch window ended');
  act(() => button('Set up a new guard').click());
  type(input('Trigger when outside buys exceed'), '5');
  act(() => button('Start Sniper Guard').click());
  await flush();
  act(() => button('Stop Sniper Guard').click());
  expect(container.textContent).toContain('You stopped Sniper Guard');
});

it('rejects a threshold with too many decimals', async () => {
  act(() => root.render(<VenueLaunchLive venue="launchlab" id={id} />));
  await flush();
  type(input('Trigger when outside buys exceed'), '0.0000000001');
  act(() => button('Start Sniper Guard').click());
  expect(container.querySelector('[role="alert"]')?.textContent).toMatch(
    /decimal places/,
  );
  expect(
    localStorage.getItem(venueSniperStorageKey('launchlab', id)),
  ).toBeNull();
});
