// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as vault from '@/lib/browser-wallet-vault';
import * as signing from '@/lib/warmup-signing';
import { createJitoMemorySignatureRecovery } from '@/lib/jito-memory-signature-recovery';
import {
  inspectJitoRecoveryJournal,
  withJitoRecoveryJournalLock,
} from '@/lib/jito-recovery-journal';
import {
  JITO_OWNER_SCOPE_HEADER,
  jitoOwnerScope,
} from '@/lib/jito-owner-scope';
import { createJitoPacketRecovery } from '@/lib/jito-packet-recovery';
import * as packetRecovery from '@/lib/jito-packet-recovery';
import type { JitoAttempt } from '@/lib/jito-sign-attempt-client';
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import {
  JitoPacketSigning,
  type JitoPacketV2Snapshot,
} from './jito-packet-signing';
import { JitoAtomicBundle } from './jito-atomic-bundle';
import type { TradeSession } from '@/lib/imported-trade-session';

vi.mock('better-auth/react', () => ({
  createAuthClient: () => ({
    useSession: () => ({ data: { user: { id: 'alice' } }, isPending: false }),
  }),
}));

const storage = vi.hoisted(() => ({
  rows: new Map<string, unknown>(),
  fault: '',
  beforeRetain: undefined as undefined | (() => Promise<void>),
}));
const externalRegistry = vi.hoisted(() => ({ wallets: [] as unknown[] }));
vi.mock('@wallet-standard/app', () => ({
  getWallets: () => ({
    get: () => externalRegistry.wallets,
    on: () => () => {},
  }),
}));
vi.mock('@/lib/jito-recovery-journal-store', () => ({
  readJournalEntry: async (key: string) =>
    structuredClone(storage.rows.get(key)),
  listJournalEntries: async () => structuredClone([...storage.rows.values()]),
  insertJournalUnknown: async (value: { key: string }) => {
    if (storage.fault === 'insert-before' || storage.rows.has(value.key))
      throw Error('insertion unavailable');
    storage.rows.set(value.key, structuredClone(value));
    if (storage.fault === 'insert-after') throw Error('ambiguous insertion');
  },
  retainJournalEntry: async (expected: { key: string }, value: unknown) => {
    if (storage.beforeRetain) await storage.beforeRetain();
    if (
      storage.fault === 'retain' ||
      JSON.stringify(storage.rows.get(expected.key)) !==
        JSON.stringify(expected)
    )
      throw Error('retention unavailable');
    storage.rows.set(expected.key, structuredClone(value));
  },
  deleteRetainedJournalEntry: async (expected: { key: string }) => {
    if (
      storage.fault === 'ack' ||
      JSON.stringify(storage.rows.get(expected.key)) !==
        JSON.stringify(expected)
    )
      throw Error('acknowledgement unavailable');
    storage.rows.delete(expected.key);
  },
}));
const owner = 'a'.repeat(64),
  locks = new Set<string>();
