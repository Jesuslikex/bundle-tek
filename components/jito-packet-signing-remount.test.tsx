// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import bs58 from 'bs58';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TradeSession } from '@/lib/imported-trade-session';
import * as vaultModule from '@/lib/browser-wallet-vault';
import * as memoryModule from '@/lib/jito-memory-signature-recovery';
import {
  JITO_OWNER_SCOPE_HEADER,
  jitoOwnerScope,
} from '@/lib/jito-owner-scope';
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import { JitoAtomicBundle } from './jito-atomic-bundle';

const context = vi.hoisted(() => ({
  wallets: [] as unknown[],
  owner: 'alice',
  pending: false,
}));
vi.mock('@wallet-standard/app', () => ({
  getWallets: () => ({ get: () => context.wallets, on: () => () => {} }),
}));
vi.mock('better-auth/react', () => ({
  createAuthClient: () => ({
    useSession: () => ({
      data: context.owner ? { user: { id: context.owner } } : null,
      isPending: context.pending,
    }),
  }),
}));
let root: Root, container: HTMLDivElement;
const fetcher = vi.fn();
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', fetcher);
  fetcher.mockReset();
  context.wallets = [];
  context.owner = 'alice';
  context.pending = false;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  context.wallets = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const button = (name: string) => {
  const value = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes(name),
  );
  if (!value) throw Error('Missing button: ' + name);
  return value;
};
const click = async (name: string) => act(async () => button(name).click());
async function until(text: string) {
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.textContent).toContain(text);
  });
}
async function fixture() {
  const f = await jitoBundleFixture();
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
    state: 'reviewed',
    bundleId: null,
    signatures: [null, null] as (string | null)[],
    updatedAt: f.manifest.createdAt,
  };
  const history = {
    projectId: f.manifest.projectId,
    sessionId: session.id,
    eligible: [],
    bundles: [bundle],
  };
  const account = {
    address: f.review.wallet,
    publicKey: bs58.decode(f.review.wallet),
    chains: ['solana:mainnet'],
    features: ['solana:signTransaction'],
  };
  let resolveWallet!: (value: { signedTransaction: Uint8Array }[]) => void;
  let rejectWallet!: (reason: unknown) => void;
  let promptStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    promptStarted = resolve;
  });
  const sign = vi.fn(() => {
    promptStarted();
    return new Promise<{ signedTransaction: Uint8Array }[]>(
      (resolve, reject) => {
        resolveWallet = resolve;
        rejectWallet = reject;
      },
    );
  });
  context.wallets = [
    {
      version: '1.0.0',
      name: 'Synthetic fixture',
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
    },
  ];
  const posts: string[] = [];
  let rejectRegistration = false;
  let mismatchRegistration = false;
  let serverOwnerOverride: string | null = null;
  let delayExact = false;
  let resolveExact!: (response: Response) => void;
  let delayCancel = false;
  let resolveCancel!: (response: Response) => void;
  let markCancelStarted!: () => void;
  const cancelStarted = new Promise<void>((resolve) => {
    markCancelStarted = resolve;
  });
  let markExactStarted!: () => void;
  const exactFetchStarted = new Promise<void>((resolve) => {
    markExactStarted = resolve;
  });
  fetcher.mockImplementation(async (_url: string, init?: RequestInit) => {
    const scope = await jitoOwnerScope(
      serverOwnerOverride ?? (context.owner || 'signed-out'),
    );
    const headers = { [JITO_OWNER_SCOPE_HEADER]: scope };
    if (!init?.method && _url.includes('bundleId=')) {
      if (delayExact)
        return new Promise<Response>((resolve) => {
          resolveExact = resolve;
          const abort = () =>
            resolve(new Response(null, { status: 499, headers }));
          init?.signal?.addEventListener('abort', abort, { once: true });
          if (init?.signal?.aborted) abort();
          markExactStarted();
        });
      return Response.json(
        { projectId: session.terms.projectId, sessionId: session.id, bundle },
        { headers },
      );
    }
    if (!init?.method)
      return context.owner === 'alice'
        ? Response.json(history, { headers })
        : Response.json({ error: 'unavailable' }, { status: 404, headers });
    const body = JSON.parse(init.body as string);
    posts.push(body.action);
    if (body.action === 'cancel' && delayCancel)
      return new Promise<Response>((resolve) => {
        resolveCancel = resolve;
        markCancelStarted();
      });
    if (body.action !== 'register') throw Error('Unexpected synthetic action');
    if (rejectRegistration)
      return Response.json(
        { error: 'registration failed' },
        { status: 409, headers },
      );
    if (mismatchRegistration)
      return Response.json(
        { bundle: { ...bundle, signatures: [f.tip.signed.signature, null] } },
        { headers },
      );
    bundle.signatures[body.packet] =
      body.packet === 0 ? f.swap.signed.signature : f.tip.signed.signature;
    return Response.json({ bundle }, { headers });
  });
  const render = async (locked = false) => {
    await act(async () =>
      root.render(
        <JitoAtomicBundle
          projectId={session.terms.projectId}
          session={session}
          locked={locked}
        />,
      ),
    );
    if (context.owner && !context.pending)
      await vi.waitFor(async () => {
        await act(async () => {});
        expect(container.textContent).not.toContain(
          'Sign in and reload bundle history to verify the current account.',
        );
        expect(container.textContent).not.toContain(
          'Checking the signed-in account',
        );
        expect(button('Load bundle approvals').disabled).toBe(false);
      });
  };
  return {
    f,
    session,
    bundle,
    sign,
    started,
    exactFetchStarted,
    cancelStarted,
    posts,
    render,
    resolveWallet: (packet: number) =>
      resolveWallet([
        {
          signedTransaction: Uint8Array.from(
            atob(
              packet === 0
                ? f.swap.signed.transaction
                : f.tip.signed.transaction,
            ),
            (c) => c.charCodeAt(0),
          ),
        },
      ]),
    rejectWallet: (reason: unknown) => rejectWallet(reason),
    failRegister: () => {
      rejectRegistration = true;
    },
    succeedRegister: () => {
      rejectRegistration = false;
    },
    mismatchRegister: () => {
      mismatchRegistration = true;
    },
    serverOwner: (value: string) => {
      serverOwnerOverride = value;
    },
    delayExact: () => {
      delayExact = true;
    },
    delayCancel: () => {
      delayCancel = true;
    },
    resolveCancel: async () => {
      const scope = await jitoOwnerScope('alice');
      bundle.state = 'cancelled';
      resolveCancel(
        Response.json(
          { bundle },
          { headers: { [JITO_OWNER_SCOPE_HEADER]: scope } },
        ),
      );
    },
    omitFromHistory: () => {
      history.bundles = [];
    },
    resolveExact: async () => {
      const scope = await jitoOwnerScope('alice');
      resolveExact(
        Response.json(
          { projectId: session.terms.projectId, sessionId: session.id, bundle },
          { headers: { [JITO_OWNER_SCOPE_HEADER]: scope } },
        ),
      );
    },
  };
}
async function startPrompt(
  f: Awaited<ReturnType<typeof fixture>>,
  packet: number,
  beforeClick?: () => void,
) {
  await f.render();
  await click('Load bundle approvals');
  await until(packet === 0 ? 'Signer for swap 1' : 'Signer for Jito tip');
  const signers = [...container.querySelectorAll('select')];
  const select = signers[packet];
  await act(async () => {
    select.value = 'Synthetic fixture';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const label = [...container.querySelectorAll('label')].find((node) =>
    node.textContent?.includes(
      packet === 0 ? 'I approve signing swap 1' : 'I approve signing Jito tip',
    ),
  )!;
  await act(async () => label.querySelector('input')!.click());
  beforeClick?.();
  await click(packet === 0 ? 'Sign swap 1 only' : 'Sign Jito tip only');
  if (!beforeClick)
    await vi.waitFor(async () => {
      await act(async () => {});
      if (!f.sign.mock.calls.length)
        throw Error('Prompt unavailable: ' + container.textContent);
    });
}
it.each([0, 1])(
  'recovers packet %s after keyed remount only after a fresh scoped history read and explicit registration',
  async (packet) => {
    const f = await fixture();
    await startPrompt(f, packet);
    await f.render(true);
    await act(async () => {
      f.resolveWallet(packet);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(f.posts).toEqual([]);
    expect(container.textContent).not.toContain(
      'original verified signature is retained',
    );
    await click('Load bundle approvals');
    await until('original verified signature is retained');
    expect(container.textContent).toContain(
      'Registration is unavailable for this bundle',
    );
    await f.render(false);
    expect(container.textContent).not.toContain(
      'original verified signature is retained',
    );
    await click('Load bundle approvals');
    await until('original verified signature is retained');
    const approval = [...container.querySelectorAll('label')]
      .find((node) =>
        node.textContent?.includes(
          'I approve registering this exact retained packet only',
        ),
      )!
      .querySelector('input')!;
    expect(approval.checked).toBe(false);
    expect(button('Register retained packet only').disabled).toBe(true);
    f.failRegister();
    await act(async () => approval.click());
    await click('Register retained packet only');
    await until('Registration was not confirmed');
    expect(f.posts).toEqual(['register']);
    expect(container.textContent).toContain(
      'original verified signature is retained',
    );
    f.succeedRegister();
    await click('Register retained packet only');
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(container.textContent).not.toContain(
        'original verified signature is retained',
      );
    });
    expect(f.posts).toEqual(['register', 'register']);
    expect(f.sign).toHaveBeenCalledOnce();
    for (const [, init] of fetcher.mock.calls as [string, RequestInit][])
      expect(init.redirect).toBe('error');
  },
);
it('does not reveal owner A recovery under B or after A returns without a new A-scoped GET', async () => {
  const f = await fixture();
  await startPrompt(f, 0);
  context.owner = 'bob';
  await f.render();
  await act(async () => {
    f.resolveWallet(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await click('Load bundle approvals');
  expect(container.textContent).not.toContain(
    'original verified signature is retained',
  );
  expect(f.posts).toEqual([]);
  context.owner = 'alice';
  await f.render();
  expect(container.textContent).not.toContain(
    'original verified signature is retained',
  );
  await click('Load bundle approvals');
  await until('original verified signature is retained');
  expect(f.posts).toEqual([]);
});
it('refuses to open a wallet prompt when the server session changes before the fresh exact read', async () => {
  const f = await fixture();
  await startPrompt(f, 0, () => f.serverOwner('bob'));
  await until('Signed-in account changed. Reload bundle history.');
  expect(f.sign).not.toHaveBeenCalled();
  expect(f.posts).toEqual([]);
});
it('refuses to open a wallet prompt when the context changes during the fresh exact read', async () => {
  const f = await fixture();
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  await startPrompt(f, 0, f.delayExact);
  await act(async () => {
    await f.exactFetchStarted;
  });
  await f.render(true);
  await act(async () => {
    await f.resolveExact();
  });
  expect(f.sign).not.toHaveBeenCalled();
  expect(f.posts).toEqual([]);
  expect(timeout).toHaveBeenCalledWith(5000);
});
it('does not open a wallet prompt when the short exact-read fence times out', async () => {
  const f = await fixture();
  const controller = new AbortController();
  const original = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) =>
    ms === 5000 ? controller.signal : original(ms),
  );
  await startPrompt(f, 0, f.delayExact);
  await until('Signer preparation is in progress; signing has not started');
  await act(async () => {
    await f.exactFetchStarted;
  });
  await act(async () => controller.abort());
  await until(
    'Bundle response unavailable. Reload saved history before another action.',
  );
  expect(f.sign).not.toHaveBeenCalled();
  expect(f.posts).toEqual([]);
  expect(container.textContent).not.toContain(
    'original wallet signing outcome is still unknown',
  );
});
it('lists omitted pending metadata after scoped history and loads the exact original only on request', async () => {
  const f = await fixture();
  await startPrompt(f, 0);
  await f.render(true);
  await act(async () => {
    f.resolveWallet(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  f.omitFromHistory();
  await f.render(false);
  expect(container.textContent).not.toContain('Load original bundle');
  await click('Load bundle approvals');
  await until('Load original bundle');
  expect(container.textContent).not.toContain(
    'original verified signature is retained',
  );
  expect(f.posts).toEqual([]);
  await click('Load original bundle');
  await until('original verified signature is retained');
  expect(f.posts).toEqual([]);
  expect(f.sign).toHaveBeenCalledOnce();
});
it('says when a fenced signer is being prepared before any prompt starts', async () => {
  const f = await fixture();
  await startPrompt(f, 0, f.delayExact);
  await until('Signer preparation is in progress; signing has not started');
  expect(f.sign).not.toHaveBeenCalled();
  await act(async () => {
    await f.exactFetchStarted;
  });
  await f.render(true);
  await act(async () => {
    await f.resolveExact();
  });
});
it('offers export only after expiry, without reopening signing or submitting', async () => {
  const f = await fixture();
  await startPrompt(f, 0);
  await f.render(true);
  await act(async () => {
    f.resolveWallet(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  vi.spyOn(Date, 'now').mockReturnValue(
    Date.parse(f.f.manifest.expiresAt) + 1000,
  );
  await f.render(false);
  await click('Load bundle approvals');
  await until('original verified signature is retained');
  expect(container.textContent).toContain(
    'Registration is unavailable for this bundle',
  );
  expect(container.textContent).not.toContain('Register retained packet only');
  expect(f.posts).toEqual([]);
  expect(f.sign).toHaveBeenCalledOnce();
});
it.each([0, 1])(
  'retains the synthetic vault packet %s across post-sign expiry without registering or sending',
  async (packet) => {
    const f = await fixture();
    const clock = vi.spyOn(Date, 'now');
    const original = memoryModule.createJitoMemorySignatureRecovery;
    vi.spyOn(
      memoryModule,
      'createJitoMemorySignatureRecovery',
    ).mockImplementation(() => {
      const coordinator = original();
      return {
        ...coordinator,
        capture: async (...args: Parameters<typeof coordinator.capture>) => {
          const result = await coordinator.capture(...args);
          clock.mockReturnValue(Date.parse(f.f.manifest.expiresAt) + 1);
          return result;
        },
      };
    });
    const syntheticSession = {
      payload: {
        wallets: [
          {
            family: 'solana',
            address: f.f.review.wallet,
            seed: '07'.repeat(32),
          },
        ],
      },
    } as unknown as vaultModule.VaultSession;
    vi.spyOn(vaultModule, 'unlockVault').mockResolvedValue(syntheticSession);
    vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('synthetic-vault');
    await f.render();
    await click('Load bundle approvals');
    await until(packet === 0 ? 'Signer for swap 1' : 'Signer for Jito tip');
    const label = [...container.querySelectorAll('label')].find((node) =>
      node.textContent?.includes(
        packet === 0
          ? 'I approve signing swap 1'
          : 'I approve signing Jito tip',
      ),
    )!;
    const password = [...container.querySelectorAll('input[type="password"]')][
      packet
    ] as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(password, 'synthetic-password');
      password.dispatchEvent(new Event('input', { bubbles: true }));
      label.querySelector('input')!.click();
    });
    await click(packet === 0 ? 'Sign swap 1 only' : 'Sign Jito tip only');
    await until('original verified signature is retained');
    expect(f.posts).toEqual([]);
    expect(f.sign).not.toHaveBeenCalled();
    expect(syntheticSession.payload.wallets[0].seed).toBe('');
    await f.render(true);
    await f.render(false);
    await click('Load bundle approvals');
    await until('original verified signature is retained');
    expect(container.textContent).toContain(
      'Registration is unavailable for this bundle',
    );
    expect(container.textContent).not.toContain(
      'Register retained packet only',
    );
    expect(f.posts).toEqual([]);
  },
);
it('offers export only if the bundle was cancelled outside this panel while the prompt was open', async () => {
  const f = await fixture();
  await startPrompt(f, 0);
  await f.render(true);
  await act(async () => {
    f.resolveWallet(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  f.bundle.state = 'cancelled';
  await f.render(false);
  await click('Load bundle approvals');
  await until('original verified signature is retained');
  expect(container.textContent).toContain(
    'Registration is unavailable for this bundle',
  );
  expect(container.textContent).not.toContain('Register retained packet only');
  expect(f.posts).toEqual([]);
});
it('retains an external wallet response arriving after expiry without registration', async () => {
  const f = await fixture();
  await startPrompt(f, 0);
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.f.manifest.expiresAt) + 1);
  await act(async () => {
    f.resolveWallet(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await until('original verified signature is retained');
  expect(f.posts).toEqual([]);
  await f.render(true);
  await f.render(false);
  await click('Load bundle approvals');
  await until('original verified signature is retained');
  expect(container.textContent).not.toContain('Register retained packet only');
  expect(f.posts).toEqual([]);
  expect(f.sign).toHaveBeenCalledOnce();
});
it('does not allow a duplicate signature while the original wallet prompt is unresolved after a remount', async () => {
  const f = await fixture();
  await startPrompt(f, 0);
  await f.render(true);
  await f.render(false);
  await click('Load bundle approvals');
  await until('original wallet signing outcome is still unknown');
  expect(button('Cancel unsigned bundle').disabled).toBe(true);
  expect(button('Sign swap 1 only').disabled).toBe(true);
  expect(button('Sign Jito tip only').disabled).toBe(true);
  expect(button('Prepare and review selected Jito swaps').disabled).toBe(true);
  expect(f.sign).toHaveBeenCalledOnce();
  await act(async () => {
    f.resolveWallet(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await until('original verified signature is retained');
  expect(f.posts).toEqual([]);
  expect(f.sign).toHaveBeenCalledOnce();
});
it('blocks wallet signing while a cancel mutation is in flight', async () => {
  const f = await fixture();
  await f.render();
  await click('Load bundle approvals');
  await until('Signer for swap 1');
  f.delayCancel();
  await click('Cancel unsigned bundle');
  await act(async () => {
    await f.cancelStarted;
  });
  await until('Another Jito action is in progress.');
  expect(button('Sign swap 1 only').disabled).toBe(true);
  expect(button('Sign Jito tip only').disabled).toBe(true);
  expect(f.sign).not.toHaveBeenCalled();
  expect(f.posts).toEqual(['cancel']);
  await act(async () => {
    await f.resolveCancel();
  });
  await until('State: cancelled');
  expect(f.sign).not.toHaveBeenCalled();
});
it('rejects a history response for a different server account before publishing any bundle', async () => {
  const f = await fixture();
  await f.render();
  const wrong = await jitoOwnerScope('bob');
  fetcher.mockResolvedValueOnce(
    Response.json(
      {
        projectId: f.session.terms.projectId,
        sessionId: f.session.id,
        eligible: [],
        bundles: [f.bundle],
      },
      { headers: { [JITO_OWNER_SCOPE_HEADER]: wrong } },
    ),
  );
  await click('Load bundle approvals');
  await until('Signed-in account changed. Reload bundle history.');
  expect(container.textContent).not.toContain('Bundle ' + f.f.manifest.id);
  expect(f.sign).not.toHaveBeenCalled();
  expect(f.posts).toEqual([]);
});
it('says that recovery is memory-only and cannot restore after the outer panel unmounts', async () => {
  const f = await fixture();
  await startPrompt(f, 0);
  expect(container.textContent).toContain(
    'Closing or reloading the page may lose it.',
  );
  act(() => root.unmount());
  root = createRoot(container);
  await act(async () => {
    f.resolveWallet(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await f.render();
  await click('Load bundle approvals');
  await until('Signer for swap 1');
  expect(container.textContent).not.toContain(
    'original verified signature is retained',
  );
  expect(f.posts).toEqual([]);
});
it('releases only an explicitly rejected wallet prompt without registering or submitting', async () => {
  const f = await fixture();
  await startPrompt(f, 0);
  await act(async () => {
    f.rejectWallet({ code: 4001 });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await until('Wallet signing was rejected');
  expect(container.textContent).not.toContain(
    'original wallet signing outcome is still unknown',
  );
  expect(container.textContent).not.toContain(
    'original verified signature is retained',
  );
  expect(f.posts).toEqual([]);
  expect(f.sign).toHaveBeenCalledOnce();
});
it('retains the original signature and does not publish a mismatched registration response', async () => {
  const f = await fixture();
  await startPrompt(f, 0);
  await f.render(true);
  await act(async () => {
    f.resolveWallet(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await f.render(false);
  await click('Load bundle approvals');
  await until('original verified signature is retained');
  const approval = [...container.querySelectorAll('label')]
    .find((node) =>
      node.textContent?.includes(
        'I approve registering this exact retained packet only',
      ),
    )!
    .querySelector('input')!;
  await act(async () => approval.click());
  f.mismatchRegister();
  await click('Register retained packet only');
  await until('Registration was not confirmed');
  expect(container.textContent).toContain(
    'original verified signature is retained',
  );
  expect(f.bundle.signatures[0]).toBeNull();
  expect(f.posts).toEqual(['register']);
  expect(f.sign).toHaveBeenCalledOnce();
});
