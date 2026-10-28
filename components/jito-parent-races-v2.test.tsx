// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import bs58 from 'bs58';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as vault from '@/lib/browser-wallet-vault';
import {
  jitoOwnerScope,
  JITO_OWNER_SCOPE_HEADER,
} from '@/lib/jito-owner-scope';
import {
  reserveJitoRecoveryUnknown,
  retainJitoRecoverySignature,
  withJitoRecoveryJournalLock,
} from '@/lib/jito-recovery-journal';
import type { TradeSession } from '@/lib/imported-trade-session';
import type { JitoAttempt } from '@/lib/jito-sign-attempt-client';
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import { JitoAtomicBundle } from './jito-atomic-bundle';

const env = vi.hoisted(() => ({
  owner: 'alice',
  wallets: [] as unknown[],
  rows: new Map<string, unknown>(),
}));
vi.mock('better-auth/react', () => ({
  createAuthClient: () => ({
    useSession: () => ({ data: { user: { id: env.owner } }, isPending: false }),
  }),
}));
vi.mock('@wallet-standard/app', () => ({
  getWallets: () => ({ get: () => env.wallets, on: () => () => {} }),
}));
vi.mock('@/lib/jito-recovery-journal-store', () => ({
  readJournalEntry: async (key: string) => structuredClone(env.rows.get(key)),
  listJournalEntries: async () => structuredClone([...env.rows.values()]),
  insertJournalUnknown: async (value: { key: string }) => {
    if (env.rows.has(value.key)) throw Error('duplicate');
    env.rows.set(value.key, structuredClone(value));
  },
  retainJournalEntry: async (expected: { key: string }, value: unknown) => {
    if (JSON.stringify(env.rows.get(expected.key)) !== JSON.stringify(expected))
      throw Error('changed');
    env.rows.set(expected.key, structuredClone(value));
  },
  deleteRetainedJournalEntry: async (expected: { key: string }) => {
    if (JSON.stringify(env.rows.get(expected.key)) !== JSON.stringify(expected))
      throw Error('changed');
    env.rows.delete(expected.key);
  },
}));

let root: Root, container: HTMLDivElement;
const locks = new Set<string>();
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal(
    'EventTarget',
    Object.getPrototypeOf(AbortSignal.prototype).constructor,
  );
  vi.stubGlobal('navigator', {
    locks: {
      request: async (
        name: string,
        _options: unknown,
        callback: (held: object | null) => Promise<unknown>,
      ) => {
        if (locks.has(name)) return callback(null);
        locks.add(name);
        try {
          return await callback({ name });
        } finally {
          locks.delete(name);
        }
      },
    },
  });
  env.owner = 'alice';
  env.wallets = [];
  env.rows.clear();
  locks.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function until(check: () => void) {
  await vi.waitFor(
    async () => {
      await act(async () => {});
      check();
    },
    { timeout: 15000 },
  );
}
function button(name: string) {
  const found = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes(name),
  );
  if (!found) throw Error(`Missing button ${name}`);
  return found;
}
async function click(name: string) {
  await act(async () => button(name).click());
}

