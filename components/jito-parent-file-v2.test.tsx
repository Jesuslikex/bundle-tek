// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as vault from '@/lib/browser-wallet-vault';
import * as warmup from '@/lib/warmup-signing';
import * as nativeWithdrawal from '@/lib/native-withdrawal';
import {
  JITO_OWNER_SCOPE_HEADER,
  jitoOwnerScope,
} from '@/lib/jito-owner-scope';
import { createJitoPacketRecovery } from '@/lib/jito-packet-recovery';
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import { JitoAtomicBundle } from './jito-atomic-bundle';
import type { TradeSession } from '@/lib/imported-trade-session';
import { bundleFingerprint } from '@/lib/jito-bundle';

vi.mock('better-auth/react', () => ({
  createAuthClient: () => ({
    useSession: () => ({ data: { user: { id: 'alice' } }, isPending: false }),
  }),
}));
vi.mock('./jito-packet-signing', () => ({
  JitoPacketSigning: () => <p>Signing component</p>,
}));
const storage = vi.hoisted(() => ({ rows: new Map<string, unknown>() }));
vi.mock('@/lib/jito-recovery-journal-store', () => ({
  readJournalEntry: async (key: string) =>
    structuredClone(storage.rows.get(key)),
  listJournalEntries: async () => structuredClone([...storage.rows.values()]),
  insertJournalUnknown: async (value: { key: string }) => {
    if (storage.rows.has(value.key)) throw Error('duplicate');
    storage.rows.set(value.key, structuredClone(value));
  },
  retainJournalEntry: async (expected: { key: string }, value: unknown) => {
    if (
      JSON.stringify(storage.rows.get(expected.key)) !==
      JSON.stringify(expected)
    )
      throw Error('changed');
    storage.rows.set(expected.key, structuredClone(value));
  },
  deleteRetainedJournalEntry: async (expected: { key: string }) => {
    if (
      JSON.stringify(storage.rows.get(expected.key)) !==
      JSON.stringify(expected)
    )
      throw Error('changed');
    storage.rows.delete(expected.key);
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
        _opts: unknown,
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
  storage.rows.clear();
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

async function setup(packet = 0, expired = false, legacy = false) {
  const f = await jitoBundleFixture();
  if (expired) {
    const { sha256: _old, ...terms } = f.manifest;
    terms.expiresAt = new Date(Date.now() - 1000).toISOString();
    f.manifest = { ...terms, sha256: await bundleFingerprint(terms) };
  }
  const signed = packet === 0 ? f.swap.signed : f.tip.signed;
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
    finalization: null,
  };
  const attempt = {
    bundleId: f.manifest.id,
    manifestSha256: f.manifest.sha256,
    packet,
    attemptId: crypto.randomUUID(),
    signer: packet === 0 ? f.review.wallet : f.manifest.tip.wallet,
    intentId: packet === 0 ? f.review.id : null,
    state: 'unknown',
    transaction: null as string | null,
    signature: null as string | null,
  };
  const calls: string[] = [];
  let serverScope = scope;
  let loseRegistrationResponse = false;
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const headers = { [JITO_OWNER_SCOPE_HEADER]: serverScope };
    if (init.method === 'POST') {
      const body = JSON.parse(init.body as string);
      calls.push(body.action);
      if (
        body.action !== 'register' ||
        body.attemptId !== attempt.attemptId ||
        body.approved !== true ||
        body.transaction !== signed.transaction
      )
        throw Error('unexpected action');
      attempt.state = 'registered';
      attempt.transaction = body.transaction;
      attempt.signature = signed.signature;
      bundle.signatures[packet] = attempt.signature;
      if (loseRegistrationResponse) {
        loseRegistrationResponse = false;
        throw Error('lost response');
      }
      return Response.json({ bundle }, { headers });
    }
    const result = String(url).includes('bundleId=')
      ? {
          projectId: session.terms.projectId,
          sessionId: session.id,
          bundle,
          attempts: legacy ? [] : [attempt],
          legacyReadOnly: legacy,
        }
      : {
          projectId: session.terms.projectId,
          sessionId: session.id,
          bundles: [bundle],
          eligible: [],
        };
    return Response.json(result, { headers });
  });
  vi.stubGlobal('fetch', fetcher);
  const swapSigner = vi.spyOn(warmup, 'signApprovedWarmupPacket');
  const tipSigner = vi.spyOn(nativeWithdrawal, 'signNativeWithdrawal');
  vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('synthetic-vault');
  vi.spyOn(vault, 'unlockVault').mockResolvedValue({
    payload: {
      wallets: [
        { family: 'solana', address: f.review.wallet, seed: '07'.repeat(32) },
      ],
    },
  } as unknown as vault.VaultSession);
  await act(async () =>
    root.render(
      <JitoAtomicBundle
        projectId={f.manifest.projectId}
        session={session}
        locked={false}
      />,
    ),
  );
  const button = (name: string) => {
    const found = [...container.querySelectorAll('button')].find((item) =>
      item.textContent?.includes(name),
    );
    if (!found) throw Error(`Missing button ${name}`);
    return found;
  };
  const click = async (name: string) => act(async () => button(name).click());
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(button('Load bundle approvals').disabled).toBe(false);
  });
  await click('Load bundle approvals');
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.textContent).toContain(
      legacy
        ? 'This older bundle is read-only'
        : 'A signing outcome is unknown',
    );
  });
  const fileText = JSON.stringify(
    await createJitoPacketRecovery(f.manifest, packet, signed.transaction),
  );
  const choose = async (text: () => Promise<string> = async () => fileText) => {
    const article = [...container.querySelectorAll('article')].find((node) =>
      node.textContent?.includes(f.manifest.id),
    )!;
    const label = [...article.querySelectorAll('label')].filter(
      (item) => item.textContent === 'Signed packet recovery file',
    )[packet]!;
    const input = document.getElementById(label.htmlFor) as HTMLInputElement;
    const file = new File([fileText], 'packet.json', {
      type: 'application/json',
    });
    Object.defineProperty(file, 'text', { value: text });
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [file],
    });
    await act(async () =>
      input.dispatchEvent(new Event('change', { bubbles: true })),
    );
  };
  const password = async () => {
    const article = [...container.querySelectorAll('article')].find((node) =>
      node.textContent?.includes(f.manifest.id),
    )!;
    const label = [...article.querySelectorAll('label')].filter(
      (item) => item.textContent === 'Vault password for recovery',
    )[packet]!;
    const input = document.getElementById(label.htmlFor) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, 'synthetic-password');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  return {
    f,
    session,
    bundle,
    attempt,
    calls,
    fetcher,
    button,
    click,
    choose,
    password,
    setScope: (value: string) => {
      serverScope = value;
    },
    swapSigner,
    tipSigner,
    loseNextRegistrationResponse: () => {
      loseRegistrationResponse = true;
    },
  };
}

