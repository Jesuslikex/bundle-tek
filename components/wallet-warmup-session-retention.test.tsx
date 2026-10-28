// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WalletWarmupSessionRetention } from './wallet-warmup-session-retention';
import { warmupSessionReviewFixture } from '../test/warmup-session-review-fixture';
import { walletWarmupSessionView } from '@/lib/wallet-warmup-session-view';
import {
  walletWarmupSessionSaveSelection,
  type WarmupSessionRecovery,
} from '@/lib/wallet-warmup-session-retained-view';
let host: HTMLDivElement,
  root: Root,
  fixture: ReturnType<typeof warmupSessionReviewFixture>,
  view: ReturnType<typeof walletWarmupSessionView>;
const at = Date.parse('2026-10-20T12:00:00Z'),
  onBusy = () => {};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', webcrypto);
  sessionStorage.clear();
  fixture = warmupSessionReviewFixture(at);
  view = walletWarmupSessionView(fixture.response(at), fixture.plan, at);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function mount(current: typeof view | null = view, plan = fixture.plan) {
  await act(async () =>
    root.render(
      <WalletWarmupSessionRetention
        plan={plan}
        view={current}
        onBusyChange={onBusy}
      />,
    ),
  );
}
function button(text: string) {
  return [...host.querySelectorAll('button')].find(
    (b) => b.textContent === text,
  )!;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
async function done(test: () => void) {
  await act(async () => vi.waitFor(test, { timeout: 5000 }));
}
function response(selection: WarmupSessionRecovery) {
  const { contextKey: _contextKey, ...document } = view.review;
  return {
    retainedReview: {
      id: selection.id,
      planId: selection.planId,
      planRevision: selection.revision,
      reviewSha256: selection.reviewSha256,
      reviewedAt: selection.reviewedAt,
      reviewExpiresAt: view.reviewExpiresAt,
      createdAt: new Date(at + 1000).toISOString(),
      document,
    },
  };
}
function readMarker() {
  return JSON.parse(
    sessionStorage.getItem(`bundle:warmup-review:${fixture.plan.id}`)!,
  ) as WarmupSessionRecovery;
}
it('does not fetch on mount and retains the recovery ID before issuing exactly one explicit save', async () => {
  const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
    const selection = JSON.parse(options!.body as string);
    expect(readMarker().id).toBe(selection.id);
    return Response.json(response(selection));
  });
  vi.stubGlobal('fetch', fetcher);
  await mount();
  expect(fetcher).not.toHaveBeenCalled();
  await click('Save reviewed session');
  await done(() =>
    expect(host.textContent).toContain('Review saved for recovery'),
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(readMarker()).not.toHaveProperty('contextKey');
  expect(host.textContent).toContain('Saved review only');
  expect(host.textContent).toContain('0.012 SOL');
  expect(button('Save reviewed session').disabled).toBe(true);
  expect(host.querySelector('input[type="password"]')).toBeNull();
});
it('requires a fresh review and refuses saving an archived plan', async () => {
  vi.stubGlobal('fetch', vi.fn());
  await mount(null);
  expect(button('Save reviewed session').disabled).toBe(true);
  await mount(view, { ...fixture.plan, archived: true });
  expect(button('Save reviewed session').disabled).toBe(true);
  await mount();
  vi.setSystemTime(at + 60000);
  await click('Save reviewed session');
  await done(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
  expect(fetch).not.toHaveBeenCalled();
});
it('recovers a lost save response by GET without reissuing the POST', async () => {
  let stored: ReturnType<typeof response>;
  const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      stored = response(JSON.parse(options.body as string));
      throw new TypeError('Synthetic lost response');
    }
    return Response.json(stored);
  });
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Save reviewed session');
  await done(() =>
    expect(host.textContent).toContain('Save outcome is unconfirmed'),
  );
  expect(button('Save reviewed session').disabled).toBe(true);
  await click('Recover saved review');
  await done(() =>
    expect(host.textContent).toContain('Saved review recovered'),
  );
  expect(
    fetcher.mock.calls.filter(([, options]) => options?.method === 'POST'),
  ).toHaveLength(1);
  expect(fetcher.mock.calls[1][0]).toContain('?id=' + readMarker().id);
  expect(fetcher.mock.calls[1][1]?.method).toBeUndefined();
});
it('restores a reminder without an automatic request and recovers historical evidence on an archived plan', async () => {
  const selection = await walletWarmupSessionSaveSelection(
    view,
    fixture.plan,
    at,
  );
  sessionStorage.setItem(
    `bundle:warmup-review:${fixture.plan.id}`,
    JSON.stringify(selection),
  );
  vi.setSystemTime(at + 120000);
  const fetcher = vi.fn(async () => Response.json(response(selection)));
  vi.stubGlobal('fetch', fetcher);
  await mount(null, { ...fixture.plan, revision: 2, archived: true });
  expect(fetcher).not.toHaveBeenCalled();
  expect((host.querySelector('input') as HTMLInputElement).value).toBe(
    selection.id,
  );
  await click('Recover saved review');
  await done(() =>
    expect(host.textContent).toContain('Saved review recovered'),
  );
  expect(host.textContent).toContain(
    'earlier than the currently opened revision',
  );
});
it('stopping a pending save keeps its recovery ID and ignores a late response', async () => {
  let finish!: (r: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Save reviewed session');
  await done(() => expect(fetcher).toHaveBeenCalledTimes(1));
  const selection = readMarker();
  await click('Stop waiting');
  await act(async () => finish(Response.json(response(selection))));
  expect(host.textContent).toContain('save may have completed');
  expect(host.textContent).not.toContain('Saved review only');
  expect(readMarker()).toEqual(selection);
});
it('keeps a pending identity after a 404 and never retries a save automatically', async () => {
  const selection = await walletWarmupSessionSaveSelection(
    view,
    fixture.plan,
    at,
  );
  sessionStorage.setItem(
    `bundle:warmup-review:${fixture.plan.id}`,
    JSON.stringify(selection),
  );
  const fetcher = vi.fn(async () =>
    Response.json({ error: 'not found' }, { status: 404 }),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Recover saved review');
  await done(() => expect(host.textContent).toContain('may still be pending'));
  expect(readMarker()).toEqual(selection);
  expect(button('Save reviewed session').disabled).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('withholds writes when browser storage cannot keep the recovery ID', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('unavailable');
  });
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Save reviewed session');
  await done(() =>
    expect(host.textContent).toContain('Could not store a recovery ID'),
  );
  expect(fetcher).not.toHaveBeenCalled();
});
it('rejects a changed save response and leaves same-ID recovery available', async () => {
  const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
    const changed = response(JSON.parse(options!.body as string));
    changed.retainedReview.document.actions[0] = {
      ...changed.retainedReview.document.actions[0],
      scheduledAt: new Date(at + 100).toISOString(),
    };
    return Response.json(changed);
  });
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Save reviewed session');
  await done(() =>
    expect(host.textContent).toContain('Save outcome is unconfirmed'),
  );
  expect(host.textContent).not.toContain('Saved review only');
  expect(button('Recover saved review').disabled).toBe(false);
});
it('clears only the local reminder after an explicit click and preserves the ID for manual recovery', async () => {
  const selection = await walletWarmupSessionSaveSelection(
    view,
    fixture.plan,
    at,
  );
  sessionStorage.setItem(
    `bundle:warmup-review:${fixture.plan.id}`,
    JSON.stringify(selection),
  );
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Clear local reminder');
  expect(
    sessionStorage.getItem(`bundle:warmup-review:${fixture.plan.id}`),
  ).toBeNull();
  expect((host.querySelector('input') as HTMLInputElement).value).toBe(
    selection.id,
  );
  expect(host.textContent).toContain('No server review was deleted');
  expect(button('Save reviewed session').disabled).toBe(true);
  await mount(
    walletWarmupSessionView(
      fixture.response(at + 1000),
      fixture.plan,
      at + 1000,
    ),
  );
  expect(button('Save reviewed session').disabled).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});
