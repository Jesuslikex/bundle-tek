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
import type { JitoAttempt } from '@/lib/jito-sign-attempt-client';
// Historical synthetic prompt/recovery contracts remain exercised explicitly.
// Production defaults stay off and are checked by the route/parent gate suites.
vi.mock('@/lib/jito-cpmm-unsigned-review', async (original) => ({
  ...(await original<typeof import('@/lib/jito-cpmm-unsigned-review')>()),
  JITO_RUNTIME_SIGNING_ENABLED: true,
}));

const journal = vi.hoisted(() => ({ rows: new Map<string, unknown>() }));
vi.mock('@/lib/jito-recovery-journal-store', () => ({
  readJournalEntry: async (key: string) =>
    structuredClone(journal.rows.get(key)),
  listJournalEntries: async () => structuredClone([...journal.rows.values()]),
  insertJournalUnknown: async (value: { key: string }) => {
    if (journal.rows.has(value.key)) throw Error('duplicate');
    journal.rows.set(value.key, structuredClone(value));
  },
  retainJournalEntry: async (expected: { key: string }, value: unknown) => {
    if (
      JSON.stringify(journal.rows.get(expected.key)) !==
      JSON.stringify(expected)
    )
      throw Error('changed');
    journal.rows.set(expected.key, structuredClone(value));
  },
  deleteRetainedJournalEntry: async (expected: { key: string }) => {
    if (
      JSON.stringify(journal.rows.get(expected.key)) !==
      JSON.stringify(expected)
    )
      throw Error('changed');
    journal.rows.delete(expected.key);
  },
}));
const locks = new Set<string>();

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
  journal.rows.clear();
  locks.clear();
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
  const attempts: JitoAttempt[] = [];
  vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('synthetic-vault');
  vi.spyOn(vaultModule, 'unlockVault').mockImplementation(
    async () =>
      ({
        payload: {
          wallets: [
            {
              family: 'solana',
              address: f.review.wallet,
              seed: '07'.repeat(32),
            },
          ],
        },
      }) as unknown as ReturnType<typeof vaultModule.unlockVault>,
  );
  const exact = () => ({
    projectId: session.terms.projectId,
    sessionId: session.id,
    bundle,
    attempts: structuredClone(attempts),
    legacyReadOnly,
  });
  let rejectRegistration = false;
  let mismatchRegistration = false;
  let serverOwnerOverride: string | null = null;
  let legacyReadOnly = false;
  let delayExact = false;
  let resolveExact!: (response: Response) => void;
  let delayCancel = false;
  let resolveCancel!: (response: Response) => void;
  let markCancelStarted!: () => void;
  const cancelStarted = new Promise<void>((resolve) => {
    markCancelStarted = resolve;
  });
  let markExactStarted!: () => void;
  let exactStarted = false;
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
          exactStarted = true;
          markExactStarted();
        });
      const id = new URL(_url, 'http://localhost').searchParams.get('bundleId');
      if (id === bundle.manifest.id) return Response.json(exact(), { headers });
      const found = history.bundles.find((item) => item.manifest.id === id);
      if (!found)
        return Response.json(
          { error: 'Owned bundle unavailable.' },
          { status: 404, headers },
        );
      return Response.json(
        {
          projectId: session.terms.projectId,
          sessionId: session.id,
          bundle: found,
          attempts: [],
          legacyReadOnly: false,
        },
        { headers },
      );
    }
    if (!init?.method)
      return context.owner === 'alice'
        ? Response.json(history, { headers })
        : Response.json({ error: 'unavailable' }, { status: 404, headers });
    const body = JSON.parse(init.body as string);
    posts.push(body.action);
    if (body.action === 'begin-signing') {
      if (
        body.approved !== true ||
        body.id !== bundle.manifest.id ||
        body.sha256 !== bundle.manifest.sha256 ||
        attempts.some((a) => a.packet === body.packet)
      )
        return Response.json(
          { error: 'attempt differs' },
          { status: 409, headers },
        );
      const review = bundle.manifest.swaps[body.packet];
      const attempt: JitoAttempt = {
        bundleId: bundle.manifest.id,
        manifestSha256: bundle.manifest.sha256,
        packet: body.packet,
        signer: review?.wallet ?? bundle.manifest.tip.wallet,
        intentId: review?.id ?? null,
        attemptId: body.attemptId,
        state: 'unknown',
        signature: null,
        transaction: null,
      };
      attempts.push(attempt);
      return Response.json({ attempt, mayInvokeSigner: true }, { headers });
    }
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
    const index = attempts.findIndex(
      (a) => a.packet === body.packet && a.attemptId === body.attemptId,
    );
    if (index < 0)
      return Response.json(
        { error: 'attempt unavailable' },
        { status: 409, headers },
      );
    const checked = await createJitoPacketRecovery(
      bundle.manifest,
      body.packet,
      body.transaction,
    );
    attempts[index] = {
      ...attempts[index],
      state: 'registered',
      signature: checked.signature,
      transaction: body.transaction,
    };
    bundle.signatures[body.packet] = checked.signature;
    return Response.json({ bundle }, { headers });
  });
  const render = async (locked = false, expectReady = true) => {
    await act(async () =>
      root.render(
        <JitoAtomicBundle
          projectId={session.terms.projectId}
          session={session}
          locked={locked}
        />,
      ),
    );
    if (expectReady && context.owner && !context.pending)
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
    exactHasStarted: () => exactStarted,
    cancelStarted,
    posts,
    attempts,
    seedUnknown: (packet: number) => {
      const review = bundle.manifest.swaps[packet];
      attempts.push({
        bundleId: bundle.manifest.id,
        manifestSha256: bundle.manifest.sha256,
        packet,
        signer: review?.wallet ?? bundle.manifest.tip.wallet,
        intentId: review?.id ?? null,
        attemptId: crypto.randomUUID(),
        state: 'unknown',
        signature: null,
        transaction: null,
      });
    },
    seedRegistered: (packet: number) => {
      const review = bundle.manifest.swaps[packet];
      const signed = packet === 0 ? f.swap.signed : f.tip.signed;
      attempts.push({
        bundleId: bundle.manifest.id,
        manifestSha256: bundle.manifest.sha256,
        packet,
        signer: review?.wallet ?? bundle.manifest.tip.wallet,
        intentId: review?.id ?? null,
        attemptId: crypto.randomUUID(),
        state: 'registered',
        signature: signed.signature,
        transaction: signed.transaction,
      });
      bundle.signatures[packet] = signed.signature;
    },
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
    setLegacy: () => {
      legacyReadOnly = true;
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
      delayExact = false;
      resolveExact(
        Response.json(exact(), {
          headers: { [JITO_OWNER_SCOPE_HEADER]: scope },
        }),
      );
    },
    failExact: async () => {
      const scope = await jitoOwnerScope('alice');
      delayExact = false;
      resolveExact(
        Response.json(
          { error: 'unavailable' },
          { status: 503, headers: { [JITO_OWNER_SCOPE_HEADER]: scope } },
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
  const passLabel = [...container.querySelectorAll('label')].find((node) =>
    node.textContent?.includes(
      packet === 0
        ? 'Vault password for swap 1'
        : 'Vault password for Jito tip',
    ),
  )!;
  const passInput = document.getElementById(
    passLabel.htmlFor,
  ) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(passInput, 'synthetic-password');
    passInput.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(label.querySelector('input')!.disabled).toBe(false);
  });
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
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => new TextEncoder().encode(text).buffer,
  });
  const terminal = [...container.querySelectorAll('label')].find((label) =>
    label.textContent?.includes(
      `Verify saved recovery file for packet ${packet + 1}`,
    ),
  );
  const signer = [...container.querySelectorAll('label')].filter(
    (label) =>
      label.textContent?.includes('Signed packet recovery file') &&
      label.htmlFor.endsWith('-file'),
  )[packet];
  const input = document.getElementById(
    (terminal || signer)!.htmlFor,
  ) as HTMLInputElement;
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(input.disabled).toBe(false);
  });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () =>
    input.dispatchEvent(new Event('change', { bubbles: true })),
  );
  if (!terminal) {
    const panel = input.closest('div')!;
    const password = panel.querySelector(
      'input[type=password]',
    ) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(password, 'synthetic-password');
      password.dispatchEvent(new Event('input', { bubbles: true }));
      const verify = [...panel.querySelectorAll('button')].find((item) =>
        item.textContent?.includes('Verify and retain'),
      )!;
      verify.click();
    });
  }
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
  const input = container.querySelector(
    'section[aria-label="Find an older Jito bundle"] input[type=file]',
  ) as HTMLInputElement;
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(input.disabled).toBe(false);
  });
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
async function retainV2Packet(f: Awaited<ReturnType<typeof fixture>>) {
  f.seedUnknown(0);
  await f.render();
  await click('Load bundle approvals');
  await until('A signing outcome is unknown');
  await importPacket(f);
  await until('Exact signed packet verified and retained');
}
it('finds an older reviewed bundle from one local file and requires history plus separate registration approval', async () => {
  const f = await fixture();
  f.seedUnknown(0);
  f.omitFromHistory();
  await f.render();
  const locatorInput = container.querySelector(
    'section[aria-label="Find an older Jito bundle"] input[type=file]',
  ) as HTMLInputElement;
  expect(locatorInput.disabled).toBe(true);
  await click('Load bundle approvals');
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(locatorInput.disabled).toBe(false);
  });
  const selected = await lookupFile(await lookupText(f));
  await until('verified signature');
  expect(selected.read).toHaveBeenCalledOnce();
  expect(container.textContent).not.toContain(
    'I approve registering only this exact retained packet',
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
  await click('Open original bundle');
  await until('Older bundle opened from a recovery file');
  await importPacket(f);
  await until('I approve registering only this exact retained packet');
  const label = [...container.querySelectorAll('label')].find((node) =>
    node.textContent?.includes(
      'I approve registering only this exact retained packet',
    ),
  )!;
  expect(label.querySelector('input')!.checked).toBe(false);
  expect(button('Confirm exact registration only').disabled).toBe(true);
  const panel = label.closest('div')!;
  const pass = panel.querySelector('input[type=password]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(pass, 'synthetic-password');
    pass.dispatchEvent(new Event('input', { bubbles: true }));
    label.querySelector('input')!.click();
  });
  await click('Confirm exact registration only');
  await vi.waitFor(() => expect(f.posts).toEqual(['register']));
  expect(f.sign).not.toHaveBeenCalled();
});
it('finds the omitted 21st bundle while twenty distinct recent bundles are listed', async () => {
  const f = await fixture();
  f.seedUnknown(0);
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
  await until('verified signature');
  await click('Open original bundle');
  await until('Older bundle opened from a recovery file');
  expect(container.textContent).not.toContain(
    'I approve registering only this exact retained packet',
  );
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('uses an owned immutable file snapshot even if the original buffer changes during locator parsing', async () => {
  const f = await fixture();
  f.seedUnknown(0);
  await f.render();
  await click('Load bundle approvals');
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
  await until('verified signature');
  expect(selected.read).toHaveBeenCalledOnce();
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('refuses duplicate keys or a different project/session before any exact-record request', async () => {
  const f = await fixture();
  await f.render();
  await click('Load bundle approvals');
  await vi.waitFor(() =>
    expect(
      (
        container.querySelector(
          'section[aria-label="Find an older Jito bundle"] input[type=file]',
        ) as HTMLInputElement
      ).disabled,
    ).toBe(false),
  );
  fetcher.mockClear();
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
  await until('Recovery file or owned bundle could not be verified.');
  await lookupFile(
    JSON.stringify({
      ...JSON.parse(text),
      projectId: '00000000-0000-4000-8000-000000000000',
    }),
  );
  await until('Recovery file or owned bundle could not be verified.');
  await lookupFile(
    JSON.stringify({
      ...JSON.parse(text),
      sessionId: '00000000-0000-4000-8000-000000000000',
    }),
  );
  await until('Recovery file or owned bundle could not be verified.');
  await lookupFile('x'.repeat(4097));
  await until('Recovery file or owned bundle could not be verified.');
  expect(
    fetcher.mock.calls.filter(([url]) => String(url).includes('bundleId=')),
  ).toHaveLength(0);
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('refuses a record whose saved state changes between the two exact reads', async () => {
  const f = await fixture();
  f.seedUnknown(0);
  await f.render();
  await click('Load bundle approvals');
  await vi.waitFor(() =>
    expect(
      (
        container.querySelector(
          'section[aria-label="Find an older Jito bundle"] input[type=file]',
        ) as HTMLInputElement
      ).disabled,
    ).toBe(false),
  );
  const implementation = fetcher.getMockImplementation()!;
  let exactReads = 0;
  fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
    if (!init?.method && url.includes('bundleId=') && ++exactReads === 2)
      f.bundle.state = 'cancelled';
    return implementation(url, init);
  });
  await lookupFile(await lookupText(f));
  await until('Recovery file or owned bundle could not be verified.');
  expect(exactReads).toBe(2);
  expect(container.textContent).not.toContain('verified signature');
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('preserves an unknown original outcome rather than replacing it from a file', async () => {
  const f = await fixture();
  await startPrompt(f, 0);
  await act(async () => f.rejectWallet(Error('Synthetic outcome unknown')));
  await until('needs recovery before another action');
  fetcher.mockClear();
  await lookupFile(await lookupText(f));
  await until('verified signature');
  expect(([...journal.rows.values()][0] as { state: string }).state).toBe(
    'unknown',
  );
  expect(f.attempts[0].state).toBe('unknown');
  expect(f.bundle.signatures[0]).toBeNull();
  expect(f.posts).toEqual(['begin-signing']);
  expect(f.sign).toHaveBeenCalledOnce();
});
it('refuses an older bundle when the authenticated server owner has changed', async () => {
  const f = await fixture();
  f.seedUnknown(0);
  await f.render();
  await click('Load bundle approvals');
  await vi.waitFor(() =>
    expect(
      (
        container.querySelector(
          'section[aria-label="Find an older Jito bundle"] input[type=file]',
        ) as HTMLInputElement
      ).disabled,
    ).toBe(false),
  );
  f.serverOwner('bob');
  await lookupFile(await lookupText(f));
  await until('Recovery file or owned bundle could not be verified.');
  expect(container.textContent).not.toContain('verified signature');
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it.each(['cancelled', 'expired'] as const)(
  'finds an older %s record for export only, with a fresh check before download',
  async (state) => {
    const f = await fixture();
    f.bundle.state = state;
    f.setLegacy();
    f.omitFromHistory();
    await f.render();
    await click('Load bundle approvals');
    const create = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:synthetic');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const download = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    await lookupFile(await lookupText(f));
    await until('verified signature');
    await click('Open original bundle');
    await until('Older bundle opened from a recovery file');
    await openTerminalRecovery();
    await importPacket(f);
    await until('Exact signed packet verified for this saved bundle.');
    expect(container.textContent).not.toContain(
      'Confirm exact registration only',
    );
    const beforeDownload = fetcher.mock.calls.filter(([url]) =>
      String(url).includes('bundleId='),
    ).length;
    await click('Download verified packet privately');
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledOnce();
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).includes('bundleId='))
        .length,
    ).toBeGreaterThanOrEqual(beforeDownload + 2);
    expect(f.posts).toEqual([]);
    expect(f.sign).not.toHaveBeenCalled();
  },
);
it('discloses an already registered matching signature without offering another registration', async () => {
  const f = await fixture();
  f.seedRegistered(0);
  await f.render();
  await click('Load bundle approvals');
  await lookupFile(await lookupText(f));
  await until('verified signature');
  await click('Open original bundle');
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.textContent).not.toContain(
      'Another Jito action is in progress.',
    );
  });
  await importPacket(f);
  await until('This exact packet is already registered.');
  expect(container.textContent).not.toContain(
    'Confirm exact registration only',
  );
  expect(journal.rows.size).toBe(0);
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('reconciles an exact signature observed in refreshed history without another registration', async () => {
  const f = await fixture();
  await retainV2Packet(f);
  f.bundle.signatures[0] = f.f.swap.signed.signature;
  f.attempts[0] = {
    ...f.attempts[0],
    state: 'registered',
    signature: f.f.swap.signed.signature,
    transaction: f.f.swap.signed.transaction,
  };
  await click('Load bundle approvals');
  await until(f.f.swap.signed.signature);
  expect(journal.rows.size).toBe(1);
  const pass = container.querySelector(
    'input[id$="-recovery-password"]',
  ) as HTMLInputElement;
  const enter = async () =>
    act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(pass, 'synthetic-password');
      pass.dispatchEvent(new Event('input', { bubbles: true }));
    });
  await enter();
  await click('Inspect retained swap 1 packet');
  await until('Exact retained packet verified locally');
  const approval = [...container.querySelectorAll('label')]
    .find((node) =>
      node.textContent?.includes(
        'I approve registering only this exact retained swap 1 packet',
      ),
    )!
    .querySelector('input')!;
  expect(approval.checked).toBe(false);
  expect(f.posts).toEqual([]);
  await enter();
  await act(async () => approval.click());
  await click('Confirm retained swap 1 registration only');
  await vi.waitFor(() => expect(journal.rows.size).toBe(0));
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('retains the original and blocks registration when refreshed history reports a different signature', async () => {
  const f = await fixture();
  await retainV2Packet(f);
  f.bundle.signatures[0] = f.f.tip.signed.signature;
  f.attempts[0] = {
    ...f.attempts[0],
    state: 'registered',
    signature: f.f.tip.signed.signature,
    transaction: f.f.tip.signed.transaction,
  };
  await click('Load bundle approvals');
  await until('Bundle details need verification');
  expect(container.textContent).not.toContain(
    'I approve registering only this exact retained',
  );
  expect(([...journal.rows.values()][0] as { state: string }).state).toBe(
    'retained',
  );
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('blocks registration if refreshed history reports a different fingerprint for the same bundle', async () => {
  const f = await fixture();
  await retainV2Packet(f);
  const { sha256: _old, ...terms } = f.f.manifest;
  const changed = {
    ...terms,
    createdAt: new Date(Date.parse(terms.createdAt) - 1000).toISOString(),
  };
  f.bundle.manifest = { ...changed, sha256: await bundleFingerprint(changed) };
  await click('Load bundle approvals');
  await until('Bundle details need verification');
  expect(container.textContent).not.toContain(
    'I approve registering only this exact retained',
  );
  expect(([...journal.rows.values()][0] as { state: string }).state).toBe(
    'retained',
  );
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('refuses duplicate bundle IDs in history without discarding the retained packet', async () => {
  const f = await fixture();
  await retainV2Packet(f);
  f.replaceHistory([f.bundle, f.bundle]);
  await click('Load bundle approvals');
  await until('Session bundle history differs.');
  expect(([...journal.rows.values()][0] as { state: string }).state).toBe(
    'retained',
  );
  expect(container.textContent).not.toContain(
    'I approve registering this exact retained packet only',
  );
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('retains a packet and refuses a conflicting terminal state while UNKNOWN', async () => {
  const f = await fixture();
  await retainV2Packet(f);
  f.bundle.state = 'cancelled';
  await click('Load bundle approvals');
  await until('Bundle details need verification');
  expect(container.textContent).not.toContain(
    'I approve registering this exact retained packet only',
  );
  expect(([...journal.rows.values()][0] as { state: string }).state).toBe(
    'retained',
  );
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('keeps the original pending if account context changes during saved-signature confirmation', async () => {
  const f = await fixture();
  await retainV2Packet(f);
  f.bundle.signatures[0] = f.f.swap.signed.signature;
  f.attempts[0] = {
    ...f.attempts[0],
    state: 'registered',
    signature: f.f.swap.signed.signature,
    transaction: f.f.swap.signed.transaction,
  };
  await click('Load bundle approvals');
  await until(f.f.swap.signed.signature);
  const pass = container.querySelector(
    'input[id$="-recovery-password"]',
  ) as HTMLInputElement;
  const enter = async () =>
    act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(pass, 'synthetic-password');
      pass.dispatchEvent(new Event('input', { bubbles: true }));
    });
  await enter();
  await click('Inspect retained swap 1 packet');
  await until('Exact retained packet verified locally');
  const approval = [...container.querySelectorAll('label')]
    .find((node) =>
      node.textContent?.includes(
        'I approve registering only this exact retained',
      ),
    )!
    .querySelector('input')!;
  await enter();
  await act(async () => approval.click());
  f.delayExact();
  await click('Confirm retained swap 1 registration only');
  await act(async () => f.exactFetchStarted);
  await f.render(true, false);
  await act(async () => f.resolveExact());
  expect(([...journal.rows.values()][0] as { state: string }).state).toBe(
    'retained',
  );
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('refuses a conflicting saved signature rather than displaying the imported packet', async () => {
  const f = await fixture();
  f.bundle.signatures[0] = f.f.tip.signed.signature;
  f.omitFromHistory();
  await f.render();
  await click('Load bundle approvals');
  await lookupFile(await lookupText(f));
  await until('Recovery file or owned bundle could not be verified.');
  expect(container.textContent).not.toContain('verified signature');
  expect(journal.rows.size).toBe(0);
  expect(f.sign).not.toHaveBeenCalled();
  expect(f.posts).toEqual([]);
});
it('does not publish a lookup result if the context changes during the owner-scoped read', async () => {
  const f = await fixture();
  f.seedUnknown(0);
  await f.render();
  await click('Load bundle approvals');
  await vi.waitFor(() =>
    expect(
      (
        container.querySelector(
          'section[aria-label="Find an older Jito bundle"] input[type=file]',
        ) as HTMLInputElement
      ).disabled,
    ).toBe(false),
  );
  f.delayExact();
  await lookupFile(await lookupText(f));
  await act(async () => f.exactFetchStarted);
  await f.render(true, false);
  await act(async () => f.resolveExact());
  expect(container.textContent).not.toContain('verified signature');
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
  await f.render(true, false);
  await act(async () => f.resolveExact());
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('does not clear a stale recovery view during a pending export', async () => {
  const f = await fixture();
  f.bundle.state = 'cancelled';
  await f.render();
  await click('Load bundle approvals');
  await openTerminalRecovery();
  await importPacket(f);
  await until('Exact signed packet verified for this saved bundle.');
  const input = container.querySelector(
    'section[aria-label="Terminal recovery for packet 1"] input[type=file]',
  ) as HTMLInputElement;
  const key = Object.keys(input).find((name) =>
    name.startsWith('__reactProps$'),
  )!;
  const stale = (
    input as unknown as Record<
      string,
      {
        onChange: (event: { target: { files: File[]; value: string } }) => void;
      }
    >
  )[key].onChange;
  const create = vi
    .spyOn(URL, 'createObjectURL')
    .mockReturnValue('blob:synthetic');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const download = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(() => {});
  f.delayExact();
  await click('Download verified packet privately');
  await vi.waitFor(
    async () => {
      await act(async () => {});
      expect(f.exactHasStarted()).toBe(true);
    },
    { timeout: 3000 },
  );
  await act(async () =>
    stale({ target: { files: [new File(['bad'], 'bad.json')], value: 'bad' } }),
  );
  expect(container.textContent).toContain(
    'Exact signed packet verified for this saved bundle.',
  );
  await act(async () => f.resolveExact());
  await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
  expect(create).toHaveBeenCalledOnce();
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
async function prepareRetainedConfirmation(
  f: Awaited<ReturnType<typeof fixture>>,
) {
  await retainV2Packet(f);
  const pass = container.querySelector(
    'input[id$="-recovery-password"]',
  ) as HTMLInputElement;
  const enter = async () =>
    act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(pass, 'synthetic-password');
      pass.dispatchEvent(new Event('input', { bubbles: true }));
    });
  await enter();
  await click('Inspect retained swap 1 packet');
  await until('Exact retained packet verified locally');
  const approval = [...container.querySelectorAll('label')]
    .find((node) =>
      node.textContent?.includes(
        'I approve registering only this exact retained swap 1 packet',
      ),
    )!
    .querySelector('input')!;
  expect(approval.checked).toBe(false);
  await enter();
  await act(async () => approval.click());
}

it('refuses stale registration after an in-flight history refresh fails', async () => {
  const f = await fixture();
  await prepareRetainedConfirmation(f);
  const load = button('Load bundle approvals');
  const key = Object.keys(load).find((name) =>
    name.startsWith('__reactProps$'),
  )!;
  const stale = (load as unknown as Record<string, { onClick: () => void }>)[
    key
  ].onClick;
  f.delayExact();
  await click('Confirm retained swap 1 registration only');
  await vi.waitFor(
    async () => {
      await act(async () => {});
      expect(f.exactHasStarted()).toBe(true);
    },
    { timeout: 3000 },
  );
  const scope = await jitoOwnerScope('alice');
  fetcher.mockResolvedValueOnce(
    Response.json(
      { error: 'History unavailable.' },
      { status: 503, headers: { [JITO_OWNER_SCOPE_HEADER]: scope } },
    ),
  );
  await act(async () => stale());
  await until('History unavailable.');
  await act(async () => f.failExact());
  await until('Recovery could not be verified.');
  expect(([...journal.rows.values()][0] as { state: string }).state).toBe(
    'retained',
  );
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});

it('refuses stale registration when refreshed history records the signature before the POST', async () => {
  const f = await fixture();
  await prepareRetainedConfirmation(f);
  f.delayExact();
  await click('Confirm retained swap 1 registration only');
  await vi.waitFor(
    async () => {
      await act(async () => {});
      expect(f.exactHasStarted()).toBe(true);
    },
    { timeout: 3000 },
  );
  f.bundle.signatures[0] = f.f.swap.signed.signature;
  f.attempts[0] = {
    ...f.attempts[0],
    state: 'registered',
    signature: f.f.swap.signed.signature,
    transaction: f.f.swap.signed.transaction,
  };
  await act(async () => f.resolveExact());
  await vi.waitFor(() => expect(journal.rows.size).toBe(0));
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
      'never registers, signs or submits',
    );
    expect(container.textContent).not.toContain(
      'Confirm exact registration only',
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
  await until('Recovery file or terminal bundle could not be verified.');
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
  await until('Recovery file or terminal bundle could not be verified.');
  expect(container.textContent).not.toContain('Exact signed packet verified');
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('refuses terminal import if the saved packet signature conflicts', async () => {
  const f = await fixture();
  f.bundle.state = 'expired';
  f.setLegacy();
  f.bundle.signatures[0] = f.f.tip.signed.signature;
  await f.render();
  await click('Load bundle approvals');
  await openTerminalRecovery();
  await importPacket(f);
  await until('Recovery file or terminal bundle could not be verified.');
  expect(container.textContent).not.toContain('Exact signed packet verified');
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it.each([0, 1])(
  'retains imported packet %s in the journal and blocks unsigned cancellation until explicit registration',
  async (packet) => {
    const f = await fixture();
    f.seedUnknown(packet);
    await f.render();
    await click('Load bundle approvals');
    await until('Signer for swap 1');
    await importPacket(f, packet);
    await until('Exact signed packet verified and retained');
    expect(button('Cancel unsigned bundle').disabled).toBe(true);
    expect(f.posts).toEqual([]);
    expect(f.sign).not.toHaveBeenCalled();
    const label = [...container.querySelectorAll('label')].find((node) =>
      node.textContent?.includes(
        'I approve registering only this exact retained packet',
      ),
    )!;
    expect(label.querySelector('input')!.checked).toBe(false);
    expect(button('Confirm exact registration only').disabled).toBe(true);
    await f.render(true);
    await f.render(false);
    await click('Load bundle approvals');
    await until('A signing outcome is unknown');
    expect(([...journal.rows.values()][0] as { state: string }).state).toBe(
      'retained',
    );
    expect(button('Cancel unsigned bundle').disabled).toBe(true);
    expect(f.posts).toEqual([]);
  },
);
it('blocks cancellation during imported-file validation and refuses a changed context', async () => {
  const f = await fixture();
  f.seedUnknown(0);
  await f.render();
  await click('Load bundle approvals');
  await until('Signer for swap 1');
  f.delayExact();
  await importPacket(f);
  await act(async () => f.exactFetchStarted);
  expect(button('Cancel unsigned bundle').disabled).toBe(true);
  expect(f.posts).toEqual([]);
  await f.render(true, false);
  await act(async () => f.resolveExact());
  await f.render(false);
  await click('Load bundle approvals');
  expect(container.textContent).not.toContain(
    'Exact signed packet verified and retained',
  );
  expect(journal.rows.size).toBe(0);
  expect(f.sign).not.toHaveBeenCalled();
  expect(f.posts).toEqual([]);
});
it('registers an imported exact packet only after a separate unchecked approval', async () => {
  const f = await fixture();
  f.seedUnknown(0);
  await f.render();
  await click('Load bundle approvals');
  await until('Signer for swap 1');
  await until('A signing outcome is unknown');
  expect(button('Sign Jito tip only').disabled).toBe(true);
  await importPacket(f);
  await until('Exact signed packet verified and retained');
  const label = [...container.querySelectorAll('label')].find((node) =>
    node.textContent?.includes(
      'I approve registering only this exact retained packet',
    ),
  )!;
  const checkbox = label.querySelector('input')!;
  expect(checkbox.checked).toBe(false);
  expect(button('Sign Jito tip only').disabled).toBe(true);
  expect(f.posts).toEqual([]);
  const panel = label.closest('div')!;
  const pass = panel.querySelector('input[type=password]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(pass, 'synthetic-password');
    pass.dispatchEvent(new Event('input', { bubbles: true }));
    checkbox.click();
  });
  await click('Confirm exact registration only');
  await vi.waitFor(() => expect(f.posts).toEqual(['register']));
  expect(f.bundle.signatures[0]).toBe(f.f.swap.signed.signature);
  await vi.waitFor(async () => {
    await act(async () => {});
    const tipApproval = [...container.querySelectorAll('label')].find((node) =>
      node.textContent?.includes('I approve signing Jito tip'),
    )!;
    expect(tipApproval.querySelector('input')!.disabled).toBe(false);
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
  const passLabel = [...container.querySelectorAll('label')].find((node) =>
    node.textContent?.includes('Vault password for Jito tip'),
  )!;
  const pass = document.getElementById(passLabel.htmlFor) as HTMLInputElement;
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(label.querySelector('input')!.disabled).toBe(false);
  });
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(pass, 'synthetic-password');
    pass.dispatchEvent(new Event('input', { bubbles: true }));
    label.querySelector('input')!.click();
  });
  expect(button('Sign Jito tip only').disabled).toBe(false);
  const scope = await jitoOwnerScope('alice');
  await cache!.reserve(scope, f.f.manifest, 0);
  expect(cache!.has(scope, f.f.manifest.id, 0)).toBe(true);
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
  await until('needs recovery before another action');
  expect(button('Sign swap 1 only').disabled).toBe(true);
  expect(button('Sign Jito tip only').disabled).toBe(true);
  expect(button('Cancel unsigned bundle').disabled).toBe(true);
  expect(f.posts).toEqual(['begin-signing']);
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
  expect(f.posts).toEqual(['begin-signing']);
});
it('refuses an imported packet if the server owner changes before its exact read', async () => {
  const f = await fixture();
  f.seedUnknown(0);
  await f.render();
  await click('Load bundle approvals');
  await until('Signer for swap 1');
  f.serverOwner('bob');
  await importPacket(f);
  await until('Signed-in account changed. Reload bundle history.');
  expect(container.textContent).not.toContain(
    'Exact signed packet verified and retained',
  );
  expect(journal.rows.size).toBe(0);
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('allows only separately approved exact evidence registration after expiry, without signing or sending', async () => {
  const f = await fixture();
  f.seedUnknown(0);
  const clock = vi
    .spyOn(Date, 'now')
    .mockReturnValue(Date.parse(f.f.manifest.expiresAt) + 1000);
  try {
    await f.render();
    await click('Load bundle approvals');
    await until('Signer for swap 1');
    await importPacket(f);
    await until('Exact signed packet verified and retained');
    const label = [...container.querySelectorAll('label')].find((node) =>
      node.textContent?.includes(
        'I approve registering only this exact retained packet',
      ),
    )!;
    expect(label.querySelector('input')!.checked).toBe(false);
    expect(button('Confirm exact registration only').disabled).toBe(true);
    expect(button('Cancel unsigned bundle').disabled).toBe(true);
    expect(f.posts).toEqual([]);
    expect(f.sign).not.toHaveBeenCalled();
    const panel = label.closest('div')!;
    const pass = panel.querySelector(
      'input[type=password]',
    ) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(pass, 'synthetic-password');
      pass.dispatchEvent(new Event('input', { bubbles: true }));
      label.querySelector('input')!.click();
    });
    await click('Confirm exact registration only');
    await vi.waitFor(() => expect(f.posts).toEqual(['register']));
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
      expect(f.posts).toEqual(['begin-signing', 'register']);
      expect(f.bundle.signatures[packet]).toBeTruthy();
    });
    expect(f.sign).toHaveBeenCalledOnce();
  },
);
it('retains the exact result without registration when the selected external account disappears', async () => {
  const f = await fixture();
  await startPrompt(f, 0);
  f.clearAccounts();
  await act(async () => f.resolveWallet(0));
  await until('needs recovery before another action');
  expect(f.posts).toEqual(['begin-signing']);
  expect(f.bundle.signatures[0]).toBeNull();
  expect(([...journal.rows.values()][0] as { state: string }).state).toBe(
    'retained',
  );
  expect(f.sign).toHaveBeenCalledOnce();
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
    await until('needs recovery before another action');
    expect(f.posts).toEqual(['begin-signing']);
    expect(f.bundle.signatures[packet]).toBeNull();
    expect(f.sign).toHaveBeenCalledOnce();
    expect(([...journal.rows.values()][0] as { state: string }).state).toBe(
      'retained',
    );
  },
);
it.each([0, 1])(
  'recovers packet %s after keyed remount only after a fresh scoped history read and explicit registration',
  async (packet) => {
    const f = await fixture();
    await startPrompt(f, packet);
    await f.render(true, false);
    await act(async () => {
      f.resolveWallet(packet);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await vi.waitFor(() =>
      expect(([...journal.rows.values()][0] as { state: string }).state).toBe(
        'retained',
      ),
    );
    expect(f.posts).toEqual(['begin-signing']);
    await f.render(false);
    const signature =
      packet === 0 ? f.f.swap.signed.signature : f.f.tip.signed.signature;
    expect(container.textContent).not.toContain(signature);
    await click('Load bundle approvals');
    await until('A signing outcome is unknown');
    expect(container.textContent).not.toContain(signature);
    const enterPassword = async () => {
      const pass = [
        ...container.querySelectorAll('input[id$="-recovery-password"]'),
      ][packet] as HTMLInputElement;
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )!.set!.call(pass, 'synthetic-password');
        pass.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    const inspect = async () => {
      await enterPassword();
      await click(
        packet === 0
          ? 'Inspect retained swap 1 packet'
          : 'Inspect retained Jito tip packet',
      );
      await until('Exact retained packet verified locally');
      expect(container.textContent).toContain(signature);
    };
    const approve = async () => {
      const approval = [...container.querySelectorAll('label')]
        .find((node) =>
          node.textContent?.includes(
            'I approve registering only this exact retained',
          ),
        )!
        .querySelector('input')!;
      expect(approval.checked).toBe(false);
      expect(
        button(
          packet === 0
            ? 'Confirm retained swap 1 registration only'
            : 'Confirm retained Jito tip registration only',
        ).disabled,
      ).toBe(true);
      await enterPassword();
      await act(async () => approval.click());
    };
    const confirm =
      packet === 0
        ? 'Confirm retained swap 1 registration only'
        : 'Confirm retained Jito tip registration only';
    await inspect();
    f.failRegister();
    await approve();
    await click(confirm);
    await until('Recovery could not be verified.');
    expect(f.posts).toEqual(['begin-signing', 'register']);
    expect(([...journal.rows.values()][0] as { state: string }).state).toBe(
      'retained',
    );
    f.succeedRegister();
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(button('Load bundle approvals').disabled).toBe(false);
    });
    await click('Load bundle approvals');
    await until('A signing outcome is unknown');
    await inspect();
    await approve();
    await click(confirm);
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(journal.rows.size).toBe(0);
    });
    expect(f.posts).toEqual(['begin-signing', 'register', 'register']);
    expect(f.sign).toHaveBeenCalledOnce();
    for (const [, init] of fetcher.mock.calls as [string, RequestInit][])
      expect(init.redirect).toBe('error');
  },
);
it('does not reveal owner A recovery under B or after A returns without a new A-scoped GET', async () => {
  const f = await fixture();
  await startPrompt(f, 0);
  context.owner = 'bob';
  await f.render(false, false);
  await act(async () => {
    f.resolveWallet(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await vi.waitFor(() =>
    expect(([...journal.rows.values()][0] as { state: string }).state).toBe(
      'retained',
    ),
  );
  await f.render();
  await click('Load bundle approvals');
  expect(container.textContent).not.toContain(f.f.swap.signed.signature);
  expect(f.posts).toEqual(['begin-signing']);
  context.owner = 'alice';
  await f.render();
  expect(container.textContent).not.toContain(f.f.swap.signed.signature);
  await click('Load bundle approvals');
  await until('A signing outcome is unknown');
  expect(container.textContent).not.toContain(f.f.swap.signed.signature);
  const input = [...container.querySelectorAll('input[type=password]')].find(
    (node) => node.id.endsWith('-recovery-password'),
  ) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, 'synthetic-password');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Inspect retained swap 1 packet');
  await until(f.f.swap.signed.signature);
  expect(f.posts).toEqual(['begin-signing']);
  expect(f.sign).toHaveBeenCalledOnce();
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
  await act(async () => {
    await f.exactFetchStarted;
  });
  expect(button('Sign swap 1 only').disabled).toBe(true);
  expect(f.sign).not.toHaveBeenCalled();
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
  await f.render(true, false);
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
  expect(f.posts).toEqual(['begin-signing']);
  await click('Load original bundle');
  await until('original verified signature is retained');
  expect(f.posts).toEqual(['begin-signing']);
  expect(f.sign).toHaveBeenCalledOnce();
});
it('says when a fenced signer is being prepared before any prompt starts', async () => {
  const f = await fixture();
  await startPrompt(f, 0, f.delayExact);
  await until('No signature has been requested yet');
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
  await f.render(true, false);
  await act(async () => {
    f.resolveWallet(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  vi.spyOn(Date, 'now').mockReturnValue(
    Date.parse(f.f.manifest.expiresAt) + 1000,
  );
  await f.render(false);
  await click('Load bundle approvals');
  await until('A signing outcome is unknown');
  const input = container.querySelector(
    'input[id$="-recovery-password"]',
  ) as HTMLInputElement;
  const enterPassword = async () =>
    act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, 'synthetic-password');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  await enterPassword();
  await click('Inspect retained swap 1 packet');
  await until('Exact retained packet verified locally');
  const create = vi.fn(() => 'blob:synthetic');
  const NativeUrl = globalThis.URL;
  class SyntheticUrl extends NativeUrl {
    static createObjectURL = create;
    static revokeObjectURL = vi.fn();
  }
  vi.stubGlobal('URL', SyntheticUrl);
  const download = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(() => {});
  await enterPassword();
  await click('Download retained swap 1 packet privately');
  await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
  expect(create).toHaveBeenCalledOnce();
  expect(journal.rows.size).toBe(1);
  expect(f.posts).toEqual(['begin-signing']);
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
    const passLabel = [...container.querySelectorAll('label')].find((node) =>
      node.textContent?.includes(
        packet === 0
          ? 'Vault password for swap 1'
          : 'Vault password for Jito tip',
      ),
    )!;
    const password = document.getElementById(
      passLabel.htmlFor,
    ) as HTMLInputElement;
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(label.querySelector('input')!.disabled).toBe(false);
    });
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(password, 'synthetic-password');
      password.dispatchEvent(new Event('input', { bubbles: true }));
      label.querySelector('input')!.click();
    });
    await click(packet === 0 ? 'Sign swap 1 only' : 'Sign Jito tip only');
    await until('needs recovery before another action');
    expect(([...journal.rows.values()][0] as { state: string }).state).toBe(
      'retained',
    );
    expect(f.posts).toEqual(['begin-signing']);
    expect(f.sign).not.toHaveBeenCalled();
    expect(syntheticSession.payload.wallets[0].seed).toBe('');
    await f.render(true);
    await f.render(false);
    await click('Load bundle approvals');
    await until('A signing outcome is unknown');
    expect(
      button(packet === 0 ? 'Sign swap 1 only' : 'Sign Jito tip only').disabled,
    ).toBe(true);
    expect(f.posts).toEqual(['begin-signing']);
  },
);
it('refuses an impossible cancellation during UNKNOWN while retaining the signed packet', async () => {
  const f = await fixture();
  await startPrompt(f, 0);
  await f.render(true, false);
  await act(async () => {
    f.resolveWallet(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  f.bundle.state = 'cancelled';
  await f.render(false);
  await click('Load bundle approvals');
  await until('Bundle details need verification');
  expect(([...journal.rows.values()][0] as { state: string }).state).toBe(
    'retained',
  );
  expect(container.textContent).not.toContain(
    'Confirm exact registration only',
  );
  expect(f.posts).toEqual(['begin-signing']);
  expect(f.sign).toHaveBeenCalledOnce();
});
it('retains an external wallet response arriving after expiry without registration', async () => {
  const f = await fixture();
  await startPrompt(f, 0);
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.f.manifest.expiresAt) + 1);
  await act(async () => {
    f.resolveWallet(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await until('needs recovery before another action');
  expect(([...journal.rows.values()][0] as { state: string }).state).toBe(
    'retained',
  );
  expect(f.posts).toEqual(['begin-signing']);
  await f.render(true);
  await f.render(false);
  await click('Load bundle approvals');
  await until('A signing outcome is unknown');
  expect(f.bundle.signatures[0]).toBeNull();
  expect(f.posts).toEqual(['begin-signing']);
  expect(f.sign).toHaveBeenCalledOnce();
});
it('does not allow a duplicate signature while the original wallet prompt is unresolved after a remount', async () => {
  const f = await fixture();
  await startPrompt(f, 0);
  await f.render(true, false);
  await f.render(false, false);
  expect(button('Load bundle approvals').disabled).toBe(true);
  expect(button('Prepare and review selected Jito swaps').disabled).toBe(true);
  expect(container.textContent).not.toContain('Sign swap 1 only');
  expect(container.textContent).not.toContain('Sign Jito tip only');
  expect(f.sign).toHaveBeenCalledOnce();
  await act(async () => {
    f.resolveWallet(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await vi.waitFor(() =>
    expect(([...journal.rows.values()][0] as { state: string }).state).toBe(
      'retained',
    ),
  );
  expect(f.posts).toEqual(['begin-signing']);
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
it('retains encrypted recovery after the outer panel unmounts and requires a fresh owned read', async () => {
  const f = await fixture();
  await startPrompt(f, 0);
  act(() => root.unmount());
  root = createRoot(container);
  await act(async () => {
    f.resolveWallet(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await f.render();
  await click('Load bundle approvals');
  await until('A signing outcome is unknown');
  expect(([...journal.rows.values()][0] as { state: string }).state).toBe(
    'retained',
  );
  expect(f.posts).toEqual(['begin-signing']);
  expect(f.bundle.signatures[0]).toBeNull();
  expect(f.sign).toHaveBeenCalledOnce();
});
it('keeps an explicitly rejected wallet prompt UNKNOWN without registering or submitting', async () => {
  const f = await fixture();
  await startPrompt(f, 0);
  await act(async () => {
    f.rejectWallet({ code: 4001 });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await until('needs recovery before another action');
  expect(([...journal.rows.values()][0] as { state: string }).state).toBe(
    'unknown',
  );
  expect(f.posts).toEqual(['begin-signing']);
  expect(f.bundle.signatures[0]).toBeNull();
  expect(f.sign).toHaveBeenCalledOnce();
});
it('retains the original signature and does not publish a mismatched registration response', async () => {
  const f = await fixture();
  await startPrompt(f, 0);
  await f.render(true, false);
  await act(async () => {
    f.resolveWallet(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await f.render(false);
  await click('Load bundle approvals');
  await until('A signing outcome is unknown');
  const pass = [
    ...container.querySelectorAll('input[id$="-recovery-password"]'),
  ][0] as HTMLInputElement;
  const enterPassword = async () =>
    act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(pass, 'synthetic-password');
      pass.dispatchEvent(new Event('input', { bubbles: true }));
    });
  await enterPassword();
  await click('Inspect retained swap 1 packet');
  await until('Exact retained packet verified locally');
  const approval = [...container.querySelectorAll('label')]
    .find((node) =>
      node.textContent?.includes(
        'I approve registering only this exact retained',
      ),
    )!
    .querySelector('input')!;
  expect(approval.checked).toBe(false);
  await enterPassword();
  await act(async () => approval.click());
  f.mismatchRegister();
  await click('Confirm retained swap 1 registration only');
  await until('Recovery could not be verified.');
  expect(([...journal.rows.values()][0] as { state: string }).state).toBe(
    'retained',
  );
  expect(f.bundle.signatures[0]).toBeNull();
  expect(f.posts).toEqual(['begin-signing', 'register']);
  expect(f.sign).toHaveBeenCalledOnce();
});
