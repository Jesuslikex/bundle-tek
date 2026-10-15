// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import { PumpGroupBroadcast } from './pump-group-broadcast';
import { pumpGroupBroadcastClientFixture } from '../../test/pump-group-broadcast-client-fixture';
import type { PumpGroupBroadcastState } from '@/lib/pump-group-broadcast';
import type { PumpGroupTipSignAction } from '@/lib/pump-group-broadcast-client';
import { collectPumpGroupChainEffects } from '@/lib/pump-group-chain-effects';
import { SOLANA_MAINNET_GENESIS } from '@/lib/wallet-balances';
import { PumpTokenWorkspaceNavigation } from './pump-token-workspace-navigation';
import { pumpTokenWorkspaceFixture } from '../../test/pump-launch-token-workspace-fixture';
let f: Awaited<ReturnType<typeof pumpGroupBroadcastClientFixture>>,
  root: Root,
  container: HTMLDivElement,
  state: PumpGroupBroadcastState;
let fetcher: ReturnType<typeof vi.fn>,
  signer: ReturnType<typeof vi.fn<PumpGroupTipSignAction>>,
  lost = false,
  registrationFailure = false;
const button = (text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === text,
  )!;
async function settle() {
  for (
    let i = 0;
    i < 4000 &&
    container.textContent?.includes('Checking complete broadcast...');
    i++
  )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
}
async function click(text: string) {
  await act(async () => button(text).click());
  await settle();
}
beforeAll(async () => {
  f = await pumpGroupBroadcastClientFixture();
}, 30000);
beforeEach(async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  state = structuredClone(f.state);
  lost = false;
  registrationFailure = false;
  signer = vi.fn<PumpGroupTipSignAction>(async (_r, _g, current) => {
    current();
    return f.tip;
  });
  fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
    if (body.action === 'broadcast-read') return Response.json(state);
    if (body.action === 'broadcast-register-tip') {
      expect(
        JSON.parse(
          localStorage.getItem('bundle.pump-group-tip.v1:' + f.review.id)!,
        ).tip,
      ).toEqual(f.tip);
      if (registrationFailure)
        return new Response('<html>error</html>', { status: 503 });
      state = { ...state, tip: f.tip };
      return Response.json(state);
    }
    if (body.action === 'broadcast-submit') {
      state = {
        ...state,
        attempted: true,
        result: { bundleId: null, outcome: 'unknown' },
      };
      if (lost) throw new Error('Lost response');
      return Response.json(state);
    }
    throw new Error('Unexpected broadcast action');
  });
  vi.stubGlobal('fetch', fetcher);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <PumpGroupBroadcast
        group={f.group}
        contextKey="same"
        canSignTip
        onSignTip={signer}
        onGroup={vi.fn()}
      />,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await settle();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function unobservedWalletResults() {
  return collectPumpGroupChainEffects(
    f.group.review,
    f.group.signedEvidence!,
    new AbortController().signal,
    async (method) => {
      if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
      if (method === 'getTransaction') return null;
      throw new Error('Unexpected effects method');
    },
  );
}
it('reads finalized wallet results only on request, shows incomplete coverage and never signs or submits', async () => {
  const report = await unobservedWalletResults();
  const original = fetcher.getMockImplementation() as (
    url: string,
    init: RequestInit,
  ) => Promise<Response>;
  fetcher.mockImplementation(async (url: string, init: RequestInit) =>
    JSON.parse(typeof init.body === 'string' ? init.body : '{}').action ===
    'chain-effects'
      ? Response.json(report)
      : original(url, init),
  );
  expect(
    fetcher.mock.calls.some(([, init]) =>
      String(init.body).includes('chain-effects'),
    ),
  ).toBe(false);
  await click('Read finalized wallet results');
  expect(container.textContent).toContain(
    'Receipt balance coverage incomplete',
  );
  expect(container.textContent).toContain('Known created-token subtotal');
  expect(container.textContent).toContain('No finalized receipt observed');
  expect(signer).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(0);
  expect(
    fetcher.mock.calls.every(([, init]) =>
      ['broadcast-read', 'chain-effects'].includes(
        JSON.parse(String(init.body)).action,
      ),
    ),
  ).toBe(true);
});
it('discards a delayed wallet result when the visible launch context changes', async () => {
  const report = await unobservedWalletResults();
  const entered = Promise.withResolvers<void>(),
    pending = Promise.withResolvers<Response>();
  const original = fetcher.getMockImplementation() as (
    url: string,
    init: RequestInit,
  ) => Promise<Response>;
  fetcher.mockImplementation(async (url: string, init: RequestInit) => {
    if (
      JSON.parse(typeof init.body === 'string' ? init.body : '{}').action !==
      'chain-effects'
    )
      return original(url, init);
    entered.resolve();
    return pending.promise;
  });
  await act(async () => {
    button('Read finalized wallet results').click();
    await entered.promise;
  });
  await act(async () =>
    root.render(
      <PumpGroupBroadcast
        group={f.group}
        contextKey="changed"
        canSignTip
        onSignTip={signer}
        onGroup={vi.fn()}
      />,
    ),
  );
  await act(async () => pending.resolve(Response.json(report)));
  await settle();
  expect(container.textContent).not.toContain(
    'Receipt balance coverage incomplete',
  );
  expect(container.textContent).toContain(
    'Finalized wallet result context changed',
  );
  expect(signer).not.toHaveBeenCalled();
});
async function renderWorkspaceNavigation(
  contextKey = 'current',
  onOpen = vi.fn(),
) {
  const handoff = pumpTokenWorkspaceFixture(f.group);
  fetcher.mockImplementation(async (_url: string, init: RequestInit) => {
    const action = JSON.parse(
      typeof init.body === 'string' ? init.body : '{}',
    ).action;
    if (action === 'broadcast-read') return Response.json(null);
    if (action === 'token-workspace') return Response.json(handoff.result);
    throw new Error('Unexpected workspace handoff action');
  });
  const render = async (key = contextKey) => {
    await act(async () =>
      root.render(
        <PumpTokenWorkspaceNavigation onOpen={onOpen}>
          <PumpGroupBroadcast
            group={handoff.group}
            contextKey={key}
            onSignTip={signer}
            onGroup={vi.fn()}
          />
        </PumpTokenWorkspaceNavigation>,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await settle();
  };
  await render();
  return { ...handoff, onOpen, render };
}
it('opens the exact finalized token workspace only after a click and does not sign or submit', async () => {
  const handoff = await renderWorkspaceNavigation();
  expect(handoff.onOpen).not.toHaveBeenCalled();
  expect(
    fetcher.mock.calls.every(
      ([, init]) => !String(init.body).includes('token-workspace'),
    ),
  ).toBe(true);
  await click('Open token workspace and chart');
  expect(handoff.onOpen).toHaveBeenCalledExactlyOnceWith(
    handoff.result.project,
  );
  expect(signer).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(0);
  expect(
    fetcher.mock.calls.every(([, init]) =>
      ['broadcast-read', 'token-workspace'].includes(
        JSON.parse(String(init.body)).action,
      ),
    ),
  ).toBe(true);
});
it('does not navigate after a delayed workspace response when the launch context changes', async () => {
  const handoff = await renderWorkspaceNavigation();
  const entered = Promise.withResolvers<void>(),
    pending = Promise.withResolvers<Response>();
  fetcher.mockImplementation(async () => {
    entered.resolve();
    return pending.promise;
  });
  await act(async () => {
    button('Open token workspace and chart').click();
    await entered.promise;
  });
  // Keep the same tree mounted; changing the context must invalidate its pending callback.
  await act(async () =>
    root.render(
      <PumpTokenWorkspaceNavigation onOpen={handoff.onOpen}>
        <PumpGroupBroadcast
          group={handoff.group}
          contextKey="changed"
          onSignTip={signer}
          onGroup={vi.fn()}
        />
      </PumpTokenWorkspaceNavigation>,
    ),
  );
  await act(async () => pending.resolve(Response.json(handoff.result)));
  await settle();
  expect(handoff.onOpen).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Token workspace context changed');
  expect(signer).not.toHaveBeenCalled();
});
it('loads history without signing or submission and requires separate unchecked approvals for tip and broadcast', async () => {
  expect(signer).not.toHaveBeenCalled();
  expect(fetcher.mock.calls).toHaveLength(1);
  expect(button('Approve and sign the reviewed tip locally').disabled).toBe(
    true,
  );
  let checks = [
    ...container.querySelectorAll<HTMLInputElement>('input[type=checkbox]'),
  ];
  expect(checks).toHaveLength(1);
  expect(checks[0].checked).toBe(false);
  await act(async () => checks[0].click());
  await click('Approve and sign the reviewed tip locally');
  expect(signer).toHaveBeenCalledTimes(1);
  expect(button('Broadcast this complete group once').disabled).toBe(true);
  checks = [
    ...container.querySelectorAll<HTMLInputElement>('input[type=checkbox]'),
  ];
  expect(checks).toHaveLength(1);
  expect(checks[0].checked).toBe(false);
  await act(async () => checks[0].click());
  await click('Broadcast this complete group once');
  expect(container.textContent).toContain('One send attempt has been consumed');
  expect(button('Broadcast this complete group once')).toBeUndefined();
  expect(
    fetcher.mock.calls.filter(
      ([, init]) =>
        typeof init.body === 'string' &&
        init.body.includes('"action":"broadcast-submit"'),
    ),
  ).toHaveLength(1);
});
it('retains a complete signed tip before failed registration and retries existing bytes without resigning', async () => {
  registrationFailure = true;
  await act(async () =>
    container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(),
  );
  await click('Approve and sign the reviewed tip locally');
  expect(localStorage.length).toBe(1);
  expect(button('Download retained signed tip')).toBeDefined();
  expect(container.textContent).not.toContain('Unexpected token');
  registrationFailure = false;
  await click('Save existing signed tip without resigning');
  expect(signer).toHaveBeenCalledTimes(1);
  expect(button('Broadcast this complete group once').disabled).toBe(true);
});
it('removes the send control on a lost response and only reloads the consumed attempt', async () => {
  await act(async () =>
    container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(),
  );
  await click('Approve and sign the reviewed tip locally');
  lost = true;
  await act(async () =>
    container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(),
  );
  await click('Broadcast this complete group once');
  expect(container.textContent).toContain('Delivery has not been confirmed');
  expect(button('Broadcast this complete group once')).toBeUndefined();
  await click('Reload saved broadcast');
  expect(container.textContent).toContain('One send attempt has been consumed');
  expect(signer).toHaveBeenCalledTimes(1);
  expect(
    fetcher.mock.calls.filter(
      ([, init]) =>
        typeof init.body === 'string' &&
        init.body.includes('"action":"broadcast-submit"'),
    ),
  ).toHaveLength(1);
});
it('blocks re-signing when an unregistered browser backup is corrupt', async () => {
  localStorage.setItem('bundle.pump-group-tip.v1:' + f.review.id, '{broken');
  await click('Reload saved broadcast');
  expect(button('Approve and sign the reviewed tip locally').disabled).toBe(
    true,
  );
  expect(signer).not.toHaveBeenCalled();
  await click('Discard corrupt local tip backup');
  expect(localStorage.length).toBe(0);
  expect(
    container.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked,
  ).toBe(false);
  expect(button('Approve and sign the reviewed tip locally').disabled).toBe(
    true,
  );
});
it('restores the original signed tip file without unlocking keys, signing or submitting', async () => {
  const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
  const file = {
    size: 1200,
    text: async () => JSON.stringify({ review: f.review, tip: f.tip }),
  };
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () =>
    input.dispatchEvent(new Event('change', { bubbles: true })),
  );
  await settle();
  expect(signer).not.toHaveBeenCalled();
  expect(button('Save existing signed tip without resigning')).toBeDefined();
  await click('Save existing signed tip without resigning');
  expect(signer).not.toHaveBeenCalled();
  expect(state.tip).toEqual(f.tip);
  expect(
    fetcher.mock.calls.some(
      ([, init]) =>
        typeof init.body === 'string' &&
        init.body.includes('"action":"broadcast-submit"'),
    ),
  ).toBe(false);
});
