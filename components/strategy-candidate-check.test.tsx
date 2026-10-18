// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StrategyCandidateCheckPanel } from './strategy-candidate-check';
import { buildStrategyCandidateCheck } from '@/lib/strategy-candidate-check';
import {
  strategyCheckFixture,
  checkHoldId,
} from '../test/strategy-check-fixture';
import { strategyWallet } from '../test/strategy-session-fixture';
let host: HTMLDivElement,
  root: Root,
  fixture: Awaited<ReturnType<typeof strategyCheckFixture>>,
  responder: (() => Promise<Response>) | null;
const at = '2026-10-18T12:00:00.000Z';
const response = () =>
  buildStrategyCandidateCheck(
    fixture.draft,
    fixture.capacity,
    checkHoldId,
    at,
    {
      source: 'api.dexscreener.com',
      chain: 'Solana',
      address: fixture.draft.plan.token.address,
      observedAt: at,
      returnedPairCount: 1,
      quoteOnlyPairCount: 0,
      pairs: [
        {
          address: strategyWallet,
          dex: 'pump',
          quoteSymbol: 'SOL',
          marketCapUsd: '100000',
        },
      ],
    },
  );
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(
    async (_algorithm, data) =>
      Uint8Array.from(
        createHash('sha256')
          .update(new Uint8Array(data as ArrayBuffer))
          .digest(),
      ).buffer,
  );
  fixture = await strategyCheckFixture();
  responder = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => (responder ? responder() : Response.json(response()))),
  );
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
const mount = (blocked = false) =>
  act(async () =>
    root.render(
      <StrategyCandidateCheckPanel
        draft={fixture.draft}
        capacity={fixture.capacity}
        holdId={checkHoldId}
        blocked={blocked}
      />,
    ),
  );
const button = (label: string) =>
  [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label,
  )!;
const click = (label: string) => act(async () => button(label).click());
const selectPool = () =>
  act(async () => {
    const select = host.getElementsByTagName('select').item(0)!;
    select.value = strategyWallet;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
it('checks only after an explicit action and requires an explicit pool choice', async () => {
  await mount();
  expect(fetch).not.toHaveBeenCalled();
  await click('Check current conditions');
  expect(host.textContent).toContain('No pool is selected automatically');
  expect(host.textContent).not.toContain('currently met');
  await selectPool();
  expect(host.textContent).toContain('currently met');
  expect(host.textContent).toContain('does not approve a trade');
  expect(host.querySelector('details')?.open).toBe(false);
});
it('expires with monotonic time even when the client wall clock is behind the server', async () => {
  vi.useFakeTimers({
    toFake: [
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
      'performance',
      'Date',
    ],
  });
  vi.setSystemTime('2000-01-01T00:00:00.000Z');
  await mount();
  await click('Check current conditions');
  await selectPool();
  expect(host.textContent).toContain('currently met');
  await act(async () => vi.advanceTimersByTimeAsync(30000));
  expect(host.textContent).toContain('check expired');
  expect(host.textContent).not.toContain('currently met');
});
it('charges request latency against the freshness window instead of extending it', async () => {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'performance',
    ],
  });
  let finish!: (response: Response) => void;
  responder = () => new Promise<Response>((r) => (finish = r));
  await mount();
  await click('Check current conditions');
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  await act(async () => finish(Response.json(response())));
  await selectPool();
  await act(async () => vi.advanceTimersByTimeAsync(20000));
  expect(host.textContent).toContain('check expired');
});
it('cancels manual checks and ignores late successful provider results', async () => {
  let finish!: (response: Response) => void;
  responder = () => new Promise<Response>((r) => (finish = r));
  await mount();
  await click('Check current conditions');
  await click('Cancel condition check');
  expect(host.textContent).toContain('No review slots changed');
  await act(async () => finish(Response.json(response())));
  expect(host.querySelector('select')).toBeNull();
});
it('invalidates a current match on offline/hidden events without fetching again', async () => {
  await mount();
  await click('Check current conditions');
  await selectPool();
  await act(async () => window.dispatchEvent(new Event('offline')));
  expect(host.textContent).not.toContain('currently met');
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('does not allow checks in a blocked context', async () => {
  await mount(true);
  expect(button('Check current conditions').disabled).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});
it('clears a current result immediately when the parent context becomes blocked', async () => {
  await mount();
  await click('Check current conditions');
  await selectPool();
  await mount(true);
  expect(host.textContent).not.toContain('currently met');
  expect(host.querySelector('select')).toBeNull();
});
it('rejects a nominally successful response with altered pool outcomes or authority', async () => {
  responder = async () => {
    const data = response();
    data.pools[0].condition = 'not-met';
    return Response.json(data);
  };
  await mount();
  await click('Check current conditions');
  expect(host.querySelector('[role=alert]')).toBeTruthy();
  expect(host.querySelector('select')).toBeNull();
});