async function setup() {
  const f = await jitoBundleFixture();
  const alice = await jitoOwnerScope('alice'),
    bob = await jitoOwnerScope('bob');
  const session: TradeSession = {
    id: f.manifest.sessionId,
    revision: f.manifest.sessionRevision,
    state: 'active',
    createdAt: f.manifest.createdAt,
    updatedAt: f.manifest.createdAt,
    terms: {
      format: 'imported-trade-session-v1',
      projectId: f.manifest.projectId,
      projectRevision: 1,
      mint: f.review.outputMint,
      decimals: 6,
      side: 'Buy',
      totalRaw: f.review.inputRaw,
      entries: [
        {
          entry: 1,
          wallet: f.review.wallet,
          walletRevision: 1,
          unitsRaw: f.review.inputRaw,
          amount: '0.01',
        },
      ],
    },
  };
  const bundle = {
    manifest: f.manifest,
    state: 'reviewed' as 'reviewed' | 'cancelled',
    bundleId: null,
    signatures: [null, null] as (string | null)[],
    updatedAt: f.manifest.createdAt,
  };
  const attempts: JitoAttempt[] = [];
  const account = {
    address: f.review.wallet,
    publicKey: Uint8Array.from(bs58.decode(f.review.wallet)),
    chains: ['solana:mainnet'],
    features: ['solana:signTransaction'],
  };
  let resolveSign!: (
    result: { signedTransaction: Uint8Array<ArrayBuffer> }[],
  ) => void;
  let notifySign!: () => void;
  const signStarted = new Promise<void>((resolve) => {
    notifySign = resolve;
  });
  const sign = vi.fn(() => {
    notifySign();
    return new Promise<{ signedTransaction: Uint8Array<ArrayBuffer> }[]>(
      (resolve) => {
        resolveSign = resolve;
      },
    );
  });
  const wallet = {
    version: '1.0.0',
    name: 'Synthetic external',
    icon: 'data:image/png;base64,',
    chains: ['solana:mainnet'],
    accounts: [account],
    features: {
      'standard:connect': {
        version: '1.0.0',
        connect: async () => ({ accounts: [account] }),
      },
      'standard:events': { version: '1.0.0', on: () => () => {} },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: [0, 'legacy'],
        signTransaction: sign,
      },
    },
  };
  env.wallets = [wallet];
  const sessionVault = {
    payload: {
      wallets: [
        { family: 'solana', address: f.review.wallet, seed: '07'.repeat(32) },
      ],
    },
  } as unknown as vault.VaultSession;
  vi.spyOn(vault, 'unlockVault').mockImplementation(async () =>
    structuredClone(sessionVault),
  );
  vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('synthetic-vault');
  let wrongScope = false,
    wrongSession = false,
    duplicateHistory = false,
    holdExact = false,
    holdCancel = false;
  let releaseExact: (() => void) | null = null,
    releaseCancel: (() => void) | null = null;
  let exactCount = 0,
    listCount = 0;
  const posts: string[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.signal?.aborted) throw Error('synthetic timeout');
    const scope = wrongScope ? bob : env.owner === 'alice' ? alice : bob;
    const headers = { [JITO_OWNER_SCOPE_HEADER]: scope };
    if (!init?.method) {
      if (!url.includes('bundleId=')) {
        listCount++;
        return Response.json(
          {
            projectId: f.manifest.projectId,
            sessionId: session.id,
            eligible: [],
            bundles:
              env.owner === 'alice'
                ? duplicateHistory
                  ? [bundle, bundle]
                  : [bundle]
                : [],
          },
          { headers },
        );
      }
      exactCount++;
      if (holdExact) {
        await new Promise<void>((resolve) => {
          releaseExact = resolve;
          init?.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        if (init?.signal?.aborted) throw Error('aborted');
      }
      if (env.owner !== 'alice')
        return Response.json({ error: 'not owned' }, { status: 404, headers });
      return Response.json(
        {
          projectId: f.manifest.projectId,
          sessionId: wrongSession ? crypto.randomUUID() : session.id,
          bundle,
          attempts,
          legacyReadOnly: false,
        },
        { headers },
      );
    }
    const body = JSON.parse(init.body as string);
    posts.push(body.action);
    if (body.action === 'begin-signing') {
      const attempt: JitoAttempt = {
        bundleId: f.manifest.id,
        manifestSha256: f.manifest.sha256,
        packet: 0,
        signer: f.review.wallet,
        intentId: f.review.id,
        attemptId: body.attemptId,
        state: 'unknown',
        signature: null,
        transaction: null,
      };
      attempts.push(attempt);
      return Response.json({ attempt, mayInvokeSigner: true }, { headers });
    }
    if (body.action === 'cancel' && holdCancel) {
      await new Promise<void>((resolve) => {
        releaseCancel = resolve;
      });
      bundle.state = 'cancelled';
      return Response.json({ bundle }, { headers });
    }
    throw Error('unexpected action');
  });
  vi.stubGlobal('fetch', fetcher);
  const render = async (locked = false) =>
    act(async () =>
      root.render(
        <JitoAtomicBundle
          projectId={f.manifest.projectId}
          session={session}
          locked={locked}
        />,
      ),
    );
  const load = async () => {
    await until(() =>
      expect(button('Load bundle approvals and history').disabled).toBe(false),
    );
    await click('Load bundle approvals and history');
  };
  const waitSignReady = async () =>
    until(() => {
      const label = [...container.querySelectorAll('label')].find((node) =>
        node.textContent?.includes('I approve signing swap 1'),
      );
      expect(label?.querySelector('input')?.disabled).toBe(false);
    });
  const prepare = async () => {
    await waitSignReady();
    await act(async () => {
      const signerLabel = [...container.querySelectorAll('label')].find(
        (node) => node.textContent?.trim() === 'Signing method for swap 1',
      )!;
      const select = document.getElementById(signerLabel.htmlFor);
      if (!(select instanceof HTMLSelectElement))
        throw Error('Signer selection unavailable');
      select.value = 'Synthetic external';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const passLabel = [...container.querySelectorAll('label')].find(
        (node) => node.textContent?.trim() === 'Vault password for swap 1',
      )!;
      const input = document.getElementById(
        passLabel.htmlFor,
      ) as HTMLInputElement;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, 'synthetic-password');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const label = [...container.querySelectorAll('label')].find((node) =>
        node.textContent?.includes('I approve signing swap 1'),
      )!;
      label.querySelector('input')!.click();
    });
    await until(() => expect(button('Sign swap 1 only').disabled).toBe(false));
  };
  await render();
  return {
    f,
    alice,
    session,
    bundle,
    attempts,
    sign,
    signStarted,
    posts,
    fetcher,
    render,
    load,
    prepare,
    waitSignReady,
    setWrongScope: (value: boolean) => {
      wrongScope = value;
    },
    setWrongSession: (value: boolean) => {
      wrongSession = value;
    },
    setDuplicate: (value: boolean) => {
      duplicateHistory = value;
    },
    setHoldExact: (value: boolean) => {
      holdExact = value;
    },
    setHoldCancel: (value: boolean) => {
      holdCancel = value;
    },
    getExactCount: () => exactCount,
    getListCount: () => listCount,
    releaseExact: () => {
      holdExact = false;
      releaseExact?.();
    },
    releaseCancel: () => {
      holdCancel = false;
      releaseCancel?.();
    },
    finishSign: () =>
      resolveSign([
        {
          signedTransaction: Uint8Array.from(
            atob(f.swap.signed.transaction),
            (c) => c.charCodeAt(0),
          ),
        },
      ]),
  };
}

