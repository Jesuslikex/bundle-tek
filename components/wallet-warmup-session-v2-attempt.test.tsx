// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { webcrypto } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { warmupV2AttemptClientFixture } from '@/test/warmup-session-v2-attempt-client-fixture';
import { WalletWarmupSessionV2Attempt } from './wallet-warmup-session-v2-attempt';
let f: Awaited<ReturnType<typeof warmupV2AttemptClientFixture>>,
  host: HTMLDivElement,
  root: Root,
  posts: number,
  gets: number,
  lost: boolean,
  missing: boolean,
  html: boolean;
const at = Date.parse('2026-10-21T12:00:00.000Z');
const key = () => 'bundle:warmup-attempt-v2:' + f.journal.id;
async function flush() {
  for (let i = 0; i < 5; i++)
    await new Promise<void>((resolve) => nextTurn(resolve));
}
async function render(disabled = false, now = at, invalidated = false) {
  await act(async () => {
    root.render(
      <WalletWarmupSessionV2Attempt
        journal={f.journal}
        consent={f.consent}
        disabled={disabled}
        invalidated={invalidated}
        now={now}
      />,
    );
    await flush();
  });
}
const button = (text: string) => {
  const b = [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!b) throw Error('Missing button ' + text);
  return b;
};
async function click(text: string) {
  await act(async () => {
    button(text).click();
    await flush();
  });
}
async function check(text = 'Request this exact unsigned quote') {
  await act(async () => {
    const label = [...host.querySelectorAll('label')].find((l) =>
      l.textContent?.includes(text),
    );
    const input = label?.querySelector('input');
    if (!input) throw Error('Missing checkbox');
    input.click();
    await flush();
  });
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  sessionStorage.clear();
  f = await warmupV2AttemptClientFixture(at);
  posts = 0;
  gets = 0;
  lost = false;
  missing = false;
  html = false;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      if (html)
        return new Response('<html>private error</html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        });
      if (init?.method === 'POST') {
        posts++;
        const body = JSON.parse(init.body as string);
        expect(JSON.parse(sessionStorage.getItem(key())!).id).toBe(body.id);
        expect(Object.keys(body).sort()).toEqual([
          'headSha256',
          'id',
          'journalId',
          'previewRequested',
          'version',
        ]);
        if (lost) throw Error('Lost response');
        return Response.json(f.response(body.id));
      }
      gets++;
      if (missing)
        return Response.json({ error: 'not found' }, { status: 404 });
      return Response.json(
        f.response(new URL(input, 'http://localhost').searchParams.get('id')!),
      );
    }),
  );
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
    await flush();
  });
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('requires its own unchecked request, persists the ID before POST and never sends wallet selectors', async () => {
  await render();
  expect(posts + gets).toBe(0);
  expect(button('Request unsigned preview').disabled).toBe(true);
  await check();
  await click('Request unsigned preview');
  expect(posts).toBe(1);
  expect(host.textContent).toContain('Exact input:');
  expect(host.textContent).toContain('Private packet retained.');
});
it('remounts a lost response without a fetch, then recovers with GET and no new POST', async () => {
  await render();
  lost = true;
  await check();
  await click('Request unsigned preview');
  const id = JSON.parse(sessionStorage.getItem(key())!).id;
  await act(async () => {
    root.unmount();
    await flush();
  });
  root = createRoot(host);
  await render();
  expect(posts).toBe(1);
  expect(gets).toBe(0);
  lost = false;
  await click('Recover unsigned request');
  expect(gets).toBe(1);
  expect(posts).toBe(1);
  expect(JSON.parse(sessionStorage.getItem(key())!).id).toBe(id);
  expect(host.textContent).toContain('Saved-only recovery complete');
});
it('a missing GET permits only a separately approved repeat of the same original ID', async () => {
  await render();
  lost = true;
  await check();
  await click('Request unsigned preview');
  const id = JSON.parse(sessionStorage.getItem(key())!).id;
  missing = true;
  await click('Recover unsigned request');
  expect(host.textContent).toContain(
    'does not prove an earlier handler failed',
  );
  expect(button('Request original ID again').disabled).toBe(true);
  lost = false;
  missing = false;
  await check('Request the same original ID');
  await click('Request original ID again');
  expect(posts).toBe(2);
  expect(JSON.parse(sessionStorage.getItem(key())!).id).toBe(id);
});
it('storage failure prevents a new POST', async () => {
  await render();
  vi.spyOn(Object.getPrototypeOf(sessionStorage), 'setItem').mockImplementation(
    () => {
      throw Error('quota');
    },
  );
  await check();
  await click('Request unsigned preview');
  expect(posts).toBe(0);
  expect(host.textContent).toContain('No new request was started');
});
it('does not render HTML error bodies or discard the original reminder', async () => {
  await render();
  html = true;
  await check();
  await click('Request unsigned preview');
  expect(host.textContent).not.toContain('private error');
  expect(sessionStorage.getItem(key())).toBeTruthy();
  expect(host.querySelector('[role="alert"]')).toBeTruthy();
});
it('a context change aborts an active preview and refuses a late successful result', async () => {
  let release: (response: Response) => void = () => {},
    requestSignal: AbortSignal | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn((_input: string, init?: RequestInit) => {
      posts++;
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }),
  );
  await render();
  await check();
  await click('Request unsigned preview');
  const id = JSON.parse(sessionStorage.getItem(key())!).id;
  await render(true, at, true);
  expect(requestSignal?.aborted).toBe(true);
  await act(async () => {
    release(Response.json(f.response(id)));
    await flush();
  });
  expect(host.textContent).not.toContain('Exact input:');
  expect(JSON.parse(sessionStorage.getItem(key())!).id).toBe(id);
});
it('a parent history read disables new requests without cancelling an already running preview', async () => {
  let release: (response: Response) => void = () => {},
    requestSignal: AbortSignal | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn((_input: string, init?: RequestInit) => {
      posts++;
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }),
  );
  await render();
  await check();
  await click('Request unsigned preview');
  const id = JSON.parse(sessionStorage.getItem(key())!).id;
  await render(true);
  expect(requestSignal?.aborted).toBe(false);
  await act(async () => {
    release(Response.json(f.response(id)));
    await flush();
  });
  expect(host.textContent).toContain('Exact input:');
  expect(posts).toBe(1);
});
it('finds and recovers a saved request after tab storage is lost without starting a POST', async () => {
  const id = crypto.randomUUID(),
    value = f.response(id);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      gets++;
      const params = new URL(input, 'http://localhost').searchParams;
      if (params.has('journalId'))
        return Response.json({
          page: {
            format: 'wallet-warmup-attempt-page-v2',
            journalId: f.journal.id,
            termsSha256: f.consent.termsSha256,
            requests: [
              {
                id,
                actionId: value.attempt.actionId,
                sequence: 1,
                attempt: 1,
                createdAt: value.attempt.createdAt,
                expiresAt: value.attempt.leaseExpiresAt,
              },
            ],
            nextBefore: null,
            executionAllowed: false,
            signingAllowed: false,
            automaticExecutionAllowed: false,
            instructionsVerified: false,
          },
        });
      expect(params.get('id')).toBe(id);
      return Response.json(value);
    }),
  );
  await render();
  expect(gets).toBe(0);
  await click('Find saved requests');
  expect(gets).toBe(1);
  expect(posts).toBe(0);
  await click('Recover saved attempt 1');
  expect(gets).toBe(2);
  expect(posts).toBe(0);
  expect(JSON.parse(sessionStorage.getItem(key())!).id).toBe(id);
  expect(host.textContent).toContain('Exact input:');
});
it('keeps an older discovered result historical until the newest saved request is recovered', async () => {
  const older = f.response(crypto.randomUUID(), 'refused', 1),
    newer = f.response(crypto.randomUUID(), 'refused', 3);
  const rows = [newer, older].map((v) => ({
    id: v.attempt.id,
    actionId: v.attempt.actionId,
    sequence: v.attempt.sequence,
    attempt: v.attempt.attempt,
    createdAt: v.attempt.createdAt,
    expiresAt: v.attempt.leaseExpiresAt,
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      gets++;
      const q = new URL(input, 'http://localhost').searchParams;
      if (q.has('journalId'))
        return Response.json({
          page: {
            format: 'wallet-warmup-attempt-page-v2',
            journalId: f.journal.id,
            termsSha256: f.consent.termsSha256,
            requests: rows,
            nextBefore: null,
            executionAllowed: false,
            signingAllowed: false,
            automaticExecutionAllowed: false,
            instructionsVerified: false,
          },
        });
      return Response.json(q.get('id') === older.attempt.id ? older : newer);
    }),
  );
  await render(false, at + 40000);
  await click('Find saved requests');
  await click('Recover saved attempt 1');
  expect(sessionStorage.getItem(key())).toBeNull();
  expect(button('Request unsigned preview').disabled).toBe(true);
  await click('Recover saved attempt 3');
  expect(JSON.parse(sessionStorage.getItem(key())!).id).toBe(newer.attempt.id);
  expect(button('Request next unsigned attempt').disabled).toBe(true);
  expect(host.textContent).toContain('three');
  expect(posts).toBe(0);
});
