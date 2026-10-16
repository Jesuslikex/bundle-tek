// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CounterBuySimulation } from './counter-buy-simulation';
import { counterPreviewUiFixture } from '../test/counter-preview-ui-fixture';
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
  expect(container.querySelectorAll('button')).toHaveLength(2);
});
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