let root: Root,
  container: HTMLDivElement,
  mounted = true;
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
        _opts: unknown,
        callback: (lock: object | null) => Promise<unknown>,
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
  storage.rows.clear();
  externalRegistry.wallets = [];
  storage.fault = '';
  storage.beforeRetain = undefined;
  locks.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mounted = true;
});
afterEach(() => {
  if (mounted) act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function setup(useExternal = false, packet = 0) {
  const f = await jitoBundleFixture();
  const bundle = {
    manifest: f.manifest,
    state: 'reviewed' as const,
    bundleId: null,
    signatures: [null, null] as (string | null)[],
    updatedAt: f.manifest.createdAt,
  };
  const attempts: JitoAttempt[] = [];
  const session = {
    payload: {
      wallets: [
        { family: 'solana', address: f.review.wallet, seed: '07'.repeat(32) },
      ],
    },
  } as unknown as vault.VaultSession;
  const account = {
    address: f.review.wallet,
    publicKey: Uint8Array.from(bs58.decode(f.review.wallet)),
    chains: ['solana:mainnet'],
    features: ['solana:signTransaction'],
  };
  const externalBytes = Uint8Array.from(
    atob(packet === 0 ? f.swap.signed.transaction : f.tip.signed.transaction),
    (value) => value.charCodeAt(0),
  );
  const externalSign = vi.fn(async () => [
    { signedTransaction: externalBytes },
  ]);
  const externalConnect = vi.fn(async () => ({ accounts: [account] }));
  const externalWallet = {
    version: '1.0.0',
    name: 'Synthetic external',
    icon: 'data:image/png;base64,',
    chains: ['solana:mainnet'],
    accounts: [account],
    features: {
      'standard:connect': { version: '1.0.0', connect: externalConnect },
      'standard:events': { version: '1.0.0', on: () => () => {} },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: [0, 'legacy'],
        signTransaction: externalSign,
      },
    },
  };
  if (useExternal) externalRegistry.wallets = [externalWallet];
  vi.spyOn(vault, 'unlockVault').mockResolvedValue(session);
  vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('synthetic-vault');
  const signer = vi.spyOn(signing, 'signApprovedWarmupPacket');
  const coordinator = createJitoMemorySignatureRecovery();
  const readSnapshot = vi.fn(
    async (): Promise<JitoPacketV2Snapshot> => ({
      ownerScope: owner,
      projectId: f.manifest.projectId,
      sessionId: f.manifest.sessionId,
      bundle: structuredClone(bundle),
      attempts: structuredClone(attempts),
      legacyReadOnly: false,
    }),
  );
  const beforeSign = vi.fn(async (id: string) => {
    if (!attempts.some((a) => a.attemptId === id && a.state === 'unknown'))
      throw Error('missing attempt');
  });
  const register = vi.fn(async (transaction: string, id: string) => {
    const checked = await createJitoPacketRecovery(
      f.manifest,
      packet,
      transaction,
    );
    const index = attempts.findIndex((a) => a.attemptId === id);
    if (index < 0) throw Error('missing attempt');
    attempts[index] = {
      ...attempts[index],
      state: 'registered',
      signature: checked.signature,
      transaction,
    };
    bundle.signatures[packet] = checked.signature;
  });
  const registerEvidence = vi.fn(async (transaction: string, id: string) =>
    register(transaction, id),
  );
  const begin = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string);
    if (body.action !== 'begin-signing')
      throw Error('unexpected network action');
    const attempt: JitoAttempt = {
      bundleId: f.manifest.id,
      manifestSha256: f.manifest.sha256,
      packet,
      signer: f.review.wallet,
      intentId: packet === 0 ? f.review.id : null,
      attemptId: body.attemptId,
      state: 'unknown',
      signature: null,
      transaction: null,
    };
    attempts.push(attempt);
    return Response.json(
      { attempt, mayInvokeSigner: true },
      { headers: { [JITO_OWNER_SCOPE_HEADER]: owner } },
    );
  });
  vi.stubGlobal('fetch', begin);
  await act(async () =>
    root.render(
      <JitoPacketSigning
        manifest={f.manifest}
        packet={packet}
        disabled={false}
        ownerScope={owner}
        coordinator={coordinator}
        isContextCurrent={() => true}
        beforeSign={beforeSign}
        register={register}
        readSnapshot={readSnapshot}
        recoveryDisabled={false}
        registerEvidence={registerEvidence}
      />,
    ),
  );
  const input = container.querySelector(
    'input[type=password]',
  ) as HTMLInputElement;
  const checkbox = container.querySelector(
    'input[type=checkbox]',
  ) as HTMLInputElement;
  const button = () =>
    [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes(
        packet === 0 ? 'Sign swap 1 only' : 'Sign Jito tip only',
      ),
    )!;
  const approve = async () => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, 'synthetic-password');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => checkbox.click());
  };
  const sign = async () =>
    act(async () => {
      button().click();
    });
  return {
    f,
    session,
    externalBytes,
    externalSign,
    externalConnect,
    externalWallet,
    coordinator,
    attempts,
    bundle,
    readSnapshot,
    beforeSign,
    register,
    registerEvidence,
    begin,
    signer,
    input,
    checkbox,
    button,
    approve,
    sign,
  };
}
async function waitFor(expectation: () => void) {
  await vi.waitFor(
    async () => {
      await act(async () => {});
      expectation();
    },
    { timeout: 15000 },
  );
}
async function enterRecoveryPassword() {
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
}
async function chooseExternal() {
  await act(async () => {
    const select = container.querySelector('select') as HTMLSelectElement;
    select.value = 'Synthetic external';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

it('uses the vault password for recovery, wipes vault seeds before external connection, and signs once', async () => {
  const f = await setup(true);
  f.externalConnect.mockImplementation(async () => {
    expect(f.session.payload.wallets[0].seed).toBe('');
    return { accounts: [] };
  });
  f.externalSign.mockImplementation(async () => {
    expect(f.session.payload.wallets[0].seed).toBe('');
    expect(([...storage.rows.values()][0] as { state: string }).state).toBe(
      'unknown',
    );
    expect(f.attempts[0].state).toBe('unknown');
    return [{ signedTransaction: f.externalBytes }];
  });
  await chooseExternal();
  await f.approve();
  await f.sign();
  await vi.waitFor(
    async () => {
      await act(async () => {});
      expect(storage.rows.size).toBe(0);
      expect(f.register).toHaveBeenCalledTimes(1);
    },
    { timeout: 15000 },
  );
  expect(f.externalConnect).toHaveBeenCalledTimes(1);
  expect(f.externalSign).toHaveBeenCalledTimes(1);
  expect(f.signer).not.toHaveBeenCalled();
  expect(f.begin).toHaveBeenCalledTimes(1);
});

it('refuses an external wallet if the vault password is wrong before any connection or attempt', async () => {
  const f = await setup(true);
  vi.mocked(vault.unlockVault).mockRejectedValue(Error('incorrect password'));
  await chooseExternal();
  await f.approve();
  await f.sign();
  await waitFor(() =>
    expect(container.textContent).toContain('incorrect password'),
  );
  expect(f.externalConnect).not.toHaveBeenCalled();
  expect(f.externalSign).not.toHaveBeenCalled();
  expect(f.begin).not.toHaveBeenCalled();
  expect(storage.rows.size).toBe(0);
});

it('keeps external-wallet rejection UNKNOWN and never opens a second signing prompt', async () => {
  const f = await setup(true);
  f.externalSign.mockRejectedValue({ code: 4001 });
  await chooseExternal();
  await f.approve();
  await f.sign();
  await waitFor(() =>
    expect(container.textContent).toContain(
      'needs recovery before another action',
    ),
  );
  expect(f.externalSign).toHaveBeenCalledTimes(1);
  expect(f.register).not.toHaveBeenCalled();
  expect(([...storage.rows.values()][0] as { state: string }).state).toBe(
    'unknown',
  );
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(f.input, 'synthetic-password');
    f.input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(f.checkbox.checked).toBe(false);
  await act(async () => f.checkbox.click());
  await f.sign();
  expect(f.externalSign).toHaveBeenCalledTimes(1);
  expect(f.begin).toHaveBeenCalledTimes(1);
});

it('captures an external wallet signature after unmount without registering it', async () => {
  const f = await setup(true);
  let release!: (
      value: { signedTransaction: Uint8Array<ArrayBuffer> }[],
    ) => void,
    started!: () => void;
  const waiting = new Promise<{ signedTransaction: Uint8Array<ArrayBuffer> }[]>(
    (resolve) => {
      release = resolve;
    },
  );
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.externalSign.mockImplementation(async () => {
    started();
    return waiting;
  });
  await chooseExternal();
  await f.approve();
  await f.sign();
  await act(async () => {
    await began;
  });
  await act(async () => {
    root.unmount();
    mounted = false;
    release([{ signedTransaction: f.externalBytes }]);
  });
  await vi.waitFor(
    () =>
      expect(([...storage.rows.values()][0] as { state: string }).state).toBe(
        'retained',
      ),
    { timeout: 15000 },
  );
  expect(f.register).not.toHaveBeenCalled();
  expect(f.session.payload.wallets[0].seed).toBe('');
});

it('retains but does not register if the external account list becomes empty during the prompt', async () => {
  const f = await setup(true);
  let release!: (
    value: { signedTransaction: Uint8Array<ArrayBuffer> }[],
  ) => void;
  let started!: () => void;
  const waiting = new Promise<{ signedTransaction: Uint8Array<ArrayBuffer> }[]>(
    (resolve) => {
      release = resolve;
    },
  );
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.externalSign.mockImplementation(async () => {
    started();
    return waiting;
  });
  await chooseExternal();
  await f.approve();
  await f.sign();
  await act(async () => {
    await began;
  });
  f.externalWallet.accounts = [];
  await act(async () => {
    release([{ signedTransaction: f.externalBytes }]);
  });
  await waitFor(() =>
    expect(container.textContent).toContain(
      'needs recovery before another action',
    ),
  );
  expect(([...storage.rows.values()][0] as { state: string }).state).toBe(
    'retained',
  );
  expect(f.register).not.toHaveBeenCalled();
  expect(f.begin).toHaveBeenCalledTimes(1);
  expect(f.externalSign).toHaveBeenCalledTimes(1);
});

it('ignores stale signer-selection and consent handlers while a wallet prompt is pending', async () => {
  const f = await setup(true);
  let release!: (
      value: { signedTransaction: Uint8Array<ArrayBuffer> }[],
    ) => void,
    started!: () => void;
  const blocked = new Promise<{ signedTransaction: Uint8Array<ArrayBuffer> }[]>(
    (resolve) => {
      release = resolve;
    },
  );
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.externalSign.mockImplementation(async () => {
    started();
    return blocked;
  });
  await chooseExternal();
  await f.approve();
  const select = container.querySelector('select') as HTMLSelectElement;
  const checkbox = f.checkbox;
  const getChange = (element: object) => {
    const key = Object.getOwnPropertyNames(element).find((name) =>
      name.startsWith('__reactProps$'),
    )!;
    return (
      element as unknown as Record<
        string,
        { onChange: (event: unknown) => void }
      >
    )[key].onChange;
  };
  const staleSelection = getChange(select),
    staleConsent = getChange(checkbox);
  await f.sign();
  await act(async () => {
    await began;
  });
  await act(async () => {
    staleSelection({ target: { value: 'vault' } });
    staleConsent({ target: { checked: false } });
  });
  expect(select.value).toBe('Synthetic external');
  expect(checkbox.checked).toBe(true);
  expect(f.externalSign).toHaveBeenCalledTimes(1);
  await act(async () => {
    release([{ signedTransaction: f.externalBytes }]);
  });
  await waitFor(() => expect(storage.rows.size).toBe(0));
  expect(f.register).toHaveBeenCalledTimes(1);
});

it('signs and registers the exact external legacy Jito tip after durable UNKNOWN and retention', async () => {
  const f = await setup(true, 1);
  f.externalConnect.mockImplementation(async () => {
    expect(f.session.payload.wallets[0].seed).toBe('');
    return { accounts: [] };
  });
  f.externalSign.mockImplementation(async () => {
    expect(([...storage.rows.values()][0] as { state: string }).state).toBe(
      'unknown',
    );
    expect(f.attempts[0].packet).toBe(1);
    expect(f.attempts[0].intentId).toBeNull();
    return [{ signedTransaction: f.externalBytes }];
  });
  f.register.mockImplementation(async (transaction, id) => {
    expect(([...storage.rows.values()][0] as { state: string }).state).toBe(
      'retained',
    );
    expect(transaction).toBe(f.f.tip.signed.transaction);
    const checked = await createJitoPacketRecovery(
      f.f.manifest,
      1,
      transaction,
    );
    const index = f.attempts.findIndex((attempt) => attempt.attemptId === id);
    f.attempts[index] = {
      ...f.attempts[index],
      state: 'registered',
      signature: checked.signature,
      transaction,
    };
    f.bundle.signatures[1] = checked.signature;
  });
  await chooseExternal();
  await f.approve();
  await f.sign();
  await vi.waitFor(
    async () => {
      await act(async () => {});
      expect(storage.rows.size).toBe(0);
      expect(f.register).toHaveBeenCalledTimes(1);
    },
    { timeout: 15000 },
  );
  expect(f.externalConnect).toHaveBeenCalledTimes(1);
  expect(f.externalSign).toHaveBeenCalledTimes(1);
  expect(f.begin).toHaveBeenCalledTimes(1);
  expect(f.bundle.signatures[1]).toBe(f.f.tip.signed.signature);
});

it('retains the external legacy tip but refuses registration if the account disappears during the prompt', async () => {
  const f = await setup(true, 1);
  let release!: (
    value: { signedTransaction: Uint8Array<ArrayBuffer> }[],
  ) => void;
  let started!: () => void;
  const waiting = new Promise<{ signedTransaction: Uint8Array<ArrayBuffer> }[]>(
    (resolve) => {
      release = resolve;
    },
  );
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.externalSign.mockImplementation(async () => {
    started();
    return waiting;
  });
  await chooseExternal();
  await f.approve();
  await f.sign();
  await act(async () => {
    await began;
  });
  f.externalWallet.accounts = [];
  await act(async () => {
    release([{ signedTransaction: f.externalBytes }]);
  });
  await waitFor(() =>
    expect(container.textContent).toContain(
      'needs recovery before another action',
    ),
  );
  expect(([...storage.rows.values()][0] as { state: string }).state).toBe(
    'retained',
  );
  expect(f.register).not.toHaveBeenCalled();
  expect(f.begin).toHaveBeenCalledTimes(1);
  expect(f.externalSign).toHaveBeenCalledTimes(1);
});

it.each([
  [0, 'replaced signer'],
  [0, 'mutated signer'],
  [0, 'replaced account'],
  [0, 'different account'],
  [1, 'replaced signer'],
  [1, 'mutated signer'],
  [1, 'replaced account'],
  [1, 'different account'],
] as const)(
  'retains packet %s without registering when %s changes during an external prompt',
  async (packet, change) => {
    const f = await setup(true, packet);
    let release!: (
      value: { signedTransaction: Uint8Array<ArrayBuffer> }[],
    ) => void;
    let started!: () => void;
    const waiting = new Promise<
      { signedTransaction: Uint8Array<ArrayBuffer> }[]
    >((resolve) => {
      release = resolve;
    });
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.externalSign.mockImplementation(async () => {
      started();
      return waiting;
    });
    await chooseExternal();
    await f.approve();
    await f.sign();
    await act(async () => {
      await began;
    });
    const feature = f.externalWallet.features['solana:signTransaction'];
    if (change === 'replaced signer')
      f.externalWallet.features['solana:signTransaction'] = {
        ...feature,
        signTransaction: vi.fn(async () => []),
      };
    else if (change === 'mutated signer')
      feature.signTransaction = vi.fn(async () => []);
    else if (change === 'replaced account')
      f.externalWallet.accounts = [{ ...f.externalWallet.accounts[0] }];
    else
      f.externalWallet.accounts = [
        {
          ...f.externalWallet.accounts[0],
          address: '11111111111111111111111111111111',
          publicKey: new Uint8Array(32),
        },
      ];
    await act(async () => {
      release([{ signedTransaction: f.externalBytes }]);
    });
    await waitFor(() =>
      expect(container.textContent).toContain(
        'needs recovery before another action',
      ),
    );
    expect(f.register).not.toHaveBeenCalled();
    expect(f.bundle.signatures[packet]).toBeNull();
    expect(f.externalSign).toHaveBeenCalledTimes(1);
    expect(f.begin).toHaveBeenCalledTimes(1);
    await withJitoRecoveryJournalLock(
      owner,
      () => {},
      async (lock) => {
        const retained = await inspectJitoRecoveryJournal(
          lock,
          f.f.manifest,
          packet,
          'synthetic-password',
          async () => ({
            ownerScope: owner,
            record: structuredClone(f.bundle),
          }),
        );
        expect(retained.status).toBe('retained');
        if (retained.status === 'retained')
          expect(retained.transaction).toBe(
            packet === 0
              ? f.f.swap.signed.transaction
              : f.f.tip.signed.transaction,
          );
      },
    );
  },
);

it.each([0, 1])(
  'retains expired external packet %s without automatic registration or resubmission',
  async (packet) => {
    const f = await setup(true, packet);
    let release!: (
      value: { signedTransaction: Uint8Array<ArrayBuffer> }[],
    ) => void;
    let started!: () => void;
    const waiting = new Promise<
      { signedTransaction: Uint8Array<ArrayBuffer> }[]
    >((resolve) => {
      release = resolve;
    });
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.externalSign.mockImplementation(async () => {
      started();
      return waiting;
    });
    await chooseExternal();
    await f.approve();
    await f.sign();
    await act(async () => {
      await began;
    });
    vi.spyOn(Date, 'now').mockReturnValue(
      Date.parse(f.f.manifest.expiresAt) + 1,
    );
    await act(async () => {
      release([{ signedTransaction: f.externalBytes }]);
    });
    await waitFor(() =>
      expect(container.textContent).toContain(
        'needs recovery before another action',
      ),
    );
    expect(([...storage.rows.values()][0] as { state: string }).state).toBe(
      'retained',
    );
    expect(f.register).not.toHaveBeenCalled();
    expect(f.externalSign).toHaveBeenCalledTimes(1);
    expect(f.begin).toHaveBeenCalledTimes(1);
  },
);

it.each([0, 1])(
  'retains a vault-signed packet %s if the review expires during durable capture',
  async (packet) => {
    const f = await setup(false, packet);
    const clock = vi.spyOn(Date, 'now');
    storage.beforeRetain = async () => {
      clock.mockReturnValue(Date.parse(f.f.manifest.expiresAt) + 1);
    };
    await f.approve();
    await f.sign();
    await waitFor(() =>
      expect(container.textContent).toContain(
        'needs recovery before another action',
      ),
    );
    expect(([...storage.rows.values()][0] as { state: string }).state).toBe(
      'retained',
    );
    expect(f.register).not.toHaveBeenCalled();
    expect(f.begin).toHaveBeenCalledTimes(1);
    expect(f.session.payload.wallets[0].seed).toBe('');
  },
);

async function remountPacket(
  f: Awaited<ReturnType<typeof setup>>,
  packet: number,
  disabled: boolean,
) {
  await act(async () => {
    root.unmount();
    mounted = false;
  });
  root = createRoot(container);
  mounted = true;
  await act(async () =>
    root.render(
      <JitoPacketSigning
        manifest={f.f.manifest}
        packet={packet}
        disabled={disabled}
        ownerScope={owner}
        coordinator={createJitoMemorySignatureRecovery()}
        isContextCurrent={() => true}
        beforeSign={f.beforeSign}
        register={f.register}
        registerEvidence={f.registerEvidence}
        recoveryDisabled={false}
        readSnapshot={f.readSnapshot}
      />,
    ),
  );
}

it('does not open a duplicate external signing prompt after a remount while the first is unresolved', async () => {
  const f = await setup(true, 0);
  let release!: (
    value: { signedTransaction: Uint8Array<ArrayBuffer> }[],
  ) => void;
  let started!: () => void;
  const waiting = new Promise<{ signedTransaction: Uint8Array<ArrayBuffer> }[]>(
    (resolve) => {
      release = resolve;
    },
  );
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.externalSign.mockImplementation(async () => {
    started();
    return waiting;
  });
  await chooseExternal();
  await f.approve();
  await f.sign();
  await act(async () => {
    await began;
  });
  await remountPacket(f, 0, false);
  await chooseExternal();
  await act(async () => {
    const input = [...container.querySelectorAll('input[type=password]')].find(
      (node) => !node.id.endsWith('-recovery-password'),
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
  await clickText('Sign swap 1 only');
  await waitFor(() =>
    expect(container.querySelector('[role=alert]')).not.toBeNull(),
  );
  expect(f.externalSign).toHaveBeenCalledTimes(1);
  expect(f.begin).toHaveBeenCalledTimes(1);
  await act(async () => {
    release([{ signedTransaction: f.externalBytes }]);
  });
  await vi.waitFor(
    () =>
      expect(([...storage.rows.values()][0] as { state: string }).state).toBe(
        'retained',
      ),
    { timeout: 15000 },
  );
  expect(f.register).not.toHaveBeenCalled();
  expect(f.externalSign).toHaveBeenCalledTimes(1);
});

it('recovers a retained external tip after remount only with a fresh read and separate unchecked approval', async () => {
  const f = await setup(true, 1);
  let release!: (
    value: { signedTransaction: Uint8Array<ArrayBuffer> }[],
  ) => void;
  let started!: () => void;
  const waiting = new Promise<{ signedTransaction: Uint8Array<ArrayBuffer> }[]>(
    (resolve) => {
      release = resolve;
    },
  );
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.externalSign.mockImplementation(async () => {
    started();
    return waiting;
  });
  await chooseExternal();
  await f.approve();
  await f.sign();
  await act(async () => {
    await began;
  });
  await remountPacket(f, 1, true);
  await act(async () => {
    release([{ signedTransaction: f.externalBytes }]);
  });
  await vi.waitFor(
    () =>
      expect(([...storage.rows.values()][0] as { state: string }).state).toBe(
        'retained',
      ),
    { timeout: 15000 },
  );
  const beforeReadCount = f.readSnapshot.mock.calls.length;
  await enterRecoveryPassword();
  await clickText('Inspect retained Jito tip packet');
  await waitFor(() =>
    expect(container.textContent).toContain(
      'Exact retained packet verified locally',
    ),
  );
  expect(f.readSnapshot.mock.calls.length).toBeGreaterThan(beforeReadCount);
  const label = [...container.querySelectorAll('label')].find((node) =>
    node.textContent?.includes('I approve registering only'),
  )!;
  expect(label.querySelector('input')!.checked).toBe(false);
  expect(f.registerEvidence).not.toHaveBeenCalled();
  await approveRecovery();
  await clickText('Confirm retained Jito tip registration only');
  await waitFor(() => expect(storage.rows.size).toBe(0));
  expect(f.registerEvidence).toHaveBeenCalledTimes(1);
  expect(f.externalSign).toHaveBeenCalledTimes(1);
  expect(f.begin).toHaveBeenCalledTimes(1);
});
async function clickText(text: string) {
  const button = [...container.querySelectorAll('button')].find((node) =>
    node.textContent?.includes(text),
  );
  if (!button) throw Error(`Missing button ${text}`);
  await act(async () => button.click());
}
async function approveRecovery() {
  await enterRecoveryPassword();
  await act(async () => {
    const label = [...container.querySelectorAll('label')].find((node) =>
      node.textContent?.includes('I approve registering only'),
    )!;
    label.querySelector('input')!.click();
  });
}

it('distinguishes preparation, wallet request and registration without claiming a signature early', async () => {
  const f = await setup(true);
  let unlock!: (session: vault.VaultSession) => void, unlocking!: () => void;
  let wallet!: (
      result: { signedTransaction: Uint8Array<ArrayBuffer> }[],
    ) => void,
    walletStarted!: () => void;
  let finishRegister!: () => void, registering!: () => void;
  const unlockPending = new Promise<vault.VaultSession>((resolve) => {
    unlock = resolve;
  });
  const unlockStart = new Promise<void>((resolve) => {
    unlocking = resolve;
  });
  const walletPending = new Promise<
    { signedTransaction: Uint8Array<ArrayBuffer> }[]
  >((resolve) => {
    wallet = resolve;
  });
  const walletStart = new Promise<void>((resolve) => {
    walletStarted = resolve;
  });
  const registerPending = new Promise<void>((resolve) => {
    finishRegister = resolve;
  });
  const registerStart = new Promise<void>((resolve) => {
    registering = resolve;
  });
  const originalRegister = f.register.getMockImplementation()!;
  vi.mocked(vault.unlockVault).mockImplementation(async () => {
    unlocking();
    return unlockPending;
  });
  f.externalSign.mockImplementation(async () => {
    walletStarted();
    return walletPending;
  });
  f.register.mockImplementation(async (transaction, id) => {
    registering();
    await registerPending;
    await originalRegister(transaction, id);
  });
  await chooseExternal();
  await f.approve();
  await f.sign();
  await act(async () => {
    await unlockStart;
  });
  expect(container.textContent).toContain('Preparing the signing request');
  expect(container.textContent).toContain(
    'No signature has been requested yet',
  );
  expect(container.textContent).not.toContain(
    'Waiting for the wallet to respond',
  );
  expect(f.externalSign).not.toHaveBeenCalled();
  await act(async () => {
    unlock(f.session);
    await walletStart;
  });
  expect(container.textContent).toContain(
    'Waiting for the wallet to respond to the signing request',
  );
  expect(container.textContent).not.toContain(
    'Saving the returned signed packet',
  );
  expect(f.register).not.toHaveBeenCalled();
  await act(async () => {
    wallet([{ signedTransaction: f.externalBytes }]);
    await registerStart;
  });
  expect(container.textContent).toContain(
    'Registering the signed packet for recovery',
  );
  await act(async () => {
    finishRegister();
  });
  await waitFor(() => expect(storage.rows.size).toBe(0));
  expect(container.textContent).not.toContain(
    'Registering the signed packet for recovery',
  );
  expect(f.externalSign).toHaveBeenCalledTimes(1);
});

it('shows recovery inspection as read-only while the exact authenticated read is pending', async () => {
  const f = await setup();
  f.register.mockRejectedValueOnce(Error('lost registration response'));
  await f.approve();
  await f.sign();
  await waitFor(() =>
    expect(container.textContent).toContain(
      'needs recovery before another action',
    ),
  );
  const response = await f.readSnapshot();
  let release!: (value: JitoPacketV2Snapshot) => void, started!: () => void;
  const pending = new Promise<JitoPacketV2Snapshot>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.readSnapshot.mockImplementationOnce(async () => {
    started();
    return pending;
  });
  await enterRecoveryPassword();
  await clickText('Inspect retained swap 1 packet');
  await act(async () => {
    await began;
  });
  expect(container.textContent).toContain(
    'Checking the retained recovery packet. This does not sign or submit.',
  );
  expect(f.registerEvidence).not.toHaveBeenCalled();
  await act(async () => {
    release(response);
  });
  await waitFor(() =>
    expect(container.textContent).toContain(
      'Exact retained packet verified locally',
    ),
  );
  expect(container.textContent).not.toContain(
    'Checking the retained recovery packet. This does not sign or submit.',
  );
  expect(f.signer).toHaveBeenCalledTimes(1);
  expect(f.registerEvidence).not.toHaveBeenCalled();
});

it('recovers retained evidence after reload only with a separate unchecked approval', async () => {
  const f = await setup();
  f.register.mockRejectedValueOnce(Error('response lost before registration'));
  await f.approve();
  await f.sign();
  await waitFor(() =>
    expect(container.textContent).toContain(
      'needs recovery before another action',
    ),
  );
  expect(([...storage.rows.values()][0] as { state: string }).state).toBe(
    'retained',
  );
  await act(async () => {
    root.unmount();
    mounted = false;
  });
  root = createRoot(container);
  mounted = true;
  await act(async () =>
    root.render(
      <JitoPacketSigning
        manifest={f.f.manifest}
        packet={0}
        disabled
        ownerScope={owner}
        coordinator={createJitoMemorySignatureRecovery()}
        isContextCurrent={() => true}
        beforeSign={f.beforeSign}
        register={f.register}
        registerEvidence={f.registerEvidence}
        recoveryDisabled={false}
        readSnapshot={f.readSnapshot}
      />,
    ),
  );
  await enterRecoveryPassword();
  await clickText('Inspect retained swap 1 packet');
  await waitFor(() =>
    expect(container.textContent).toContain(
      'Exact retained packet verified locally',
    ),
  );
  expect(f.registerEvidence).not.toHaveBeenCalled();
  const label = [...container.querySelectorAll('label')].find((node) =>
    node.textContent?.includes('I approve registering only'),
  )!;
  expect(label.querySelector('input')!.checked).toBe(false);
  await approveRecovery();
  await clickText('Confirm retained swap 1 registration only');
  await waitFor(() => expect(storage.rows.size).toBe(0));
  expect(f.registerEvidence).toHaveBeenCalledTimes(1);
  expect(f.signer).toHaveBeenCalledTimes(1);
  expect(f.begin).toHaveBeenCalledTimes(1);
});

it('downloads an exact retained packet after remount and expiry only on explicit request', async () => {
  const f = await setup();
  f.register.mockRejectedValueOnce(Error('lost registration response'));
  await f.approve();
  await f.sign();
  await waitFor(() =>
    expect(container.textContent).toContain(
      'needs recovery before another action',
    ),
  );
  await remountPacket(f, 0, true);
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.f.manifest.expiresAt) + 1);
  await enterRecoveryPassword();
  await clickText('Inspect retained swap 1 packet');
  await waitFor(() =>
    expect(container.textContent).toContain(
      'Exact retained packet verified locally',
    ),
  );
  expect(container.textContent).toContain(
    'anyone with it may be able to submit it',
  );
  const create = vi.fn((_blob: Blob) => 'blob:synthetic'),
    revoke = vi.fn();
  vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
  const clickAnchor = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(() => {});
  expect(create).not.toHaveBeenCalled();
  await enterRecoveryPassword();
  await clickText('Download retained swap 1 packet privately');
  await waitFor(() => expect(clickAnchor).toHaveBeenCalledTimes(1));
  expect(create).toHaveBeenCalledTimes(1);
  const blob = create.mock.calls[0][0] as Blob;
  const text = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(Error('Expected text'));
    };
    reader.onerror = () => reject(Error('read failed'));
    reader.readAsText(blob);
  });
  expect(JSON.parse(text)).toEqual(
    await createJitoPacketRecovery(
      f.f.manifest,
      0,
      f.f.swap.signed.transaction,
    ),
  );
  expect(storage.rows.size).toBe(1);
  expect(f.registerEvidence).not.toHaveBeenCalled();
  expect(f.signer).toHaveBeenCalledTimes(1);
  expect(f.begin).toHaveBeenCalledTimes(1);
});

it('does not export or clear a retained packet if the authenticated owner changes', async () => {
  const f = await setup();
  f.register.mockRejectedValueOnce(Error('lost registration response'));
  await f.approve();
  await f.sign();
  await waitFor(() =>
    expect(container.textContent).toContain(
      'needs recovery before another action',
    ),
  );
  await remountPacket(f, 0, true);
  await enterRecoveryPassword();
  await clickText('Inspect retained swap 1 packet');
  await waitFor(() =>
    expect(container.textContent).toContain(
      'Exact retained packet verified locally',
    ),
  );
  const create = vi.fn(() => 'blob:synthetic');
  vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: vi.fn() });
  f.readSnapshot.mockImplementation(async () => ({
    ownerScope: 'b'.repeat(64),
    projectId: f.f.manifest.projectId,
    sessionId: f.f.manifest.sessionId,
    bundle: structuredClone(f.bundle),
    attempts: structuredClone(f.attempts),
    legacyReadOnly: false,
  }));
  await enterRecoveryPassword();
  await clickText('Download retained swap 1 packet privately');
  await waitFor(() =>
    expect(container.textContent).toContain('could not be verified for export'),
  );
  expect(create).not.toHaveBeenCalled();
  expect(storage.rows.size).toBe(1);
  expect(f.registerEvidence).not.toHaveBeenCalled();
});

