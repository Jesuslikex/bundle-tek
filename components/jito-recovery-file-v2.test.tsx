// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as vault from '@/lib/browser-wallet-vault';
import { createJitoMemorySignatureRecovery } from '@/lib/jito-memory-signature-recovery';
import {
  reserveJitoRecoveryUnknown,
  withJitoRecoveryJournalLock,
} from '@/lib/jito-recovery-journal';
import { createJitoPacketRecovery } from '@/lib/jito-packet-recovery';
import type { JitoAttempt } from '@/lib/jito-sign-attempt-client';
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import { JitoRecoveryFileV2 } from './jito-recovery-file-v2';
type MutableAttempt = { -readonly [K in keyof JitoAttempt]: JitoAttempt[K] };

const store = vi.hoisted(() => ({
  rows: new Map<string, unknown>(),
  fault: '',
  afterInsert: undefined as undefined | (() => void),
}));
vi.mock('@/lib/jito-recovery-journal-store', () => ({
  readJournalEntry: async (key: string) => structuredClone(store.rows.get(key)),
  listJournalEntries: async () => structuredClone([...store.rows.values()]),
  insertJournalUnknown: async (value: { key: string }) => {
    if (store.fault === 'insert' || store.rows.has(value.key))
      throw Error('insert unavailable');
    store.rows.set(value.key, structuredClone(value));
    store.afterInsert?.();
  },
  retainJournalEntry: async (expected: { key: string }, value: unknown) => {
    if (
      store.fault === 'retain' ||
      JSON.stringify(store.rows.get(expected.key)) !== JSON.stringify(expected)
    )
      throw Error('retain unavailable');
    store.rows.set(expected.key, structuredClone(value));
  },
  deleteRetainedJournalEntry: async (expected: { key: string }) => {
    if (
      store.fault === 'delete' ||
      JSON.stringify(store.rows.get(expected.key)) !== JSON.stringify(expected)
    )
      throw Error('ack unavailable');
    store.rows.delete(expected.key);
  },
}));
const owner = 'a'.repeat(64),
  password = 'synthetic-password',
  locks = new Set<string>();
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('crypto', webcrypto);
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
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw Error('unexpected network');
    }),
  );
  store.rows.clear();
  store.fault = '';
  store.afterInsert = undefined;
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

