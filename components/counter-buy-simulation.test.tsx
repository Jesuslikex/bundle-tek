// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CounterBuySimulation } from './counter-buy-simulation';
import { counterPreviewUiFixture } from '../test/counter-preview-ui-fixture';
import { counterRuntimeUiFixture } from '../test/counter-runtime-ui-fixture';
import { pairRuntimeDigest } from '../lib/pair-runtime-trace';
import { setTimeout as nodeDelay } from 'node:timers/promises';
let root: Root,
  container: HTMLDivElement,
  f: ReturnType<typeof counterPreviewUiFixture>;
let calls: {
  url: string;
  init: RequestInit;
  resolve: (response: Response) => void;
}[];
beforeEach(() => {
  f = counterPreviewUiFixture();
  calls = [];
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string, init: RequestInit) =>
        new Promise<Response>((resolve) => calls.push({ url, init, resolve })),
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function render(budget = '0.000001005', locked = false) {
  await act(async () =>
    root.render(
      <CounterBuySimulation
        plan={f.plan}
        decisionIdentity={f.identity}
        maximumSolAmount={budget}
        locked={locked}
      />,
    ),
  );
}
const button = (text: string) =>
  Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent === text,
  )!;
async function click(text: string) {
  await act(async () => button(text).click());
}
async function respond(value: unknown, status = 200) {
  await act(async () =>
    calls.at(-1)!.resolve(Response.json(value, { status })),
  );
}
async function respondRuntime(value: unknown) {
  await respond(value);
  // WebCrypto resolves outside React's initial response microtasks. Wait for the
  // actual request to settle, independently of the deliberately controlled Date.
  for (let i = 0; i < 40 && button('Cancel preview'); i++)
    await act(async () => {
      await nodeDelay(5);
    });
  expect(button('Cancel preview')).toBeUndefined();
}
async function configure() {
  await render();
  await click('Load verified wallets');
  await respond(f.workspace);
  await act(async () => {
    const select = container.querySelector('select')!;
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      'value',
    )!.set!.call(select, f.request.wallet);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const input = container.querySelector('input')!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, '0.000005');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
it('does no automatic fetch and explains each missing requirement', async () => {
  await render();
  expect(fetch).not.toHaveBeenCalled();
  expect(button('Preview settlement').disabled).toBe(true);
  expect(container.textContent).toContain('Load verified wallets');
});
it('requires explicit verified-wallet loading and sends only the exact selected preview terms', async () => {
  await configure();
  expect(container.textContent).not.toContain('Watch-only wallet');
  await click('Preview settlement');
  expect(calls[1].url).toBe('/api/imported-projects/counter-previews');
  expect(JSON.parse(calls[1].init.body as string)).toEqual(f.request);
  await respond({ preview: f.preview });
  expect(container.textContent).toContain('Simulated swap input');
  expect(container.textContent).toContain('Signing is unavailable here');
  expect(container.textContent).toContain('0.000000999 SOL');
  expect(container.querySelectorAll('button')).toHaveLength(4);
  expect(button('Review accounting limits').disabled).toBe(true);
  expect(calls).toHaveLength(2);
});
it('requests runtime evidence only on the explicit action with the same selected Counter terms', async () => {
  const runtimeFixture = await counterRuntimeUiFixture();
  f = runtimeFixture;
  await configure();
  expect(calls).toHaveLength(1);
  await click('Check runtime evidence');
  expect(calls[1].url).toBe('/api/imported-projects/counter-runtime-previews');
  expect(JSON.parse(calls[1].init.body as string)).toEqual(f.request);
  await respondRuntime({ preview: f.preview, runtime: runtimeFixture.runtime });
  expect(container.textContent).toContain('two matching full code scans');
  expect(container.textContent).toContain('10 of 32 slots');
  expect(container.textContent).toContain(
    'Clock account and response slots matched',
  );
  expect(container.textContent).toContain(
    'Provider observation, not code or inner-instruction approval',
  );
  expect(container.textContent).toContain(
    'This check does not approve a signature or trade',
  );
  expect(calls).toHaveLength(2);
  expect(container.querySelector('input[type=password]')).toBeNull();
});
it('discloses parsed provider coverage and never treats it as raw-instruction approval', async () => {
  const rf = await counterRuntimeUiFixture();
  f = rf;
  rf.runtime.rawInstructionCoverageComplete = false;
  const { sha256: _hash, ...receipt } = rf.runtime;
  rf.runtime.sha256 = await pairRuntimeDigest(receipt);
  await configure();
  await click('Check runtime evidence');
  await respondRuntime({ preview: f.preview, runtime: rf.runtime });
  expect(container.textContent).toContain('provider-parsed observations');
  expect(container.textContent).toContain('verified inner-instruction policy');
});
it('context changes abort runtime reads and ignore late code identity results', async () => {
  const rf = await counterRuntimeUiFixture();
  f = rf;
  await configure();
  await click('Check runtime evidence');
  const original = calls[1];
  await render('0.000002');
  expect(original.init.signal?.aborted).toBe(true);
  await act(async () =>
    original.resolve(
      Response.json({ preview: f.preview, runtime: rf.runtime }),
    ),
  );
  expect(container.textContent).not.toContain('two matching full code scans');
  expect(container.textContent).not.toContain('Simulated swap input');
});
it('cancelled runtime results cannot replace a newer basic settlement preview', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  const rf = await counterRuntimeUiFixture();
  f = rf;
  await configure();
  await click('Check runtime evidence');
  const old = calls[1];
  await click('Cancel preview');
  await click('Preview settlement');
  expect(calls.map((c) => c.url)).toEqual([
    '/api/wallet-workspace',
    '/api/imported-projects/counter-runtime-previews',
    '/api/imported-projects/counter-previews',
  ]);
  expect(calls[1].init.signal?.aborted).toBe(true);
  expect(calls[2].init.signal?.aborted).toBe(false);
  await act(async () =>
    old.resolve(Response.json({ preview: f.preview, runtime: rf.runtime })),
  );
  expect(container.textContent).not.toContain('two matching full code scans');
  await respondRuntime({ preview: f.preview });
  expect(
    container.textContent,
    JSON.stringify({
      text: container.textContent,
      calls: calls.map((c) => ({
        url: c.url,
        aborted: c.init.signal?.aborted,
      })),
    }),
  ).toContain('Simulated swap input');
  expect(container.textContent).not.toContain('two matching full code scans');
});
it('refuses malformed runtime receipts or elevated policy flags without exposing raw responses', async () => {
  const rf = await counterRuntimeUiFixture();
  f = rf;
  await configure();
  await click('Check runtime evidence');
  await respond({
    preview: f.preview,
    runtime: { ...rf.runtime, trustedProgramPolicyEstablished: true },
  });
  expect(container.textContent).toContain(
    'Counter runtime evidence unavailable or changed',
  );
  expect(container.textContent).not.toContain('two matching full code scans');
  expect(calls).toHaveLength(2);
});
it('handles runtime HTML, sign-in and provider errors with no automatic retry or parser text', async () => {
  await configure();
  await click('Check runtime evidence');
  await act(async () =>
    calls[1].resolve(
      new Response('<html>PRIVATE ERROR</html>', {
        status: 401,
        headers: { 'content-type': 'text/html' },
      }),
    ),
  );
  expect(container.textContent).toContain(
    'Counter runtime evidence unavailable or changed',
  );
  expect(container.textContent).not.toMatch(/PRIVATE ERROR|Unexpected token/);
  expect(calls).toHaveLength(2);
  await click('Check runtime evidence');
  await respond({ error: 'PRIVATE API DETAILS' }, 429);
  expect(container.textContent).not.toContain('PRIVATE API DETAILS');
  expect(calls).toHaveLength(3);
});
it.each(['runtime', 'base'] as const)(
  'expires runtime display at the earlier %s deadline without another request',
  async (which) => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const rf = await counterRuntimeUiFixture();
    f = rf;
    if (which === 'runtime')
      rf.runtime.expiresAt = new Date(Date.now() + 5000).toISOString();
    else rf.preview.expiresAt = new Date(Date.now() + 5000).toISOString();
    const { sha256: _hash, ...receipt } = rf.runtime;
    rf.runtime.sha256 = await pairRuntimeDigest(receipt);
    await configure();
    await click('Check runtime evidence');
    await respondRuntime({ preview: rf.preview, runtime: rf.runtime });
    expect(container.textContent).toContain('two matching full code scans');
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(container.textContent).toContain('Runtime evidence expired');
    expect(container.textContent).not.toContain('two matching full code scans');
    expect(calls).toHaveLength(2);
  },
);
it('cancels and refuses a late response when the input context changes', async () => {
  await configure();
  await click('Preview settlement');
  const pending = calls[1];
  await render('0.000002');
  expect((pending.init.signal as AbortSignal).aborted).toBe(true);
  await respond({ preview: f.preview });
  expect(container.textContent).not.toContain('Simulated swap input');
});
it('discards an accepted preview after context changes, even when the old limit is restored', async () => {
  await configure();
  await click('Preview settlement');
  await respond({ preview: f.preview });
  await render('0.000002');
  await render();
  expect(container.textContent).not.toContain('Simulated swap input');
});
it('keeps a cancelled response from replacing a newer request in the same context', async () => {
  await configure();
  await click('Preview settlement');
  const cancelled = calls[1];
  await click('Cancel preview');
  expect(cancelled.init.signal!.aborted).toBe(true);
  await click('Preview settlement');
  await act(async () =>
    cancelled.resolve(Response.json({ preview: f.preview })),
  );
  expect(container.textContent).not.toContain('Simulated swap input');
  expect(button('Cancel preview')).toBeDefined();
  await respond({ preview: f.preview });
  expect(container.textContent).toContain('Simulated swap input');
  expect(calls).toHaveLength(3);
});
it('rejects server authority flags', async () => {
  await configure();
  await click('Preview settlement');
  await respond({ preview: { ...f.preview, signingAllowed: true } });
  expect(container.querySelector('[role=alert]')).not.toBeNull();
  expect(container.textContent).not.toContain('Simulated swap input');
});
it('expires a current preview without another provider call', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  await configure();
  await click('Preview settlement');
  await respond({ preview: f.preview });
  expect(container.textContent).toContain('Simulated swap input');
  await act(async () => vi.advanceTimersByTimeAsync(31000));
  expect(container.textContent).toContain('Settlement preview expired');
  expect(calls).toHaveLength(2);
});
it('handles HTML and rate limits without exposing parser text or retrying', async () => {
  await configure();
  await click('Preview settlement');
  await act(async () =>
    calls.at(-1)!.resolve(
      new Response('<html>upstream error</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    ),
  );
  expect(container.textContent).toContain('Counter preview unavailable');
  expect(container.textContent).not.toContain('Unexpected token');
  expect(calls).toHaveLength(2);
  await click('Preview settlement');
  await respond({ error: 'Wait 15 seconds between provider previews.' }, 429);
  expect(container.textContent).toContain('Wait 15 seconds');
  expect(calls).toHaveLength(3);
});
