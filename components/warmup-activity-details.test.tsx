// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WarmupActivityDetails } from './warmup-activity-details';
import { warmupSavedDisplayFixture } from '../test/warmup-saved-plan-display-fixture';
import { PANEL_JSON_RESPONSE_BYTES } from '@/lib/read-bounded-panel-json';
import { WarmupApprovalHistory } from './warmup-approval-history';
import { warmupUiFixture } from '../test/warmup-ui-fixture';
import type { WarmupApprovalHistoryRow } from '@/lib/warmup-approval-history';

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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
const plan = () => warmupSavedDisplayFixture();
const props = () => ({
  id: plan().id,
  refreshRevision: 0,
  onClose: vi.fn(),
  onOpenWallets: vi.fn(),
});
const button = (name: string) =>
  Array.from(host.querySelectorAll('button')).find(
    (b) => b.textContent === name,
  )!;
const click = async (name: string) => act(async () => button(name).click());
const alert = () => host.querySelector('[role="alert"]')?.textContent;
const ok = () => Response.json({ plan: plan() });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

it('loads the selected historical plan with one GET, keeps children collapsed and navigation explicit', async () => {
  const fetcher = vi.fn(async () => ok());
  vi.stubGlobal('fetch', fetcher);
  const p = props();
  await act(async () => root.render(<WarmupActivityDetails {...p} />));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]).toEqual([
    `/api/wallet-workspace/warmup/plans?id=${plan().id}`,
    expect.objectContaining({
      cache: 'no-store',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    }),
  ]);
  expect(host.textContent).toContain('Historical warmup fixture');
  expect(host.textContent).toContain('Archived');
  expect(host.textContent).toContain('Total budget: 0.004 SOL');
  expect(host.textContent).toContain('Fee reserve per wallet: 0.002 SOL');
  expect(document.activeElement).toBe(host.querySelector('h2'));
  expect(p.onOpenWallets).not.toHaveBeenCalled();
  await click('Open warmup in My wallets');
  expect(p.onOpenWallets).toHaveBeenCalledExactlyOnceWith(plan().id);
  await click('Close warmup details');
  expect(p.onClose).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each([
  'HTML',
  'null',
  'missing tokens',
  'object field',
  'oversized',
  'invalid UTF-8',
])(
  'recovers manually from %s without raw diagnostics or navigation',
  async (kind) => {
    const saved = plan();
    const response = () => {
      if (kind === 'HTML')
        return new Response('<html>Private upstream diagnostics</html>', {
          status: 502,
        });
      if (kind === 'null') return Response.json(null);
      if (kind === 'oversized')
        return new Response(' '.repeat(PANEL_JSON_RESPONSE_BYTES + 1), {
          headers: { 'content-type': 'application/json' },
        });
      if (kind === 'invalid UTF-8')
        return new Response(new Uint8Array([255]), {
          headers: { 'content-type': 'application/json' },
        });
      if (kind === 'missing tokens')
        delete (saved.document as Partial<typeof saved.document>).tokens;
      else
        (saved.document as unknown as { name: unknown }).name = {
          broken: true,
        };
      return Response.json({ plan: saved });
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockImplementation(async () => ok());
    vi.stubGlobal('fetch', fetcher);
    const p = props();
    await act(async () => root.render(<WarmupActivityDetails {...p} />));
    expect(alert()).toMatch(/Saved warmup/);
    expect(host.textContent).not.toMatch(
      /Unexpected|Cannot read|Private upstream|<html>|ZodError/,
    );
    expect(host.querySelector('h3')).toBeNull();
    expect(button('Open warmup in My wallets')).toBeUndefined();
    expect(button('Reload saved warmup').disabled).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await click('Reload saved warmup');
    expect(host.querySelector('h3')?.textContent).toBe(
      'Historical warmup fixture',
    );
    expect(alert()).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(p.onOpenWallets).not.toHaveBeenCalled();
  },
);

it.each([
  [401, 'Sign in again'],
  [404, 'no longer available'],
  [429, 'Wait a moment'],
])(
  'gives a usable %i response even for an HTML body',
  async (status, message) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>private</html>', { status })),
    );
    await act(async () => root.render(<WarmupActivityDetails {...props()} />));
    expect(alert()).toContain(message);
  },
);

