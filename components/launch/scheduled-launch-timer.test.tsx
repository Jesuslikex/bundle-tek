// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ScheduledLaunchTimer } from './scheduled-launch-timer';

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  localStorage.clear();
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});
const button = (text: string) =>
  [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.startsWith(text),
  )!;

it('simulates once at the scheduled time and only when ready', async () => {
  const onDue = vi.fn();
  localStorage.setItem(
    'bundle.scheduled-launch.v1:p1',
    String(Date.now() + 3000),
  );
  await act(async () =>
    root.render(<ScheduledLaunchTimer projectId="p1" ready onDue={onDue} />),
  );
  expect(container.textContent).toContain('Simulating at');
  await act(async () => vi.advanceTimersByTime(2000));
  expect(onDue).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(2000));
  expect(onDue).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem('bundle.scheduled-launch.v1:p1')).toBeNull();
  await act(async () => vi.advanceTimersByTime(5000));
  expect(onDue).toHaveBeenCalledTimes(1);
});

it('does not simulate when the launch is not ready, and can be cancelled', async () => {
  const onDue = vi.fn();
  localStorage.setItem(
    'bundle.scheduled-launch.v1:p1',
    String(Date.now() + 1000),
  );
  await act(async () =>
    root.render(
      <ScheduledLaunchTimer projectId="p1" ready={false} onDue={onDue} />,
    ),
  );
  await act(async () => vi.advanceTimersByTime(2000));
  expect(onDue).not.toHaveBeenCalled();
  expect(container.textContent).toContain('not ready to simulate');
  localStorage.setItem(
    'bundle.scheduled-launch.v1:p2',
    String(Date.now() + 60000),
  );
  act(() => root.unmount());
  root = createRoot(container);
  await act(async () =>
    root.render(<ScheduledLaunchTimer projectId="p2" ready onDue={onDue} />),
  );
  await act(async () => button('Cancel schedule').click());
  await act(async () => vi.advanceTimersByTime(120000));
  expect(onDue).not.toHaveBeenCalled();
  expect(localStorage.getItem('bundle.scheduled-launch.v1:p2')).toBeNull();
});
