// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  warmupCycleProgress,
  type WarmupCycleProgress,
} from '@/lib/warmup-cycle-progress';
import { warmupUiFixture } from '@/test/warmup-ui-fixture';
import { WarmupNextReview } from './warmup-next-review';
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No request permitted');
    }),
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function progress() {
  const { plan } = warmupUiFixture();
  return warmupCycleProgress(
    { ...plan, document: { ...plan.document, cycles: 3 } },
    [],
    [],
    [],
    false,
  );
}
async function mount(
  value: WarmupCycleProgress,
  callbacks: {
    onReview?: (step: WarmupCycleProgress['steps'][number]) => void;
    onRecover?: (wallet: string) => void;
  } = {},
) {
  await act(async () =>
    root.render(<WarmupNextReview progress={value} {...callbacks} />),
  );
}
it('opens the first unbought cycle through the existing callback only after an explicit click', async () => {
  const p = progress(),
    onReview = vi.fn();
  await mount(p, { onReview });
  expect(onReview).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(host.textContent).toContain('included in this revision scope');
  expect(host.textContent).toContain('not a scheduled action');
  await act(async () => host.querySelector('button')!.click());
  expect(onReview).toHaveBeenCalledExactlyOnceWith(p.steps[0]);
  expect(fetch).not.toHaveBeenCalled();
});
it('prefers a remaining lot over an earlier unbought cycle without changing the selected step', async () => {
  const p = progress(),
    onReview = vi.fn();
  Object.assign(p.steps[2], {
    state: 'Tokens remaining',
    buyCount: 1,
    buyIds: ['retained-buy'],
    remainingRaw: '42',
    decimals: 6,
  });
  await mount(p, { onReview });
  expect(host.querySelector('button')?.textContent).toBe('Review next sell');
  expect(host.textContent).toContain('Cycle 3');
  await act(async () => host.querySelector('button')!.click());
  expect(onReview).toHaveBeenCalledExactlyOnceWith(p.steps[2]);
});
it('prioritizes approval recovery across pages and never invokes transaction review', async () => {
  const p = progress(),
    onReview = vi.fn(),
    onRecover = vi.fn();
  p.activeApprovals = 1;
  Object.assign(p.steps[2], { state: 'Recovery required', recoveryCount: 1 });
  await mount(p, { onReview, onRecover });
  expect(host.querySelector('button')?.textContent).toBe(
    'Recover wallet approval',
  );
  await act(async () => host.querySelector('button')!.click());
  expect(onRecover).toHaveBeenCalledExactlyOnceWith(p.steps[2].wallet);
  expect(onReview).not.toHaveBeenCalled();
});
it('does not offer a replacement trade when an active approval lacks a selected recovery row', async () => {
  const p = progress(),
    onReview = vi.fn();
  p.activeApprovals = 1;
  await mount(p, { onReview });
  expect(host.textContent).toContain('approval recovery');
  expect(host.querySelector('button')).toBeNull();
});
it('keeps read-only progress informative without creating a review action', async () => {
  await mount(progress());
  expect(host.querySelector('button')).toBeNull();
  expect(host.textContent).toContain('requires an active Solana plan');
});
it('explains archival without asking the user to fix wallet selection and retains recovery', async () => {
  const p = progress();
  p.archived = true;
  await mount(p);
  expect(host.textContent).toContain('Restore this archived plan');
  expect(host.querySelector('button')).toBeNull();
  p.activeApprovals = 1;
  Object.assign(p.steps[0], { state: 'Recovery required', recoveryCount: 1 });
  const onRecover = vi.fn();
  await mount(p, { onRecover });
  await act(async () => host.querySelector('button')!.click());
  expect(onRecover).toHaveBeenCalledExactlyOnceWith(p.steps[0].wallet);
});
it('shows completion only when no included step remains and retains the receipt-only scope', async () => {
  const p = progress();
  p.steps.forEach((s) =>
    Object.assign(s, {
      state: 'Recorded lots sold',
      buyCount: 1,
      buyIds: ['saved'],
      remainingRaw: '0',
      decimals: 6,
    }),
  );
  await mount(p, { onReview: vi.fn() });
  expect(host.querySelector('button')).toBeNull();
  expect(host.textContent).toContain('All included recorded buy lots are sold');
  expect(host.textContent).toContain('does not prove profit');
});
