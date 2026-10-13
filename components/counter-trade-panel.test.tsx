// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { CounterTradePanel } from './counter-trade-panel';
import { initialCounterLedger, type CounterRules } from '@/lib/counter-trade';
import type { CounterPlan } from '@/lib/counter-trade-store';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import {
  acquisitionId as id,
  acquisitionMint as mint,
  acquisitionWallet as wallet,
} from '../test/imported-sell-acquisition-fixture';
const project = {
  id: id(1),
  revision: 1,
  archived: false,
  document: {
    format: 'imported-token-project-v1',
    executionAllowed: false,
    token: {
      chain: 'Solana',
      address: mint,
      decimals: 6,
      symbol: 'TEST',
      name: 'Test',
      totalSupplyRaw: '1000000',
      source: 'fixture.test',
      observedAt: '2026-10-13T12:00:00.000Z',
    },
  },
} as ImportedTokenProject;
const rules: CounterRules = {
  format: 'counter-evaluator-v1',
  responseSide: 'Sell',
  replicationPercent: '20',
  trigger: { kind: 'rate', percent: '100' },
  minimumResponseTokenRaw: '500',
  ignoredWallets: [],
};
function plan(state: CounterPlan['state'] = 'active'): CounterPlan {
  return {
    format: 'counter-plan-v1',
    executionAllowed: false,
    id: id(2),
    projectId: project.id,
    revision: 1,
    state,
    projectDocument: JSON.stringify(project.document),
    rules,
    ledger: initialCounterLedger(rules, {
      projectId: project.id,
      revision: 1,
      mint,
      decimals: 6,
    }),
    createdAt: '2026-10-13T12:00:00.000Z',
    updatedAt: '2026-10-13T12:00:00.000Z',
  };
}
type RequestCall = {
  url: string;
  payload: Record<string, unknown> | null;
  signal: AbortSignal;
  resolve: (r: Response) => void;
  reject: (e: Error) => void;
};
let root: Root,
  container: HTMLDivElement,
  calls: RequestCall[],
  pending: RequestCall[];
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  calls = [];
  pending = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string, options: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          if (options.body !== undefined && typeof options.body !== 'string')
            throw new Error('Expected JSON request text.');
          const call = {
            url: String(url),
            payload: options.body
              ? (JSON.parse(options.body) as Record<string, unknown>)
              : null,
            signal: options.signal as AbortSignal,
            resolve,
            reject,
          };
          calls.push(call);
          pending.push(call);
        }),
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(p = project, locked = false) {
  await act(async () =>
    root.render(<CounterTradePanel project={p} locked={locked} />),
  );
}
async function resolve(data: unknown, status = 200) {
  const call = pending.shift()!;
  await act(async () => call.resolve(Response.json(data, { status })));
  return call;
}
async function saved(p = plan()) {
  await render();
  await resolve({ projectId: project.id, plans: [p], executionAllowed: false });
}
function button(text: string) {
  const result = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === text,
  );
  if (!result) throw Error('Missing ' + text);
  return result;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