it('acknowledges an existing exact server receipt after a lost response without registering again', async () => {
  const f = await setup();
  f.register.mockImplementationOnce(async (transaction, id) => {
    const checked = await createJitoPacketRecovery(
      f.f.manifest,
      0,
      transaction,
    );
    const index = f.attempts.findIndex((attempt) => attempt.attemptId === id);
    f.attempts[index] = {
      ...f.attempts[index],
      state: 'registered',
      signature: checked.signature,
      transaction,
    };
    f.bundle.signatures[0] = checked.signature;
    throw Error('response lost after registration');
  });
  await f.approve();
  await f.sign();
  await waitFor(() =>
    expect(container.textContent).toContain(
      'needs recovery before another action',
    ),
  );
  await act(async () => {
    root.unmount();
    mounted = false;
  });
  root = createRoot(container);
  mounted = true;
  await act(async () =>
    root.render(
      <JitoPacketSigning
        manifest={f.f.manifest}
        packet={0}
        disabled
        recoveryOnly
        ownerScope={owner}
        coordinator={createJitoMemorySignatureRecovery()}
        isContextCurrent={() => true}
        beforeSign={f.beforeSign}
        register={f.register}
        registerEvidence={f.registerEvidence}
        recoveryDisabled={false}
        readSnapshot={f.readSnapshot}
      />,
    ),
  );
  expect(container.textContent).not.toContain('Sign swap 1 only');
  await enterRecoveryPassword();
  await clickText('Inspect retained swap 1 packet');
  await waitFor(() =>
    expect(container.textContent).toContain(
      'Exact retained packet verified locally',
    ),
  );
  await approveRecovery();
  await clickText('Confirm retained swap 1 registration only');
  await waitFor(() => expect(storage.rows.size).toBe(0));
  expect(f.registerEvidence).not.toHaveBeenCalled();
  expect(f.signer).toHaveBeenCalledTimes(1);
});