it('times out a stalled fetch and ignores its late success after explicit retry', async () => {
  vi.useFakeTimers();
  const old = deferred<Response>();
  const fetcher = vi
    .fn()
    .mockReturnValueOnce(old.promise)
    .mockImplementation(async () => ok());
  vi.stubGlobal('fetch', fetcher);
  await act(async () => root.render(<WarmupActivityDetails {...props()} />));
  expect(button('Reload saved warmup').disabled).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(alert()).toContain('took too long');
  expect((fetcher.mock.calls[0][1] as RequestInit).signal!.aborted).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await click('Reload saved warmup');
  await act(async () =>
    old.resolve(
      Response.json({
        plan: {
          ...plan(),
          document: { ...plan().document, name: 'Late old plan' },
        },
      }),
    ),
  );
  expect(host.querySelector('h3')?.textContent).toBe(
    'Historical warmup fixture',
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('cancels a stalled JSON body without auto retry or a late error replacing cancellation', async () => {
  vi.useFakeTimers();
  const cancelled = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('{"plan":'));
    },
    cancel: cancelled,
  });
  const fetcher = vi.fn(
    async () =>
      new Response(body, { headers: { 'content-type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fetcher);
  await act(async () => root.render(<WarmupActivityDetails {...props()} />));
  await click('Cancel saved warmup read');
  expect(alert()).toContain('cancelled');
  expect(cancelled).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(alert()).toContain('cancelled');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('times out a stalled JSON body as well as stalled headers', async () => {
  vi.useFakeTimers();
  const cancelled = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(new ReadableStream({ cancel: cancelled }), {
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
  await act(async () => root.render(<WarmupActivityDetails {...props()} />));
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(alert()).toContain('took too long');
  expect(cancelled).toHaveBeenCalledTimes(1);
});

it('aborts old context and unmount, ignores late results, and does not steal focus after a reply', async () => {
  const old = deferred<Response>(),
    current = deferred<Response>();
  const fetcher = vi
    .fn()
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(current.promise);
  vi.stubGlobal('fetch', fetcher);
  const p = props();
  await act(async () => root.render(<WarmupActivityDetails {...p} />));
  await act(async () =>
    root.render(<WarmupActivityDetails {...p} refreshRevision={1} />),
  );
  expect((fetcher.mock.calls[0][1] as RequestInit).signal!.aborted).toBe(true);
  const outside = document.createElement('button');
  document.body.appendChild(outside);
  outside.focus();
  await act(async () => old.resolve(ok()));
  expect(host.querySelector('h3')).toBeNull();
  await act(async () => current.resolve(ok()));
  expect(document.activeElement).toBe(outside);
  expect(host.querySelector('h3')).not.toBeNull();
  await act(async () => root.render(null));
  expect((fetcher.mock.calls[1][1] as RequestInit).signal!.aborted).toBe(true);
  outside.remove();
});

it('does not send a read for an invalid plan identity', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await act(async () =>
    root.render(<WarmupActivityDetails {...props()} id="../other" />),
  );
  expect(alert()).toBe('Choose a saved warmup plan.');
  expect(fetcher).not.toHaveBeenCalled();
});

function approvalRows() {
  const review = warmupUiFixture().review('Buy');
  return (['awaiting_signature', 'signed', 'submitted', 'failed'] as const).map(
    (state, i) => {
      const id = `approval-${i}`;
      return {
        id,
        preparationId: review.preparationId,
        planId: plan().id,
        planRevision: plan().revision,
        wallet: review.wallet,
        cycle: 1,
        side: 'Buy',
        state,
        signature:
          state === 'awaiting_signature' ? null : 'SYNTHETIC_SIGNATURE_ONLY',
        createdAt: plan().updatedAt,
        updatedAt: plan().updatedAt,
        document: { ...review, id },
      } satisfies WarmupApprovalHistoryRow;
    },
  );
}

it('opens Activity approval history explicitly as view-only and retains no write controls across reloads', async () => {
  const fetcher = vi.fn(async (input: string) =>
    input.includes('/signing?')
      ? Response.json({
          planId: plan().id,
          intents: approvalRows(),
          nextCursor: null,
        })
      : ok(),
  );
  vi.stubGlobal('fetch', fetcher);
  const p = props();
  await act(async () => root.render(<WarmupActivityDetails {...p} />));
  expect(fetcher).toHaveBeenCalledTimes(1);
  await click('View saved approvals');
  expect(host.querySelectorAll('article')).toHaveLength(4);
  expect(host.textContent).toContain(
    'Open warmup in My wallets for cancellation',
  );
  expect(host.querySelector('input[type=checkbox]')).toBeNull();
  for (const name of [
    'Cancel this unsigned approval',
    'Check finalized outcome',
    'Check original failure evidence',
    'Verify finalized buy receipt',
    'Submit this saved signed transaction to mainnet',
  ])
    expect(button(name)).toBeUndefined();
  await click('Reload saved warmup');
  expect(button('View saved approvals')).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls.every(([url]) => !url.includes('/receipts'))).toBe(
    true,
  );
});

it('keeps default My wallets recovery controls and unchecked submission approval unchanged', async () => {
  const active = { ...plan(), archived: false };
  const fetcher = vi.fn(async () =>
    Response.json({
      planId: active.id,
      intents: approvalRows(),
      nextCursor: null,
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  await act(async () => root.render(<WarmupApprovalHistory plan={active} />));
  expect(fetcher).not.toHaveBeenCalled();
  await click('Open approval recovery');
  expect(button('Cancel this unsigned approval')).toBeTruthy();
  expect(
    button('Submit this saved signed transaction to mainnet').disabled,
  ).toBe(true);
  expect(
    (host.querySelector('input[type=checkbox]') as HTMLInputElement).checked,
  ).toBe(false);
  expect(button('Check original failure evidence')).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('renders a historical unsupported network in native units without mounting Solana approval recovery', async () => {
  const saved = plan();
  saved.document.chain = 'FormerNetwork';
  const fetcher = vi.fn(async () => Response.json({ plan: saved }));
  vi.stubGlobal('fetch', fetcher);
  await act(async () => root.render(<WarmupActivityDetails {...props()} />));
  expect(host.textContent).toContain('Total budget: 0.004 native units');
  expect(button('View saved approvals')).toBeUndefined();
  expect(alert()).toBeUndefined();
});

it('opens an explicitly selected public run timeline and leaves saved approvals collapsed', async () => {
  const run = { id: 'public-run-fixture', revision: 2 };
  const fetcher = vi.fn(async (input: string) =>
    input.includes('/runs/events?')
      ? Response.json({
          id: run.id,
          events: [],
          nextBefore: null,
          executionAllowed: false,
        })
      : ok(),
  );
  vi.stubGlobal('fetch', fetcher);
  await act(async () =>
    root.render(<WarmupActivityDetails {...props()} run={run} />),
  );
  expect(button('Close run timeline')).toBeTruthy();
  expect(button('View saved approvals')).toBeTruthy();
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(
    expect.arrayContaining([
      `/api/wallet-workspace/warmup/plans?id=${plan().id}`,
      `/api/wallet-workspace/warmup/runs/events?id=${run.id}`,
    ]),
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
});