it('rejects duplicate history identities without discarding an existing encrypted packet', async () => {
  const f = await setup();
  await withJitoRecoveryJournalLock(
    f.alice,
    () => {},
    async (lock) => {
      const reservation = await reserveJitoRecoveryUnknown(
        lock,
        f.f.manifest,
        0,
        'synthetic-password',
        async () => ({
          ownerScope: f.alice,
          record: structuredClone(f.bundle),
        }),
      );
      await retainJitoRecoverySignature(
        lock,
        reservation,
        f.f.manifest,
        f.f.swap.signed.transaction,
      );
    },
  );
  const prior = structuredClone([...env.rows.values()][0]);
  f.setDuplicate(true);
  await f.load();
  await until(() =>
    expect(container.textContent).toContain('Session bundle history differs'),
  );
  expect([...env.rows.values()][0]).toEqual(prior);
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});

it('keeps Alice recovery private from Bob and requires a new Alice-scoped read after returning', async () => {
  const f = await setup();
  await withJitoRecoveryJournalLock(
    f.alice,
    () => {},
    async (lock) => {
      const reservation = await reserveJitoRecoveryUnknown(
        lock,
        f.f.manifest,
        0,
        'synthetic-password',
        async () => ({
          ownerScope: f.alice,
          record: structuredClone(f.bundle),
        }),
      );
      await retainJitoRecoverySignature(
        lock,
        reservation,
        f.f.manifest,
        f.f.swap.signed.transaction,
      );
    },
  );
  f.attempts.push({
    bundleId: f.f.manifest.id,
    manifestSha256: f.f.manifest.sha256,
    packet: 0,
    signer: f.f.review.wallet,
    intentId: f.f.review.id,
    attemptId: crypto.randomUUID(),
    state: 'unknown',
    signature: null,
    transaction: null,
  });
  await f.load();
  await until(() =>
    expect(container.textContent).toContain('Recover retained swap 1 packet'),
  );
  await until(() => {
    const input = container.querySelector(
      'input[id$="-recovery-password"]',
    ) as HTMLInputElement;
    expect(input?.disabled).toBe(false);
  });
  await act(async () => {
    const input = container.querySelector(
      'input[id$="-recovery-password"]',
    ) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, 'synthetic-password');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Inspect retained swap 1 packet');
  await until(() =>
    expect(container.textContent).toContain(f.f.swap.signed.signature),
  );
  env.owner = 'bob';
  await f.render();
  expect(container.textContent).not.toContain(f.f.swap.signed.signature);
  await f.load();
  expect(container.textContent).not.toContain(f.f.swap.signed.signature);
  const before = f.getListCount();
  env.owner = 'alice';
  await f.render();
  expect(container.textContent).not.toContain(f.f.swap.signed.signature);
  await f.load();
  expect(f.getListCount()).toBeGreaterThan(before);
  expect(container.textContent).not.toContain(f.f.swap.signed.signature);
  await until(() => {
    const input = container.querySelector(
      'input[id$="-recovery-password"]',
    ) as HTMLInputElement;
    expect(input?.disabled).toBe(false);
  });
  await act(async () => {
    const input = container.querySelector(
      'input[id$="-recovery-password"]',
    ) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, 'synthetic-password');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Inspect retained swap 1 packet');
  await until(() =>
    expect(container.textContent).toContain(f.f.swap.signed.signature),
  );
  expect(env.rows.size).toBe(1);
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});

it('refuses a changed server owner before any signer or begin request', async () => {
  const f = await setup();
  await f.load();
  await f.prepare();
  f.setWrongScope(true);
  await click('Sign swap 1 only');
  await until(() =>
    expect(container.textContent).toContain('Signed-in account changed'),
  );
  expect(f.sign).not.toHaveBeenCalled();
  expect(f.posts).toEqual([]);
  expect(env.rows.size).toBe(0);
});

it('refuses a changed server session before any signer or begin request', async () => {
  const f = await setup();
  await f.load();
  await f.prepare();
  f.setWrongSession(true);
  await click('Sign swap 1 only');
  await until(() =>
    expect(container.querySelector('[role=alert]')).not.toBeNull(),
  );
  expect(f.sign).not.toHaveBeenCalled();
  expect(f.posts).toEqual([]);
  expect(env.rows.size).toBe(0);
});

it('abandons a held exact read when session context changes before a wallet prompt', async () => {
  const f = await setup();
  await f.load();
  await f.prepare();
  const before = f.getExactCount();
  f.setHoldExact(true);
  await click('Sign swap 1 only');
  await until(() => expect(f.getExactCount()).toBeGreaterThan(before));
  f.session.revision += 1;
  await f.render();
  f.releaseExact();
  await act(async () => {});
  expect(f.sign).not.toHaveBeenCalled();
  expect(f.posts).toEqual([]);
  expect(env.rows.size).toBe(0);
});

it('fails a short exact-read timeout before creating a signing attempt or prompting a wallet', async () => {
  const f = await setup();
  await f.load();
  await f.prepare();
  const original = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) =>
    ms === 5000 ? AbortSignal.abort('synthetic timeout') : original(ms),
  );
  await click('Sign swap 1 only');
  await until(() =>
    expect(container.querySelector('[role=alert]')).not.toBeNull(),
  );
  expect(f.sign).not.toHaveBeenCalled();
  expect(f.posts).toEqual([]);
  expect(env.rows.size).toBe(0);
});