it('requires unchecked user consent and registers only after durable local retention', async () => {
  const f = await setup();
  expect(f.button().disabled).toBe(true);
  expect(container.textContent).toContain(
    'including when signing with an external wallet',
  );
  const events: string[] = [];
  storage.beforeRetain = async () => {
    events.push('durable-retain');
  };
  f.register.mockImplementation(async (transaction, id) => {
    expect(storage.rows.size).toBe(1);
    const record = [...storage.rows.values()][0] as { state: string };
    expect(record.state).toBe('retained');
    expect(f.session.payload.wallets[0].seed).toBe('');
    events.push('register');
    const checked = await createJitoPacketRecovery(
      f.f.manifest,
      0,
      transaction,
    );
    const index = f.attempts.findIndex((attempt) => attempt.attemptId === id);
    f.attempts[index] = {
      ...f.attempts[index],
      state: 'registered',
      signature: checked.signature,
      transaction,
    };
    f.bundle.signatures[0] = checked.signature;
  });
  await f.approve();
  await f.sign();
  await waitFor(() => expect(f.register).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(storage.rows.size).toBe(0));
  expect(events).toEqual(['durable-retain', 'register']);
  expect(f.signer).toHaveBeenCalledTimes(1);
  expect(f.begin).toHaveBeenCalledTimes(1);
});