it('retains a file and registers its exact evidence only after separate unchecked approval in the real parent', async () => {
  const f = await setup();
  await f.choose();
  await f.password();
  await f.click('Verify and retain swap 1 file');
  await vi.waitFor(
    async () => {
      await act(async () => {});
      expect(container.textContent).toContain(
        'Exact signed packet verified and retained',
      );
    },
    { timeout: 15000 },
  );
  expect(f.calls).toEqual([]);
  expect(([...storage.rows.values()][0] as { state: string }).state).toBe(
    'retained',
  );
  const approval = [...container.querySelectorAll('label')]
    .find((item) =>
      item.textContent?.includes(
        'I approve registering only this exact retained packet',
      ),
    )!
    .querySelector('input')!;
  expect(approval.checked).toBe(false);
  expect(f.button('Confirm exact registration only').disabled).toBe(true);
  await f.password();
  await act(async () => approval.click());
  await f.click('Confirm exact registration only');
  await vi.waitFor(
    async () => {
      await act(async () => {});
      expect(container.textContent).toContain('Exact registration confirmed');
    },
    { timeout: 15000 },
  );
  expect(f.calls).toEqual(['register']);
  expect(storage.rows.size).toBe(0);
  expect(f.bundle.signatures[0]).toBe(f.f.swap.signed.signature);
});

it('recovers an exact tip file against the existing null-intent attempt in the real parent', async () => {
  const f = await setup(1);
  expect(f.attempt.intentId).toBeNull();
  await f.choose();
  await f.password();
  await f.click('Verify and retain Jito tip file');
  await vi.waitFor(
    async () => {
      await act(async () => {});
      expect(container.textContent).toContain(
        'Exact signed packet verified and retained',
      );
    },
    { timeout: 15000 },
  );
  expect(f.calls).toEqual([]);
  const approval = [...container.querySelectorAll('label')]
    .find((item) =>
      item.textContent?.includes(
        'I approve registering only this exact retained packet',
      ),
    )!
    .querySelector('input')!;
  expect(approval.checked).toBe(false);
  await f.password();
  await act(async () => approval.click());
  await f.click('Confirm exact registration only');
  await vi.waitFor(
    async () => {
      await act(async () => {});
      expect(container.textContent).toContain('Exact registration confirmed');
    },
    { timeout: 15000 },
  );
  expect(f.calls).toEqual(['register']);
  expect(storage.rows.size).toBe(0);
  expect(f.bundle.signatures[1]).toBe(f.f.tip.signed.signature);
});

it('saves only approved exact evidence after expiry without signing or submitting', async () => {
  const f = await setup(0, true);
  await f.choose();
  await f.password();
  await f.click('Verify and retain swap 1 file');
  await vi.waitFor(
    async () => {
      await act(async () => {});
      expect(container.textContent).toContain(
        'Exact signed packet verified and retained',
      );
    },
    { timeout: 15000 },
  );
  expect(f.calls).toEqual([]);
  const approval = [...container.querySelectorAll('label')]
    .find((item) =>
      item.textContent?.includes(
        'I approve registering only this exact retained packet',
      ),
    )!
    .querySelector('input')!;
  expect(approval.checked).toBe(false);
  expect(f.button('Confirm exact registration only').disabled).toBe(true);
  await f.password();
  await act(async () => approval.click());
  await f.click('Confirm exact registration only');
  await vi.waitFor(
    async () => {
      await act(async () => {});
      expect(container.textContent).toContain('Exact registration confirmed');
    },
    { timeout: 15000 },
  );
  expect(f.calls).toEqual(['register']);
  expect(storage.rows.size).toBe(0);
  expect(f.swapSigner).not.toHaveBeenCalled();
  expect(f.tipSigner).not.toHaveBeenCalled();
});

