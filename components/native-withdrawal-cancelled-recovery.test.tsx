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
  let historyProblem:
    | 'none'
    | 'missing'
    | 'wrong'
    | 'signedout'
    | 'unavailable' = 'none';
  let historyDelay = false;
  let resolveHistory!: () => void;
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
    if (historyDelay)
      await new Promise<void>((resolve) => {
        resolveHistory = resolve;
      });
    const historyScope = await withdrawalOwnerScope(serverOwner);
    const expected = new Headers(init?.headers).get(
      WITHDRAWAL_OWNER_SCOPE_HEADER,
    );
    if (historyProblem === 'signedout')
      return Response.json({ error: 'Sign in' }, { status: 401 });
    if (historyProblem === 'unavailable')
      return Response.json({ error: 'Unavailable' }, { status: 503 });
    if (expected !== historyScope)
      return Response.json(
        { error: 'scope' },
        {
          status: 409,
          headers: { [WITHDRAWAL_OWNER_SCOPE_HEADER]: historyScope },
        },
      );
    const historyHeaders = new Headers();
    if (historyProblem !== 'missing')
      historyHeaders.set(
        WITHDRAWAL_OWNER_SCOPE_HEADER,
        historyProblem === 'wrong'
          ? await withdrawalOwnerScope('bob')
          : historyScope,
      );
    if (p.get('cursor'))
      return Response.json(
        {
          withdrawals: [cancelled],
          active,
          nextCursor: null,
        },
        { headers: historyHeaders },
      );
    return Response.json(
      {
        withdrawals: [active],
        active,
        nextCursor: active.id,
      },
      { headers: historyHeaders },
    );
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
  await vi.waitFor(() =>
    expect(button('Reload withdrawal history').disabled).toBe(false),
  );
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
    historyProblem: (value: typeof historyProblem) => {
      historyProblem = value;
    },
    delayHistory: () => {
      historyDelay = true;
    },
    resolveHistory: () => resolveHistory(),
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
  const historyCalls = f.calls.filter((x) => !x.url.includes('withdrawalId='));
  expect(historyCalls).toHaveLength(2);
  for (const call of historyCalls) {
    expect(
      new Headers(call.init?.headers).get(WITHDRAWAL_OWNER_SCOPE_HEADER),
    ).toBe(await withdrawalOwnerScope('alice'));
    expect(call.init?.credentials).toBe('same-origin');
    expect(call.init?.redirect).toBe('error');
  }
  expect(f.calls.filter((x) => x.init?.method)).toHaveLength(0);
});
it.each(['mismatch', 'missing', 'wrong', 'signedout', 'unavailable'] as const)(
  'hides prior account rows and refuses the %s history response',
  async (problem) => {
    const f = await fixture();
    if (problem === 'mismatch') f.serverOwner('bob');
    else f.historyProblem(problem);
    await click('Reload withdrawal history');
    await until('Signed-in account changed');
    expect(container.textContent).toContain(
      'account verification is unavailable',
    );
    expect(container.textContent).not.toContain('Retained withdrawal');
    expect(container.textContent).not.toContain(
      'Check for retained signed packet',
    );
    expect(container.querySelector('textarea')).toBeNull();
    expect(f.calls.filter((x) => x.init?.method)).toHaveLength(0);
  },
);
it.each(['switch', 'pending'] as const)(
  'does not expose stale history after the client session becomes %s during its request',
  async (change) => {
    const f = await fixture();
    f.delayHistory();
    await click('Reload withdrawal history');
    await vi.waitFor(() =>
      expect(button('Reload withdrawal history').disabled).toBe(true),
    );
    if (change === 'switch') auth.owner = 'bob';
    else auth.pending = true;
    await f.render();
    await act(async () => f.resolveHistory());
    expect(container.textContent).not.toContain('Retained withdrawal');
    expect(container.querySelector('textarea')).toBeNull();
  },
);
it('withholds history requests while the session is pending', async () => {
  const f = await fixture();
  auth.pending = true;
  await f.render();
  const count = f.calls.length;
  expect(button('Reload withdrawal history').disabled).toBe(true);
  await click('Reload withdrawal history');
  expect(f.calls).toHaveLength(count);
  expect(container.textContent).toContain('wait for account verification');
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
  expect(container.textContent).not.toContain('Retained withdrawal');
  expect(container.textContent).not.toContain(
    'Check for retained signed packet',
  );
  f.serverOwner('alice');
  await click('Reload withdrawal history');
  await until('Retained withdrawal');
  await click('Load older withdrawals');
  await until('Check for retained signed packet');
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