async function setup() {
  const f = await jitoBundleFixture();
  const manifest = f.manifest;
  const bundle = {
    manifest,
    state: 'reviewed' as const,
    bundleId: null,
    signatures: [null, null] as (string | null)[],
    updatedAt: manifest.createdAt,
  };
  const attempt: MutableAttempt = {
    bundleId: manifest.id,
    manifestSha256: manifest.sha256,
    packet: 0,
    signer: f.review.wallet,
    intentId: f.review.id,
    attemptId: crypto.randomUUID(),
    state: 'unknown',
    signature: null,
    transaction: null,
  };
  const snapshot = vi.fn(async () => ({
    ownerScope: owner,
    projectId: manifest.projectId,
    sessionId: manifest.sessionId,
    bundle: structuredClone(bundle),
    attempts: [structuredClone(attempt)],
    legacyReadOnly: false,
  }));
  const registerEvidence = vi.fn(async (transaction: string, id: string) => {
    if (id !== attempt.attemptId) throw Error('unexpected attempt');
    const checked = await createJitoPacketRecovery(manifest, 0, transaction);
    attempt.state = 'registered';
    attempt.signature = checked.signature;
    attempt.transaction = transaction;
    bundle.signatures[0] = checked.signature;
  });
  const vaultSession = {
    payload: {
      wallets: [
        { family: 'solana', address: f.review.wallet, seed: '07'.repeat(32) },
      ],
    },
  } as unknown as vault.VaultSession;
  vi.spyOn(vault, 'unlockVault').mockResolvedValue(vaultSession);
  vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('synthetic-vault');
  const checked = await createJitoPacketRecovery(
    manifest,
    0,
    f.swap.signed.transaction,
  );
  const fileText = JSON.stringify(checked);
  const file = new File([fileText], 'recovery.json', {
    type: 'application/json',
  });
  Object.defineProperty(file, 'text', { value: async () => fileText });
  const coordinator = createJitoMemorySignatureRecovery();
  let active = true;
  const render = async (currentCoordinator = coordinator) =>
    act(async () =>
      root.render(
        <JitoRecoveryFileV2
          manifest={manifest}
          packet={0}
          ownerScope={owner}
          coordinator={currentCoordinator}
          disabled={false}
          isContextCurrent={() => active}
          readSnapshot={snapshot}
          registerEvidence={registerEvidence}
        />,
      ),
    );
  await render();
  const setFile = async (value: File) =>
    act(async () => {
      const input = container.querySelector(
        'input[type=file]',
      ) as HTMLInputElement;
      Object.defineProperty(input, 'files', {
        configurable: true,
        value: [value],
      });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  const setPassword = async (value = password) =>
    act(async () => {
      const pass = container.querySelector(
        'input[type=password]',
      ) as HTMLInputElement;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(pass, value);
      pass.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const click = async (text: string) => {
    const button = [...container.querySelectorAll('button')].find((node) =>
      node.textContent?.includes(text),
    );
    if (!button) throw Error(`Missing button ${text}`);
    await act(async () => button.click());
  };
  return {
    f,
    manifest,
    bundle,
    attempt,
    snapshot,
    registerEvidence,
    vaultSession,
    checked,
    file,
    setFile,
    setPassword,
    click,
    coordinator,
    render,
    setActive: (value: boolean) => {
      active = value;
    },
  };
}
async function until(check: () => void) {
  await vi.waitFor(
    async () => {
      await act(async () => {});
      check();
    },
    { timeout: 15000 },
  );
}

it('retains an exact file for an owned UNKNOWN and requires separate unchecked approval before registration', async () => {
  const f = await setup();
  await f.setFile(f.file);
  await f.setPassword();
  await f.click('Verify and retain');
  await until(() =>
    expect(container.textContent).toContain(
      'Exact signed packet verified and retained',
    ),
  );
  expect(store.rows.size).toBe(1);
  expect(([...store.rows.values()][0] as { state: string }).state).toBe(
    'retained',
  );
  expect(JSON.stringify([...store.rows.values()])).not.toContain(
    f.checked.signature,
  );
  expect(f.vaultSession.payload.wallets[0].seed).toBe('');
  expect(f.registerEvidence).not.toHaveBeenCalled();
  const checkbox = container.querySelector(
    'input[type=checkbox]',
  ) as HTMLInputElement;
  expect(checkbox.checked).toBe(false);
  await f.setPassword();
  await act(async () => checkbox.click());
  await f.click('Confirm exact registration only');
  await until(() => expect(store.rows.size).toBe(0));
  expect(f.registerEvidence).toHaveBeenCalledTimes(1);
  expect(f.attempt.signature).toBe(f.checked.signature);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('reopens an existing UNKNOWN using its original password even if the current vault password has changed', async () => {
  const f = await setup();
  await withJitoRecoveryJournalLock(
    owner,
    () => {},
    async (lock) => {
      await reserveJitoRecoveryUnknown(
        lock,
        f.manifest,
        0,
        'old-password',
        async () => ({ ownerScope: owner, record: structuredClone(f.bundle) }),
      );
    },
  );
  vi.mocked(vault.unlockVault).mockRejectedValue(
    Error('new vault password differs'),
  );
  await f.setFile(f.file);
  await f.setPassword('old-password');
  await f.click('Verify and retain');
  await until(() =>
    expect(container.textContent).toContain(
      'Exact signed packet verified and retained',
    ),
  );
  expect(([...store.rows.values()][0] as { state: string }).state).toBe(
    'retained',
  );
  expect(vault.unlockVault).not.toHaveBeenCalled();
  expect(f.registerEvidence).not.toHaveBeenCalled();
});

it('never persists an imported file when its bytes or server attempt differ', async () => {
  const f = await setup();
  const bad = new File(['bad'], 'bad.json');
  Object.defineProperty(bad, 'text', {
    value: async () => JSON.stringify({ ...f.checked, signature: 'bad' }),
  });
  await f.setFile(bad);
  await f.setPassword();
  await f.click('Verify and retain');
  await until(() =>
    expect(container.textContent).toContain('could not be verified'),
  );
  expect(store.rows.size).toBe(0);
  expect(f.registerEvidence).not.toHaveBeenCalled();
  f.attempt.signer = '11111111111111111111111111111111';
  await f.setFile(f.file);
  await f.setPassword();
  await f.click('Verify and retain');
  await until(() =>
    expect(container.textContent).toContain('could not be verified'),
  );
  expect(store.rows.size).toBe(0);
  expect(f.registerEvidence).not.toHaveBeenCalled();
});

it('does not overwrite a retained entry with a malformed or mismatched file', async () => {
  const f = await setup();
  await f.setFile(f.file);
  await f.setPassword();
  await f.click('Verify and retain');
  await until(() =>
    expect(container.textContent).toContain(
      'Exact signed packet verified and retained',
    ),
  );
  const original = structuredClone([...store.rows.values()][0]);
  const bad = new File(['bad'], 'bad.json');
  Object.defineProperty(bad, 'text', { value: async () => '{invalid' });
  await f.setFile(bad);
  await f.setPassword();
  await f.click('Verify and retain');
  await until(() =>
    expect(container.textContent).toContain('could not be verified'),
  );
  expect([...store.rows.values()][0]).toEqual(original);
  expect(f.registerEvidence).not.toHaveBeenCalled();
});

it('recognizes an already registered exact packet without registering or creating a new journal record', async () => {
  const f = await setup();
  f.attempt.state = 'registered';
  f.attempt.signature = f.checked.signature;
  f.attempt.transaction = f.checked.transaction;
  f.bundle.signatures[0] = f.checked.signature;
  await f.setFile(f.file);
  await f.setPassword();
  await f.click('Verify and retain');
  await until(() =>
    expect(container.textContent).toContain('already registered'),
  );
  expect(store.rows.size).toBe(0);
  expect(f.registerEvidence).not.toHaveBeenCalled();
});

it('keeps the exact retained packet if registration returns without an authenticated matching receipt', async () => {
  const f = await setup();
  f.registerEvidence.mockImplementation(async () => {});
  await f.setFile(f.file);
  await f.setPassword();
  await f.click('Verify and retain');
  await until(() =>
    expect(container.textContent).toContain(
      'Exact signed packet verified and retained',
    ),
  );
  await f.setPassword();
  await act(async () =>
    (
      container.querySelector('input[type=checkbox]') as HTMLInputElement
    ).click(),
  );
  await f.click('Confirm exact registration only');
  await until(() =>
    expect(container.textContent).toContain('could not be verified'),
  );
  expect(([...store.rows.values()][0] as { state: string }).state).toBe(
    'retained',
  );
});

it('preserves the retained file and asks for reload before registering when a memory outcome is unresolved', async () => {
  const f = await setup();
  const memory = await f.coordinator.reserve(owner, f.manifest, 0);
  f.coordinator.markStarted(memory);
  await f.setFile(f.file);
  await f.setPassword();
  await f.click('Verify and retain');
  await until(() =>
    expect(container.textContent).toContain(
      'Exact signed packet verified and retained',
    ),
  );
  await f.setPassword();
  await act(async () =>
    (
      container.querySelector('input[type=checkbox]') as HTMLInputElement
    ).click(),
  );
  await f.click('Confirm exact registration only');
  await until(() =>
    expect(container.textContent).toContain(
      'Reload the page, then inspect the retained packet again',
    ),
  );
  expect(([...store.rows.values()][0] as { state: string }).state).toBe(
    'retained',
  );
  expect(f.registerEvidence).not.toHaveBeenCalled();
});

it('acknowledges the exact registered file after a lost response and reload without registering or signing again', async () => {
  const f = await setup();
  f.registerEvidence.mockImplementationOnce(async (transaction, id) => {
    expect(id).toBe(f.attempt.attemptId);
    const checked = await createJitoPacketRecovery(f.manifest, 0, transaction);
    f.attempt.state = 'registered';
    f.attempt.signature = checked.signature;
    f.attempt.transaction = transaction;
    f.bundle.signatures[0] = checked.signature;
    throw Error('response lost after commit');
  });
  await f.setFile(f.file);
  await f.setPassword();
  await f.click('Verify and retain');
  await until(() =>
    expect(container.textContent).toContain(
      'Exact signed packet verified and retained',
    ),
  );
  await f.setPassword();
  await act(async () =>
    (
      container.querySelector('input[type=checkbox]') as HTMLInputElement
    ).click(),
  );
  await f.click('Confirm exact registration only');
  await until(() =>
    expect(container.textContent).toContain('could not be verified'),
  );
  expect(([...store.rows.values()][0] as { state: string }).state).toBe(
    'retained',
  );
  await act(async () => root.unmount());
  root = createRoot(container);
  await f.render(createJitoMemorySignatureRecovery());
  await f.setFile(f.file);
  await f.setPassword();
  await f.click('Verify and retain');
  await until(() =>
    expect(container.textContent).toContain(
      'Exact signed packet verified and retained',
    ),
  );
  await f.setPassword();
  await act(async () =>
    (
      container.querySelector('input[type=checkbox]') as HTMLInputElement
    ).click(),
  );
  await f.click('Confirm exact registration only');
  await until(() => expect(store.rows.size).toBe(0));
  expect(f.registerEvidence).toHaveBeenCalledTimes(1);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('keeps UNKNOWN when the owner changes after the local insertion', async () => {
  const f = await setup();
  store.afterInsert = () => {
    f.snapshot.mockImplementation(async () => ({
      ownerScope: 'b'.repeat(64),
      projectId: f.manifest.projectId,
      sessionId: f.manifest.sessionId,
      bundle: structuredClone(f.bundle),
      attempts: [structuredClone(f.attempt)],
      legacyReadOnly: false,
    }));
  };
  await f.setFile(f.file);
  await f.setPassword();
  await f.click('Verify and retain');
  await until(() =>
    expect(container.textContent).toContain('could not be verified'),
  );
  expect(([...store.rows.values()][0] as { state: string }).state).toBe(
    'unknown',
  );
  expect(f.registerEvidence).not.toHaveBeenCalled();
});

it('refuses a changed attempt after inspection and preserves the retained signature', async () => {
  const f = await setup();
  await f.setFile(f.file);
  await f.setPassword();
  await f.click('Verify and retain');
  await until(() =>
    expect(container.textContent).toContain(
      'Exact signed packet verified and retained',
    ),
  );
  f.attempt.attemptId = crypto.randomUUID();
  await f.setPassword();
  await act(async () =>
    (
      container.querySelector('input[type=checkbox]') as HTMLInputElement
    ).click(),
  );
  await f.click('Confirm exact registration only');
  await until(() =>
    expect(container.textContent).toContain('could not be verified'),
  );
  expect(([...store.rows.values()][0] as { state: string }).state).toBe(
    'retained',
  );
  expect(f.registerEvidence).not.toHaveBeenCalled();
});

it('leaves UNKNOWN unchanged on a wrong previous password', async () => {
  const f = await setup();
  await withJitoRecoveryJournalLock(
    owner,
    () => {},
    async (lock) => {
      await reserveJitoRecoveryUnknown(
        lock,
        f.manifest,
        0,
        'old-password',
        async () => ({ ownerScope: owner, record: structuredClone(f.bundle) }),
      );
    },
  );
  const original = structuredClone([...store.rows.values()][0]);
  await f.setFile(f.file);
  await f.setPassword('wrong-password');
  await f.click('Verify and retain');
  await until(() =>
    expect(container.textContent).toContain('could not be verified'),
  );
  expect([...store.rows.values()][0]).toEqual(original);
  expect(f.registerEvidence).not.toHaveBeenCalled();
});

it('retains exact signed evidence after review expiry without signing or submitting', async () => {
  const f = await setup();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.manifest.expiresAt) + 1);
  await f.setFile(f.file);
  await f.setPassword();
  await f.click('Verify and retain');
  await until(() =>
    expect(container.textContent).toContain(
      'Exact signed packet verified and retained',
    ),
  );
  expect(([...store.rows.values()][0] as { state: string }).state).toBe(
    'retained',
  );
  expect(f.registerEvidence).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('does not retain or register if context changes while the recovery file is loading', async () => {
  const f = await setup();
  let release!: (text: string) => void, started!: () => void;
  const waiting = new Promise<string>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const delayed = new File(['held'], 'held.json');
  Object.defineProperty(delayed, 'text', {
    value: async () => {
      started();
      return waiting;
    },
  });
  await f.setFile(delayed);
  await f.setPassword();
  await f.click('Verify and retain');
  await act(async () => {
    await began;
  });
  f.setActive(false);
  await act(async () => {
    release(JSON.stringify(f.checked));
  });
  await until(() =>
    expect(container.textContent).toContain('could not be verified'),
  );
  expect(store.rows.size).toBe(0);
  expect(f.registerEvidence).not.toHaveBeenCalled();
});