it('keeps file import disabled for a legacy read-only bundle', async () => {
  const f = await setup(0, false, true);
  expect(f.button('Verify and retain swap 1 file').disabled).toBe(true);
  const article = [...container.querySelectorAll('article')].find((node) =>
    node.textContent?.includes(f.f.manifest.id),
  )!;
  const label = [...article.querySelectorAll('label')].find(
    (item) => item.textContent === 'Signed packet recovery file',
  )!;
  expect(
    (document.getElementById(label.htmlFor) as HTMLInputElement).disabled,
  ).toBe(true);
  expect(f.calls).toEqual([]);
  expect(storage.rows.size).toBe(0);
});

it('rejects a late file read after the authenticated owner changes without registration', async () => {
  const f = await setup();
  let release!: (value: string) => void, started!: () => void;
  const waiting = new Promise<string>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const text = JSON.stringify(
    await createJitoPacketRecovery(
      f.f.manifest,
      0,
      f.f.swap.signed.transaction,
    ),
  );
  await f.choose(() => {
    started();
    return waiting;
  });
  await f.password();
  await f.click('Verify and retain swap 1 file');
  await act(async () => {
    await began;
  });
  f.setScope(await jitoOwnerScope('bob'));
  await act(async () => {
    release(text);
  });
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.textContent).toContain('Signed-in account changed');
  });
  expect(f.calls).toEqual([]);
  expect(storage.rows.size).toBe(0);
});

it('recognizes an exact already registered file without another write', async () => {
  const f = await setup();
  f.attempt.state = 'registered';
  f.attempt.transaction = f.f.swap.signed.transaction;
  f.attempt.signature = f.f.swap.signed.signature;
  f.bundle.signatures[0] = f.f.swap.signed.signature;
  await f.click('Load bundle approvals');
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.textContent).toContain(f.f.swap.signed.signature);
  });
  await f.choose();
  await f.password();
  await vi.waitFor(() =>
    expect(f.button('Verify and retain swap 1 file').disabled).toBe(false),
  );
  await f.click('Verify and retain swap 1 file');
  await vi.waitFor(
    async () => {
      await act(async () => {});
      expect(container.textContent).toContain(
        'This exact packet is already registered',
      );
    },
    { timeout: 15000 },
  );
  expect(f.calls).toEqual([]);
  expect(storage.rows.size).toBe(0);
});

it('after a lost registration response, reloads and acknowledges the exact receipt without another POST', async () => {
  const f = await setup();
  await f.choose();
  await f.password();
  await f.click('Verify and retain swap 1 file');
  await vi.waitFor(
    async () => {
      await act(async () => {});
      expect(container.textContent).toContain(
        'Exact signed packet verified and retained',
      );
    },
    { timeout: 15000 },
  );
  f.loseNextRegistrationResponse();
  const approval = () =>
    [...container.querySelectorAll('label')]
      .find((item) =>
        item.textContent?.includes(
          'I approve registering only this exact retained packet',
        ),
      )!
      .querySelector('input')!;
  await f.password();
  await act(async () => approval().click());
  await f.click('Confirm exact registration only');
  await vi.waitFor(
    async () => {
      await act(async () => {});
      expect(container.textContent).toContain(
        'Recovery file or attempt could not be verified',
      );
    },
    { timeout: 15000 },
  );
  expect(f.calls).toEqual(['register']);
  expect(([...storage.rows.values()][0] as { state: string }).state).toBe(
    'retained',
  );
  await vi.waitFor(() =>
    expect(f.button('Load bundle approvals').disabled).toBe(false),
  );
  await f.click('Load bundle approvals');
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(f.button('Verify and retain swap 1 file').disabled).toBe(true);
  });
  await f.choose();
  await f.password();
  await vi.waitFor(() =>
    expect(f.button('Verify and retain swap 1 file').disabled).toBe(false),
  );
  await f.click('Verify and retain swap 1 file');
  await vi.waitFor(
    async () => {
      await act(async () => {});
      expect(container.textContent).toContain(
        'Exact signed packet verified and retained',
      );
    },
    { timeout: 15000 },
  );
  expect(approval().checked).toBe(false);
  await f.password();
  await act(async () => approval().click());
  await f.click('Confirm exact registration only');
  await vi.waitFor(
    async () => {
      await act(async () => {});
      expect(container.textContent).toContain('Exact registration confirmed');
    },
    { timeout: 15000 },
  );
  expect(f.calls).toEqual(['register']);
  expect(storage.rows.size).toBe(0);
});