it('fails wrong password before creating any local or server attempt', async () => {
  const f = await setup();
  vi.mocked(vault.unlockVault).mockRejectedValue(Error('incorrect password'));
  await f.approve();
  await f.sign();
  await waitFor(() =>
    expect(container.textContent).toContain('incorrect password'),
  );
  expect(f.begin).not.toHaveBeenCalled();
  expect(f.signer).not.toHaveBeenCalled();
  expect(storage.rows.size).toBe(0);
});

it('refuses an in-place manifest change while vault unlock is pending', async () => {
  const f = await setup();
  let release!: (session: vault.VaultSession) => void;
  let started!: () => void;
  const waiting = new Promise<vault.VaultSession>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.mocked(vault.unlockVault).mockImplementation(async () => {
    started();
    return waiting;
  });
  await f.approve();
  await f.sign();
  await act(async () => {
    await began;
  });
  f.f.manifest.swaps[0].inputRaw = '99999999';
  await act(async () => {
    release(f.session);
  });
  await waitFor(() =>
    expect(container.textContent).toContain('Bundle changed or expired'),
  );
  expect(f.begin).not.toHaveBeenCalled();
  expect(f.signer).not.toHaveBeenCalled();
  expect(storage.rows.size).toBe(0);
  expect(f.session.payload.wallets[0].seed).toBe('');
});

