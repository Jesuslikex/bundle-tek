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
import { createJitoPacketRecovery } from '@/lib/jito-packet-recovery';
import * as locatorModule from '@/lib/jito-recovery-locator';
import { bundleFingerprint } from '@/lib/jito-bundle';

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
  // Vitest supplies Node AbortSignal alongside JSDOM EventTarget; use the
  // signal's native EventTarget prototype for the strict local parser.
  vi.stubGlobal(
    'EventTarget',
    Object.getPrototypeOf(AbortSignal.prototype).constructor,
  );
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
    replaceSigner: () => {
      const wallet = context.wallets[0] as {
        features: {
          'solana:signTransaction': { signTransaction: typeof sign };
        };
      };
      wallet.features['solana:signTransaction'] = {
        ...wallet.features['solana:signTransaction'],
        signTransaction: vi.fn(async () => []),
      };
    },
    mutateSigner: () => {
      const wallet = context.wallets[0] as {
        features: {
          'solana:signTransaction': { signTransaction: typeof sign };
        };
      };
      wallet.features['solana:signTransaction'].signTransaction = vi.fn(
        async () => [],
      );
    },
    replaceAccount: () => {
      const wallet = context.wallets[0] as { accounts: (typeof account)[] };
      wallet.accounts = [{ ...account }];
    },
    replaceWithDifferentAccount: () => {
      const wallet = context.wallets[0] as { accounts: (typeof account)[] };
      wallet.accounts = [
        {
          ...account,
          address: '11111111111111111111111111111111',
          publicKey: new Uint8Array(32),
        },
      ];
    },
    clearAccounts: () => {
      const wallet = context.wallets[0] as { accounts: (typeof account)[] };
      wallet.accounts = [];
    },
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
    replaceHistory: (records: typeof history.bundles) => {
      history.bundles = records;
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
async function importPacket(
  f: Awaited<ReturnType<typeof fixture>>,
  packet = 0,
) {
  const signed = packet === 0 ? f.f.swap.signed : f.f.tip.signed;
  const text = JSON.stringify(
    await createJitoPacketRecovery(f.f.manifest, packet, signed.transaction),
  );
  const file = new File([text], 'synthetic-recovery.json', {
    type: 'application/json',
  });
  Object.defineProperty(file, 'text', { value: async () => text });
  const terminal = [...container.querySelectorAll('label')].find((label) =>
    label.textContent?.includes(
      `Verify saved recovery file for packet ${packet + 1}`,
    ),
  );
  const signer = [...container.querySelectorAll('label')].filter((label) =>
    label.textContent?.includes('Signed packet recovery file'),
  )[packet];
  const input = document.getElementById(
    (terminal || signer)!.htmlFor,
  ) as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () =>
    input.dispatchEvent(new Event('change', { bubbles: true })),
  );
}
async function openTerminalRecovery() {
  await until('Inspect saved signed packet recovery');
  const summary = [...container.querySelectorAll('summary')].find((node) =>
    node.textContent?.includes('Inspect saved signed packet recovery'),
  )!;
  const disclosure = summary.parentElement as HTMLDetailsElement;
  expect(disclosure.open).toBe(false);
  await act(async () => summary.click());
  expect(disclosure.open).toBe(true);
}
async function lookupFile(text: string, onRead?: (bytes: Uint8Array) => void) {
  const summary = [...container.querySelectorAll('summary')].find((node) =>
    node.textContent?.includes('Find an older bundle from a recovery file'),
  )!;
  if (!(summary.parentElement as HTMLDetailsElement).open)
    await act(async () => summary.click());
  const label = [...container.querySelectorAll('label')].find((node) =>
    node.textContent?.includes('Signed Jito recovery file'),
  )!;
  const input = document.getElementById(label.htmlFor) as HTMLInputElement;
  const file = new File([text], 'synthetic-lookup.json', {
    type: 'application/json',
  });
  const source = new TextEncoder().encode(text);
  const read = vi.fn(async () => {
    onRead?.(source);
    return source.buffer;
  });
  Object.defineProperty(file, 'arrayBuffer', { value: read });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () =>
    input.dispatchEvent(new Event('change', { bubbles: true })),
  );
  return { source, read };
}
async function lookupText(f: Awaited<ReturnType<typeof fixture>>) {
  return JSON.stringify(
    await createJitoPacketRecovery(
      f.f.manifest,
      0,
      f.f.swap.signed.transaction,
    ),
  );
}
it('finds an older reviewed bundle from one local file and requires history plus separate registration approval', async () => {
  const f = await fixture();
  f.omitFromHistory();
  await f.render();
  const selected = await lookupFile(await lookupText(f));
  await until('Exact signed packet found');
  expect(selected.read).toHaveBeenCalledOnce();
  expect(container.textContent).not.toContain(
    'I approve registering this exact retained packet only',
  );
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
  const reads = fetcher.mock.calls.filter(([url]) =>
    String(url).includes('bundleId='),
  );
  expect(reads).toHaveLength(2);
  for (const [url, init] of reads) {
    expect(String(url)).toContain(encodeURIComponent(f.f.manifest.id));
    expect(String(url)).not.toContain(f.f.swap.signed.transaction);
    expect(String(url)).not.toContain(f.f.swap.signed.signature);
    expect((init as RequestInit).body).toBeUndefined();
  }
  await click('Load bundle approvals');
  await until('I approve registering this exact retained packet only');
  const label = [...container.querySelectorAll('label')].find((node) =>
    node.textContent?.includes(
      'I approve registering this exact retained packet only',
    ),
  )!;
  expect(label.querySelector('input')!.checked).toBe(false);
  expect(button('Register retained packet only').disabled).toBe(true);
  await act(async () => label.querySelector('input')!.click());
  await click('Register retained packet only');
  await vi.waitFor(() => expect(f.posts).toEqual(['register']));
  expect(f.sign).not.toHaveBeenCalled();
});
it('finds the omitted 21st bundle while twenty distinct recent bundles are listed', async () => {
  const f = await fixture();
  const recent = await Promise.all(
    Array.from({ length: 20 }, async (_, i) => {
      const { sha256: _original, ...terms } = f.f.manifest;
      const changed = {
        ...terms,
        id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      };
      return {
        ...f.bundle,
        manifest: { ...changed, sha256: await bundleFingerprint(changed) },
        signatures: [null, null],
      };
    }),
  );
  f.replaceHistory(recent);
  await f.render();
  await click('Load bundle approvals');
  await until('00000000-0000-4000-8000-000000000020');
  expect(container.textContent).not.toContain(`Bundle ${f.f.manifest.id}`);
  await lookupFile(await lookupText(f));
  await until('Exact signed packet found');
  await until('I approve registering this exact retained packet only');
  const label = [...container.querySelectorAll('label')].find((node) =>
    node.textContent?.includes(
      'I approve registering this exact retained packet only',
    ),
  )!;
  expect(label.querySelector('input')!.checked).toBe(false);
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('uses an owned immutable file snapshot even if the original buffer changes during locator parsing', async () => {
  const f = await fixture();
  await f.render();
  const original = locatorModule.readJitoRecoveryLocator;
  let source: Uint8Array | undefined;
  vi.spyOn(locatorModule, 'readJitoRecoveryLocator').mockImplementation(
    async (bytes) => {
      source!.fill(0);
      return original(bytes);
    },
  );
  const selected = await lookupFile(await lookupText(f), (bytes) => {
    source = bytes;
  });
  await until('Exact signed packet found');
  expect(selected.read).toHaveBeenCalledOnce();
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('refuses duplicate keys or a different project/session before any exact-record request', async () => {
  const f = await fixture();
  await f.render();
  const text = await lookupText(f);
  const parsed = JSON.parse(text) as {
    projectId: string;
    sessionId: string;
    bundleId: string;
  };
  const duplicate = text.replace(
    `"bundleId":"${parsed.bundleId}"`,
    `"bundleId":"${parsed.bundleId}","bundleId":"${parsed.bundleId}"`,
  );
  await lookupFile(duplicate);
  await until('Recovery file is unavailable or invalid.');
  await lookupFile(
    JSON.stringify({
      ...JSON.parse(text),
      projectId: '00000000-0000-4000-8000-000000000000',
    }),
  );
  await until('Recovery file belongs to a different project or session.');
  await lookupFile(
    JSON.stringify({
      ...JSON.parse(text),
      sessionId: '00000000-0000-4000-8000-000000000000',
    }),
  );
  await until('Recovery file belongs to a different project or session.');
  await lookupFile('x'.repeat(4097));
  await until('Recovery file is unavailable or invalid.');
  expect(
    fetcher.mock.calls.filter(([url]) => String(url).includes('bundleId=')),
  ).toHaveLength(0);
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('refuses a record whose saved state changes between the two exact reads', async () => {
  const f = await fixture();
  await f.render();
  const implementation = fetcher.getMockImplementation()!;
  let exactReads = 0;
  fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
    if (!init?.method && url.includes('bundleId=') && ++exactReads === 2)
      f.bundle.state = 'cancelled';
    return implementation(url, init);
  });
  await lookupFile(await lookupText(f));
  await until('Bundle changed. Reload saved history before recovery.');
  expect(exactReads).toBe(2);
  expect(container.textContent).not.toContain('Exact signed packet found');
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('preserves an unknown original outcome rather than replacing it from a file', async () => {
  const f = await fixture();
  await startPrompt(f, 0);
  await act(async () => f.rejectWallet(Error('Synthetic outcome unknown')));
  await until('original wallet signing outcome is still unknown');
  fetcher.mockClear();
  await lookupFile(await lookupText(f));
  await until('Original Jito packet recovery is pending.');
  expect(
    fetcher.mock.calls.filter(([url]) => String(url).includes('bundleId=')),
  ).toHaveLength(0);
  expect(f.posts).toEqual([]);
  expect(f.sign).toHaveBeenCalledOnce();
});
it('refuses an older bundle when the authenticated server owner has changed', async () => {
  const f = await fixture();
  await f.render();
  f.serverOwner('bob');
  await lookupFile(await lookupText(f));
  await until('Signed-in account changed. Reload bundle history.');
  expect(container.textContent).not.toContain('Exact signed packet found');
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it.each(['cancelled', 'expired'] as const)(
  'finds an older %s record for export only, with a fresh check before download',
  async (state) => {
    const f = await fixture();
    f.bundle.state = state;
    f.omitFromHistory();
    await f.render();
    const create = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:synthetic');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const download = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    await lookupFile(await lookupText(f));
    await until('This saved bundle is cancelled or expired.');
    expect(container.textContent).not.toContain(
      'Register retained packet only',
    );
    await click('Download verified packet privately');
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledOnce();
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).includes('bundleId=')),
    ).toHaveLength(3);
    expect(f.posts).toEqual([]);
    expect(f.sign).not.toHaveBeenCalled();
  },
);
it('discloses an already registered matching signature without offering another registration', async () => {
  const f = await fixture();
  f.bundle.signatures[0] = f.f.swap.signed.signature;
  await f.render();
  await lookupFile(await lookupText(f));
  await until('This exact signature is already registered.');
  expect(container.textContent).not.toContain('Register retained packet only');
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('reconciles an exact signature observed in refreshed history without another registration', async () => {
  const f = await fixture();
  const original = memoryModule.createJitoMemorySignatureRecovery;
  let coordinator: ReturnType<typeof original> | undefined;
  vi.spyOn(
    memoryModule,
    'createJitoMemorySignatureRecovery',
  ).mockImplementation(() => {
    coordinator = original();
    return coordinator;
  });
  await f.render();
  await lookupFile(await lookupText(f));
  await until('Exact signed packet found');
  const scope = await jitoOwnerScope('alice');
  expect(coordinator!.has(scope, f.f.manifest.id, 0)).toBe(true);
  f.bundle.signatures[0] = f.f.swap.signed.signature;
  await click('Load bundle approvals');
  await until('Saved history already contains this exact signature.');
  expect(container.textContent).not.toContain(
    'I approve registering this exact retained packet only',
  );
  expect(f.posts).toEqual([]);
  await click('Confirm saved signature');
  await until('This exact signature is already registered.');
  expect(coordinator!.has(scope, f.f.manifest.id, 0)).toBe(false);
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('retains the original and blocks registration when refreshed history reports a different signature', async () => {
  const f = await fixture();
  const original = memoryModule.createJitoMemorySignatureRecovery;
  let coordinator: ReturnType<typeof original> | undefined;
  vi.spyOn(
    memoryModule,
    'createJitoMemorySignatureRecovery',
  ).mockImplementation(() => {
    coordinator = original();
    return coordinator;
  });
  await f.render();
  await lookupFile(await lookupText(f));
  await until('Exact signed packet found');
  f.bundle.signatures[0] = f.f.tip.signed.signature;
  await click('Load bundle approvals');
  await until('Saved history contains a different signature.');
  expect(container.textContent).not.toContain(
    'I approve registering this exact retained packet only',
  );
  expect(
    coordinator!.has(await jitoOwnerScope('alice'), f.f.manifest.id, 0),
  ).toBe(true);
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('blocks registration if refreshed history reports a different fingerprint for the same bundle', async () => {
  const f = await fixture();
  await f.render();
  await lookupFile(await lookupText(f));
  await until('Exact signed packet found');
  const { sha256: _old, ...terms } = f.f.manifest;
  const changed = {
    ...terms,
    createdAt: new Date(Date.parse(terms.createdAt) - 1000).toISOString(),
  };
  f.bundle.manifest = { ...changed, sha256: await bundleFingerprint(changed) };
  await click('Load bundle approvals');
  await until('Saved history contains a different bundle fingerprint.');
  expect(container.textContent).not.toContain(
    'I approve registering this exact retained packet only',
  );
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('refuses duplicate bundle IDs in history without discarding the retained packet', async () => {
  const f = await fixture();
  const original = memoryModule.createJitoMemorySignatureRecovery;
  let coordinator: ReturnType<typeof original> | undefined;
  vi.spyOn(
    memoryModule,
    'createJitoMemorySignatureRecovery',
  ).mockImplementation(() => {
    coordinator = original();
    return coordinator;
  });
  await f.render();
  await lookupFile(await lookupText(f));
  await until('Exact signed packet found');
  f.replaceHistory([f.bundle, f.bundle]);
  await click('Load bundle approvals');
  await until('Session bundle history differs.');
  expect(
    coordinator!.has(await jitoOwnerScope('alice'), f.f.manifest.id, 0),
  ).toBe(true);
  expect(container.textContent).not.toContain(
    'I approve registering this exact retained packet only',
  );
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('keeps a retained packet export-only when refreshed history reports a terminal state', async () => {
  const f = await fixture();
  const original = memoryModule.createJitoMemorySignatureRecovery;
  let coordinator: ReturnType<typeof original> | undefined;
  vi.spyOn(
    memoryModule,
    'createJitoMemorySignatureRecovery',
  ).mockImplementation(() => {
    coordinator = original();
    return coordinator;
  });
  await f.render();
  await lookupFile(await lookupText(f));
  await until('Exact signed packet found');
  f.bundle.state = 'cancelled';
  await click('Load bundle approvals');
  await until('The saved bundle state changed.');
  expect(container.textContent).not.toContain(
    'I approve registering this exact retained packet only',
  );
  expect(
    coordinator!.has(await jitoOwnerScope('alice'), f.f.manifest.id, 0),
  ).toBe(true);
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('keeps the original pending if account context changes during saved-signature confirmation', async () => {
  const f = await fixture();
  const original = memoryModule.createJitoMemorySignatureRecovery;
  let coordinator: ReturnType<typeof original> | undefined;
  vi.spyOn(
    memoryModule,
    'createJitoMemorySignatureRecovery',
  ).mockImplementation(() => {
    coordinator = original();
    return coordinator;
  });
  await f.render();
  await lookupFile(await lookupText(f));
  await until('Exact signed packet found');
  f.bundle.signatures[0] = f.f.swap.signed.signature;
  await click('Load bundle approvals');
  await until('Saved history already contains this exact signature.');
  f.delayExact();
  await click('Confirm saved signature');
  await act(async () => f.exactFetchStarted);
  await f.render(true);
  await act(async () => f.resolveExact());
  expect(
    coordinator!.has(await jitoOwnerScope('alice'), f.f.manifest.id, 0),
  ).toBe(true);
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('refuses a conflicting saved signature rather than displaying the imported packet', async () => {
  const f = await fixture();
  f.bundle.signatures[0] = f.f.tip.signed.signature;
  await f.render();
  await lookupFile(await lookupText(f));
  await until('Saved bundle signature differs from this recovery file.');
  expect(container.textContent).not.toContain(
    'This exact signature is already registered.',
  );
  expect(f.posts).toEqual([]);
});
it('does not publish a lookup result if the context changes during the owner-scoped read', async () => {
  const f = await fixture();
  await f.render();
  f.delayExact();
  await lookupFile(await lookupText(f));
  await act(async () => f.exactFetchStarted);
  await f.render(true);
  await act(async () => f.resolveExact());
  expect(container.textContent).not.toContain('Exact signed packet found');
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('synchronously blocks a stale cancel while lookup is reading the exact record', async () => {
  const f = await fixture();
  await f.render();
  await click('Load bundle approvals');
  await until('Signer for swap 1');
  const cancel = button('Cancel unsigned bundle');
  const key = Object.keys(cancel).find((name) =>
    name.startsWith('__reactProps$'),
  )!;
  const stale = (cancel as unknown as Record<string, { onClick: () => void }>)[
    key
  ].onClick;
  f.delayExact();
  await lookupFile(await lookupText(f));
  await act(async () => f.exactFetchStarted);
  await act(async () => stale());
  expect(f.posts).toEqual([]);
  await f.render(true);
  await act(async () => f.resolveExact());
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('does not close a stale recovery view during a pending export', async () => {
  const f = await fixture();
  f.bundle.state = 'cancelled';
  await f.render();
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  await lookupFile(await lookupText(f));
  await until('This saved bundle is cancelled or expired.');
  const close = button('Close recovery view');
  const key = Object.keys(close).find((name) =>
    name.startsWith('__reactProps$'),
  )!;
  const stale = (close as unknown as Record<string, { onClick: () => void }>)[
    key
  ].onClick;
  f.delayExact();
  await click('Download verified packet privately');
  await act(async () => f.exactFetchStarted);
  await act(async () => stale());
  expect(container.textContent).toContain(
    'This saved bundle is cancelled or expired.',
  );
  await act(async () => f.resolveExact());
  expect(f.posts).toEqual([]);
});
it('refuses stale registration after an in-flight history refresh fails', async () => {
  const f = await fixture();
  f.omitFromHistory();
  const original = memoryModule.createJitoMemorySignatureRecovery;
  let delay = false,
    release!: () => void,
    markStarted!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  vi.spyOn(
    memoryModule,
    'createJitoMemorySignatureRecovery',
  ).mockImplementation(() => {
    const coordinator = original();
    return {
      ...coordinator,
      inspect: async (...args: Parameters<typeof coordinator.inspect>) => {
        if (delay) {
          delay = false;
          markStarted();
          await gate;
        }
        return coordinator.inspect(...args);
      },
    };
  });
  await f.render();
  await lookupFile(await lookupText(f));
  await until('Exact signed packet found');
  await click('Load bundle approvals');
  await until('I approve registering this exact retained packet only');
  const label = [...container.querySelectorAll('label')].find((node) =>
    node.textContent?.includes(
      'I approve registering this exact retained packet only',
    ),
  )!;
  await act(async () => label.querySelector('input')!.click());
  delay = true;
  await click('Register retained packet only');
  await act(async () => started);
  const scope = await jitoOwnerScope('alice');
  fetcher.mockResolvedValueOnce(
    Response.json(
      { error: 'History unavailable.' },
      { status: 503, headers: { [JITO_OWNER_SCOPE_HEADER]: scope } },
    ),
  );
  await click('Load bundle approvals');
  await until('History unavailable.');
  await act(async () => release());
  await until('Registration was not confirmed.');
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('refuses stale registration when refreshed history records the signature before the POST', async () => {
  const f = await fixture();
  const original = memoryModule.createJitoMemorySignatureRecovery;
  let delay = false,
    release!: () => void,
    markStarted!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  vi.spyOn(
    memoryModule,
    'createJitoMemorySignatureRecovery',
  ).mockImplementation(() => {
    const coordinator = original();
    return {
      ...coordinator,
      inspect: async (...args: Parameters<typeof coordinator.inspect>) => {
        if (delay) {
          delay = false;
          markStarted();
          await gate;
        }
        return coordinator.inspect(...args);
      },
    };
  });
  await f.render();
  await lookupFile(await lookupText(f));
  await until('Exact signed packet found');
  await click('Load bundle approvals');
  await until('I approve registering this exact retained packet only');
  const label = [...container.querySelectorAll('label')].find((node) =>
    node.textContent?.includes(
      'I approve registering this exact retained packet only',
    ),
  )!;
  await act(async () => label.querySelector('input')!.click());
  delay = true;
  await click('Register retained packet only');
  await act(async () => started);
  f.bundle.signatures[0] = f.f.swap.signed.signature;
  await click('Load bundle approvals');
  await until('Saved history already contains this exact signature.');
  await act(async () => release());
  await until('Registration was not confirmed.');
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it.each(['cancelled', 'expired'] as const)(
  'inspects a %s bundle recovery file through the owner-scoped exact record without signing or submission',
  async (state) => {
    const f = await fixture();
    f.bundle.state = state;
    await f.render();
    await click('Load bundle approvals');
    await openTerminalRecovery();
    await importPacket(f);
    await until('Exact signed packet verified');
    expect(container.textContent).toContain(
      'does not register, sign or submit',
    );
    expect(container.textContent).not.toContain(
      'Register retained packet only',
    );
    expect(container.textContent).not.toContain('Sign swap 1 only');
    expect(container.textContent).not.toContain('Submit complete Jito bundle');
    expect(f.posts).toEqual([]);
    expect(f.sign).not.toHaveBeenCalled();
  },
);
it('refuses terminal import when the authenticated account changes before the exact read', async () => {
  const f = await fixture();
  f.bundle.state = 'cancelled';
  await f.render();
  await click('Load bundle approvals');
  await openTerminalRecovery();
  f.serverOwner('bob');
  await importPacket(f);
  await until('Signed-in account changed. Reload bundle history.');
  expect(container.textContent).not.toContain('Exact signed packet verified');
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('refuses terminal import if the fresh saved record is no longer terminal', async () => {
  const f = await fixture();
  f.bundle.state = 'cancelled';
  await f.render();
  await click('Load bundle approvals');
  await openTerminalRecovery();
  f.delayExact();
  await importPacket(f);
  await act(async () => f.exactFetchStarted);
  f.bundle.state = 'reviewed';
  await act(async () => f.resolveExact());
  await until('Bundle changed. Reload saved history before recovery.');
  expect(container.textContent).not.toContain('Exact signed packet verified');
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('refuses terminal import if the saved packet signature conflicts', async () => {
  const f = await fixture();
  f.bundle.state = 'expired';
  f.bundle.signatures[0] = f.f.tip.signed.signature;
  await f.render();
  await click('Load bundle approvals');
  await openTerminalRecovery();
  await importPacket(f);
  await until('Saved bundle signature differs from this recovery file.');
  expect(container.textContent).not.toContain('Exact signed packet verified');
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it.each([0, 1])(
  'retains imported packet %s in the coordinator and blocks unsigned cancellation until explicit registration',
  async (packet) => {
    const f = await fixture();
    await f.render();
    await click('Load bundle approvals');
    await until('Signer for swap 1');
    await importPacket(f, packet);
    await until('original verified signature is retained');
    expect(button('Cancel unsigned bundle').disabled).toBe(true);
    expect(f.posts).toEqual([]);
    expect(f.sign).not.toHaveBeenCalled();
    const label = [...container.querySelectorAll('label')].find((node) =>
      node.textContent?.includes(
        'I approve registering this exact retained packet only',
      ),
    )!;
    expect(label.querySelector('input')!.checked).toBe(false);
    expect(button('Register retained packet only').disabled).toBe(true);
    await f.render(true);
    await f.render(false);
    await click('Load bundle approvals');
    await until('original verified signature is retained');
    expect(button('Cancel unsigned bundle').disabled).toBe(true);
    expect(f.posts).toEqual([]);
  },
);
it('blocks cancellation during imported-file validation and refuses a changed context', async () => {
  const f = await fixture();
  await f.render();
  await click('Load bundle approvals');
  await until('Signer for swap 1');
  f.delayExact();
  await importPacket(f);
  await act(async () => f.exactFetchStarted);
  expect(button('Cancel unsigned bundle').disabled).toBe(true);
  expect(f.posts).toEqual([]);
  await f.render(true);
  await act(async () => f.resolveExact());
  await f.render(false);
  await click('Load bundle approvals');
  expect(container.textContent).not.toContain(
    'original verified signature is retained',
  );
  expect(f.sign).not.toHaveBeenCalled();
  expect(f.posts).toEqual([]);
});
it('registers an imported exact packet only after a separate unchecked approval', async () => {
  const f = await fixture();
  await f.render();
  await click('Load bundle approvals');
  await until('Signer for swap 1');
  const tipSelect = [...container.querySelectorAll('select')][1];
  await act(async () => {
    tipSelect.value = 'Synthetic fixture';
    tipSelect.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const tipApproval = [...container.querySelectorAll('label')].find((node) =>
    node.textContent?.includes('I approve signing Jito tip'),
  )!;
  await act(async () => tipApproval.querySelector('input')!.click());
  expect(button('Sign Jito tip only').disabled).toBe(false);
  await importPacket(f);
  await until('original verified signature is retained');
  const label = [...container.querySelectorAll('label')].find((node) =>
    node.textContent?.includes(
      'I approve registering this exact retained packet only',
    ),
  )!;
  const checkbox = label.querySelector('input')!;
  expect(checkbox.checked).toBe(false);
  expect(button('Sign Jito tip only').disabled).toBe(true);
  expect(f.posts).toEqual([]);
  await act(async () => checkbox.click());
  await click('Register retained packet only');
  await vi.waitFor(() => expect(f.posts).toEqual(['register']));
  expect(f.bundle.signatures[0]).toBe(f.f.swap.signed.signature);
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(button('Sign Jito tip only').disabled).toBe(false);
  });
  expect(f.sign).not.toHaveBeenCalled();
});
it('blocks a stale cross-packet sign handler synchronously before any wallet prompt', async () => {
  const f = await fixture();
  const original = memoryModule.createJitoMemorySignatureRecovery;
  let cache: ReturnType<typeof original> | undefined;
  vi.spyOn(
    memoryModule,
    'createJitoMemorySignatureRecovery',
  ).mockImplementation(() => {
    cache = original();
    // Suppress coordinator-driven parent renders to model a stale UI callback.
    return {
      ...cache,
      subscribe: () => () => {},
      subscribeOperations: () => () => {},
    };
  });
  await f.render();
  await click('Load bundle approvals');
  await until('Signer for swap 1');
  const tipSelect = [...container.querySelectorAll('select')][1];
  await act(async () => {
    tipSelect.value = 'Synthetic fixture';
    tipSelect.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const label = [...container.querySelectorAll('label')].find((node) =>
    node.textContent?.includes('I approve signing Jito tip'),
  )!;
  await act(async () => label.querySelector('input')!.click());
  expect(button('Sign Jito tip only').disabled).toBe(false);
  await importPacket(f);
  const scope = await jitoOwnerScope('alice');
  await vi.waitFor(() =>
    expect(cache!.has(scope, f.f.manifest.id, 0)).toBe(true),
  );
  expect(button('Sign Jito tip only').disabled).toBe(false);
  await click('Sign Jito tip only');
  await until('A Jito signing outcome is still pending.');
  expect(f.sign).not.toHaveBeenCalled();
  expect(f.posts).toEqual([]);
});
it('blocks all new signing and submission while a prior wallet outcome remains unknown', async () => {
  const f = await fixture();
  await startPrompt(f, 0);
  await act(async () =>
    f.rejectWallet(Error('Synthetic wallet outcome unknown')),
  );
  await until('original wallet signing outcome is still unknown');
  expect(button('Sign swap 1 only').disabled).toBe(true);
  expect(button('Sign Jito tip only').disabled).toBe(true);
  expect(button('Cancel unsigned bundle').disabled).toBe(true);
  expect(f.posts).toEqual([]);
  // Even a later history response containing both signatures cannot enable
  // submit while the original local outcome has not been resolved.
  f.bundle.signatures[0] = f.f.swap.signed.signature;
  f.bundle.signatures[1] = f.f.tip.signed.signature;
  await click('Load bundle approvals');
  await until('I approve submitting all');
  const submitLabel = [...container.querySelectorAll('label')].find((node) =>
    node.textContent?.includes('I approve submitting all'),
  )!;
  expect(submitLabel.querySelector('input')!.disabled).toBe(true);
  expect(button('Submit complete Jito bundle').disabled).toBe(true);
  expect(f.posts).toEqual([]);
});
it('refuses an imported packet if the server owner changes before its exact read', async () => {
  const f = await fixture();
  await f.render();
  await click('Load bundle approvals');
  await until('Signer for swap 1');
  f.serverOwner('bob');
  await importPacket(f);
  await until('Signed-in account changed. Reload bundle history.');
  expect(container.textContent).not.toContain(
    'original verified signature is retained',
  );
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('allows a verified expired import for export only, without registration, signing or sending', async () => {
  const f = await fixture();
  const clock = vi
    .spyOn(Date, 'now')
    .mockReturnValue(Date.parse(f.f.manifest.expiresAt) + 1000);
  try {
    await f.render();
    await click('Load bundle approvals');
    await until('Signer for swap 1');
    await importPacket(f);
    await until('original verified signature is retained');
    expect(container.textContent).toContain('Registration is unavailable');
    expect(container.textContent).not.toContain(
      'Register retained packet only',
    );
    expect(button('Cancel unsigned bundle').disabled).toBe(true);
    expect(f.posts).toEqual([]);
    expect(f.sign).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});
it.each([0, 1])(
  'registers packet %s after an unchanged external wallet finishes its final check',
  async (packet) => {
    const f = await fixture();
    await startPrompt(f, packet);
    await act(async () => f.resolveWallet(packet));
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(f.posts).toEqual(['register']);
      expect(f.bundle.signatures[packet]).toBeTruthy();
    });
    expect(f.sign).toHaveBeenCalledOnce();
  },
);
it('preserves the empty-account-list fallback after an external swap prompt', async () => {
  const f = await fixture();
  await startPrompt(f, 0);
  f.clearAccounts();
  await act(async () => f.resolveWallet(0));
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(f.posts).toEqual(['register']);
  });
});
it.each([
  [0, 'signer'],
  [0, 'mutated signer'],
  [0, 'account'],
  [0, 'different account'],
  [1, 'signer'],
  [1, 'mutated signer'],
  [1, 'account'],
  [1, 'different account'],
] as const)(
  'retains packet %s but never registers when the external %s changes during the prompt',
  async (packet, change) => {
    const f = await fixture();
    await startPrompt(f, packet);
    if (change === 'signer') f.replaceSigner();
    else if (change === 'mutated signer') f.mutateSigner();
    else if (change === 'account') f.replaceAccount();
    else f.replaceWithDifferentAccount();
    await act(async () => f.resolveWallet(packet));
    await until('original verified signature is retained');
    await until('changed');
    expect(f.posts).toEqual([]);
    expect(f.bundle.signatures[packet]).toBeNull();
    expect(f.sign).toHaveBeenCalledOnce();
    const approval = [...container.querySelectorAll('label')]
      .find((node) =>
        node.textContent?.includes(
          'I approve registering this exact retained packet only',
        ),
      )!
      .querySelector('input')!;
    expect(approval.checked).toBe(false);
    expect(button('Register retained packet only').disabled).toBe(true);
  },
);
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
