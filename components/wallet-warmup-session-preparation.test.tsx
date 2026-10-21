// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setImmediate as nextTurn } from 'node:timers';
import { webcrypto } from 'node:crypto';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { WalletWarmupSessionPreparation } from './wallet-warmup-session-preparation';
import { warmupPreparationClientFixture } from '@/test/warmup-session-preparation-client-fixture';
const at = Date.parse('2026-10-21T12:00:00.000Z'),
  onBusy = vi.fn();
let host: HTMLDivElement,
  root: Root,
  f: Awaited<ReturnType<typeof warmupPreparationClientFixture>>,
  saved: ReturnType<typeof f.preparation> | null;
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
  f = await warmupPreparationClientFixture(at);
  saved = null;
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
        saved = f.preparation(id);
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
  await act(async () =>
    root.render(
      <WalletWarmupSessionPreparation
        journal={journal}
        context={f.context}
        disabled={disabled}
        onBusyChange={onBusy}
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
    const checkbox = host.querySelector('input')!;
    checkbox.click();
  });
}
async function ready() {
  await render();
  await settle(() => expect(host.querySelector('input')?.disabled).toBe(false));
}
it('has a separate unchecked approval, no mount request and no signing control', async () => {
  await ready();
  expect(calls).toHaveLength(0);
  expect(host.querySelector('input')?.checked).toBe(false);
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
    expect(host.textContent).toContain('Unsigned preparation recovered'),
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
    expect(host.textContent).toContain('Unsigned preparation recovered'),
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
    expect(host.textContent).toContain('Unsigned preparation recovered'),
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
    expect(host.textContent).toContain('Unsigned preparation recovered'),
  );
  expect(writes()).toHaveLength(1);
});
it('expires the review without renewal while keeping GET recovery available', async () => {
  await ready();
  await approve();
  await click('Prepare unsigned action');
  await settle(() =>
    expect(host.textContent).toContain('Unsigned preparation recovered'),
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
  expect(host.textContent).not.toContain('Unsigned preparation recovered');
  expect(host.textContent).toContain('Recover its original ID');
  expect(button('Retry this preparation request').disabled).toBe(true);
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
});
it('invalidates an in-flight result on a newer journal head and preserves original-head GET recovery', async () => {
  await ready();
  await approve();
  await click('Prepare unsigned action');
  await settle(() =>
    expect(host.textContent).toContain('Unsigned preparation recovered'),
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
