// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LaunchTimingForm } from './launch-timing-form';
import { DEFAULT_LAUNCH_PLAN } from '@/lib/launch-plan';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (props: Parameters<typeof LaunchTimingForm>[0]) =>
  act(async () => {
    root.render(<LaunchTimingForm {...props} />);
  });

const byLabel = (label: string) =>
  host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);

it('shows the MEV estimate panel on a sequenced plan', async () => {
  await render({ plan: DEFAULT_LAUNCH_PLAN, onChange: vi.fn() });
  expect(host.textContent).toContain('Bubble Maps');
  expect(byLabel('Detection mode slider')).not.toBeNull();
  expect(byLabel('Supply cost basis points')).not.toBeNull();
  expect(byLabel('Cleanup duration milliseconds')).not.toBeNull();
});

it('hides the panel off the sequenced method', async () => {
  await render({
    plan: { ...DEFAULT_LAUNCH_PLAN, mode: 'Stagger' },
    onChange: vi.fn(),
  });
  expect(host.textContent).not.toContain('Bubble Maps');
  expect(byLabel('Detection mode slider')).toBeNull();
});

it('reports slider edits', async () => {
  const onChange = vi.fn();
  await render({ plan: DEFAULT_LAUNCH_PLAN, onChange });
  const slider = byLabel('Detection mode slider')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!;
    setter.call(slider, '1.4');
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(onChange).toHaveBeenCalledWith({ mevSlider: 1.4 });
});

it('clears an optional estimate field rather than writing zero', async () => {
  const onChange = vi.fn();
  await render({
    plan: { ...DEFAULT_LAUNCH_PLAN, supplyCostBps: 250 },
    onChange,
  });
  const input = byLabel('Supply cost basis points')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(onChange).toHaveBeenCalledWith({ supplyCostBps: undefined });
});

it('feeds the supply percentage only in supply mode', async () => {
  await render({
    plan: { ...DEFAULT_LAUNCH_PLAN, holdersBuy: 40, supplyCostBps: 100 },
    onChange: vi.fn(),
  });
  // 40% supply at 100 bps is 0.4% of supply, locale-rendered.
  expect(host.textContent).toContain(
    `${(0.4).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`,
  );
});

it('drops the supply cost value in quote mode', async () => {
  await render({
    plan: { ...DEFAULT_LAUNCH_PLAN, mode: 'Stagger', supplyCostBps: 100 },
    onChange: vi.fn(),
  });
  // Stagger is quote mode, and the panel is hidden entirely there.
  expect(host.textContent).not.toContain('Supply cost');
});

it('renders a cleanliness label from the buy delay', async () => {
  await render({
    plan: {
      ...DEFAULT_LAUNCH_PLAN,
      timing: { buyDelayMs: 20_000, initialBuyDelayMs: 0 },
    },
    onChange: vi.fn(),
  });
  expect(host.textContent).toContain('Likely clean');
});
