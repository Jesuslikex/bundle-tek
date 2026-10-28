// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { nativeWithdrawalFixture } from '../test/native-withdrawal-fixture';
import { retainNativeWithdrawalSignature } from '@/lib/native-withdrawal-signature-cache';
import {
  withdrawalOwnerScope,
  WITHDRAWAL_OWNER_SCOPE_HEADER,
} from '@/lib/native-withdrawal-owner-scope';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import { NativeWithdrawalPanel } from './native-withdrawal-panel';

const auth = vi.hoisted(() => ({ owner: 'alice', pending: false }));
vi.mock('better-auth/react', () => ({
  createAuthClient: () => ({
    useSession: () => ({
      data: auth.owner ? { user: { id: auth.owner } } : null,
      isPending: auth.pending,
    }),
  }),
}));
vi.mock('@wallet-standard/app', () => ({
  getWallets: () => ({ get: () => [], on: () => () => {} }),
}));
let root: Root, container: HTMLDivElement, unmounted: boolean;
const fetcher = vi.fn();
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', fetcher);
  fetcher.mockReset();
  sessionStorage.clear();
  unmounted = false;
  auth.owner = 'alice';
  auth.pending = false;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  if (!unmounted) act(() => root.unmount());
  container.remove();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const button = (name: string) => {
  const b = [...container.querySelectorAll('button')].find((x) =>
    x.textContent?.includes(name),
  );
  if (!b) throw Error(`Missing button: ${name}`);
  return b;
};
const click = async (name: string) => act(async () => button(name).click());
async function until(text: string) {
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.textContent).toContain(text);
  });
}
async function fixture() {
  const old = await nativeWithdrawalFixture(),
    next = await nativeWithdrawalFixture();
  const row = (f: typeof old, state: 'cancelled' | 'awaiting_signature') => ({
    id: f.review.id,
    wallet: f.wallet,
    walletRevision: f.review.walletRevision,
    document: f.review,
    state,
    signature: null,
    receipt: null,
    createdAt: f.review.preparedAt,
    updatedAt: f.review.preparedAt,
  });
  const cancelled = row(old, 'cancelled'),
    active = row(next, 'awaiting_signature');
  let serverOwner = 'alice',
    delay = false,
    exact = cancelled;
  let resolveExact!: () => void;
  const calls: { url: string; init?: RequestInit }[] = [];
  fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (init?.method) throw Error('Unexpected POST');
    const p = new URL(url, 'http://localhost').searchParams;
    if (p.get('withdrawalId')) {
      if (delay)
        await new Promise<void>((resolve) => {
          resolveExact = resolve;
        });
      const headers = {
        [WITHDRAWAL_OWNER_SCOPE_HEADER]:
          await withdrawalOwnerScope(serverOwner),
      };
      if (
        new Headers(init?.headers).get(WITHDRAWAL_OWNER_SCOPE_HEADER) !==
        headers[WITHDRAWAL_OWNER_SCOPE_HEADER]
      )
        return Response.json({ error: 'scope' }, { status: 409, headers });
      return Response.json({ withdrawal: exact }, { headers });
    }
    if (p.get('cursor'))
      return Response.json({
        withdrawals: [cancelled],
        active,
        nextCursor: null,
      });
    return Response.json({
      withdrawals: [active],
      active,
      nextCursor: active.id,
    });
  });
  const wallets = [
    { chain: 'Solana', address: old.wallet, label: 'Fixture', archived: false },
  ] as WorkspaceWallet[];
  const render = async () =>
    act(async () =>
      root.render(
        <NativeWithdrawalPanel
          wallets={wallets}
          initialWallet={old.wallet}
          initialOpen
        />,
      ),
    );
  await render();
  await click('Reload withdrawal history');
  await until('Retained withdrawal');
  await click('Load older withdrawals');
  await until('Check for retained signed packet');
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(button('Check for retained signed packet').disabled).toBe(false);
  });
  return {
    old,
    next,
    active,
    cancelled,
    calls,
    render,
    save: () =>
      retainNativeWithdrawalSignature(old.review, old.signed, sessionStorage),
    serverOwner: (s: string) => {
      serverOwner = s;
    },
    delay: () => {
      delay = true;
    },
    resolveExact: () => resolveExact(),
    wrongExact: () => {
      exact = { ...cancelled, id: next.review.id, document: next.review };
    },
  };
}
it('checks exact ownership on request and displays a paginated cancelled packet without changing the active row', async () => {
  const f = await fixture();
  await f.save();
  expect(container.querySelector('textarea')).toBeNull();
  await click('Check for retained signed packet');
  await until('Cancelled withdrawal signed packet');
  expect(container.querySelector('textarea')?.value).toBe(
    f.old.signed.transaction,
  );
  expect(container.textContent).toContain(
    'Retained withdrawal · awaiting_signature',
  );
  expect(container.textContent).toContain('Anyone with it may submit it');
  expect(container.textContent).toContain('Cancellation does not establish');
  expect(f.calls.at(-1)?.url).toContain(`withdrawalId=${f.cancelled.id}`);
  expect(f.calls.at(-1)?.init?.redirect).toBe('error');
  expect(f.calls.filter((x) => x.init?.method)).toHaveLength(0);
});
it('fails closed if no packet is retained', async () => {
  const f = await fixture();
  await click('Check for retained signed packet');
  await until('No exact signed packet is retained');
  expect(container.querySelector('textarea')).toBeNull();
  expect(f.calls.filter((x) => x.init?.method)).toHaveLength(0);
});
it.each(['wallet', 'signature'] as const)(
  'refuses retained data with a tampered %s',
  async (field) => {
    const f = await fixture();
    await f.save();
    const key = `pulseforge.native-withdrawal-signature:${f.cancelled.id}`;
    const record = JSON.parse(sessionStorage.getItem(key)!);
    if (field === 'wallet') record.wallet = '11111111111111111111111111111111';
    else record.signature = '1'.repeat(64);
    sessionStorage.setItem(key, JSON.stringify(record));
    await click('Check for retained signed packet');
    await until('Retained packet storage is unavailable or invalid');
    expect(container.querySelector('textarea')).toBeNull();
  },
);
it('refuses a server-side account mismatch and a different exact row', async () => {
  const f = await fixture();
  await f.save();
  f.serverOwner('bob');
  await click('Check for retained signed packet');
  await until('unavailable for this account');
  expect(container.querySelector('textarea')).toBeNull();
  f.serverOwner('alice');
  f.wrongExact();
  await click('Check for retained signed packet');
  await until('Cancelled withdrawal context differs');
  expect(container.querySelector('textarea')).toBeNull();
});
it.each(['switch', 'pending', 'unmount'] as const)(
  'does not expose a packet if account context becomes %s while the exact request is pending',
  async (change) => {
    const f = await fixture();
    await f.save();
    f.delay();
    await click('Check for retained signed packet');
    await vi.waitFor(() =>
      expect(f.calls.at(-1)?.url).toContain('withdrawalId='),
    );
    if (change === 'switch') {
      auth.owner = 'bob';
      await f.render();
    } else if (change === 'pending') {
      auth.pending = true;
      await f.render();
    } else {
      act(() => root.unmount());
      unmounted = true;
    }
    await act(async () => f.resolveExact());
    expect(container.querySelector('textarea')).toBeNull();
    expect(f.calls.filter((x) => x.init?.method)).toHaveLength(0);
  },
);
it('clears an already displayed packet when the signed-in account changes', async () => {
  const f = await fixture();
  await f.save();
  await click('Check for retained signed packet');
  await until('Cancelled withdrawal signed packet');
  auth.owner = 'bob';
  await f.render();
  expect(container.querySelector('textarea')).toBeNull();
});
