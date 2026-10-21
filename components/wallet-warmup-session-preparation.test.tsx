// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setImmediate as nextTurn } from 'node:timers';
import { webcrypto } from 'node:crypto';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { WalletWarmupSessionPreparation } from './wallet-warmup-session-preparation';
import { warmupPreparationClientFixture } from '@/test/warmup-session-preparation-client-fixture';
const at = Date.parse('2026-10-21T12:00:00.000Z'),
  onBusy = vi.fn(),
  onRecovered = vi.fn();
let host: HTMLDivElement,
  root: Root,
  f: Awaited<ReturnType<typeof warmupPreparationClientFixture>>,
  saved: ReturnType<typeof f.preparation> | null;
let currentReview: typeof f.journal;
let calls: { method: string; id: string }[], lose: boolean, notFound: boolean;
const storageKey = () =>
  'bundle:warmup-preparation-request:' + f.context.consentId;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(at);
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  sessionStorage.clear();
  onBusy.mockClear();
  onRecovered.mockClear();
  f = await warmupPreparationClientFixture(at);
  saved = null;
  currentReview = f.journal;
  calls = [];
  lose = false;
  notFound = false;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      expect(
        input.startsWith('/api/wallet-workspace/warmup/session-preparations'),
      ).toBe(true);
      const method = init?.method ?? 'GET';
      const body = method === 'POST' ? JSON.parse(init!.body as string) : null;
      const id =
        body?.id ?? new URL(input, 'http://localhost').searchParams.get('id');
      calls.push({ method, id });
      if (method === 'POST') {
        const marker = JSON.parse(sessionStorage.getItem(storageKey())!);
        expect(marker.id).toBe(id);
        expect(marker.journal.headSha256).toBe(body.headSha256);
        saved = f.preparation(id, currentReview);
        if (lose) {
          lose = false;
          throw Error('Lost synthetic reply');
        }
      }
      return saved && !notFound
        ? Response.json(saved)
        : Response.json({ error: 'Missing' }, { status: 404 });
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
const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label)!;
const writes = () => calls.filter((c) => c.method === 'POST');
async function render(journal = f.journal, disabled = false) {
  currentReview = journal;
  await act(async () =>
    root.render(
      <WalletWarmupSessionPreparation
        journal={journal}
        context={f.context}
        disabled={disabled}
        onBusyChange={onBusy}
        onRecovered={onRecovered}
      />,
    ),
  );
}
async function settle(check: () => void) {
  let failure: unknown;
  for (let n = 0; n < 45; n++) {
    await act(async () => {
      await new Promise<void>((r) => nextTurn(r));
    });
    try {
      check();
      return;
    } catch (e) {
      failure = e;
    }
  }
  throw failure;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function approve() {
  await act(async () => {
    const checkbox = host.querySelector<HTMLInputElement>(
      'input[type=checkbox]',
    )!;
    checkbox.click();
  });
}
async function typeRecovery(id: string) {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>(
      'input:not([type=checkbox])',
    )!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, id);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function ready() {
  await render();
  await settle(() =>
    expect(
      host.querySelector<HTMLInputElement>('input[type=checkbox]')?.disabled,
    ).toBe(false),
  );
}
it('has a separate unchecked approval, no mount request and no signing control', async () => {
  await ready();
  expect(calls).toHaveLength(0);
  expect(
    host.querySelector<HTMLInputElement>('input[type=checkbox]')?.checked,
  ).toBe(false);
  expect(button('Prepare unsigned action').disabled).toBe(true);
  expect(host.textContent).toContain(
    'Signing and automatic activity remain off',
  );
});
it('persists the original ID/head before one POST and displays honest provisional values', async () => {
  await ready();
  await approve();
  await click('Prepare unsigned action');
  await settle(() =>
    expect(host.textContent).toMatch(/Unsigned preparation (saved|recovered)/),
  );
  expect(writes()).toHaveLength(1);
  expect(host.textContent).toContain('101 token base units');
  expect(host.textContent).toContain('Minimum output');
  expect(host.textContent).toContain('not additive');
  expect(host.textContent).not.toContain('private-bytes');
});
it('holds a lost reply and recovers by GET with no replacement or automatic retry', async () => {
  lose = true;
  await ready();
  await approve();
  await click('Prepare unsigned action');
  await settle(() => expect(host.querySelector('[role=alert]')).toBeTruthy());
  const id = writes()[0].id;
  expect(button('Retry this preparation request').disabled).toBe(true);
  await click('Recover saved preparation');
  await settle(() =>
    expect(host.textContent).toMatch(/Unsigned preparation (saved|recovered)/),
  );
  expect(calls.map((c) => c.method)).toEqual(['POST', 'GET']);
  expect(calls.every((c) => c.id === id)).toBe(true);
});
it('recovers a saved original head on remount without provider POST', async () => {
  await ready();
  await approve();
  await click('Prepare unsigned action');
  await settle(() => expect(writes()).toHaveLength(1));
  await settle(() =>
    expect(host.textContent).toMatch(/Unsigned preparation (saved|recovered)/),
  );
  await act(async () => root.unmount());
  root = createRoot(host);
  await render();
  await settle(() => expect(calls).toHaveLength(2));
  expect(calls[1].method).toBe('GET');
  expect(writes()).toHaveLength(1);
});
it('refuses a modified response and never exposes an HTML/parser error', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('<html>private provider key</html>', {
          headers: { 'content-type': 'text/html' },
        }),
    ),
  );
  await ready();
  await approve();
  await click('Prepare unsigned action');
  await settle(() => expect(host.querySelector('[role=alert]')).toBeTruthy());
  expect(host.textContent).not.toContain('private provider key');
  expect(host.textContent).not.toContain('Unexpected token');
});
it('blocks writes when reminder storage fails, preserving the in-memory original ID', async () => {
  await ready();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('blocked');
  });
  await approve();
  await click('Prepare unsigned action');
  await settle(() => expect(host.querySelector('[role=alert]')).toBeTruthy());
  expect(writes()).toHaveLength(0);
  expect(host.textContent).toContain('Request:');
  expect(button('Retry this preparation request').disabled).toBe(true);
});
it('does not accept rapid duplicate prepare clicks', async () => {
  await ready();
  await approve();
  await act(async () => {
    button('Prepare unsigned action').click();
    button('Prepare unsigned action').click();
  });
  await settle(() =>
    expect(host.textContent).toMatch(/Unsigned preparation (saved|recovered)/),
  );
  expect(writes()).toHaveLength(1);
});
it('expires the review without renewal while keeping GET recovery available', async () => {
  await ready();
  await approve();
  await click('Prepare unsigned action');
  await settle(() =>
    expect(host.textContent).toMatch(/Unsigned preparation (saved|recovered)/),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(31000);
  });
  expect(host.textContent).toContain('expired');
  expect(button('Recover saved preparation').disabled).toBe(false);
  expect(writes()).toHaveLength(1);
});
it('requires GET absence before an explicit same-ID retry, retaining consent gating', async () => {
  lose = true;
  await ready();
  await approve();
  await click('Prepare unsigned action');
  await settle(() => expect(host.querySelector('[role=alert]')).toBeTruthy());
  saved = null;
  currentReview = f.journal;
  await click('Recover saved preparation');
  await settle(() =>
    expect(host.textContent).toContain('No saved result is confirmed'),
  );
  expect(button('Retry this preparation request').disabled).toBe(true);
  await approve();
  await click('Retry this preparation request');
  await settle(() => expect(writes()).toHaveLength(2));
  expect(writes()[0].id).toBe(writes()[1].id);
});
it('holds cancellation and ignores a late noncooperative response', async () => {
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
  await ready();
  await approve();
  await click('Prepare unsigned action');
  await settle(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));
  const id = JSON.parse(sessionStorage.getItem(storageKey())!).id;
  await click('Cancel preparation request');
  await act(async () => resolve(Response.json(f.preparation(id))));
  expect(host.textContent).not.toMatch(
    /Unsigned preparation (saved|recovered)/,
  );
  expect(host.textContent).toContain('Recover its original ID');
  expect(button('Retry this preparation request').disabled).toBe(true);
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
});
it('does not publish a late busy change after its original panel unmounts', async () => {
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
  await ready();
  await approve();
  await click('Prepare unsigned action');
  await settle(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));
  const id = JSON.parse(sessionStorage.getItem(storageKey())!).id;
  await act(async () => root.unmount());
  root = createRoot(host);
  onBusy.mockClear();
  await act(async () => {
    resolve(Response.json(f.preparation(id)));
    await new Promise<void>((r) => nextTurn(r));
  });
  expect(onBusy).not.toHaveBeenCalled();
});
it('preserves original-head GET recovery after the current saved head advances', async () => {
  await ready();
  await approve();
  await click('Prepare unsigned action');
  await settle(() =>
    expect(host.textContent).toMatch(/Unsigned preparation (saved|recovered)/),
  );
  const newer = structuredClone(f.journal);
  newer.version++;
  newer.headSha256 = 'c'.repeat(64);
  await render(newer);
  await click('Recover saved preparation');
  await settle(() => expect(calls).toHaveLength(2));
  expect(calls[1].method).toBe('GET');
  expect(writes()).toHaveLength(1);
  expect(
    JSON.parse(sessionStorage.getItem(storageKey())!).journal.headSha256,
  ).toBe(f.journal.headSha256);
});
it('ignores an in-flight response after the current head changes', async () => {
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
  await ready();
  await approve();
  await click('Prepare unsigned action');
  await settle(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));
  const id = JSON.parse(sessionStorage.getItem(storageKey())!).id;
  const newer = structuredClone(f.journal);
  newer.version++;
  newer.headSha256 = 'c'.repeat(64);
  await render(newer);
  await act(async () => {
    resolve(Response.json(f.preparation(id)));
    await new Promise<void>((r) => nextTurn(r));
  });
  expect(host.textContent).not.toMatch(
    /Unsigned preparation (saved|recovered)/,
  );
  expect(
    host.querySelector<HTMLInputElement>('input[type=checkbox]'),
  ).toBeNull();
  expect(
    JSON.parse(sessionStorage.getItem(storageKey())!).journal.headSha256,
  ).toBe(f.journal.headSha256);
});
it('holds a 429 with fixed guidance and no automatic retry', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ error: 'private upstream response' }, { status: 429 }),
    ),
  );
  await ready();
  await approve();
  await click('Prepare unsigned action');
  await settle(() => expect(host.textContent).toContain('rate limited'));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  expect(host.textContent).not.toContain('private upstream response');
  expect(button('Retry this preparation request').disabled).toBe(true);
});
it('retires only a confirmed absent request at a changed head, then requires new consent', async () => {
  lose = true;
  await ready();
  await approve();
  await click('Prepare unsigned action');
  await settle(() => expect(host.querySelector('[role=alert]')).toBeTruthy());
  const id = writes()[0].id;
  saved = null;
  const newer = structuredClone(f.journal);
  newer.version++;
  newer.headSha256 = 'c'.repeat(64);
  await render(newer);
  expect(button('Retire absent request')).toBeUndefined();
  await click('Recover saved preparation');
  await settle(() => expect(button('Retire absent request')).toBeTruthy());
  await click('Retire absent request');
  expect(sessionStorage.getItem(storageKey())).toBeNull();
  expect(button('Prepare unsigned action').disabled).toBe(true);
  await approve();
  await click('Prepare unsigned action');
  await settle(() => expect(writes()).toHaveLength(2));
  expect(writes()[1].id).not.toBe(id);
  expect(
    JSON.parse(sessionStorage.getItem(storageKey())!).journal.headSha256,
  ).toBe(newer.headSha256);
});
it('keeps a colliding ID across GET absence and remount without adopting or fetching it', async () => {
  const earlier = '00000000-0000-4000-8000-000000000009';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET',
        id =
          method === 'POST'
            ? JSON.parse(init!.body as string).id
            : new URL(input, 'http://localhost').searchParams.get('id');
      calls.push({ method, id });
      return method === 'POST'
        ? Response.json(
            { error: 'Already retained', recoveryId: earlier },
            { status: 409 },
          )
        : Response.json({ error: 'Absent' }, { status: 404 });
    }),
  );
  await ready();
  await approve();
  await click('Prepare unsigned action');
  await settle(() => expect(host.textContent).toContain(earlier));
  expect(JSON.parse(sessionStorage.getItem(storageKey())!).recoveryId).toBe(
    earlier,
  );
  await click('Recover saved preparation');
  await settle(() => expect(calls).toHaveLength(2));
  expect(button('Retry this preparation request').disabled).toBe(true);
  await act(async () => root.unmount());
  root = createRoot(host);
  await render();
  await settle(() => expect(calls).toHaveLength(3));
  expect(host.textContent).toContain(earlier);
  expect(calls.every((c) => c.id !== earlier)).toBe(true);
});
it('shows a valid unreadable local ID only as unverified guidance, without fetching it', async () => {
  const id = '00000000-0000-4000-8000-000000000008';
  sessionStorage.setItem(storageKey(), JSON.stringify({ id, invalid: true }));
  await render();
  await settle(() => expect(host.textContent).toContain('unverified local ID'));
  expect(host.textContent).toContain(id);
  expect(calls).toHaveLength(0);
  expect(button('Prepare unsigned action').disabled).toBe(true);
});
for (const status of [401, 429])
  it(`keeps specific fixed guidance on a non-JSON ${status}`, async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html>private failure</html>', {
            status,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    );
    await ready();
    await approve();
    await click('Prepare unsigned action');
    await settle(() =>
      expect(host.textContent).toContain(
        status === 401 ? 'Sign in again' : 'rate limited',
      ),
    );
    expect(host.textContent).not.toContain('private failure');
  });
