// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MeteoraDbcLaunchReview } from './meteora-dbc-launch-review';
import { DEFAULT_LAUNCH_PLAN } from '@/lib/launch-plan';

const project = {
  id: 'dbc-a',
  updatedAt: '2026-10-19T00:00:00.000Z',
  payer: {
    address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
    revision: 1,
  },
};
let container: HTMLDivElement, root: Root;
const fetcher = vi.fn();
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  localStorage.clear();
  fetcher
    .mockReset()
    .mockImplementation(async () => Response.json({ launches: [] }));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const plan = (currency: string) => ({
  ...DEFAULT_LAUNCH_PLAN,
  launchpad: 'Meteora DBC',
  currency,
});

it('renders the Meteora DBC panel without a mutating request and asks for a DBC config', async () => {
  await act(async () =>
    root.render(
      <MeteoraDbcLaunchReview
        project={project}
        plan={plan('SOL')}
        releaseId={'a'.repeat(64)}
      />,
    ),
  );
  expect(container.textContent).toContain('Create your Meteora DBC coin');
  expect(container.textContent).toContain('Enter a DBC config.');
  const input = container.querySelector<HTMLInputElement>(
    'input[placeholder="Enter a DBC config"]',
  );
  expect(input).not.toBeNull();
  const prepare = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Prepare and simulate launch',
  )!;
  expect(prepare.disabled).toBe(true);
  expect(fetcher.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

it('asks for SOL or USDC when another quote is saved', async () => {
  await act(async () =>
    root.render(
      <MeteoraDbcLaunchReview
        project={project}
        plan={plan('BONK')}
        releaseId={'a'.repeat(64)}
      />,
    ),
  );
  expect(container.textContent).toContain('Choose SOL or USDC');
});
