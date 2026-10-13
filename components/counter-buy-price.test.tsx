// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { CounterBuyPrice } from './counter-buy-price';
import { counterBuyFixture } from '../test/counter-buy-fixture';
import type { CounterPlan } from '@/lib/counter-trade-store';
import type { CounterBuyTargetQuote } from '@/lib/counter-buy-quote';
let root: Root, container: HTMLDivElement, plan: CounterPlan, identity: string;
let requests: {
  body: Record<string, unknown>;
  signal: AbortSignal;
  resolve: (r: Response) => void;
}[];
function preview(): CounterBuyTargetQuote {
  return {
    format: 'counter-buy-target-quote-v1',
    executionAllowed: false,
    projectId: plan.projectId,
    projectRevision: 1,
    planId: plan.id,
    planRevision: plan.revision,
    decisionIdentity: identity,
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: plan.ledger.scope.mint,
    outputTargetRaw: plan.ledger.decisions[0].proposalTokenRaw!,
    requiredSolInputRaw: '1000',
    maximumSolInputRaw: '1005',
    reviewedSolBudgetRaw: '1005',
    swapMode: 'ExactOut',
    slippageBps: 50,
    contextSlot: 100,
    routes: [],
    source: 'api.jup.ag',
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30000).toISOString(),
    limitations: 'Fixture',
  };
}
beforeEach(() => {
  const f = counterBuyFixture();
  plan = f.plan;
  identity = f.identity;
  requests = [];
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve) =>
          requests.push({
            body: JSON.parse(init.body as string) as Record<string, unknown>,
            signal: init.signal as AbortSignal,
            resolve,
          }),
        ),
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render(value = plan, locked = false) {
  await act(async () =>
    root.render(<CounterBuyPrice plan={value} locked={locked} />),
  );
}
async function configure() {
  await render();
  await act(async () => {
    const select = container.querySelector('select')!;
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      'value',
    )!.set!.call(select, identity);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const input = container.querySelector('input')!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, '0.000001005');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function price() {
  await act(async () => container.querySelector('button')!.click());
}
async function respond(quote = preview()) {
  await act(async () =>
    requests.at(-1)!.resolve(Response.json({ quote, executionAllowed: false })),
  );
}
it('sends only the selected persisted proposal and human swap-input limit on explicit request', async () => {
  await configure();
  expect(fetch).not.toHaveBeenCalled();
  await price();
  expect(requests[0].body).toEqual({
    projectId: plan.projectId,
    projectRevision: 1,
    planId: plan.id,
    planRevision: plan.revision,
    decisionIdentity: identity,
    maximumSolAmount: '0.000001005',
  });
  await respond();
  expect(container.textContent).toContain('0.000001005 SOL');
  expect(container.textContent).toContain('Preview only');
});
it.each(['plan', 'target', 'budget', 'ceiling', 'expiry'])(
  'rejects a substituted %s preview',
  async (kind) => {
    await configure();
    await price();
    const q = preview();
    if (kind === 'plan') q.planId = '00000000-0000-4000-8000-000000000009';
    if (kind === 'target') q.outputTargetRaw = '999';
    if (kind === 'budget') q.reviewedSolBudgetRaw = '1006';
    if (kind === 'ceiling') q.maximumSolInputRaw = '1006';
    if (kind === 'expiry') q.expiresAt = '2000-01-01T00:00:00.000Z';
    await respond(q);
    expect(container.querySelector('[role=alert]')).not.toBeNull();
    expect(container.textContent).not.toContain('Estimated swap input:');
  },
);
it('clears a preview after input changes and marks it expired on the clock', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  await configure();
  await price();
  await respond();
  await act(async () => vi.advanceTimersByTime(31000));
  expect(container.textContent).toContain('Price preview expired');
  expect(container.textContent).not.toContain('Estimated swap input:');
});
it('aborts pending pricing and ignores its response when the plan changes', async () => {
  await configure();
  await price();
  const pending = requests[0],
    q = preview();
  await render({ ...plan, revision: plan.revision + 1 });
  expect(pending.signal.aborted).toBe(true);
  await act(async () =>
    pending.resolve(Response.json({ quote: q, executionAllowed: false })),
  );
  expect(container.textContent).not.toContain('Estimated swap input:');
});
it('gates paused plans and sign-in locks', async () => {
  await render({ ...plan, state: 'paused' });
  expect(container.querySelector('button')!.disabled).toBe(true);
  await render(plan, true);
  expect(container.querySelector('input')!.disabled).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});
it('uses a product error for non-JSON responses and suppresses duplicate pending requests', async () => {
  await configure();
  await price();
  await price();
  expect(requests).toHaveLength(1);
  await act(async () =>
    requests[0].resolve(
      new Response('<html>PRIVATE-UPSTREAM</html>', { status: 503 }),
    ),
  );
  expect(container.querySelector('[role=alert]')?.textContent).toContain(
    'Counter pricing unavailable',
  );
  expect(container.textContent).not.toMatch(
    /PRIVATE-UPSTREAM|Unexpected token/,
  );
});
it('discards the old preview when the user changes the reviewed input limit', async () => {
  await configure();
  await price();
  await respond();
  expect(container.textContent).toContain('Estimated swap input:');
  await act(async () => {
    const input = container.querySelector('input')!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, '0.001');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(container.textContent).not.toContain('Estimated swap input:');
  expect(requests).toHaveLength(1);
});