it('refuses an in-place manifest mutation while the final server sign check is pending', async () => {
  const f = await setup();
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.beforeSign.mockImplementation(async () => {
    started();
    await waiting;
  });
  const signer = vi.spyOn(nacl.sign, 'detached');
  await f.approve();
  await f.sign();
  await act(async () => {
    await began;
  });
  f.f.manifest.swaps[0].inputRaw = '99999999';
  await act(async () => {
    release();
  });
  await waitFor(() =>
    expect(container.textContent).toContain(
      'needs recovery before another action',
    ),
  );
  expect(signer).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
  expect(([...storage.rows.values()][0] as { state: string }).state).toBe(
    'unknown',
  );
});

it('keeps UNKNOWN and does not re-prompt when the begin response is lost', async () => {
  const f = await setup();
  f.begin.mockRejectedValue(Error('lost response'));
  await f.approve();
  await f.sign();
  await waitFor(() =>
    expect(container.textContent).toContain(
      'needs recovery before another action',
    ),
  );
  expect(f.begin).toHaveBeenCalledTimes(1);
  expect(f.signer).not.toHaveBeenCalled();
  expect(([...storage.rows.values()][0] as { state: string }).state).toBe(
    'unknown',
  );
  await f.sign();
  expect(f.begin).toHaveBeenCalledTimes(1);
  await enterRecoveryPassword();
  await clickText('Inspect retained swap 1 packet');
  await waitFor(() =>
    expect(container.textContent).toContain(
      'signing outcome is unknown and no signed packet is available',
    ),
  );
  expect(f.registerEvidence).not.toHaveBeenCalled();
  expect(([...storage.rows.values()][0] as { state: string }).state).toBe(
    'unknown',
  );
});

