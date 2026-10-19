// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LaunchLabLaunchReview } from './launchlab-launch-review';
import { DEFAULT_LAUNCH_PLAN } from '@/lib/launch-plan';

const project = {
  id: 'bonk-a',
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
  fetcher.mockReset();
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

for (const venue of ['LetsBonk', 'Surge'] as const)
  it(`renders the ${venue} panel without any request`, () => {
    act(() =>
      root.render(
        <LaunchLabLaunchReview
          venue={venue}
          project={project}
          plan={{ ...DEFAULT_LAUNCH_PLAN, launchpad: venue, currency: 'SOL' }}
          releaseId=""
        />,
      ),
    );
    expect(container.textContent).toContain(`Create your ${venue} coin`);
    expect(container.textContent).toContain(
      'Publish the reviewed image and metadata above first.',
    );
    const prepare = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Prepare and simulate launch',
    )!;
    expect(prepare.disabled).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

it('asks for SOL or USD1 when another quote is saved', () => {
  act(() =>
    root.render(
      <LaunchLabLaunchReview
        venue="LetsBonk"
        project={project}
        plan={{
          ...DEFAULT_LAUNCH_PLAN,
          launchpad: 'LetsBonk',
          currency: 'BONK',
        }}
        releaseId={'a'.repeat(64)}
      />,
    ),
  );
  expect(container.textContent).toContain('Choose SOL or USD1');
});
