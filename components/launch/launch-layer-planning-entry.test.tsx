// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LaunchLayerPlanningEntry } from './launch-layer-planning-entry';
import type { LayerSelection } from '@/lib/launch-layer-client';

const selection: LayerSelection = {
  projectId: 'project',
  projectUpdatedAt: '2026-10-18T00:00:00.000Z',
  target: { kind: 'new', mint: 'actual-public-mint-candidate' },
};
let root: Root, container: HTMLDivElement;
let fetcher: ReturnType<typeof vi.fn>;
const toggle = () => container.querySelector('button')!;
const panel = () =>
  container.querySelector('[aria-label="Front and Back layer planning"]');
async function render(current = selection, disabled = false) {
  await act(async () => {
    root.render(
      <LaunchLayerPlanningEntry selection={current} disabled={disabled} />,
    );
  });
}
async function open() {
  await act(async () => {
    toggle().click();
    await vi.dynamicImportSettled();
  });
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it('opens the real public-mint planner without reading providers or requesting authority', async () => {
  await render();
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  expect(panel()).toBeNull();
  await open();
  expect(panel()?.textContent).toContain(selection.target.mint);
  expect(panel()?.textContent).toContain(
    'Staged funding and execution are not',
  );
  expect(toggle().getAttribute('aria-expanded')).toBe('true');
  expect(
    document.getElementById(toggle().getAttribute('aria-controls')!),
  ).not.toBeNull();
  expect(container.querySelector('input[type="password"]')).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => toggle().click());
  expect(panel()).toBeNull();
  expect(toggle().hasAttribute('aria-controls')).toBe(false);
});
it.each(['projectId', 'projectUpdatedAt', 'mint'] as const)(
  'closes and discards the mounted planner when %s changes',
  async (field) => {
    await render();
    await open();
    const oldPanel = panel();
    const next: LayerSelection = {
      ...selection,
      ...(field === 'projectId' ? { projectId: 'another-project' } : {}),
      ...(field === 'projectUpdatedAt'
        ? { projectUpdatedAt: '2026-10-18T00:01:00.000Z' }
        : {}),
      target: {
        kind: 'new',
        mint:
          field === 'mint' ? 'replacement-public-mint' : selection.target.mint,
      },
    };
    await render(next);
    expect(panel()).toBeNull();
    expect(oldPanel?.isConnected).toBe(false);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    await open();
    expect(panel()?.textContent).toContain(next.target.mint);
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it('preserves an open public context on equivalent rerender and blocks controls while busy', async () => {
  await render(selection, true);
  expect(toggle().disabled).toBe(true);
  await open();
  expect(panel()).toBeNull();
  await render();
  await open();
  const oldPanel = panel();
  await render({ ...selection, target: { ...selection.target } }, true);
  expect(panel()).toBe(oldPanel);
  expect(toggle().disabled).toBe(true);
  expect(
    [...panel()!.querySelectorAll('button')].every((button) => button.disabled),
  ).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
});
it('aborts both pending planning reads when the entry is closed', async () => {
  const signals: AbortSignal[] = [];
  const urls: string[] = [];
  fetcher.mockImplementation((url: string, init: RequestInit) => {
    signals.push(init.signal as AbortSignal);
    urls.push(url);
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('Aborted', 'AbortError')),
        { once: true },
      );
    });
  });
  await render();
  await open();
  const load = [...panel()!.querySelectorAll('button')].find(
    (button) => button.textContent === 'Load saved wallets and layer history',
  )!;
  await act(async () => load.click());
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(
    JSON.parse(
      new URL(urls[0], 'https://bundle.test').searchParams.get('context')!,
    ),
  ).toEqual(selection);
  expect(signals.every((signal) => !signal.aborted)).toBe(true);
  await act(async () => toggle().click());
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(panel()).toBeNull();
  expect(container.textContent).not.toContain(
    'The planning snapshot may already be saved.',
  );
});

it('labels the Stonk planning surface Front-only without changing its authority', async () => {
  await act(async () => {
    root.render(<LaunchLayerPlanningEntry selection={selection} frontOnly />);
  });
  expect(toggle().textContent).toBe('Plan Front wallets');
  await open();
  const front = container.querySelector('[aria-label="Front-wallet planning"]');
  expect(front?.textContent).toContain('Plan Front wallets only');
  expect(front?.textContent).toContain(
    'Saving does not create a coin or configure execution',
  );
  expect(
    container.querySelector('[aria-label="Front and Back layer planning"]'),
  ).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
