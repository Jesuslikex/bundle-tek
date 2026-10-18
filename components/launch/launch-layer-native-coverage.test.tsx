// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { LaunchLayerNativeCoverage } from './launch-layer-native-coverage';
import { layerNativeFixture } from '../../test/launch-layer-native-fixture';
let host: HTMLDivElement,
  root: Root,
  f: Awaited<ReturnType<typeof layerNativeFixture>>;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const button = (name: string) =>
  [...host.querySelectorAll('button')].find(
    (button) => button.textContent === name,
  )!;
async function click(name: string) {
  await act(async () => {
    button(name).click();
    await flush();
  });
}
async function until(assertion: () => void) {
  await vi.waitFor(
    async () => {
      await act(async () => {
        await flush();
      });
      assertion();
    },
    { timeout: 3000, interval: 10 },
  );
}
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  f = await layerNativeFixture();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ evidence: f.evidence })),
  );
  await act(async () =>
    root.render(
      <LaunchLayerNativeCoverage
        key={f.plan.id}
        plan={f.plan}
        disabled={false}
      />,
    ),
  );
});
afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('reads only on request, renders exact separate ceilings and filters without new requests', async () => {
  expect(fetch).not.toHaveBeenCalled();
  f.evidence.rows[0].observation!.raw = '0';
  await click('Load saved SOL observations');
  await until(() =>
    expect(host.textContent).toContain('Below ceiling by 0.002105 SOL'),
  );
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining('balances=1'),
    expect.objectContaining({ cache: 'no-store' }),
  );
  expect(host.textContent).toContain(
    'historical observations, not current spendability',
  );
  expect(host.textContent).toContain(
    'Exchange deposits and transfers to other roles are not calculated',
  );
  expect(host.querySelectorAll('tbody tr')).toHaveLength(7);
  const select = host.querySelector('select')!;
  expect(select.labels?.[0].textContent).toBe('Show role');
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      'value',
    )!.set!.call(select, 'front');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(host.querySelectorAll('tbody tr')).toHaveLength(1);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('shows readable HTML/ref-change errors and never calls a provider or a write route', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response('<html>upstream down</html>', { status: 503 }),
  );
  await click('Load saved SOL observations');
  await until(() =>
    expect(host.querySelector('[role=alert]')?.textContent).toContain(
      'unavailable or inconsistent',
    ),
  );
  expect(host.textContent).not.toContain('Unexpected token');
  expect(host.textContent).not.toContain('<html>');
  vi.mocked(fetch).mockResolvedValueOnce(
    Response.json({ error: 'current references' }, { status: 409 }),
  );
  await click('Load saved SOL observations');
  await until(() =>
    expect(host.querySelector('[role=alert]')?.textContent).toContain(
      'Planning references changed',
    ),
  );
  expect(
    vi
      .mocked(fetch)
      .mock.calls.every(
        ([url, options]) =>
          typeof url === 'string' &&
          url.startsWith('/api/launch/layers?') &&
          !options?.method,
      ),
  ).toBe(true);
});
it('releases a timeout and ignores a late response, including after snapshot replacement', async () => {
  let release!: (response: Response) => void;
  vi.mocked(fetch).mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  vi.useFakeTimers();
  await act(async () => {
    button('Load saved SOL observations').click();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(host.textContent).toContain('loading timed out');
  expect(button('Load saved SOL observations').disabled).toBe(false);
  await act(async () => {
    release(Response.json({ evidence: f.evidence }));
    await Promise.resolve();
  });
  expect(host.querySelector('table')).toBeNull();
  await act(async () => {
    button('Load saved SOL observations').click();
  });
  const next = { ...f.plan, id: '00000000-0000-4000-8000-000000000003' };
  await act(async () =>
    root.render(
      <LaunchLayerNativeCoverage key={next.id} plan={next} disabled={false} />,
    ),
  );
  await act(async () => {
    release(Response.json({ evidence: f.evidence }));
    await Promise.resolve();
  });
  expect(host.querySelector('table')).toBeNull();
  expect(host.querySelector('[role=alert]')).toBeNull();
});
