// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { VolumeRunProgress } from './volume-run-progress';

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

const START = Date.UTC(2026, 0, 1, 12, 0, 0);
const render = (props: Parameters<typeof VolumeRunProgress>[0]) =>
  act(async () => {
    root.render(<VolumeRunProgress {...props} />);
  });

it('shows the start time and the time left', async () => {
  await render({
    startedAt: START,
    endsAt: START + 30_000,
    now: START + 10_000,
  });
  expect(host.textContent).toContain('Started:');
  expect(host.textContent).toContain('Time Left: 20s');
  expect(host.textContent).not.toContain('Taking longer');
});

it('switches to the overrun line once the planned end passes', async () => {
  await render({
    startedAt: START,
    endsAt: START + 30_000,
    now: START + 31_000,
  });
  expect(host.textContent).toContain('Taking longer than usual...');
  expect(host.textContent).not.toContain('Time Left');
});

it('treats the exact end as still on time', async () => {
  await render({
    startedAt: START,
    endsAt: START + 30_000,
    now: START + 30_000,
  });
  expect(host.textContent).toContain('Time Left: 0s');
});

it('advances the bar with elapsed time and caps at 100', async () => {
  await render({
    startedAt: START,
    endsAt: START + 20_000,
    now: START + 5_000,
  });
  const bar = host.querySelector('progress')!;
  expect(bar.value.toString()).toBe('25');
  await render({
    startedAt: START,
    endsAt: START + 20_000,
    now: START + 90_000,
  });
  expect(host.querySelector('progress')!.value.toString()).toBe('100');
});

it('never reports a negative fraction before the start', async () => {
  await render({
    startedAt: START,
    endsAt: START + 20_000,
    now: START - 5_000,
  });
  expect(host.querySelector('progress')!.value.toString()).toBe('0');
});

it('omits the countdown when there is no planned end', async () => {
  await render({ startedAt: START, endsAt: null, now: START + 60_000 });
  expect(host.textContent).toContain('Started:');
  expect(host.textContent).not.toContain('Time Left');
  expect(host.textContent).not.toContain('Taking longer');
});

it('handles a zero-length window without dividing by zero', async () => {
  await render({ startedAt: START, endsAt: START, now: START + 1 });
  expect(host.textContent).toContain('Taking longer than usual...');
  expect(host.querySelector('progress')!.value.toString()).toBe('0');
});