it('never opens a signer after ambiguous local marker insertion', async () => {
  const f = await setup();
  storage.fault = 'insert-after';
  await f.approve();
  await f.sign();
  await waitFor(() =>
    expect(container.textContent).toContain(
      'needs recovery before another action',
    ),
  );
  expect(f.begin).not.toHaveBeenCalled();
  expect(f.signer).not.toHaveBeenCalled();
  expect(([...storage.rows.values()][0] as { state: string }).state).toBe(
    'unknown',
  );
});

it('retains the exact signature after unmount and never registers it automatically', async () => {
  const f = await setup();
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  storage.beforeRetain = async () => {
    started();
    await waiting;
  };
  await f.approve();
  await f.sign();
  await act(async () => {
    await began;
  });
  await act(async () => {
    root.unmount();
    mounted = false;
    release();
  });
  await vi.waitFor(() =>
    expect(([...storage.rows.values()][0] as { state: string }).state).toBe(
      'retained',
    ),
  );
  expect(f.register).not.toHaveBeenCalled();
  expect(f.session.payload.wallets[0].seed).toBe('');
});

it('does not register if durable retention fails, and keeps UNKNOWN', async () => {
  const f = await setup();
  storage.fault = 'retain';
  await f.approve();
  await f.sign();
  await waitFor(() =>
    expect(container.textContent).toContain(
      'needs recovery before another action',
    ),
  );
  expect(f.signer).toHaveBeenCalledTimes(1);
  expect(f.register).not.toHaveBeenCalled();
  expect(([...storage.rows.values()][0] as { state: string }).state).toBe(
    'unknown',
  );
});

it('keeps a retained packet if registration returns without an exact authenticated receipt', async () => {
  const f = await setup();
  f.register.mockImplementation(async () => {});
  await f.approve();
  await f.sign();
  await waitFor(() =>
    expect(container.textContent).toContain(
      'needs recovery before another action',
    ),
  );
  expect(f.register).toHaveBeenCalledTimes(1);
  expect(([...storage.rows.values()][0] as { state: string }).state).toBe(
    'retained',
  );
});

it('keeps UNKNOWN and never invokes a signer when the server returns recovery-only authority', async () => {
  const f = await setup();
  const original = f.begin.getMockImplementation()!;
  f.begin.mockImplementation(async (...args) => {
    const result = await original(...args);
    const value = (await result.json()) as Record<string, unknown>;
    return Response.json(
      { ...value, mayInvokeSigner: false },
      { headers: { [JITO_OWNER_SCOPE_HEADER]: owner } },
    );
  });
  await f.approve();
  await f.sign();
  await waitFor(() =>
    expect(container.textContent).toContain(
      'needs recovery before another action',
    ),
  );
  expect(f.signer).not.toHaveBeenCalled();
  expect(([...storage.rows.values()][0] as { state: string }).state).toBe(
    'unknown',
  );
});

it('keeps UNKNOWN when the final server pre-sign check fails', async () => {
  const f = await setup();
  f.beforeSign.mockRejectedValue(Error('context changed'));
  await f.approve();
  await f.sign();
  await waitFor(() =>
    expect(container.textContent).toContain(
      'needs recovery before another action',
    ),
  );
  expect(f.beforeSign).toHaveBeenCalledTimes(1);
  expect(f.register).not.toHaveBeenCalled();
  expect(([...storage.rows.values()][0] as { state: string }).state).toBe(
    'unknown',
  );
});