function field(label: string) {
  const found = [...container.querySelectorAll('label')].find((l) =>
    l.textContent?.startsWith(label),
  );
  if (!found) throw Error('Missing ' + label);
  return document.getElementById(found.htmlFor) as
    | HTMLInputElement
    | HTMLSelectElement;
}
async function select(label: string, value: string) {
  await act(async () => {
    const input = field(label);
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
it('recovers saved rules and persists resume/end controls with their current revision', async () => {
  await saved(plan('paused'));
  expect(container.textContent).toContain('State: paused');
  await click('Resume Counter');
  expect(calls.at(-1)!.payload).toMatchObject({
    action: 'control',
    id: id(2),
    revision: 1,
    state: 'active',
  });
  await resolve({ plan: { ...plan(), revision: 2 }, executionAllowed: false });
  await click('End Counter');
  expect(calls.at(-1)!.payload).toMatchObject({
    action: 'control',
    revision: 2,
    state: 'ended',
  });
  await resolve({
    plan: { ...plan('ended'), revision: 3 },
    executionAllowed: false,
  });
  expect(button('Resume Counter').disabled).toBe(true);
  expect(button('Evaluate selected trade').disabled).toBe(true);
});
it('retries a lost create response with the same id and sends exact token units', async () => {
  await render();
  await resolve({ projectId: project.id, plans: [], executionAllowed: false });
  await click('Save Counter rules');
  const first = pending.shift()!;
  await act(async () => first.reject(new Error('Network lost')));
  await click('Save Counter rules');
  const second = pending[0];
  expect(second.payload?.id).toBe(first.payload?.id);
  expect(second.payload?.rules).toMatchObject({
    minimumResponseTokenRaw: '1000000',
    replicationPercent: '100',
  });
  const r = second.payload!.rules as CounterRules;
  const p = {
    ...plan(),
    id: String(second.payload!.id),
    rules: r,
    ledger: initialCounterLedger(r, plan().ledger.scope),
  };
  await resolve({ plan: p, executionAllowed: false });
  expect(container.textContent).toContain('Counter history saved');
});
it('cancels and disregards prior-context reads when project identity changes', async () => {
  await render();
  const old = pending.shift()!;
  await render({ ...project, id: id(9) });
  expect(old.signal.aborted).toBe(true);
  await act(async () =>
    old.resolve(
      Response.json({
        projectId: project.id,
        plans: [plan()],
        executionAllowed: false,
      }),
    ),
  );
  await resolve({ projectId: id(9), plans: [], executionAllowed: false });
  expect(container.textContent).not.toContain('State: active');
  expect(calls).toHaveLength(2);
});
it('keeps archival history controls while blocking new evaluation and resumes', async () => {
  await render({ ...project, archived: true });
  await resolve({
    projectId: project.id,
    plans: [plan()],
    executionAllowed: false,
  });
  expect(container.querySelector('fieldset')!.disabled).toBe(true);
  expect(button('Load saved trades').disabled).toBe(true);
  expect(button('Pause Counter').disabled).toBe(false);
  await click('Pause Counter');
  expect(calls.at(-1)!.payload).toMatchObject({ state: 'paused' });
  await resolve({
    plan: { ...plan('paused'), revision: 2 },
    executionAllowed: false,
  });
  expect(button('Resume Counter').disabled).toBe(true);
});
it('selects a saved trade reference and sends no client classification or transaction', async () => {
  await saved();
  await click('Load saved trades');
  await resolve({
    id: project.id,
    revision: 1,
    executionAllowed: false,
    observations: [
      {
        chain: 'Solana',
        address: mint,
        projectRevision: 1,
        executionAllowed: false,
        pool: wallet,
        observedAt: '2026-10-13T12:01:00.000Z',
        trades: [
          {
            id: 't1',
            side: 'Buy',
            sender: wallet,
            transaction: 'public-signature',
          },
        ],
      },
    ],
  });
  await select('Trade to evaluate', '0');
  await click('Evaluate selected trade');
  expect(calls.at(-1)!.payload).toEqual({
    action: 'evaluate',
    id: id(2),
    projectId: project.id,
    revision: 1,
    selection: {
      id: project.id,
      revision: 1,
      pool: wallet,
      tradeId: 't1',
      tapeObservedAt: '2026-10-13T12:01:00.000Z',
    },
  });
  await resolve({
    plan: { ...plan(), revision: 2 },
    executionAllowed: false,
    replayed: true,
  });
  expect(container.textContent).toContain('original recorded decision');
});
it('rejects a substituted plan response and clears history on sign-in lock changes', async () => {
  await saved();
  await click('Pause Counter');
  await resolve({
    plan: { ...plan('paused'), id: id(3), revision: 2 },
    executionAllowed: false,
  });
  expect(container.querySelector('[role=alert]')?.textContent).toContain(
    'Counter project differs',
  );
  await render(project, true);
  expect(container.textContent).not.toContain('State: active');
  await resolve({ error: 'Sign in' }, 401);
  expect(container.querySelector('fieldset')!.disabled).toBe(true);
});
it('shows a recovery message for an HTML Counter error without exposing parser text', async () => {
  await render();
  const call = pending.shift()!;
  await act(async () =>
    call.resolve(
      new Response('<html>PRIVATE-UPSTREAM-DIAGNOSTIC</html>', {
        status: 503,
        headers: { 'content-type': 'text/html' },
      }),
    ),
  );
  expect(container.querySelector('[role=alert]')?.textContent).toBe(
    'Counter request unavailable. Reload saved history before retrying.',
  );
  expect(container.textContent).not.toMatch(
    /Unexpected token|PRIVATE-UPSTREAM|SyntaxError/,
  );
});
