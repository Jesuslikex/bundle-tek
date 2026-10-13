// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountCostsPanel } from './account-costs';
import { AccountPerformancePanel } from './account-performance';
import { accountPerformanceFromScopes } from '@/lib/account-performance';

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function loadPanel(panel: React.ReactElement, response: Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response),
  );
  await act(async () => root.render(panel));
  const button = container.querySelector('button')!;
  await act(async () => {
    button.click();
    await new Promise((r) => setTimeout(r, 10));
  });
}
const alertText = () =>
  container.querySelector('[role="alert"]')?.textContent ?? '';

it('asks signed-out users to sign in for account costs', async () => {
  await loadPanel(
    <AccountCostsPanel />,
    Response.json({ error: 'Sign in.' }, { status: 401 }),
  );
  expect(alertText()).toBe('Sign in to view account transaction costs.');
});

it('hides parser text when account costs receive an HTML error page', async () => {
  await loadPanel(
    <AccountCostsPanel />,
    new Response('<html>Bad gateway</html>', { status: 502 }),
  );
  expect(alertText()).toBe(
    'Account costs unavailable. No partial totals are shown.',
  );
});

it('shows one empty state instead of an empty chart when no trades exist', async () => {
  const observedAt = '2026-10-13T12:00:00.000Z';
  await loadPanel(
    <AccountPerformancePanel />,
    Response.json({
      summary: accountPerformanceFromScopes([], observedAt),
      timeline: { observedAt, sales: [], unlinkedSaleCount: 0 },
    }),
  );
  expect(alertText()).toBe('');
  expect(container.querySelector('.performance-empty')?.textContent).toContain(
    'No finalized trades are recorded yet.',
  );
  expect(container.textContent).not.toContain('Results calendar');
  expect(container.textContent).not.toContain('Recorded results by project');
});
