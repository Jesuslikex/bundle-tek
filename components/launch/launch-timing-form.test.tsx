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

// Assign through the prototype setter so React sees a change, then fire input.
const typeInto = async (input: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

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
  await typeInto(byLabel('Detection mode slider')!, '1.4');
  expect(onChange).toHaveBeenCalledWith({ mevSlider: 1.4 });
});

it('clears an optional estimate field rather than writing zero', async () => {
  const onChange = vi.fn();
  await render({
    plan: { ...DEFAULT_LAUNCH_PLAN, supplyCostBps: 250 },
    onChange,
  });
  const input = byLabel('Supply cost basis points')!;
  await typeInto(input, '');
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

it('offers the captured Front MEV ceilings', async () => {
  await render({ plan: DEFAULT_LAUNCH_PLAN, onChange: vi.fn() });
  expect(byLabel('Max Front MEV wallets')).not.toBeNull();
  expect(byLabel('Max Front MEV wallets after migration')).not.toBeNull();
  expect(byLabel('Migration threshold')).not.toBeNull();
});

it('hides the ceilings off the sequenced method', async () => {
  await render({
    plan: { ...DEFAULT_LAUNCH_PLAN, mode: 'Stagger' },
    onChange: vi.fn(),
  });
  expect(byLabel('Max Front MEV wallets')).toBeNull();
});

it('reports each ceiling edit', async () => {
  const onChange = vi.fn();
  await render({ plan: DEFAULT_LAUNCH_PLAN, onChange });
  await typeInto(byLabel('Max Front MEV wallets')!, '6');
  await typeInto(byLabel('Max Front MEV wallets after migration')!, '2');
  await typeInto(byLabel('Migration threshold')!, '40');
  expect(onChange).toHaveBeenNthCalledWith(1, { maxFrontMevCount: 6 });
  expect(onChange).toHaveBeenNthCalledWith(2, { maxFrontMevPostMigration: 2 });
  expect(onChange).toHaveBeenNthCalledWith(3, { migrationThreshold: 40 });
});

it('clears a ceiling to uncapped rather than zero', async () => {
  const onChange = vi.fn();
  await render({
    plan: { ...DEFAULT_LAUNCH_PLAN, maxFrontMevCount: 4 },
    onChange,
  });
  await typeInto(byLabel('Max Front MEV wallets')!, '');
  expect(onChange).toHaveBeenCalledWith({ maxFrontMevCount: undefined });
});

it('shows a stored ceiling', async () => {
  await render({
    plan: { ...DEFAULT_LAUNCH_PLAN, maxFrontMevCount: 3 },
    onChange: vi.fn(),
  });
  expect(byLabel('Max Front MEV wallets')!.value).toBe('3');
});