for (const event of ['pagehide', 'storage', 'receipt'])
  it(`holds late publication after ${event}`, async () => {
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
    await ready();
    await approve();
    await click('Prepare unsigned action');
    await settle(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));
    const id = JSON.parse(sessionStorage.getItem(storageKey())!).id;
    await act(async () =>
      window.dispatchEvent(
        event === 'storage'
          ? new StorageEvent('storage', {
              key: storageKey(),
              storageArea: sessionStorage,
            })
          : event === 'receipt'
            ? new CustomEvent('bundle:warmup-receipt-saved', {
                detail: { planId: f.context.planId },
              })
            : new Event('pagehide'),
      ),
    );
    await act(async () => {
      resolve(Response.json(f.preparation(id)));
      await new Promise<void>((r) => nextTurn(r));
    });
    expect(host.textContent).not.toMatch(
      /Unsigned preparation (saved|recovered)/,
    );
    expect(JSON.parse(sessionStorage.getItem(storageKey())!).id).toBe(id);
  });
it('does not cancel for an unrelated child storage notification', async () => {
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
  await ready();
  await approve();
  await click('Prepare unsigned action');
  await settle(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));
  const id = JSON.parse(sessionStorage.getItem(storageKey())!).id;
  await act(async () =>
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'unrelated',
        storageArea: localStorage,
      }),
    ),
  );
  await act(async () => resolve(Response.json(f.preparation(id))));
  await settle(() =>
    expect(host.textContent).toContain('Unsigned preparation saved'),
  );
});
it('holds a timed-out request and never sends another one automatically', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_input, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init!.signal!.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          ),
        ),
    ),
  );
  await ready();
  await approve();
  await click('Prepare unsigned action');
  await settle(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30001);
  });
  expect(host.querySelector('[role=alert]')).toBeTruthy();
  expect(button('Retry this preparation request').disabled).toBe(true);
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
});
it('rejects a recovered preparation using a newer head than the original reminder', async () => {
  await ready();
  await approve();
  await click('Prepare unsigned action');
  await settle(() =>
    expect(host.textContent).toContain('Unsigned preparation saved'),
  );
  saved!.preparation.reviewHeadSha256 = 'c'.repeat(64);
  await click('Recover saved preparation');
  await settle(() => expect(host.querySelector('[role=alert]')).toBeTruthy());
  expect(writes()).toHaveLength(1);
});
it('rearms the display expiry if the local clock moves backwards', async () => {
  await ready();
  await approve();
  await click('Prepare unsigned action');
  await settle(() =>
    expect(host.textContent).toContain('Unsigned preparation saved'),
  );
  expect(document.activeElement?.getAttribute('aria-label')).toBe(
    'Saved unsigned preparation review',
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(29000);
    vi.setSystemTime(at + 28000);
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(host.textContent).not.toContain('· expired');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(host.textContent).toContain('· expired');
});
it('recovers by ID from a different browser with GET only, no reminder and no new quote', async () => {
  const id = '00000000-0000-4000-8000-000000000007';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      expect(init?.method ?? 'GET').toBe('GET');
      expect(input).toContain('/recovery?id=' + id);
      calls.push({ method: 'GET', id });
      return Response.json(f.recovery(id));
    }),
  );
  await render(f.root);
  await typeRecovery(id);
  await click('Read saved preparation context');
  await settle(() =>
    expect(host.textContent).toContain('Original unsigned review recovered'),
  );
  const marker = JSON.parse(sessionStorage.getItem(storageKey())!);
  expect(marker.id).toBe(id);
  expect(marker.recovered).toBe(true);
  expect(marker.journal.headSha256).toBe(f.journal.headSha256);
  expect(calls).toEqual([{ method: 'GET', id }]);
  expect(onRecovered).toHaveBeenCalledWith(
    expect.objectContaining({ version: 1 }),
  );
  expect(
    host.querySelector<HTMLInputElement>('input[type=checkbox]'),
  ).toBeNull();
});
it('finds a saved action without any browser reminder or known preparation ID', async () => {
  const id = '00000000-0000-4000-8000-000000000007';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      expect(input).toContain('/recovery?journalId=' + f.journal.id);
      expect(init?.method ?? 'GET').toBe('GET');
      return Response.json(f.recovery(id));
    }),
  );
  await render(f.root);
  await click('Find saved preparation');
  await settle(() =>
    expect(host.textContent).toContain('Original unsigned review recovered'),
  );
  expect(JSON.parse(sessionStorage.getItem(storageKey())!).id).toBe(id);
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  expect(host.querySelector('input[type=checkbox]')).toBeNull();
});
it('keeps an absent discovery read-only without creating a reminder or approving a retry', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: 'Absent' }, { status: 404 })),
  );
  await ready();
  await click('Find saved preparation');
  await settle(() =>
    expect(host.textContent).toContain(
      'No saved preparation is confirmed for this action',
    ),
  );
  expect(sessionStorage.getItem(storageKey())).toBeNull();
  expect(button('Prepare unsigned action').disabled).toBe(true);
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
});
it('recovers a collision only after an explicit read and preserves the unconfirmed earlier local request ID', async () => {
  const id = '00000000-0000-4000-8000-000000000009';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const selected =
        method === 'POST'
          ? JSON.parse(init!.body as string).id
          : new URL(input, 'http://localhost').searchParams.get('id');
      calls.push({ method, id: selected });
      return method === 'POST'
        ? Response.json(
            { error: 'Earlier preparation', recoveryId: id },
            { status: 409 },
          )
        : Response.json(f.recovery(id));
    }),
  );
  await ready();
  await approve();
  await click('Prepare unsigned action');
  await settle(() =>
    expect(button('Recover earlier preparation')).toBeTruthy(),
  );
  expect(calls).toHaveLength(1);
  const previous = calls[0].id;
  await click('Recover earlier preparation');
  await settle(() =>
    expect(host.textContent).toContain('Original unsigned review recovered'),
  );
  const marker = JSON.parse(sessionStorage.getItem(storageKey())!);
  expect(marker.id).toBe(id);
  expect(marker.priorRequestId).toBe(previous);
  expect(marker.recovered).toBe(true);
  expect(calls.map((c) => c.method)).toEqual(['POST', 'GET']);
});
it('does not replace the existing reminder with a wrong-owner or altered recovery context', async () => {
  const id = '00000000-0000-4000-8000-000000000009';
  lose = true;
  await ready();
  await approve();
  await click('Prepare unsigned action');
  await settle(() => expect(host.querySelector('[role=alert]')).toBeTruthy());
  const old = sessionStorage.getItem(storageKey());
  const invalid = f.recovery(id);
  invalid.recovery.originalJournal.termsSha256 = 'c'.repeat(64);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(invalid)),
  );
  await typeRecovery(id);
  await click('Read saved preparation context');
  await settle(() =>
    expect(host.textContent).toContain(
      'Saved recovery context could not be confirmed',
    ),
  );
  expect(sessionStorage.getItem(storageKey())).toBe(old);
  expect(onRecovered).not.toHaveBeenCalled();
});
it('never offers retry or retirement when a confirmed read-only recovery later reads as absent', async () => {
  const id = '00000000-0000-4000-8000-000000000007';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) =>
      input.includes('/recovery?')
        ? Response.json(f.recovery(id))
        : Response.json({ error: 'Absent' }, { status: 404 }),
    ),
  );
  await ready();
  await typeRecovery(id);
  await click('Read saved preparation context');
  await settle(() =>
    expect(host.textContent).toContain('Original unsigned review recovered'),
  );
  await act(async () => root.unmount());
  root = createRoot(host);
  await render();
  await settle(() =>
    expect(host.textContent).toContain(
      'cannot be retried as a new preparation',
    ),
  );
  expect(button('Recovered preparation · read only').disabled).toBe(true);
  expect(button('Retire absent request')).toBeUndefined();
  expect(
    host.querySelector<HTMLInputElement>('input[type=checkbox]'),
  ).toBeNull();
});
it('keeps verified recovery display read-only when storing the browser reminder fails', async () => {
  const id = '00000000-0000-4000-8000-000000000007';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(f.recovery(id))),
  );
  await ready();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('Blocked');
  });
  await typeRecovery(id);
  await click('Read saved preparation context');
  await settle(() =>
    expect(host.textContent).toContain(
      'Saved review verified, but its browser reminder could not be retained',
    ),
  );
  expect(host.textContent).toContain('Saved unsigned preparation');
  expect(
    host.querySelector<HTMLInputElement>('input[type=checkbox]'),
  ).toBeNull();
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
});
it('ignores a cancelled late context recovery response without storing or changing the parent', async () => {
  const id = '00000000-0000-4000-8000-000000000007';
  let resolve!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    ),
  );
  await ready();
  await typeRecovery(id);
  await click('Read saved preparation context');
  await settle(() => expect(button('Cancel preparation request')).toBeTruthy());
  await click('Cancel preparation request');
  await act(async () => {
    resolve(Response.json(f.recovery(id)));
    await new Promise<void>((r) => nextTurn(r));
  });
  expect(sessionStorage.getItem(storageKey())).toBeNull();
  expect(onRecovered).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain('Original unsigned review recovered');
});
for (const status of [401, 429])
  it(`keeps fixed saved-context ${status} guidance even on an HTML reply`, async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html>private error</html>', {
            status,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    );
    await ready();
    await typeRecovery('00000000-0000-4000-8000-000000000007');
    await click('Read saved preparation context');
    await settle(() =>
      expect(host.textContent).toContain(
        status === 401
          ? 'Sign in again'
          : 'Saved-context recovery is rate limited',
      ),
    );
    expect(sessionStorage.getItem(storageKey())).toBeNull();
    expect(host.textContent).not.toContain('private error');
  });
