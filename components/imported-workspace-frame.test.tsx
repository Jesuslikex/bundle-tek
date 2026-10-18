// @vitest-environment jsdom
import React, { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  ImportedWorkspaceFrame,
  ImportedWorkspaceViews,
  useImportedWorkspaceWalletView,
} from './imported-workspace-frame';

let root: Root;
let container: HTMLDivElement;
let frameTop: number;
let chartScroll: number;
let width: number;
let frameWidth: number;
const mounted = vi.fn();
const unmounted = vi.fn();
const elapsed = vi.fn();

function RetainedReview() {
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    mounted();
    const timer = setTimeout(elapsed, 5000);
    return () => {
      clearTimeout(timer);
      unmounted();
    };
  }, []);
  return (
    <label>
      Existing review selection
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => setChecked(event.target.checked)}
      />
    </label>
  );
}
function WalletNavigation() {
  const showWallets = useImportedWorkspaceWalletView();
  return (
    <button onClick={() => showWallets?.()}>Review selected wallet</button>
  );
}
function views(tabbed = true) {
  return (
    <ImportedWorkspaceViews
      tabbed={tabbed}
      views={[
        { id: 'wallets', title: 'My wallets', content: <RetainedReview /> },
        { id: 'holders', title: 'Holders', content: <WalletNavigation /> },
        { id: 'activity', title: 'Activity', content: <p>Saved activity</p> },
      ]}
    />
  );
}
async function render(content: React.ReactNode) {
  await act(async () => root.render(content));
}
async function click(element: Element | null) {
  expect(element).not.toBeNull();
  await act(async () => (element as HTMLElement).click());
}
function tab(name: string) {
  return (
    [...container.querySelectorAll('[role="tab"]')].find(
      (element) => element.getAttribute('aria-label') === name,
    ) ?? null
  );
}
async function resize() {
  vi.stubGlobal('innerWidth', width);
  await act(async () => {
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(20);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 16),
  );
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  width = 1920;
  frameWidth = 1600;
  frameTop = 160;
  chartScroll = 0;
  vi.stubGlobal('innerWidth', width);
  vi.stubGlobal('innerHeight', 945);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      const top = this.classList.contains('workspace') ? 70 : frameTop;
      const bottom = this.classList.contains('workspace')
        ? 920
        : this.getAttribute('aria-label') === 'Inspect chart candles'
          ? frameTop + 480 - chartScroll
          : top + 480;
      return {
        x: 0,
        y: top,
        top,
        bottom,
        left: 0,
        right: frameWidth,
        width: frameWidth,
        height: bottom - top,
        toJSON() {},
      };
    },
  );
  container = document.createElement('div');
  container.className = 'workspace';
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('keeps review state and existing timers mounted across tabs and full-page mode', async () => {
  await render(views());
  const checkbox = container.querySelector<HTMLInputElement>('input')!;
  await click(checkbox);
  await click(tab('Holders'));
  expect(checkbox.closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(
    true,
  );
  await act(async () => vi.advanceTimersByTime(5001));
  expect(elapsed).toHaveBeenCalledTimes(1);
  await render(views(false));
  expect(container.querySelector('[role="tablist"]')).toBeNull();
  expect(container.querySelector('[hidden]')).toBeNull();
  expect(container.querySelector('[role="region"][tabindex]')).toBeNull();
  expect(container.querySelector('input')).toBe(checkbox);
  expect(checkbox.checked).toBe(true);
  await render(views());
  expect(tab('Holders')?.getAttribute('aria-selected')).toBe('true');
  await click(tab('My wallets'));
  expect(checkbox.checked).toBe(true);
  expect(mounted).toHaveBeenCalledTimes(1);
  expect(unmounted).not.toHaveBeenCalled();
});

it('supports keyboard tabs with one tab stop and exact labelled panel relationships', async () => {
  await render(views());
  await act(async () => {
    tab('My wallets')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
    );
  });
  expect(document.activeElement).toBe(tab('Activity'));
  expect(tab('Activity')?.getAttribute('aria-selected')).toBe('true');
  expect(container.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(
    1,
  );
  const active = tab('Activity')!;
  const panel = document.getElementById(active.getAttribute('aria-controls')!)!;
  expect(panel.getAttribute('aria-labelledby')).toBe(active.id);
  expect(panel.hidden).toBe(false);
});

it('reveals the retained wallet view for a successful cross-panel review handoff', async () => {
  await render(views());
  const checkbox = container.querySelector('input');
  await click(tab('Holders'));
  await click(
    container.querySelector('[role="tabpanel"]:not([hidden]) button'),
  );
  expect(tab('My wallets')?.getAttribute('aria-selected')).toBe('true');
  expect(container.querySelector('input')).toBe(checkbox);
  expect(unmounted).not.toHaveBeenCalled();
});

it('marks changed hidden content and clears the presentation marker when opened', async () => {
  function Observation() {
    const [text, setText] = useState('Saved observation');
    useEffect(() => {
      const timer = setTimeout(() => setText('New observation'), 1000);
      return () => clearTimeout(timer);
    }, []);
    return <output>{text}</output>;
  }
  await render(
    <ImportedWorkspaceViews
      tabbed
      views={[
        { id: 'wallets', title: 'My wallets', content: <p>Wallets</p> },
        { id: 'holders', title: 'Holders', content: <Observation /> },
      ]}
    />,
  );
  expect(tab('Holders')?.textContent).not.toContain('Updated');
  await act(async () => vi.advanceTimersByTime(1001));
  expect(tab('Holders')?.textContent).toContain('Updated');
  expect(
    document.getElementById(tab('Holders')!.getAttribute('aria-describedby')!)
      ?.textContent,
  ).toBe('Updated');
  await click(tab('Holders'));
  expect(tab('Holders')?.textContent).not.toContain('Updated');
  expect(tab('Holders')?.hasAttribute('aria-describedby')).toBe(false);
  expect(
    container.querySelector('[data-workspace-view="holders"] output')
      ?.textContent,
  ).toBe('New observation');
});

it('fits the full plot without page-scroll feedback and falls back when room is lost', async () => {
  await render(
    <ImportedWorkspaceFrame compact>
      <section aria-label="Open token chart">
        <div aria-label="Inspect chart candles" />
      </section>
      <section className="imported-workspace-trading">Quote</section>
      {views()}
    </ImportedWorkspaceFrame>,
  );
  await resize();
  const frame = container.querySelector<HTMLElement>('[data-wallet-dock]')!;
  expect(frame.dataset.walletDock).toBe('docked');
  expect(frame.style.getPropertyValue('--workspace-fit-height')).toBe('756px');
  expect(frame.style.getPropertyValue('--workspace-chart-height')).toBe(
    '492px',
  );
  container.scrollTop = 200;
  frameTop = -40;
  const chart = container.querySelector<HTMLElement>(
    '[aria-label="Open token chart"]',
  )!;
  chart.scrollTop = chartScroll = 50;
  await resize();
  expect(frame.style.getPropertyValue('--workspace-fit-height')).toBe('756px');
  expect(frame.style.getPropertyValue('--workspace-chart-height')).toBe(
    '492px',
  );
  width = 1280;
  await resize();
  expect(frame.dataset.walletDock).toBe('flow');
  expect(frame.style.getPropertyValue('--workspace-fit-height')).toBe('');
  width = 1920;
  frameWidth = 1170;
  await resize();
  expect(frame.dataset.walletDock).toBe('flow');
  frameWidth = 1600;
  container.scrollTop = 0;
  frameTop = 300;
  await resize();
  expect(frame.dataset.walletDock).toBe('flow');
});
