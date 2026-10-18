// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { exchangeFundingReviewFixture } from '@/test/exchange-funding-review-fixture';
import { ExchangeFundingReview } from './exchange-funding-review';
import { FundingPlanner } from './funding-planner';
import { DEFAULT_LAUNCH_PLAN } from '@/lib/launch-plan';
import bs58 from 'bs58';
// These tests exercise funding source selection, not wallet provider execution.
vi.mock('./devnet-funding-execution', () => ({
  DevnetFundingExecution: () => null,
}));
vi.mock('./mainnet-funding-execution', () => ({
  MainnetFundingExecution: () => null,
}));
let fixture: ReturnType<typeof exchangeFundingReviewFixture>,
  root: Root,
  container: HTMLDivElement;
const fetcher = vi.fn<typeof fetch>();
let configured = true,
  wallets: unknown[],
  history: unknown = null;
const postCalls = () =>
  fetcher.mock.calls.filter(([, options]) => options?.method === 'POST');
const button = (text: string) => {
  const found = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent === text,
  );
  if (!found) throw new Error('Missing button: ' + text);
  return found;
};
async function mount(enabled = true) {
  await act(async () =>
    root.render(
      <ExchangeFundingReview
        plan={fixture.plan}
        draft={fixture.plan.document}
        enabled={enabled}
      />,
    ),
  );
}
async function click(text: string) {
  await act(async () => button(text).click());
}
async function change(value: string) {
  const input = container.querySelector('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fixture = exchangeFundingReviewFixture();
  configured = true;
  wallets = [fixture.funder];
  history = null;
  fetcher.mockReset().mockImplementation(async (input, options) => {
    const url = typeof input === 'string' ? input : '';
    if (options?.method === 'POST')
      return Response.json({ quote: fixture.review });
    if (url.endsWith('status=1'))
      return Response.json({ ...fixture.status, quotesConfigured: configured });
    if (url === '/api/wallet-workspace') return Response.json({ wallets });
    if (url.includes('?planId=')) return Response.json({ quote: history });
    throw new Error('Unexpected fixture request');
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('keeps missing provider setup clear when quote history storage is not installed', async () => {
  configured = false;
  const existing = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((input, options) =>
    typeof input === 'string' && input.includes('?planId=')
      ? Promise.resolve(new Response('unavailable', { status: 503 }))
      : existing(input, options),
  );
  await mount();
  expect(container.textContent).toContain('Exchange quotes need server setup');
  expect(container.textContent).toContain(
    'Complete or restore exchange storage setup',
  );
  expect(postCalls()).toHaveLength(0);
});
it('shows the historical quote funder separately from a changed current draft funder', async () => {
  history = fixture.review;
  const changed = bs58.encode(new Uint8Array(32).fill(6));
  fixture.plan.document = { ...fixture.plan.document, funderAddress: changed };
  await mount();
  expect(container.textContent).toContain(
    'Receiving funder saved with this quote',
  );
  expect(container.textContent).toContain(fixture.review.funder);
  expect(container.textContent).toContain(changed);
  expect(postCalls()).toHaveLength(0);
});
it('gives a rate-limit recovery message without retrying a quote', async () => {
  const existing = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((input, options) =>
    options?.method === 'POST'
      ? Promise.resolve(new Response('<html>upstream</html>', { status: 429 }))
      : existing(input, options),
  );
  await mount();
  await click('Get exchange quote');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'Wait 15 seconds',
  );
  expect(postCalls()).toHaveLength(1);
});
it('marks a loaded quote expired using a controlled clock', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  history = fixture.review;
  await mount();
  expect(container.textContent).not.toContain('Saved quote · expired');
  await act(async () => vi.advanceTimersByTime(60001));
  expect(container.textContent).toContain('Saved quote · expired');
  expect(postCalls()).toHaveLength(0);
});
it('loads setup and saved history with no provider mutation or payment action', async () => {
  await mount();
  expect(button('Get exchange quote').disabled).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(postCalls()).toHaveLength(0);
  expect(container.textContent).toContain(
    'Deposit, payout verification and distribution handoff are not connected',
  );
  expect(
    Array.from(container.querySelectorAll('button')).some((b) =>
      /sign|deposit|distribute/i.test(b.textContent ?? ''),
    ),
  ).toBe(false);
});
it('explains missing server setup without inviting a deposit', async () => {
  configured = false;
  await mount();
  expect(container.textContent).toContain('Exchange quotes need server setup');
  expect(button('Get exchange quote').disabled).toBe(true);
  expect(postCalls()).toHaveLength(0);
});
it('explains a missing saved funder and supports reload', async () => {
  wallets = [];
  await mount();
  expect(container.textContent).toContain(
    'Add the receiving funder to Wallets',
  );
  wallets = [fixture.funder];
  await click('Reload funding details');
  expect(button('Get exchange quote').disabled).toBe(false);
});
it('requires a saved active draft and explains unsupported assets without reads', async () => {
  await act(async () =>
    root.render(
      <ExchangeFundingReview
        plan={null}
        draft={fixture.plan.document}
        enabled={false}
      />,
    ),
  );
  expect(container.textContent).toContain('Save this active CEX draft');
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () =>
    root.render(
      <ExchangeFundingReview
        plan={fixture.plan}
        draft={{ ...fixture.plan.document, currency: 'USDC' }}
        enabled
      />,
    ),
  );
  expect(container.textContent).toContain(
    'supports native SOL drafts without proxy routes',
  );
  expect(fetcher).not.toHaveBeenCalled();
});
it('requires enough payout, posts exact selection only after click and separates amounts', async () => {
  await mount();
  await change('0.9');
  expect(container.textContent).toContain('Expected payout must cover');
  expect(button('Get exchange quote').disabled).toBe(true);
  await change('1.1');
  await click('Get exchange quote');
  expect(
    container.querySelector('[aria-label="Saved exchange quote"]'),
  ).not.toBeNull();
  expect(postCalls()).toHaveLength(1);
  const body = postCalls()[0][1]?.body;
  if (typeof body !== 'string') throw new Error('Expected JSON request');
  expect(JSON.parse(body)).toEqual({
    planId: fixture.plan.id,
    revision: 3,
    funderRevision: 2,
    minimumPayoutLamports: '1100000000',
  });
  expect(container.textContent).toContain('1.15 SOL');
  expect(container.textContent).toContain('0.05 SOL');
});
it('loads expired historical evidence without POST', async () => {
  const old = Date.now() - 120000;
  history = {
    ...fixture.review,
    quotedAt: new Date(old).toISOString(),
    expiresAt: new Date(old + 60000).toISOString(),
  };
  await mount();
  expect(container.textContent).toContain('Saved quote · expired');
  expect(container.textContent).toContain('This is historical evidence');
  expect(postCalls()).toHaveLength(0);
});
it('keeps HTML/parser details out of errors and offers reload', async () => {
  fetcher.mockResolvedValue(
    new Response('<html>secret upstream parser text</html>', { status: 502 }),
  );
  await mount();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'Exchange funding details are unavailable',
  );
  expect(container.textContent).not.toContain('secret upstream');
  expect(button('Reload funding details').disabled).toBe(false);
});
it('refuses response authority flags instead of showing a quote', async () => {
  fixture.review = {
    ...fixture.review,
    signingAllowed: true,
  } as unknown as typeof fixture.review;
  await mount();
  await change('1.1');
  await click('Get exchange quote');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'Quote unavailable or changed',
  );
  expect(
    container.querySelector('[aria-label="Saved exchange quote"]'),
  ).toBeNull();
});
it('discards a late quote when the draft becomes dirty', async () => {
  let complete!: (response: Response) => void;
  const defaultFetch = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((input, options) =>
    options?.method === 'POST'
      ? new Promise((resolve) => {
          complete = resolve;
        })
      : defaultFetch(input, options),
  );
  await mount();
  await change('1.1');
  await click('Get exchange quote');
  const signal = postCalls()[0][1]?.signal;
  await mount(false);
  expect(signal?.aborted).toBe(true);
  await act(async () => complete(Response.json({ quote: fixture.review })));
  expect(container.textContent).toContain('Save this active CEX draft');
  expect(
    container.querySelector('[aria-label="Saved exchange quote"]'),
  ).toBeNull();
});
it('wires a saved CEX draft into the real FundingPlanner in place of wallet preparation', async () => {
  const existing = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((input, options) => {
    if (input === '/api/funding' && !options?.method)
      return Promise.resolve(Response.json({ plans: [fixture.plan] }));
    if (
      typeof input === 'string' &&
      (input.startsWith('/api/funding/history') ||
        input.startsWith('/api/funding/mainnet-history') ||
        input.startsWith('/api/funding/events'))
    )
      return Promise.resolve(
        Response.json({
          records: [],
          executions: [],
          events: [],
          nextCursor: null,
        }),
      );
    return existing(input, options);
  });
  await act(async () =>
    root.render(<FundingPlanner plan={DEFAULT_LAUNCH_PLAN} />),
  );
  const open = Array.from(container.querySelectorAll('button')).find(
    (b) =>
      b.querySelector('strong')?.textContent === fixture.plan.document.name,
  );
  expect(open).toBeDefined();
  await act(async () => open!.click());
  expect(
    container.querySelector('[aria-label="Exchange funding review"]'),
  ).not.toBeNull();
  expect(
    container.querySelector('[aria-label="Solana funding preparation"]'),
  ).toBeNull();
  expect(postCalls()).toHaveLength(0);
});
it.each(['Wallet', 'Manual'] as const)(
  'keeps %s drafts on their own funding path',
  async (source) => {
    fixture.plan.document.source = source;
    const existing = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((input, options) =>
      input === '/api/funding' && !options?.method
        ? Promise.resolve(Response.json({ plans: [fixture.plan] }))
        : existing(input, options),
    );
    await act(async () =>
      root.render(<FundingPlanner plan={DEFAULT_LAUNCH_PLAN} />),
    );
    const open = Array.from(container.querySelectorAll('button')).find(
      (b) =>
        b.querySelector('strong')?.textContent === fixture.plan.document.name,
    );
    await act(async () => open!.click());
    expect(
      Boolean(
        container.querySelector('[aria-label="Solana funding preparation"]'),
      ),
    ).toBe(source === 'Wallet');
    expect(
      container.querySelector('[aria-label="Exchange funding review"]'),
    ).toBeNull();
    if (source === 'Manual')
      expect(container.textContent).toContain(
        'Manual drafts record allocations',
      );
    expect(postCalls()).toHaveLength(0);
  },
);
