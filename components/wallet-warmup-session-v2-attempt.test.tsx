// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { webcrypto } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
const admission = vi.hoisted(() => ({
  block: false,
  entered: false,
  returned: false,
  release: null as (() => void) | null,
}));
vi.mock('@/lib/wallet-warmup-session-v2-read-view', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/lib/wallet-warmup-session-v2-read-view')
    >();
  return {
    ...actual,
    warmupReadReminder: async (
      ...args: Parameters<typeof actual.warmupReadReminder>
    ) => {
      const marker = await actual.warmupReadReminder(...args);
      if (admission.block) {
        admission.block = false;
        admission.entered = true;
        await new Promise<void>((resolve) => {
          admission.release = resolve;
        });
        admission.returned = true;
      }
      return marker;
    },
  };
});
import { warmupReadClientFixture } from '@/test/warmup-session-v2-read-client-fixture';
import { WalletWarmupSessionV2Attempt } from './wallet-warmup-session-v2-attempt';
let f: Awaited<ReturnType<typeof warmupReadClientFixture>>,
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
  admission.block = false;
  admission.entered = false;
  admission.returned = false;
  admission.release = null;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  sessionStorage.clear();
  f = await warmupReadClientFixture(at);
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
        const runtime = body.runtimeRequested === true;
        expect(Object.keys(body).sort()).toEqual(
          [
            'headSha256',
            'id',
            'journalId',
            runtime ? 'runtimeRequested' : 'previewRequested',
            'version',
          ].sort(),
        );
        expect(
          input.endsWith(
            runtime ? '/session-v2-runtime-attempts' : '/session-v2-attempts',
          ),
        ).toBe(true);
        expect(JSON.parse(sessionStorage.getItem(key())!).mode).toBe(
          runtime ? 'runtime' : 'preview',
        );
        if (lost) throw Error('Lost response');
        const { mode: _mode, ...response } = f.readResponse(
          body.id,
          runtime ? 'runtime' : 'preview',
        );
        return Response.json(response);
      }
      gets++;
      if (missing)
        return Response.json({ error: 'not found' }, { status: 404 });
      return Response.json(
        f.readResponse(
          new URL(input, 'http://localhost').searchParams.get('id')!,
          JSON.parse(sessionStorage.getItem(key()) ?? '{}').mode ?? 'preview',
        ),
      );
    }),
  );
});
afterEach(async () => {
  admission.release?.();
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
            format: 'wallet-warmup-read-page-v1',
            journalId: f.journal.id,
            termsSha256: f.consent.termsSha256,
            requests: [
              {
                id,
                mode: 'preview',
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
      return Response.json({ mode: 'preview', ...value });
    }),
  );
  await render();
  expect(gets).toBe(0);
  await click('Find saved requests');
  expect(gets).toBe(1);
  expect(posts).toBe(0);
  await click('Recover saved attempt 1');
  await act(async () => {
    const deadline = performance.now() + 3000;
    while (
      sessionStorage.getItem(key()) === null &&
      performance.now() < deadline
    )
      await new Promise<void>((resolve) => nextTurn(resolve));
  });
  expect(gets).toBe(2);
  expect(posts).toBe(0);
  expect(sessionStorage.getItem(key()), host.textContent ?? '').not.toBeNull();
  expect(JSON.parse(sessionStorage.getItem(key())!).id).toBe(id);
  expect(host.textContent).toContain('Exact input:');
});
it('keeps an older discovered result historical until the newest saved request is recovered', async () => {
  const older = f.response(crypto.randomUUID(), 'refused', 1),
    newer = f.response(crypto.randomUUID(), 'refused', 3);
  const rows = [newer, older].map((v) => ({
    mode: 'preview',
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
            format: 'wallet-warmup-read-page-v1',
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
      return Response.json({
        mode: 'preview',
        ...(q.get('id') === older.attempt.id ? older : newer),
      });
    }),
  );
  await render(false, at + 40000);
  await click('Find saved requests');
  await vi.waitFor(async () => {
    await act(flush);
    expect(button('Recover saved attempt 1').disabled).toBe(false);
  });
  await click('Recover saved attempt 1');
  await vi.waitFor(async () => {
    await act(flush);
    expect(button('Recover saved attempt 3').disabled).toBe(false);
  });
  expect(sessionStorage.getItem(key())).toBeNull();
  expect(button('Request unsigned preview').disabled).toBe(true);
  await click('Recover saved attempt 3');
  await vi.waitFor(async () => {
    await act(flush);
    expect(JSON.parse(sessionStorage.getItem(key()) ?? '{}').id).toBe(
      newer.attempt.id,
    );
  });
  expect(JSON.parse(sessionStorage.getItem(key())!).id).toBe(newer.attempt.id);
  expect(button('Request next unsigned attempt').disabled).toBe(true);
  expect(host.textContent).toContain('three');
  expect(posts).toBe(0);
});
async function chooseRuntime() {
  await act(async () => {
    const input = [
      ...host.querySelectorAll('input[type="radio"]'),
    ][1] as HTMLInputElement;
    input.click();
    await flush();
  });
}
it('runtime checks require their own initially unchecked approval and retain the selected mode before one POST', async () => {
  await render();
  await check();
  await chooseRuntime();
  expect(button('Request runtime checks').disabled).toBe(true);
  expect(posts + gets).toBe(0);
  await check('Request the exact runtime checks');
  await click('Request runtime checks');
  expect(posts).toBe(1);
  expect(gets).toBe(0);
  expect(JSON.parse(sessionStorage.getItem(key())!).mode).toBe('runtime');
  expect(host.textContent).toContain('Account observations span 3 of 32 slots');
  expect(host.textContent).toContain('No trade approved');
  expect(host.textContent).toContain('without a Clock read for each chunk');
});
it('a lost runtime response remounts without fetching and recovers its original mode by GET', async () => {
  await render();
  await chooseRuntime();
  lost = true;
  await check('Request the exact runtime checks');
  await click('Request runtime checks');
  const original = sessionStorage.getItem(key())!;
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
  expect(sessionStorage.getItem(key())).toBe(original);
  await render(false, at + 20000);
  expect(host.textContent).toContain(
    'Runtime checks expired. Saved history only.',
  );
  expect(button('Request next runtime check').disabled).toBe(true);
  expect(
    (
      host.querySelectorAll('input[type="radio"]')[0] as HTMLInputElement
    ).matches(':disabled'),
  ).toBe(true);
});
it('keeps an old preview reminder byte-for-byte while recovering it through mode-aware history', async () => {
  const id = crypto.randomUUID(),
    raw = JSON.stringify({
      format: 'wallet-warmup-attempt-reminder-v2',
      id,
      journal: f.journal,
    });
  sessionStorage.setItem(key(), raw);
  await render();
  await click('Recover unsigned request');
  expect(sessionStorage.getItem(key())).toBe(raw);
  expect(posts).toBe(0);
  expect(gets).toBe(1);
  expect(host.textContent).toContain('Exact input:');
});
it('invalidating the source aborts runtime work and refuses its late result', async () => {
  let release: (value: Response) => void = () => {},
    activeSignal: AbortSignal | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init: RequestInit) => {
      posts++;
      activeSignal = init.signal ?? undefined;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }),
  );
  await render();
  await chooseRuntime();
  await check('Request the exact runtime checks');
  await click('Request runtime checks');
  const id = JSON.parse(sessionStorage.getItem(key())!).id;
  await render(true, at, true);
  expect(activeSignal!.aborted).toBe(true);
  await act(async () => {
    const { mode: _mode, ...body } = f.readResponse(id, 'runtime');
    release(Response.json(body));
    await flush();
  });
  expect(host.textContent).not.toContain('Account observations span');
  expect(posts).toBe(1);
  expect(JSON.parse(sessionStorage.getItem(key())!).id).toBe(id);
});
async function until(test: () => boolean) {
  const deadline = performance.now() + 3000;
  while (!test() && performance.now() < deadline)
    await new Promise<void>((resolve) => nextTurn(resolve));
  expect(test()).toBe(true);
}
it('renders refused runtime checks without suggesting a completed observation', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      posts++;
      if (typeof init.body !== 'string')
        throw Error('Expected JSON request text');
      const { mode: _mode, ...value } = f.readResponse(
        JSON.parse(init.body).id,
        'runtime',
        'refused',
      );
      return Response.json(value);
    }),
  );
  await render();
  await chooseRuntime();
  await check('Request the exact runtime checks');
  await click('Request runtime checks');
  expect(host.textContent).toContain('Check refused');
  expect(host.textContent).not.toContain('Account observations span');
  expect(host.textContent).not.toContain(
    'Runtime observations saved. No trade approved.',
  );
  expect(posts).toBe(1);
});
it('clears a discovered page and its adoption hint when the session context changes', async () => {
  const id = crypto.randomUUID(),
    a = f.response(id).attempt;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        page: {
          format: 'wallet-warmup-read-page-v1',
          journalId: f.journal.id,
          termsSha256: f.consent.termsSha256,
          requests: [
            {
              id,
              mode: 'runtime',
              actionId: a.actionId,
              sequence: 1,
              attempt: 1,
              createdAt: a.createdAt,
              expiresAt: a.leaseExpiresAt,
            },
          ],
          nextBefore: null,
          executionAllowed: false,
          signingAllowed: false,
          automaticExecutionAllowed: false,
          instructionsVerified: false,
        },
      }),
    ),
  );
  await render();
  await click('Find saved requests');
  expect(button('Recover saved attempt 1')).toBeTruthy();
  await render(true, at, true);
  expect(host.textContent).not.toContain(id);
  expect(sessionStorage.getItem(key())).toBeNull();
  expect(posts).toBe(0);
});
it.each(['mode', 'uncheck', 'unmount'] as const)(
  'cancels an asynchronous reminder admission after %s',
  async (change) => {
    await render();
    await check();
    admission.block = true;
    await click('Request unsigned preview');
    await act(async () => {
      await until(() => admission.entered);
    });
    if (change === 'mode') await chooseRuntime();
    if (change === 'uncheck') await check();
    if (change === 'unmount') {
      await act(async () => {
        root.unmount();
        await flush();
      });
      root = createRoot(host);
    }
    await act(async () => {
      admission.release!();
      await until(() => admission.returned);
      await flush();
    });
    expect(posts).toBe(0);
    expect(sessionStorage.getItem(key())).toBeNull();
  },
);
it('shows the shared expiry and gates the next request by its later bound, then requires fresh mode consent', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      posts++;
      if (typeof init.body !== 'string')
        throw Error('Expected JSON request text');
      const body = JSON.parse(init.body);
      const { mode: _mode, ...value } = f.readResponse(body.id, 'runtime');
      value.attempt.outcome!.expiresAt = new Date(at + 45000).toISOString();
      value.attempt.preview!.quoteExpiresAt = new Date(
        at + 45000,
      ).toISOString();
      return Response.json(value);
    }),
  );
  await render();
  await chooseRuntime();
  await check('Request the exact runtime checks');
  await click('Request runtime checks');
  await render(false, at + 40000);
  expect(host.textContent).toContain(
    'Shared request expiry: ' + new Date(at + 45000).toLocaleString(),
  );
  expect(host.textContent).toContain(
    'Next check no earlier than ' + new Date(at + 45000).toLocaleString(),
  );
  expect(host.textContent).toContain('This request is recovered.');
  expect(button('Request next runtime check').disabled).toBe(true);
  await render(false, at + 45000);
  await act(async () => {
    (
      host.querySelectorAll('input[type="radio"]')[0] as HTMLInputElement
    ).click();
    await flush();
  });
  expect(button('Request next unsigned attempt').disabled).toBe(true);
  expect(posts).toBe(1);
});
it('waits for local reminder admission before enabling saved-only discovery', async () => {
  const id = crypto.randomUUID();
  sessionStorage.setItem(
    key(),
    JSON.stringify({
      format: 'wallet-warmup-attempt-reminder-v2',
      id,
      journal: f.journal,
    }),
  );
  admission.block = true;
  await render();
  await act(async () => {
    await until(() => admission.entered);
  });
  expect(button('Find saved requests').disabled).toBe(true);
  expect(gets).toBe(0);
  await act(async () => {
    admission.release!();
    await until(() => admission.returned);
    await flush();
  });
  await click('Recover unsigned request');
  expect(gets).toBe(1);
  expect(posts).toBe(0);
});
it('never offers the current ID as an earlier pending request', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      posts++;
      if (typeof init.body !== 'string')
        throw Error('Expected JSON request text');
      return Response.json(
        {
          error: 'Synthetic mode conflict',
          recoveryId: JSON.parse(init.body).id,
        },
        { status: 409 },
      );
    }),
  );
  await render();
  await check();
  await click('Request unsigned preview');
  expect(host.textContent).not.toContain(
    'An earlier pending request is available',
  );
  expect(sessionStorage.getItem(key())).toBeTruthy();
  expect(posts).toBe(1);
});
it('never adopts a late discovered result after a context change', async () => {
  const id = crypto.randomUUID(),
    a = f.response(id).attempt;
  let release: (value: Response) => void = () => {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      gets++;
      if (new URL(input, 'http://localhost').searchParams.has('journalId'))
        return Response.json({
          page: {
            format: 'wallet-warmup-read-page-v1',
            journalId: f.journal.id,
            termsSha256: f.consent.termsSha256,
            requests: [
              {
                id,
                mode: 'preview',
                actionId: a.actionId,
                sequence: 1,
                attempt: 1,
                createdAt: a.createdAt,
                expiresAt: a.leaseExpiresAt,
              },
            ],
            nextBefore: null,
            executionAllowed: false,
            signingAllowed: false,
            automaticExecutionAllowed: false,
            instructionsVerified: false,
          },
        });
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }),
  );
  await render();
  await click('Find saved requests');
  await click('Recover saved attempt 1');
  await render(true, at, true);
  await act(async () => {
    release(Response.json({ mode: 'preview', ...f.response(id) }));
    await flush();
  });
  expect(sessionStorage.getItem(key())).toBeNull();
  expect(host.textContent).not.toContain('Exact input:');
  expect(gets).toBe(2);
  expect(posts).toBe(0);
});
