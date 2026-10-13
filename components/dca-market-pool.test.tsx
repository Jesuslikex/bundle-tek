// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DcaMarketPool } from './dca-market-pool';
const mint = 'So11111111111111111111111111111111111111112';
const pair = '11111111111111111111111111111111';
const project = {
  id: '11111111-1111-4111-8111-111111111111',
  revision: 1,
  document: { token: { address: mint } },
};
let root: Root, container: HTMLDivElement;
let calls: { signal: AbortSignal; resolve: (response: Response) => void }[];
const selected = vi.fn();
const response = (patch: Record<string, unknown> = {}) =>
  Response.json({
    id: project.id,
    revision: 1,
    executionAllowed: false,
    observations: [
      {
        chain: 'Solana',
        address: mint,
        projectRevision: 1,
        source: 'api.dexscreener.com',
        executionAllowed: false,
        observedAt: new Date().toISOString(),
        pairs: [{ address: pair, dex: 'raydium', marketCapUsd: 100 }],
      },
    ],
    ...patch,
  });
const render = (revision = 1, disabled = false) =>
  act(async () =>
    root.render(
      <DcaMarketPool
        project={{ ...project, revision }}
        value=""
        disabled={disabled}
        onChange={selected}
      />,
    ),
  );
const click = () => act(async () => container.querySelector('button')!.click());
beforeEach(async () => {
  calls = [];
  selected.mockReset();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve) =>
          calls.push({ signal: init.signal!, resolve }),
        ),
    ),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it('loads only on request and selects an observed pool with saved coverage disclosure', async () => {
  expect(fetch).not.toHaveBeenCalled();
  await click();
  expect(calls).toHaveLength(1);
  await act(async () => calls[0].resolve(response()));
  const select = container.querySelector('select')!;
  expect(select.disabled).toBe(false);
  expect(container.textContent).toContain(
    'Each cycle needs a current market observation',
  );
  await act(async () => {
    select.value = pair;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(selected).toHaveBeenLastCalledWith(pair);
});
it('rejects another project response instead of retaining a selectable foreign pool', async () => {
  await click();
  await act(async () => calls[0].resolve(response({ id: 'foreign' })));
  expect(container.querySelector('select')!.disabled).toBe(true);
  expect(container.textContent).toContain('Pool selection unavailable');
});
it('aborts a pending read on project revision changes and ignores its late result', async () => {
  await click();
  await render(2);
  expect(calls[0].signal.aborted).toBe(true);
  await act(async () => calls[0].resolve(response()));
  expect(container.querySelector('select')!.disabled).toBe(true);
  expect(container.textContent).not.toContain('raydium');
});
it('keeps loading disabled during signing and aborts an unmounted request', async () => {
  await render(1, true);
  await click();
  expect(fetch).not.toHaveBeenCalled();
  await render();
  await click();
  await act(async () => root.unmount());
  expect(calls[0].signal.aborted).toBe(true);
});
