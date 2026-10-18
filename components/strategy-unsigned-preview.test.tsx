// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StrategyCandidateCheckPanel } from './strategy-candidate-check';
import { strategyPreviewFixture } from '../test/strategy-preview-fixture';
import { checkHoldId } from '../test/strategy-check-fixture';
let host: HTMLDivElement,
  root: Root,
  f: Awaited<ReturnType<typeof strategyPreviewFixture>>,
  reply: () => Promise<Response>;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(
    async (_algorithm, data) =>
      Uint8Array.from(
        createHash('sha256')
          .update(new Uint8Array(data as ArrayBuffer))
          .digest(),
      ).buffer,
  );
  f = await strategyPreviewFixture();
  reply = async () => Response.json(f.preview);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) =>
      String(url).endsWith('/strategy-checks')
        ? Response.json(f.preview.checks)
        : reply(),
    ),
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const mount = (blocked = false) =>
  act(async () =>
    root.render(
      <StrategyCandidateCheckPanel
        draft={f.draft}
        capacity={f.capacity}
        holdId={checkHoldId}
        blocked={blocked}
      />,
    ),
  );
const button = (name: string) =>
  [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === name,
  )!;
const click = (name: string) => act(async () => button(name).click());
it('performs only explicit requests, keeps details collapsed and exposes no signing, send or funding controls', async () => {
  await mount();
  expect(fetch).not.toHaveBeenCalled();
  await click('Check current conditions');
  expect(fetch).toHaveBeenCalledTimes(1);
  await click('Preview unsigned trade');
  expect(fetch).toHaveBeenCalledTimes(2);
  const sent = vi.mocked(fetch).mock.calls[1][1]?.body;
  const body = JSON.parse(typeof sent === 'string' ? sent : '{}');
  expect(body).toEqual({
    projectId: f.draft.plan.input.projectId,
    draftId: f.draft.id,
    revision: f.capacity.revision,
    holdId: checkHoldId,
    conditionPool: null,
  });
  expect(host.textContent).toContain('Unsigned quote and simulation checked.');
  expect(host.textContent).toContain('Minimum output:');
  expect(host.querySelector('details[open]')).toBeNull();
  expect(
    [...host.querySelectorAll('button')].map((b) => b.textContent),
  ).toEqual(['Check current conditions', 'Preview unsigned trade']);
});
it('removes stale quote and fee values when the preview expires', async () => {
  vi.useFakeTimers();
  await mount();
  await click('Check current conditions');
  await click('Preview unsigned trade');
  expect(host.textContent).toContain('Minimum output:');
  await act(async () => vi.advanceTimersByTimeAsync(15000));
  expect(host.textContent).toContain('This preview expired');
  expect(host.textContent).not.toContain('Minimum output:');
});
it.each(['blocked', 'offline', 'cancel'] as const)(
  'discards a delayed preview after %s without retrying or showing a stale success',
  async (kind) => {
    let release: (v: Response) => void = () => {};
    reply = () => new Promise((resolve) => (release = resolve));
    await mount();
    await click('Check current conditions');
    await click('Preview unsigned trade');
    const signal = vi.mocked(fetch).mock.calls[1][1]?.signal;
    if (kind === 'blocked') await mount(true);
    if (kind === 'offline')
      await act(async () => window.dispatchEvent(new Event('offline')));
    if (kind === 'cancel') await click('Cancel preview');
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      release(Response.json(f.preview));
      await Promise.resolve();
    });
    expect(host.textContent).not.toContain('Minimum output:');
    expect(host.textContent).not.toContain(
      'Unsigned quote and simulation checked.',
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  },
);
it('shows an actionable unfunded refusal and preserves retry access without a funding action', async () => {
  reply = async () =>
    Response.json(
      {
        error:
          'This wallet has insufficient input balance. No order was requested and the review slot is unchanged.',
      },
      { status: 422 },
    );
  await mount();
  await click('Check current conditions');
  await click('Preview unsigned trade');
  expect(host.querySelector('[role=alert]')?.textContent).toContain(
    'insufficient input balance',
  );
  expect(button('Preview unsigned trade').disabled).toBe(false);
});
