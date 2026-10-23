// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DEFAULT_LAUNCH_PLAN, type LaunchPlanInput } from '@/lib/launch-plan';
import { LiveOperationsForm } from './live-operations-form';

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (patch: Partial<LaunchPlanInput>) =>
  act(async () =>
    root.render(
      <LiveOperationsForm
        plan={{ ...DEFAULT_LAUNCH_PLAN, ...patch }}
        onOpenSimulation={() => {}}
      />,
    ),
  );
const checked = () =>
  host.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.value;

it('shows the Base launch panel with Bankr selected for a Base / Bankr plan', async () => {
  await render({ chain: 'Base', launchpad: 'Bankr', currency: 'ETH' });
  expect(host.textContent).toContain('Launch on Bankr (Base)');
  expect(checked()).toBe('Bankr');
  expect(host.textContent).toContain('Transactions require separate approval');
  expect(host.textContent).toContain('wallet confirmation');
  expect(host.textContent).not.toContain(
    'no trade or launch order submitter exists',
  );
});

it('shows the Base launch panel with Clanker selected for a Base / Clanker plan', async () => {
  await render({ chain: 'Base', launchpad: 'Clanker', currency: 'ETH' });
  expect(host.textContent).toContain('Launch on Clanker (Base)');
  expect(checked()).toBe('Clanker');
});

it('does not show the Base launch panel for other plans', async () => {
  await render({});
  expect(host.textContent).not.toContain('(Base)');
  expect(host.textContent).toContain('Market preview only');
});
