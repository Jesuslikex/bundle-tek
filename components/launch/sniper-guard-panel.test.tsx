// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import {
  SniperGuardPanel,
  sniperGuardSettingsFromDraft,
} from './sniper-guard-panel';
import { PUMP_NATIVE_QUOTE } from '@/lib/pump-launch-config';
import type { SniperGuardView } from '@/lib/sniper-guard-service';

const key = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const REVIEW = '6f1c2e8a-1d2b-4c3d-9e4f-5a6b7c8d9e0f';
const launch = {
  mint: key(50),
  bondingCurve: key(40),
  quoteMint: PUMP_NATIVE_QUOTE,
  quoteDecimals: 9,
  quoteTokenProgram: null,
  developer: key(1),
  holders: [key(2)],
};
const settings = {
  format: 'sniper-guard-settings-v1' as const,
  thresholdRaw: '5000000000',
  response: { kind: 'nuke' as const, scope: 'holders' as const },
  end: { kind: 'timed' as const, seconds: 300 },
  whitelist: [],
};
const guard = (patch: Partial<SniperGuardView> = {}): SniperGuardView => ({
  id: 'g',
  reviewId: REVIEW,
  projectId: 'p',
  revision: 1,
  state: 'planned',
  settings,
  launch: null,
  observation: null,
  armedAt: null,
  finishedAt: null,
  updatedAt: 'now',
  automaticExecution: false,
  signingAllowed: false,
  ...patch,
});
const evaluation = (triggered: boolean) => ({
  externalTotalRaw: triggered ? '6000000000' : '1000000000',
  thresholdRaw: '5000000000',
  counted: [],
  countedOverflow: 0,
  excludedCount: 2,
  triggered,
  triggeringSignature: null,
  ended: false,
  endReason: null,
  actions: triggered
    ? { sellWallets: [key(2)], keepWallets: [key(1)], stopRemainingBuys: true }
    : null,
});
const observation = (triggered: boolean) => ({
  cursor: null,
  coverage: 'complete' as const,
  pendingTransactions: false,
  observedAt: 'now',
  launchState: 'signed',
  evaluation: evaluation(triggered),
  endReason: null,
  stoppedSequences: [] as string[],
  balances: triggered
    ? [{ wallet: key(2), tokenAccount: key(3), amountRaw: '1500000' }]
    : null,
});

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement, fetcher: ReturnType<typeof vi.fn>;
let initial: SniperGuardView | null = null;
const posts: Record<string, unknown>[] = [];
let respond: (body: Record<string, unknown>) => unknown = () => ({});
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  posts.length = 0;
  fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (!init?.method)
      return Response.json({ guard: initial, launch, launchState: 'signed' });
    const body = JSON.parse(init.body as string);
    posts.push(body);
    return Response.json(respond(body));
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  initial = null;
});
const flush = async () => {
  for (let i = 0; i < 5; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
};
const button = (text: string) =>
  [...container.querySelectorAll('button')].find(
    (b) => b.textContent === text,
  )!;

it('converts the form into exact settings', () => {
  expect(
    sniperGuardSettingsFromDraft(
      {
        threshold: '2.5',
        response: 'nuke',
        scope: 'dev',
        completeEarly: false,
        end: 'timed',
        seconds: '1',
        whitelist: `${key(9)}\n\n${key(10)}`,
      },
      9,
    ),
  ).toEqual({
    format: 'sniper-guard-settings-v1',
    thresholdRaw: '2500000000',
    response: { kind: 'nuke', scope: 'dev', completeEarly: false },
    end: { kind: 'timed', seconds: 1 },
    whitelist: [key(9), key(10)],
  });
  expect(() =>
    sniperGuardSettingsFromDraft(
      {
        threshold: '1',
        response: 'complete-early',
        scope: 'all',
        completeEarly: true,
        end: 'timed',
        seconds: '0',
        whitelist: '',
      },
      9,
    ),
  ).toThrow('at least 1');
});

it('saves settings from the form and then offers to start watching', async () => {
  respond = (body) => guard({ settings: body.settings as typeof settings });
  await act(async () => root.render(<SniperGuardPanel reviewId={REVIEW} />));
  await flush();
  expect(container.textContent).toContain('Limit for outside buys (SOL)');
  expect(container.textContent).toContain('Bundle never sells for you');
  const input = container.querySelector(
    'input[inputmode="decimal"]',
  ) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, '5');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Save Sniper Guard').click());
  await flush();
  expect(posts[0]).toMatchObject({
    action: 'save',
    reviewId: REVIEW,
    revision: null,
    settings: {
      thresholdRaw: '5000000000',
      response: { kind: 'nuke', scope: 'holders' },
    },
  });
  expect(button('Start watching')).toBeTruthy();
});

it('polls while watching and shows the Nuke list when triggered, without signing anything', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  initial = guard({
    state: 'watching',
    revision: 2,
    launch,
    observation: observation(false),
  });
  respond = () =>
    guard({
      state: 'triggered',
      revision: 3,
      launch,
      observation: observation(true),
      finishedAt: 'now',
    });
  await act(async () => root.render(<SniperGuardPanel reviewId={REVIEW} />));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(container.textContent).toContain('Outside buys: 1 of 5 SOL limit');
  expect(posts).toHaveLength(0);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(posts).toEqual([{ action: 'observe', revision: 2, reviewId: REVIEW }]);
  const alert = [...container.querySelectorAll('[role="alert"]')]
    .map((n) => n.textContent)
    .join(' ');
  expect(alert).toContain('Nothing has been sold');
  expect(alert).toContain("don't sign any remaining holder buys");
  expect(alert).toContain(key(2));
  expect(alert).toContain('1.5 tokens');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(posts).toHaveLength(1);
});
