// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DcaTradeSession } from './dca-trade-session';
import { tradeSessionTerms } from '@/lib/imported-trade-session';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import {
  acquisitionId as id,
  acquisitionWallet as wallet,
  acquisitionMint as mint,
} from '../test/imported-sell-acquisition-fixture';
const token = { chain: 'Solana', address: mint, decimals: 6, symbol: 'TEST' };
const project = {
  id: id(1),
  revision: 1,
  archived: false,
  document: { token },
} as ImportedTokenProject;
const wallets = [
  {
    chain: 'Solana',
    address: wallet,
    revision: 1,
    archived: false,
    label: 'DCA wallet',
  },
] as WorkspaceWallet[];
let root: Root, container: HTMLDivElement;
const saved = vi.fn();
const busyChanged = vi.fn();
let requests: {
  body: Record<string, unknown>;
  signal: AbortSignal;
  resolve: (r: Response) => void;
}[];
async function setField(name: string, value: string) {
  await act(async () => {
    const label = Array.from(container.querySelectorAll('label')).find((l) =>
      l.textContent?.startsWith(name),
    );
    const element = label?.querySelector('input,select') as
      | HTMLInputElement
      | HTMLSelectElement;
    if (!element) throw new Error('Missing field ' + name);
    const prototype =
      element.tagName === 'SELECT'
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(
      new Event(element.tagName === 'SELECT' ? 'change' : 'input', {
        bubbles: true,
      }),
    );
  });
}
const saveButton = () =>
  Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Save DCA'),
  )!;
async function fill() {
  await setField('DCA wallet', wallet);
  await setField('Total DCA input', '0.000000011');
  await setField('DCA cycles', '3');
  await setField('DCA start', '2026-10-13T12:00');
}
it('saves the reviewed inclusive pool range and rejects reversed bounds in the composer', async () => {
  await fill();
  await act(async () => {
    const box = container.querySelector(
      'input[type=checkbox]',
    ) as HTMLInputElement;
    box.click();
  });
  expect(saveButton().disabled).toBe(true);
  const originalFetch = fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      if (url.startsWith('/api/imported-projects/market?'))
        return Promise.resolve(
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
                pairs: [{ address: wallet, dex: 'raydium', marketCapUsd: 150 }],
              },
            ],
          }),
        );
      return originalFetch(url, init);
    }),
  );
  await act(async () =>
    Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent === 'Load saved market pools')!
      .click(),
  );
  await setField('Selected market pool', wallet);
  await setField('Minimum market cap', '100');
  await setField('Maximum market cap', '99');
  expect(saveButton().disabled).toBe(true);
  await setField('Maximum market cap', '200');
  expect(container.textContent).toContain('Bounds are inclusive');
  expect(saveButton().disabled).toBe(false);
  await act(async () => saveButton().click());
  expect(requests[0].body.marketCapRange).toEqual({
    pair: wallet,
    minimumUsd: '100',
    maximumUsd: '200',
  });
  await respond(0);
  expect(saved.mock.calls[0][0].terms.marketCapRange).toEqual(
    requests[0].body.marketCapRange,
  );
});
async function respond(index: number, patch: Record<string, unknown> = {}) {
  const body = requests[index].body;
  const now = new Date().toISOString();
  await act(async () =>
    requests[index].resolve(
      Response.json({
        session: {
          id: body.id,
          revision: 1,
          state: 'active',
          terms: tradeSessionTerms(body, token),
          createdAt: now,
          updatedAt: now,
        },
        control: {
          sessionId: body.id,
          projectId: project.id,
          state: 'ready',
          revision: 1,
          createdAt: now,
          updatedAt: now,
        },
        executionAllowed: false,
        ...patch,
      }),
    ),
  );
}
beforeEach(async () => {
  requests = [];
  saved.mockReset();
  busyChanged.mockReset();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve) =>
          requests.push({
            body: JSON.parse(init.body as string),
            signal: init.signal!,
            resolve,
          }),
        ),
    ),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <DcaTradeSession
        project={project}
        wallets={wallets}
        locked={false}
        onSaved={saved}
        onBusyChange={busyChanged}
      />,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it('previews exact cycle amounts and saves only after an explicit click without signing', async () => {
  expect(requests).toHaveLength(0);
  await fill();
  expect(container.querySelectorAll('li')).toHaveLength(3);
  expect(container.textContent).toContain('Cycle 1: 0.000000004 SOL');
  expect(container.textContent).toContain('Cycle 3: 0.000000003 SOL');
  expect(saveButton().disabled).toBe(false);
  await act(async () => saveButton().click());
  expect(busyChanged).toHaveBeenLastCalledWith(true);
  expect(requests[0].body.strategy).toBe('DCA');
  expect(saved).not.toHaveBeenCalled();
  await respond(0);
  expect(busyChanged).toHaveBeenLastCalledWith(false);
  expect(saved).toHaveBeenCalledOnce();
  expect(container.textContent).toContain('Review each due cycle');
  expect(requests).toHaveLength(1);
});
it('reuses immutable request identity after an ambiguous gateway failure and rejects execution payloads', async () => {
  await fill();
  await act(async () => saveButton().click());
  await act(async () =>
    requests[0].resolve(new Response('gateway', { status: 502 })),
  );
  await act(async () => saveButton().click());
  expect(requests[1].body).toEqual(requests[0].body);
  await respond(1, { executionAllowed: true });
  expect(saved).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Saved DCA differs');
});
it('blocks an invalid or locked budget and cancels a pending save on unmount', async () => {
  await fill();
  await setField('Total DCA input', '0.000000002');
  expect(saveButton().disabled).toBe(true);
  await setField('Total DCA input', '0.000000011');
  await act(async () =>
    root.render(
      <DcaTradeSession
        project={project}
        wallets={wallets}
        locked
        onSaved={saved}
      />,
    ),
  );
  expect(saveButton().disabled).toBe(true);
  await act(async () =>
    root.render(
      <DcaTradeSession
        project={project}
        wallets={wallets}
        locked={false}
        onSaved={saved}
      />,
    ),
  );
  await act(async () => saveButton().click());
  await act(async () => root.unmount());
  expect(requests[0].signal.aborted).toBe(true);
  await respond(0);
  expect(saved).not.toHaveBeenCalled();
  root = createRoot(container);
});
it('includes the reviewed UTC deadline in immutable saved terms and blocks an end before the final cycle', async () => {
  await fill();
  await setField('DCA end', '2026-10-13T12:01');
  expect(saveButton().disabled).toBe(true);
  await setField('DCA end', '2026-10-13T12:05');
  const expectedEnd = new Date('2026-10-13T12:05').toISOString();
  expect(container.textContent).toContain(`DCA stops at ${expectedEnd}`);
  await act(async () => saveButton().click());
  expect(requests[0].body.endsAt).toBe(expectedEnd);
  await respond(0);
  expect(saved.mock.calls[0][0].terms.endsAt).toBe(expectedEnd);
});
