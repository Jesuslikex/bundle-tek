// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LaunchSnipePanel, scaledInteger } from './launch-snipe-panel';
import { DEFAULT_LAUNCH_PLAN } from '@/lib/launch-plan';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const manual = {
  ...DEFAULT_LAUNCH_PLAN,
  mode: 'Manual' as const,
  developerBuy: 0,
  holdersBuy: 0,
  holdersBuyQuote: '0.3',
  holderCount: 3,
};
const launchId = '11111111-1111-4111-8111-111111111111';

it('converts decimal inputs exactly', () => {
  expect(scaledInteger('0.8', 1000, 'x')).toBe(800);
  expect(scaledInteger('5', 100, 'x')).toBe(500);
  expect(scaledInteger('0.004', 1_000_000_000, 'x')).toBe(4_000_000);
  expect(() => scaledInteger('0.0001', 1000, 'x')).toThrow();
  expect(() => scaledInteger('-1', 1000, 'x')).toThrow();
});

it('renders nothing for plans that buy at launch', async () => {
  vi.stubGlobal('fetch', vi.fn());
  await act(async () =>
    root.render(
      <LaunchSnipePanel projectId="p1" plan={{ ...manual, mode: 'Quick' }} />,
    ),
  );
  expect(host.textContent).toBe('');
  expect(fetch).not.toHaveBeenCalled();
});

it('sends only pacing terms on Snipe; wallets and amounts stay server-side', async () => {
  const calls: { url: string; body?: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body as string | undefined });
      if (!init)
        return Response.json({
          launches: [{ state: 'finalized', review: { id: launchId } }],
        });
      return Response.json({ id: 'seq' });
    }),
  );
  const onStarted = vi.fn();
  await act(async () =>
    root.render(
      <LaunchSnipePanel projectId="p1" plan={manual} onStarted={onStarted} />,
    ),
  );
  expect(host.textContent).toContain('0.3 SOL across 3 holder wallets');
  const button = [...host.querySelectorAll('button')].find(
    (b) => b.textContent === 'Snipe',
  )!;
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  const post = calls.find((c) => c.body)!;
  expect(post.url).toBe('/api/launch/pump/organic');
  expect(JSON.parse(post.body!)).toEqual({
    action: 'snipe',
    terms: {
      launchReviewId: launchId,
      mode: 'Stagger',
      delayMinMs: 800,
      delayMaxMs: 800,
      slippageBps: 500,
      rentAllowanceRaw: '4000000',
    },
  });
  expect(onStarted).toHaveBeenCalledOnce();
  expect(host.textContent).toContain('Nothing has been signed or sent yet');
});

it('keeps Snipe disabled until the token is deployed', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ launches: [] })),
  );
  await act(async () =>
    root.render(<LaunchSnipePanel projectId="p1" plan={manual} />),
  );
  const button = [...host.querySelectorAll('button')].find(
    (b) => b.textContent === 'Snipe',
  )!;
  expect(button.disabled).toBe(true);
  expect(host.textContent).toContain('Deploy the token first');
});
