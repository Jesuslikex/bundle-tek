// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { webcrypto } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { WalletWarmupSessionConsent } from './wallet-warmup-session-consent';
import { warmupConsentClientFixture } from '@/test/warmup-session-consent-client-fixture';
import {
  warmupConsentPreview,
  readWarmupConsentResponse,
} from '@/lib/wallet-warmup-session-consent-view';
let host: HTMLDivElement,
  root: Root,
  f: Awaited<ReturnType<typeof warmupConsentClientFixture>>,
  latest: Awaited<ReturnType<typeof f.preview>> | null,
  stored: ReturnType<typeof f.saved> | null,
  writes: number,
  reads: number,
  lost: boolean;
const at = Date.parse('2026-10-21T12:00:00.000Z'),
  onBusy = () => {};
const key = () => `bundle:warmup-consent:${f.plan.id}`;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(at);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', webcrypto);
  sessionStorage.clear();
  f = await warmupConsentClientFixture(at);
  latest = null;
  stored = null;
  writes = 0;
  reads = 0;
  lost = false;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (_url.startsWith('/api/wallet-workspace/warmup/session-journals'))
        return Response.json(
          { error: 'No synthetic session yet' },
          { status: 404 },
        );
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        if (body.operation === 'review') {
          latest = await f.preview(body.sessionExpiresAt);
          return Response.json(latest);
        }
        writes++;
        expect(JSON.parse(sessionStorage.getItem(key())!).id).toBe(body.id);
        stored = f.saved(body.id, latest!);
        if (lost) throw Error('Synthetic lost response');
        return Response.json(stored);
      }
      reads++;
      return stored
        ? Response.json(stored)
        : Response.json({ error: 'not found' }, { status: 404 });
    }),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text)!;
