// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { WalletWarmup } from './wallet-warmup';
import { warmupUiFixture } from '../test/warmup-ui-fixture';
let host: HTMLDivElement,
  root: Root,
  fixture: ReturnType<typeof warmupUiFixture>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture = warmupUiFixture();
  vi.stubGlobal('fetch', vi.fn(fixture.fetcher));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function mount() {
  await act(async () =>
    root.render(
      <WalletWarmup
        chain="Solana"
        addresses={[fixture.wallet]}
        walletRevisions={[{ address: fixture.wallet, revision: 1 }]}
        onClose={() => {}}
      />,
    ),
  );
}
async function click(text: string) {
  const b = Array.from(host.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  )!;
  expect(b, text).toBeTruthy();
  await act(async () => b.click());
}
it('reviews and saves a USDC draft with a fresh start without manually finding a mint or date', async () => {
  await mount();
  expect(fixture.calls.every((c) => c.method === 'GET')).toBe(true);
  expect(host.querySelector('form details')!.hasAttribute('open')).toBe(false);
  await click('Use USDC');
  await click('Review warmup plan');
  expect(host.textContent).toContain('0.013 SOL');
  await click('Save draft');
  expect(fixture.plan.document.tokens).toEqual([
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  ]);
  expect(Date.parse(fixture.plan.document.startAt)).toBe(
    Date.now() + 30 * 60000,
  );
  expect(host.textContent).toContain('No swaps scheduled');
  const advanced = Array.from(host.querySelectorAll('details')).find(
    (d) =>
      d.querySelector('summary')?.textContent === 'Transactions and recovery',
  )!;
  expect(advanced.open).toBe(false);
  const quote = Array.from(host.querySelectorAll('details')).find(
    (d) => d.querySelector('summary')?.textContent === 'Optional market quote',
  )!;
  expect(quote.open).toBe(false);
  const archive = Array.from(host.querySelectorAll('button')).find(
    (b) => b.textContent === 'Archive',
  )!;
  expect(archive.closest('details')?.open).toBe(false);
  const fullSchedule = host.querySelector<HTMLDetailsElement>(
    '[aria-label="Warmup plan review"]',
  )!;
  expect(fullSchedule.open).toBe(false);
  expect(
    fixture.calls.some(
      (c) =>
        ['register', 'submit'].includes(c.action ?? '') ||
        c.path.endsWith('/prepare'),
    ),
  ).toBe(false);
});
it('refreshes an expired saved draft explicitly and requires review before any new save', async () => {
  await mount();
  await click('Use USDC');
  await click('Review warmup plan');
  await click('Save draft');
  await act(async () => vi.advanceTimersByTime(31 * 60000));
  await click('Reload drafts');
  const before = fixture.calls.filter((c) => c.action === 'save').length;
  await click('Review with fresh start');
  expect(host.textContent).toContain('Fresh start selected');
  expect(fixture.calls.filter((c) => c.action === 'save')).toHaveLength(before);
  const save = Array.from(host.querySelectorAll('button')).find(
    (b) => b.textContent === 'Save changes',
  )!;
  expect(save.disabled).toBe(true);
  await click('Review warmup plan');
  await click('Save changes');
  expect(Date.parse(fixture.plan.document.startAt)).toBe(
    Date.now() + 30 * 60000,
  );
});
it('reveals token entry after review refuses an empty selection, without any mutation', async () => {
  await mount();
  await click('Review warmup plan');
  expect(host.querySelector('form details')!.hasAttribute('open')).toBe(true);
  expect(host.querySelector('[role="alert"]')).toBeTruthy();
  expect(fixture.calls.every((c) => c.method === 'GET')).toBe(true);
});

it('opens a collapsed options section when native input validation needs correction', async () => {
  await mount();
  const label = Array.from(host.querySelectorAll('label')).find((l) =>
    l.textContent?.includes('Cycles per wallet'),
  )!;
  const input = label.querySelector('input')!;
  const details = input.closest('details')!;
  expect(details.open).toBe(false);
  await act(async () =>
    input.dispatchEvent(
      new Event('invalid', { bubbles: false, cancelable: true }),
    ),
  );
  expect(details.open).toBe(true);
});
