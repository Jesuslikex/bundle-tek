// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { ImportedTradeSessions } from './imported-trade-sessions';
import { initialCounterLedger, type CounterRules } from '@/lib/counter-trade';
import type { CounterPlan } from '@/lib/counter-trade-store';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import {
  acquisitionId as id,
  acquisitionMint as mint,
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
      symbol: 'QA',
      name: 'QA token',
      totalSupplyRaw: '1000000',
      observedAt: '2026-10-14T00:00:00.000Z',
      source: 'fixture.test',
    },
  },
} as ImportedTokenProject;
let root: Root,
  container: HTMLDivElement,
  plans: CounterPlan[],
  calls: { url: string; body: Record<string, unknown> | null }[];
beforeEach(() => {
  plans = [];
  calls = [];
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit = {}) => {
      const body = options.body
        ? (JSON.parse(options.body as string) as Record<string, unknown>)
        : null;
      calls.push({ url: String(url), body });
      if (String(url).startsWith('/api/imported-projects/counter-trades')) {
        if (!body)
          return Response.json({
            projectId: project.id,
            plans,
            executionAllowed: false,
          });
        if (body.action === 'create') {
          const rules = body.rules as CounterRules,
            now = new Date().toISOString();
          const plan: CounterPlan = {
            format: 'counter-plan-v1',
            executionAllowed: false,
            id: String(body.id),
            projectId: project.id,
            revision: 1,
            state: 'active',
            projectDocument: JSON.stringify(project.document),
            rules,
            ledger: initialCounterLedger(rules, {
              projectId: project.id,
              revision: 1,
              mint,
              decimals: 6,
            }),
            createdAt: now,
            updatedAt: now,
          };
          plans.push(plan);
          return Response.json({ plan, executionAllowed: false });
        }
      }
      return Response.json(
        { error: 'Unconfigured fixture service.' },
        { status: 503 },
      );
    }),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(locked = false) {
  await act(async () =>
    root.render(
      <ImportedTradeSessions
        project={project}
        wallets={[]}
        folders={[]}
        locked={locked}
      />,
    ),
  );
  const open = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Open Counter Trading',
  )!;
  await act(async () => open.click());
}
it('mounts the actual Counter component beside DCA and uses its API on explicit save', async () => {
  await render();
  expect(
    container.querySelector('[aria-label="Counter Trading"]'),
  ).not.toBeNull();
  expect(calls.filter((c) => c.url.includes('counter-trades'))).toHaveLength(1);
  expect(calls.some((c) => c.body !== null)).toBe(false);
  const button = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Save Counter rules',
  )!;
  await act(async () => button.click());
  expect(plans).toHaveLength(1);
  expect(container.textContent).toContain('Counter history saved');
  expect(calls.filter((c) => c.body?.action === 'create')).toHaveLength(1);
  expect(calls.some((c) => /prepare|signing|counter-quotes/.test(c.url))).toBe(
    false,
  );
});
it('passes the workspace lock through to Counter rule creation', async () => {
  await render(true);
  const section = container.querySelector('[aria-label="Counter Trading"]')!;
  expect(section.querySelector('fieldset')!.disabled).toBe(true);
  const button = [...section.querySelectorAll('button')].find(
    (b) => b.textContent === 'Save Counter rules',
  )!;
  await act(async () => button.click());
  expect(plans).toHaveLength(0);
  expect(calls.some((c) => c.body !== null)).toBe(false);
});
