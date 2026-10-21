// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setImmediate as nextTurn } from 'node:timers';
import { webcrypto } from 'node:crypto';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { WalletWarmupSessionProgress } from './wallet-warmup-session-progress';
import { warmupJournalClientFixture } from '@/test/warmup-session-journal-client-fixture';
import {
  warmupJournalRequest,
  type WarmupJournalView,
} from '@/lib/wallet-warmup-session-journal-view';
const at = Date.parse('2026-10-21T12:00:00.000Z'),
  onBusy = vi.fn();
let host: HTMLDivElement,
  root: Root,
  f: Awaited<ReturnType<typeof warmupJournalClientFixture>>,
  saved: WarmupJournalView | null,
  requests: { url: string; body: Record<string, unknown> | null }[],
  loseAfter: boolean,
  loseBefore: boolean,
  hideReceipt: boolean;
const receipts = new Map<
  string,
  NonNullable<WarmupJournalView['commandReceipt']>
>();
const key = () => 'bundle:warmup-journal-request:' + f.consent.id;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(at);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', webcrypto);
  sessionStorage.clear();
  onBusy.mockClear();
  f = await warmupJournalClientFixture(at);
  saved = null;
  requests = [];
  loseAfter = false;
  loseBefore = false;
  hideReceipt = false;
  receipts.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      expect(
        input.startsWith('/api/wallet-workspace/warmup/session-journals'),
      ).toBe(true);
      const body =
        init?.method === 'POST'
          ? (JSON.parse(init.body as string) as Record<string, unknown>)
          : null;
      requests.push({ url: input, body });
      if (!body) {
        if (!saved)
          return Response.json({ error: 'Not found' }, { status: 404 });
        const eventId = new URL(input, 'http://localhost').searchParams.get(
          'eventId',
        );
        return Response.json({
          journal: {
            ...saved,
            commandReceipt:
              eventId && !hideReceipt ? (receipts.get(eventId) ?? null) : null,
          },
        });
      }
      const marker = warmupJournalRequest(
        JSON.parse(sessionStorage.getItem(key())!),
        f.context,
      );
      expect(marker.id).toBe(body.id);
      if (loseBefore) {
        loseBefore = false;
        throw Error('Synthetic unsent history request');
      }
      if (body.operation === 'record') {
        if (saved && saved.id !== body.id)
          return Response.json({ error: 'Already recorded' }, { status: 409 });
        saved = saved ?? f.root(body.id as string);
      } else {
        if (!saved || marker.kind !== 'control')
          return Response.json({ error: 'Missing journal' }, { status: 404 });
        if (!receipts.has(marker.id)) {
          if (
            marker.expectedVersion !== saved.version ||
            marker.expectedHeadSha256 !== saved.headSha256
          )
            return Response.json({ error: 'Stale head' }, { status: 409 });
          saved = await f.apply(saved, marker);
          receipts.set(marker.id, saved.commandReceipt!);
        }
      }
      if (loseAfter) {
        loseAfter = false;
        throw Error('Synthetic lost reply');
      }
      return Response.json({
        journal: {
          ...saved,
          commandReceipt:
            body.operation === 'control'
              ? receipts.get(body.id as string)
              : null,
        },
      });
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
const writes = () => requests.filter((r) => r.body !== null);
async function render(consent = f.consent) {
  await act(async () =>
    root.render(
      <WalletWarmupSessionProgress consent={consent} onBusyChange={onBusy} />,
    ),
  );
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function done(check: () => void) {
  let failure: unknown;
  for (let n = 0; n < 40; n++) {
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
async function ready() {
  await render();
  await done(() => expect(button('Save session history').disabled).toBe(false));
}
async function create() {
  await ready();
  await click('Save session history');
  await done(() => expect(button('Pause plan')).toBeTruthy());
}
it('loads owned history on open without writes, keeps Start disabled and shows no technical ID in the main controls', async () => {
  await ready();
  expect(requests).toHaveLength(1);
  expect(writes()).toHaveLength(0);
  expect(button('Start automatic activity').disabled).toBe(true);
  expect(host.textContent).toContain('Automatic activity off');
  expect(host.querySelector('details')?.open).toBe(false);
  expect(requests[0].url).toContain('consentId=' + f.consent.id);
});
it('saves history once, then explicitly pauses/resumes/stops without any wallet or provider endpoint', async () => {
  await create();
  expect(writes()).toHaveLength(1);
  expect(host.textContent).toContain('0 of 4 actions recorded');
  await click('Pause plan');
  await done(() => expect(button('Resume plan')).toBeTruthy());
  await click('Resume plan');
  await done(() => expect(button('Pause plan')).toBeTruthy());
  await click('Stop plan');
  await done(() => expect(host.textContent).toContain('Plan stopped'));
  expect(
    writes().map((r) =>
      r.body!.operation === 'record' ? 'record' : r.body!.control,
    ),
  ).toEqual(['record', 'pause', 'resume', 'stop']);
  expect(button('Resume plan')).toBeUndefined();
  expect(button('Start automatic activity').disabled).toBe(true);
  expect(sessionStorage.getItem(key())).toBeNull();
});
it('prevents a rapid double click from creating a second request', async () => {
  await ready();
  await act(async () => {
    button('Save session history').click();
    button('Save session history').click();
  });
  await done(() => expect(button('Pause plan')).toBeTruthy());
  expect(writes()).toHaveLength(1);
});
it('recovers a committed lost root response by approval ID without a new POST', async () => {
  await ready();
  loseAfter = true;
  await click('Save session history');
  await done(() =>
    expect(host.textContent).toContain('Request needs recovery'),
  );
  const id = JSON.parse(sessionStorage.getItem(key())!).id;
  await click('Recover request');
  await done(() => expect(sessionStorage.getItem(key())).toBeNull());
  expect(writes()).toHaveLength(1);
  expect(saved?.id).toBe(id);
  expect(button('Pause plan')).toBeTruthy();
});
it('recovers a lost control response using the exact event ID and receipt hash without another POST', async () => {
  await create();
  loseAfter = true;
  await click('Pause plan');
  await done(() =>
    expect(host.textContent).toContain('Request needs recovery'),
  );
  const marker = JSON.parse(sessionStorage.getItem(key())!);
  await click('Recover request');
  await done(() => expect(sessionStorage.getItem(key())).toBeNull());
  expect(requests.at(-1)!.url).toContain('eventId=' + marker.id);
  expect(writes()).toHaveLength(2);
  expect(button('Resume plan')).toBeTruthy();
});
it('allows an explicit metadata retry only after recovery and reuses the original request ID', async () => {
  await ready();
  loseBefore = true;
  await click('Save session history');
  await done(() =>
    expect(host.textContent).toContain('Request needs recovery'),
  );
  const first = writes()[0].body!.id;
  expect(button('Retry this history request').disabled).toBe(true);
  await click('Recover request');
  await done(() =>
    expect(button('Retry this history request').disabled).toBe(false),
  );
  await click('Retry this history request');
  await done(() => expect(button('Pause plan')).toBeTruthy());
  expect(writes().map((r) => r.body!.id)).toEqual([first, first]);
});
it('does not silently confirm a missing control receipt or retry it against a newer head', async () => {
  await create();
  loseAfter = true;
  await click('Pause plan');
  await done(() =>
    expect(host.textContent).toContain('Request needs recovery'),
  );
  hideReceipt = true;
  await click('Recover request');
  await done(() => expect(button('Continue from saved status')).toBeTruthy());
  expect(sessionStorage.getItem(key())).not.toBeNull();
  expect(writes()).toHaveLength(2);
  expect(button('Retry this history request').disabled).toBe(true);
  await click('Continue from saved status');
  expect(sessionStorage.getItem(key())).toBeNull();
  expect(writes()).toHaveLength(2);
});
it('rejects raw HTML errors without exposing parser or provider text', async () => {
  await ready();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('<html>PRIVATE_PROVIDER_TOKEN', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
    ),
  );
  await click('Refresh saved status');
  await done(() => expect(host.querySelector('[role=alert]')).toBeTruthy());
  expect(host.textContent).not.toContain('PRIVATE_PROVIDER_TOKEN');
  expect(host.textContent).not.toContain('Unexpected token');
});
it('refuses writes if the browser cannot persist the recovery ID first', async () => {
  await ready();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('Synthetic storage refusal');
  });
  await click('Save session history');
  await done(() => expect(host.querySelector('[role=alert]')).toBeTruthy());
  expect(writes()).toHaveLength(0);
});
it('keeps a malformed reminder held until an explicit clear and fresh read, with no automatic save', async () => {
  sessionStorage.setItem(key(), '{bad');
  await render();
  await done(() =>
    expect(button('Clear local session reminder').disabled).toBe(false),
  );
  expect(button('Save session history').disabled).toBe(true);
  await click('Clear local session reminder');
  expect(button('Save session history').disabled).toBe(true);
  await click('Refresh saved status');
  await done(() => expect(button('Save session history').disabled).toBe(false));
  expect(writes()).toHaveLength(0);
});
it('recovers existing history without a local reminder and never treats expiry as permission to run', async () => {
  saved = f.root();
  await render();
  await done(() => expect(button('Pause plan')).toBeTruthy());
  await act(async () => vi.advanceTimersByTimeAsync(60001));
  expect(host.textContent).toContain('Fresh review required');
  expect(host.textContent).toContain('Review expired at');
  expect(button('Start automatic activity').disabled).toBe(true);
  expect(writes()).toHaveLength(0);
});
it('keeps an unknown outcome prominent after Stop and labels reserves as budgets', async () => {
  saved = f.root();
  saved.version = 3;
  saved.recoveryRequired = true;
  saved.snapshot.stopped = true;
  saved.snapshot.phase = 'recovery-required';
  const a = f.context.actions[0];
  saved.snapshot.pending = {
    state: 'unknown',
    action: {
      id: a.id,
      side: a.side,
      cycle: a.cycle,
      wallet: a.wallet,
      walletRevision: a.walletRevision,
      mint: a.mint,
      scheduledAt: a.scheduledAt,
    },
  };
  await render();
  await done(() => expect(host.textContent).toContain('Recovery required'));
  expect(host.textContent).toContain('Fee budget remaining');
  expect(host.textContent).toContain('erase a pending outcome');
  expect(button('Start automatic activity').disabled).toBe(true);
  expect(writes()).toHaveLength(0);
});
it('ignores a cancelled late response and preserves recovery before any new write', async () => {
  await ready();
  let resolve!: (r: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    ),
  );
  await click('Save session history');
  expect(button('Cancel status request')).toBeTruthy();
  await click('Cancel status request');
  await act(async () => {
    resolve(Response.json({ journal: f.root() }));
    await new Promise<void>((r) => nextTurn(r));
  });
  expect(host.textContent).not.toContain('Session history saved.');
  expect(sessionStorage.getItem(key())).not.toBeNull();
  expect(button('Save session history').disabled).toBe(true);
});
it('holds a previously known session if a later read returns 404 instead of offering a replacement record', async () => {
  await create();
  saved = null;
  await click('Refresh saved status');
  await done(() => expect(host.querySelector('[role=alert]')).toBeTruthy());
  expect(button('Save session history')).toBeUndefined();
  expect(button('Pause plan').disabled).toBe(true);
  expect(writes()).toHaveLength(1);
});
it('ignores the late result from a previous approval after a keyed context change', async () => {
  let complete!: (r: Response) => void,
    calls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      ++calls === 1
        ? new Promise<Response>((r) => {
            complete = r;
          })
        : Response.json({ error: 'not found' }, { status: 404 }),
    ),
  );
  await render();
  await render({ ...f.consent, id: crypto.randomUUID() });
  await done(() => expect(button('Save session history').disabled).toBe(false));
  await act(async () => {
    complete(Response.json({ journal: f.root() }));
    await new Promise<void>((r) => nextTurn(r));
  });
  expect(button('Pause plan')).toBeUndefined();
  expect(host.textContent).toContain('No session history yet');
});
it('times out once without retrying and preserves the original request for explicit recovery', async () => {
  await ready();
  const fetcher = vi.fn(
    async (_input: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  await click('Save session history');
  const id = JSON.parse(sessionStorage.getItem(key())!).id;
  await act(async () => vi.advanceTimersByTimeAsync(15000));
  await done(() =>
    expect(host.textContent).toContain(
      'Request ended before its result was confirmed',
    ),
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(sessionStorage.getItem(key())!).id).toBe(id);
  expect(button('Retry this history request').disabled).toBe(true);
});
