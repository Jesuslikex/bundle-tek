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

const observedAt = '2026-10-13T12:00:00.000Z';
const emptyPerformance = () =>
  Response.json({
    summary: accountPerformanceFromScopes([], observedAt),
    timeline: { observedAt, sales: [], unlinkedSaleCount: 0 },
  });

async function loadPanel(
  panel: React.ReactElement,
  response: Response,
  launchResponse = Response.json({
    observedAt,
    savedGroups: 0,
    finalizedGroups: 0,
    awaitingReview: 0,
    finalizationEvidenceMissing: 0,
    recent: [],
  }),
) {
  // Launch history loads on mount, independently of the manual trade review.
  // Each endpoint must receive its own response body, as it does over HTTP.
  const fetch = vi.fn(async (input: string) => {
    if (input === '/api/account-launch-activity') return launchResponse;
    if (
      input === '/api/account-costs' ||
      input === '/api/account-performance?view=timeline'
    )
      return response;
    throw new Error(`Unexpected account request: ${input}`);
  });
  vi.stubGlobal('fetch', fetch);
  await act(async () => root.render(panel));
  const button = container.querySelector('button')!;
  await act(async () => {
    button.click();
  });
  return fetch;
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
  const fetch = await loadPanel(
    <AccountPerformancePanel />,
    emptyPerformance(),
  );
  expect(fetch.mock.calls.map(([input]) => input)).toEqual([
    '/api/account-launch-activity',
    '/api/account-performance?view=timeline',
  ]);
  expect(alertText()).toBe('');
  expect(container.querySelector('.performance-empty')?.textContent).toContain(
    'No finalized trades are recorded yet.',
  );
  expect(container.textContent).not.toContain('Results calendar');
  expect(container.textContent).not.toContain('Recorded results by project');
});

it('keeps the trade empty state usable when the separate launch history fails', async () => {
  await loadPanel(
    <AccountPerformancePanel />,
    emptyPerformance(),
    new Response('<html>Bad gateway</html>', { status: 502 }),
  );
  const performance = container.querySelector(
    'section[aria-label="Recorded trading performance"]',
  )!;
  expect(performance.querySelector('[role="alert"]')).toBeNull();
  expect(
    performance.querySelector('.performance-empty')?.textContent,
  ).toContain('No finalized trades are recorded yet.');
  expect(alertText()).toBe(
    'Saved launch activity is unavailable. No partial counts are shown.',
  );
});