it.each(['normal response', 'lost response'] as const)(
  'keeps the real parent and child recoverable with a %s',
  async (mode) => {
    const f = await jitoBundleFixture();
    const scope = await jitoOwnerScope('alice');
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
      state: 'reviewed' as const,
      bundleId: null,
      signatures: [null, null] as (string | null)[],
      updatedAt: f.manifest.createdAt,
    };
    const attempts: JitoAttempt[] = [];
    const vaultSession = {
      payload: {
        wallets: [
          { family: 'solana', address: f.review.wallet, seed: '07'.repeat(32) },
        ],
      },
    } as unknown as vault.VaultSession;
    vi.spyOn(vault, 'unlockVault').mockResolvedValue(vaultSession);
    vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('synthetic-vault');
    const signer = vi.spyOn(signing, 'signApprovedWarmupPacket');
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const headers = { [JITO_OWNER_SCOPE_HEADER]: scope };
        if (!init?.method) {
          if (url.includes('bundleId='))
            return Response.json(
              {
                projectId: f.manifest.projectId,
                sessionId: session.id,
                bundle,
                attempts,
                legacyReadOnly: false,
              },
              { headers },
            );
          return Response.json(
            {
              projectId: f.manifest.projectId,
              sessionId: session.id,
              eligible: [],
              bundles: [bundle],
            },
            { headers },
          );
        }
        const body = JSON.parse(init.body as string);
        calls.push(body.action);
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
        if (body.action === 'register') {
          const retained = [...storage.rows.values()][0] as { state: string };
          expect(retained.state).toBe('retained');
          const checked = await createJitoPacketRecovery(
            f.manifest,
            0,
            body.transaction,
          );
          const index = attempts.findIndex(
            (a) => a.attemptId === body.attemptId,
          );
          attempts[index] = {
            ...attempts[index],
            state: 'registered',
            signature: checked.signature,
            transaction: body.transaction,
          };
          bundle.signatures[0] = checked.signature;
          if (mode === 'lost response')
            throw Error('response lost after durable registration');
          return Response.json({ bundle }, { headers });
        }
        throw Error('Unexpected synthetic action');
      }),
    );
    await act(async () =>
      root.render(
        <JitoAtomicBundle
          projectId={f.manifest.projectId}
          session={session}
          locked={false}
        />,
      ),
    );
    await waitFor(() => {
      const button = [...container.querySelectorAll('button')].find((node) =>
        node.textContent?.includes('Load bundle approvals and history'),
      );
      expect(button?.disabled).toBe(false);
    });
    await clickText('Load bundle approvals and history');
    await waitFor(() => {
      const label = [...container.querySelectorAll('label')].find((node) =>
        node.textContent?.includes('I approve signing swap 1'),
      );
      expect(label?.querySelector('input')?.disabled).toBe(false);
    });
    await act(async () => {
      const passwordLabel = [...container.querySelectorAll('label')].find(
        (node) => node.textContent?.trim() === 'Vault password for swap 1',
      )!;
      const input = document.getElementById(
        passwordLabel.htmlFor,
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
    await waitFor(() => {
      const button = [...container.querySelectorAll('button')].find((node) =>
        node.textContent?.includes('Sign swap 1 only'),
      );
      expect(button?.disabled).toBe(false);
    });
    await clickText('Sign swap 1 only');
    if (mode === 'normal response') {
      await vi.waitFor(
        async () => {
          await act(async () => {});
          expect(bundle.signatures[0]).toBe(f.swap.signed.signature);
          expect(storage.rows.size).toBe(0);
        },
        { timeout: 15000 },
      );
    } else {
      await vi.waitFor(
        async () => {
          await act(async () => {});
          expect(bundle.signatures[0]).toBe(f.swap.signed.signature);
          expect(
            ([...storage.rows.values()][0] as { state: string }).state,
          ).toBe('retained');
          expect(container.textContent).toContain(
            'needs recovery before another action',
          );
        },
        { timeout: 15000 },
      );
      await act(async () => {
        root.unmount();
        mounted = false;
      });
      root = createRoot(container);
      mounted = true;
      await act(async () =>
        root.render(
          <JitoAtomicBundle
            projectId={f.manifest.projectId}
            session={session}
            locked={false}
          />,
        ),
      );
      await waitFor(() => {
        const button = [...container.querySelectorAll('button')].find((node) =>
          node.textContent?.includes('Load bundle approvals and history'),
        );
        expect(button?.disabled).toBe(false);
      });
      await clickText('Load bundle approvals and history');
      await waitFor(() => {
        const input = container.querySelector(
          'input[id$="-recovery-password"]',
        ) as HTMLInputElement;
        expect(input?.disabled).toBe(false);
      });
      await enterRecoveryPassword();
      await clickText('Inspect retained swap 1 packet');
      await vi.waitFor(
        async () => {
          await act(async () => {});
          expect(container.textContent).toContain(
            'Exact retained packet verified locally',
          );
        },
        { timeout: 15000 },
      );
      await approveRecovery();
      await clickText('Confirm retained swap 1 registration only');
      await vi.waitFor(
        async () => {
          await act(async () => {});
          expect(storage.rows.size).toBe(0);
        },
        { timeout: 15000 },
      );
    }
    expect(calls).toEqual(['begin-signing', 'register']);
    expect(signer).toHaveBeenCalledTimes(1);
    expect(vaultSession.payload.wallets[0].seed).toBe('');
  },
);

it.each([
  'revoked consent',
  'changed password',
  'restored consent',
  'disabled',
  'context changed',
])('does not let a stale sign click revive %s', async (change) => {
  const f = await setup();
  await f.approve();
  const button = f.button();
  const key = Object.getOwnPropertyNames(button).find((name) =>
    name.startsWith('__reactProps$'),
  )!;
  const stale = (button as unknown as Record<string, { onClick: () => void }>)[
    key
  ].onClick;
  if (change === 'disabled' || change === 'context changed') {
    await act(async () =>
      root.render(
        <JitoPacketSigning
          manifest={f.f.manifest}
          packet={0}
          disabled={change === 'disabled'}
          ownerScope={owner}
          coordinator={f.coordinator}
          isContextCurrent={() => change !== 'context changed'}
          beforeSign={f.beforeSign}
          register={f.register}
          readSnapshot={f.readSnapshot}
          recoveryDisabled={false}
          registerEvidence={f.registerEvidence}
        />,
      ),
    );
  } else if (change === 'changed password') {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(f.input, 'another-password');
      f.input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  } else {
    await act(async () => f.checkbox.click());
    if (change === 'restored consent')
      await act(async () => f.checkbox.click());
  }
  await act(async () => stale());
  expect(f.begin).not.toHaveBeenCalled();
  expect(f.signer).not.toHaveBeenCalled();
  expect(storage.rows.size).toBe(0);
});

it('does not register retained evidence from a stale approval click', async () => {
  const f = await setup();
  f.register.mockRejectedValueOnce(Error('lost registration response'));
  await f.approve();
  await f.sign();
  await waitFor(() =>
    expect(container.textContent).toContain(
      'Registration or acknowledgement needs attention',
    ),
  );
  await enterRecoveryPassword();
  await clickText('Inspect retained swap 1 packet');
  await waitFor(() =>
    expect(container.textContent).toContain(
      'Exact retained packet verified locally',
    ),
  );
  await approveRecovery();
  const button = [...container.querySelectorAll('button')].find((node) =>
    node.textContent?.includes('Confirm retained swap 1 registration only'),
  )!;
  const key = Object.getOwnPropertyNames(button).find((name) =>
    name.startsWith('__reactProps$'),
  )!;
  const stale = (button as unknown as Record<string, { onClick: () => void }>)[
    key
  ].onClick;
  const label = [...container.querySelectorAll('label')].find((node) =>
    node.textContent?.includes('I approve registering only'),
  )!;
  const checkbox = label.querySelector('input')!;
  await act(async () => checkbox.click());
  await act(async () => checkbox.click());
  await act(async () => stale());
  expect(f.registerEvidence).not.toHaveBeenCalled();
  expect(storage.rows.size).toBe(1);
});

it('does not download an in-memory signed packet when context changes during cryptographic preparation', async () => {
  const f = await setup();
  f.register.mockRejectedValueOnce(Error('lost registration response'));
  await f.approve();
  await f.sign();
  await waitFor(() =>
    expect(container.textContent).toContain(
      'Registration or acknowledgement needs attention',
    ),
  );
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const original = packetRecovery.createJitoPacketRecovery;
  vi.spyOn(packetRecovery, 'createJitoPacketRecovery').mockImplementation(
    async (...args) => {
      started();
      await waiting;
      return original(...args);
    },
  );
  const create = vi.fn();
  vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: vi.fn() });
  await clickText('Download signed packet recovery file');
  await act(async () => {
    await began;
  });
  await act(async () =>
    root.render(
      <JitoPacketSigning
        manifest={f.f.manifest}
        packet={0}
        disabled={false}
        ownerScope={owner}
        coordinator={f.coordinator}
        isContextCurrent={() => false}
        beforeSign={f.beforeSign}
        register={f.register}
        readSnapshot={f.readSnapshot}
        recoveryDisabled={false}
        registerEvidence={f.registerEvidence}
      />,
    ),
  );
  await act(async () => {
    release();
  });
  await waitFor(() =>
    expect(container.textContent).not.toContain('Preparing the recovery'),
  );
  expect(create).not.toHaveBeenCalled();
  expect(storage.rows.size).toBe(1);
});

it('does not let a stale checkbox handler reapprove signing after consent was revoked', async () => {
  const f = await setup();
  await f.approve();
  const key = Object.getOwnPropertyNames(f.checkbox).find((name) =>
    name.startsWith('__reactProps$'),
  )!;
  const stale = (
    f.checkbox as unknown as Record<
      string,
      { onChange: (event: unknown) => void }
    >
  )[key].onChange;
  await act(async () => f.checkbox.click());
  await act(async () => stale({ target: { checked: true } }));
  expect(f.checkbox.checked).toBe(false);
  await f.sign();
  expect(f.begin).not.toHaveBeenCalled();
  expect(storage.rows.size).toBe(0);
});

it('does not accept a stale signing-consent handler after the password changes', async () => {
  const f = await setup();
  const key = Object.getOwnPropertyNames(f.checkbox).find((name) =>
    name.startsWith('__reactProps$'),
  )!;
  const stale = (
    f.checkbox as unknown as Record<
      string,
      { onChange: (event: unknown) => void }
    >
  )[key].onChange;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(f.input, 'synthetic-password');
    f.input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => stale({ target: { checked: true } }));
  expect(f.checkbox.checked).toBe(false);
  await f.sign();
  expect(f.begin).not.toHaveBeenCalled();
  expect(storage.rows.size).toBe(0);
});