it('blocks signing while cancellation is pending and does not open a wallet prompt', async () => {
  const f = await setup();
  await f.load();
  await f.waitSignReady();
  f.setHoldCancel(true);
  await click('Cancel unsigned bundle');
  await until(() => expect(f.posts).toEqual(['cancel']));
  await until(() => expect(button('Sign swap 1 only').disabled).toBe(true));
  await click('Sign swap 1 only');
  expect(f.sign).not.toHaveBeenCalled();
  expect(f.posts).toEqual(['cancel']);
  f.releaseCancel();
  await until(() => expect(container.textContent).toContain('cancelled'));
  expect(f.sign).not.toHaveBeenCalled();
});

it('blocks the other packet and cancellation while a swap wallet prompt is unresolved', async () => {
  const f = await setup();
  await f.load();
  await f.prepare();
  await click('Sign swap 1 only');
  await act(async () => {
    await f.signStarted;
  });
  await until(() => expect(button('Sign Jito tip only').disabled).toBe(true));
  expect(button('Cancel unsigned bundle').disabled).toBe(true);
  await click('Sign Jito tip only');
  await click('Cancel unsigned bundle');
  expect(f.sign).toHaveBeenCalledTimes(1);
  expect(f.posts).toEqual(['begin-signing']);
  await act(async () => f.finishSign());
});