async function click(text: string) {
  await act(async () => button(text).click());
}
async function done(check: () => void) {
  let failure: unknown;
  for (let n = 0; n < 1000; n++) {
    await act(async () => {
      await new Promise<void>((resolve) => nextTurn(resolve));
    });
    try {
      check();
      return;
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}
async function mount(view: typeof f.view | null = f.view) {
  await act(async () =>
    root.render(
      <WalletWarmupSessionConsent
        plan={f.plan}
        view={view}
        retained={f.retained}
        onBusyChange={onBusy}
      />,
    ),
  );
}
async function review() {
  expect(button('Review plan approval').disabled).toBe(false);
  await click('Review plan approval');
  await done(() => {
    if (!button('Save plan approval')) throw Error(host.textContent ?? 'empty');
  });
}
async function approve() {
  await act(async () =>
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
}
it('admits the browser fixture through the bounded body reader and exact client replay', async () => {
  const deadline = new Date(at + 90000).toISOString(),
    body = await f.preview(deadline);
  const data = await readWarmupConsentResponse(
    Response.json(body),
    new AbortController().signal,
  );
  expect(data).toEqual(body);
  expect(
    (await warmupConsentPreview(data, f.plan, f.view, f.retained, deadline))
      .summary.actionCount,
  ).toBe(4);
});
it('does not fetch on mount and requires a separate unchecked approval before one exact save', async () => {
  await mount();
  expect(fetch).not.toHaveBeenCalled();
  expect(host.querySelector('input[type="password"]')).toBeNull();
  await review();
  expect(
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked,
  ).toBe(false);
  expect(button('Save plan approval').disabled).toBe(true);
  expect(writes).toBe(0);
  await approve();
  await click('Save plan approval');
  await done(() => expect(host.textContent).toContain('Plan approval saved.'));
  expect(writes).toBe(1);
  expect(host.textContent).toContain('Automatic Start is still unavailable');
  expect(JSON.parse(sessionStorage.getItem(key())!)).not.toHaveProperty(
    'reviewDocument',
  );
  expect(JSON.parse(sessionStorage.getItem(key())!)).not.toHaveProperty(
    'contextKey',
  );
});
it('keeps a lost save ID and recovers with GET without resending approval', async () => {
  lost = true;
  await mount();
  await review();
  await approve();
  await click('Save plan approval');
  await done(() =>
    expect(host.textContent).toContain('Save outcome is unconfirmed'),
  );
  const marker = JSON.parse(sessionStorage.getItem(key())!);
  expect(writes).toBe(1);
  expect(button('Review plan approval').disabled).toBe(true);
  await click('Recover plan approval');
  await done(() =>
    expect(host.textContent).toContain('Recorded plan approval recovered'),
  );
  expect(reads).toBe(1);
  expect(writes).toBe(1);
  expect(stored!.consent.id).toBe(marker.id);
});
it('clears the checkbox and terms whenever the finish deadline changes', async () => {
  await mount();
  await review();
  await approve();
  await act(async () => {
    const select = host.querySelector('select')!;
    select.value = '3';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(button('Save plan approval')).toBeUndefined();
  expect(writes).toBe(0);
  await review();
  expect(
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked,
  ).toBe(false);
});
it('discards a late preview after the source context is removed', async () => {
  let resolve!: (value: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    ),
  );
  await mount();
  await click('Review plan approval');
  await mount(null);
  const old = await f.preview(new Date(at + 90000).toISOString());
  await act(async () => resolve(Response.json(old)));
  expect(button('Save plan approval')).toBeUndefined();
  expect(host.textContent).toContain('Request and save a fresh session review');
});
it('requires a fresh review after source expiry without sending an approval', async () => {
  await mount();
  await review();
  await approve();
  await act(async () => vi.advanceTimersByTime(60000));
  expect(button('Save plan approval')).toBeUndefined();
  expect(writes).toBe(0);
  expect(host.textContent).toContain('source review expired');
});
it('withholds the save if its recovery reminder cannot be persisted', async () => {
  await mount();
  await review();
  await approve();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('blocked');
  });
  await click('Save plan approval');
  await done(() =>
    expect(host.textContent).toContain('No approval save was sent'),
  );
  expect(writes).toBe(0);
});
it('restores a minimal reminder without fetching and keeps it after a missing recovery', async () => {
  const p = await f.preview(new Date(at + 90000).toISOString()),
    marker = {
      id: '00000000-0000-4000-8000-000000000002',
      planId: f.plan.id,
      reviewId: f.retained.id,
      reviewSha256: f.retained.reviewSha256,
      sessionExpiresAt: p.consentReview.terms.sessionExpiresAt,
      termsSha256: p.consentReview.termsSha256,
    };
  sessionStorage.setItem(key(), JSON.stringify(marker));
  await mount();
  expect(fetch).not.toHaveBeenCalled();
  expect(button('Review plan approval').disabled).toBe(true);
  await click('Recover plan approval');
  await done(() =>
    expect(host.textContent).toContain('does not cancel a save'),
  );
  expect(JSON.parse(sessionStorage.getItem(key())!).id).toBe(marker.id);
  expect(writes).toBe(0);
});
it('blocks a malformed local reminder and requires a fresh source after explicit clearing', async () => {
  sessionStorage.setItem(key(), '{oops');
  await mount();
  expect(button('Review plan approval').disabled).toBe(true);
  await click('Clear local approval reminder');
  expect(button('Review plan approval').disabled).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});
it('never displays HTML or raw parser details from a review failure', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('<html>private diagnostic', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
    ),
  );
  await mount();
  await click('Review plan approval');
  await done(() => expect(host.textContent).toContain('could not be reviewed'));
  expect(host.textContent).not.toMatch(
    /private diagnostic|Unexpected token|<html>/,
  );
  expect(writes).toBe(0);
});
it('withholds confirmation for a changed saved response and retains the original marker', async () => {
  const normal = fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      const result = await normal(url, options);
      if (
        options?.body &&
        JSON.parse(options.body as string).operation === 'save'
      )
        return Response.json({
          consent: { ...stored!.consent, id: crypto.randomUUID() },
        });
      return result;
    }),
  );
  await mount();
  await review();
  await approve();
  await click('Save plan approval');
  await done(() =>
    expect(host.textContent).toContain('Save outcome is unconfirmed'),
  );
  expect(host.textContent).not.toContain('Plan approval saved.');
  expect(sessionStorage.getItem(key())).not.toBeNull();
  expect(writes).toBe(1);
});
it('stops a stalled save body, retains unknown outcome and recovers without a retry', async () => {
  const normal = fetch;
  let cancelled = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      const result = await normal(url, options);
      if (
        options?.body &&
        JSON.parse(options.body as string).operation === 'save'
      )
        return new Response(
          new ReadableStream({
            pull() {
              return new Promise(() => {});
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      return result;
    }),
  );
  await mount();
  await review();
  await approve();
  await click('Save plan approval');
  await done(() => expect(writes).toBe(1));
  await click('Stop waiting for approval');
  expect(cancelled).toBe(true);
  expect(writes).toBe(1);
  expect(host.textContent).toContain('may have been saved');
  await click('Recover plan approval');
  await done(() =>
    expect(host.textContent).toContain('Recorded plan approval recovered'),
  );
  expect(writes).toBe(1);
});
it('recovers an existing approval under another identity without repeating a write or changing its deadline', async () => {
  const normal = fetch,
    original = '00000000-0000-4000-8000-000000000003';
  let attempts = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (
        options?.body &&
        JSON.parse(options.body as string).operation === 'save'
      ) {
        attempts++;
        stored = f.saved(original, latest!);
        return Response.json(
          {
            error:
              'This review already has a saved plan approval. Recover its original approval ID.',
            recoveryId: original,
          },
          { status: 409 },
        );
      }
      return normal(url, options);
    }),
  );
  await mount();
  await review();
  await approve();
  await click('Save plan approval');
  await done(() => expect(button('Recover original approval')).toBeDefined());
  const attempt = JSON.parse(sessionStorage.getItem(key())!);
  expect(attempt.id).not.toBe(original);
  await click('Recover original approval');
  await done(() =>
    expect(host.textContent).toContain('Recorded plan approval recovered'),
  );
  expect(attempts).toBe(1);
  expect(reads).toBe(1);
  expect(JSON.parse(sessionStorage.getItem(key())!).id).toBe(original);
  expect(stored!.consent.terms.sessionExpiresAt).toBe(
    latest!.consentReview.terms.sessionExpiresAt,
  );
});
