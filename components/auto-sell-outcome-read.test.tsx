// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { AutoSellOutcomeRead } from './auto-sell-outcome-read';
import {
  autoSellOutcomePage,
  autoSellOutcomeReference as ref,
} from '../test/auto-sell-outcome-fixture';
let host: HTMLDivElement, root: Root | null;
const fetcher = vi.fn();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetcher);
  fetcher.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const render = async (reference = ref, projectId = ref.projectId) =>
  act(async () =>
    root!.render(
      <AutoSellOutcomeRead
        reference={reference}
        projectId={projectId}
        mint={ref.mint}
      />,
    ),
  );
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find(
    (x) => x.textContent === label,
  );
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
const ok = () => Response.json(autoSellOutcomePage());
it('makes no request on mount or disclosure, then reads only the exact original GET on explicit click', async () => {
  fetcher.mockResolvedValue(ok());
  await render();
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => host.querySelector('summary')!.click());
  expect(fetcher).not.toHaveBeenCalled();
  await click('Read saved outcome');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe(
    `/api/imported-projects/signing?projectId=${ref.projectId}&intentId=${ref.intentId}`,
  );
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    method: 'GET',
    cache: 'no-store',
  });
  expect(host.textContent).toContain(
    'Submission recorded; receipt proof not loaded',
  );
  expect(host.textContent).toContain(
    'Submitted or unknown amounts remain accounted for',
  );
  expect(host.textContent).not.toContain('SYNTHETIC-UNSIGNED-PACKET');
  expect(host.querySelector('a')!.getAttribute('href')).toBe(
    'https://solscan.io/tx/' + ref.signature,
  );
});
it.each(['html', 'wrong-signature', 'wrong-intent'] as const)(
  'withholds raw or mismatched saved response: %s',
  async (kind) => {
    const page = autoSellOutcomePage();
    if (kind === 'wrong-signature') page.intents[0].signature = '1'.repeat(88);
    if (kind === 'wrong-intent') {
      page.intents[0].id = '44444444-4444-4444-8444-444444444444';
      page.intents[0].document.id = page.intents[0].id;
    }
    fetcher.mockResolvedValue(
      kind === 'html'
        ? new Response('<html>PRIVATE-PARSER-DETAIL</html>', { status: 502 })
        : Response.json(page),
    );
    await render();
    await click('Read saved outcome');
    expect(host.querySelector('[role="alert"]')).toBeTruthy();
    expect(host.textContent).not.toContain('PRIVATE-PARSER-DETAIL');
    expect(host.textContent).not.toContain('Unexpected token');
    expect(host.querySelector('output')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it('cancels a pending lookup and refuses an abort-ignoring late response without retrying', async () => {
  let resolve!: (r: Response) => void;
  fetcher.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await render();
  await click('Read saved outcome');
  await click('Cancel lookup');
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  await act(async () => resolve(ok()));
  expect(host.textContent).toContain('Lookup cancelled');
  expect(host.querySelector('output')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('invalidates the original request and results when its retained reference changes', async () => {
  let resolve!: (r: Response) => void;
  fetcher.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await render();
  await click('Read saved outcome');
  const changed = { ...ref, intentId: '44444444-4444-4444-8444-444444444444' };
  await render(changed);
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  await act(async () => resolve(ok()));
  expect(host.querySelector('output')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('refuses another project context without a request or transaction controls', async () => {
  await render(ref, '44444444-4444-4444-8444-444444444444');
  expect(host.textContent).toContain(
    'Original outcome lookup context is unavailable',
  );
  expect(host.querySelector('button')).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
it('aborts a lookup on unmount and never writes or clears a trading outcome', async () => {
  let resolve!: (r: Response) => void;
  fetcher.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await render();
  await click('Read saved outcome');
  await act(async () => root!.unmount());
  root = null;
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  await act(async () => resolve(ok()));
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('refuses a late response after its controlled timeout without an automatic retry', async () => {
  const timer = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, 'timeout')
    .mockReturnValue(timer.signal);
  let resolve!: (r: Response) => void;
  fetcher.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  try {
    await render();
    await click('Read saved outcome');
    timer.abort();
    await act(async () => resolve(ok()));
    expect(host.querySelector('output')).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    timeout.mockRestore();
  }
});
it.each(['signed', 'failed', 'finalized'] as const)(
  'labels saved %s without claiming receipt proof or enabling another action',
  async (state) => {
    const page = autoSellOutcomePage();
    page.intents[0].state = state;
    fetcher.mockResolvedValue(Response.json(page));
    await render();
    await click('Read saved outcome');
    expect(host.querySelector('output')).toBeTruthy();
    const expected = {
      signed: 'Signature recorded; submission not established',
      failed: 'Failure recorded; inspect preparation history',
      finalized: 'Finalized status recorded; receipt proof not loaded',
    };
    expect(host.querySelector('output')!.textContent).toContain(
      expected[state],
    );
    expect(host.textContent).toContain(
      'Recorded status alone is not receipt verification',
    );
    expect(host.textContent).not.toContain('Sign transaction');
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
