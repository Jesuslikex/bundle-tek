// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as vault from '@/lib/browser-wallet-vault';
import * as snapshotModule from '@/lib/jito-v2-snapshot';
import { bundleFingerprint, type JitoBundleRecord } from '@/lib/jito-bundle';
import {
  JITO_OWNER_SCOPE_HEADER,
  jitoOwnerScope,
} from '@/lib/jito-owner-scope';
import { createJitoPacketRecovery } from '@/lib/jito-packet-recovery';
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import { JitoAtomicBundle } from './jito-atomic-bundle';
import type { TradeSession } from '@/lib/imported-trade-session';

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

async function setup(legacy = false) {
  const f = await jitoBundleFixture(),
    scope = await jitoOwnerScope('alice');
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
  const older: JitoBundleRecord = {
    manifest: f.manifest,
    state: 'reviewed',
    bundleId: null,
    signatures: [null, null],
    updatedAt: f.manifest.createdAt,
    finalization: null,
  };
  const history: JitoBundleRecord[] = [];
  for (let i = 0; i < 20; i++) {
    const { sha256: _old, ...terms } = structuredClone(f.manifest);
    terms.id = crypto.randomUUID();
    history.push({
      ...older,
      manifest: { ...terms, sha256: await bundleFingerprint(terms) },
      signatures: [null, null],
    });
  }
  const attempt = {
    bundleId: f.manifest.id,
    manifestSha256: f.manifest.sha256,
    packet: 0,
    attemptId: crypto.randomUUID(),
    signer: f.review.wallet,
    intentId: f.review.id,
    state: 'unknown',
    transaction: null as string | null,
    signature: null as string | null,
  };
  const actions: string[] = [],
    exactRequests: string[] = [];
  let serverScope = scope,
    olderReads = 0,
    wrongScopeAfter = Infinity;
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'POST') {
      const body = JSON.parse(init.body as string);
      actions.push(body.action);
      if (
        body.action !== 'register' ||
        body.id !== older.manifest.id ||
        body.packet !== 0 ||
        body.attemptId !== attempt.attemptId ||
        body.approved !== true ||
        body.transaction !== f.swap.signed.transaction
      )
        throw Error('unexpected mutation');
      attempt.state = 'registered';
      attempt.signature = f.swap.signed.signature;
      attempt.transaction = body.transaction;
      older.signatures[0] = attempt.signature;
      return Response.json(
        { bundle: older },
        { headers: { [JITO_OWNER_SCOPE_HEADER]: serverScope } },
      );
    }
    const id = new URL(url, 'http://localhost').searchParams.get('bundleId');
    if (!id)
      return Response.json(
        {
          projectId: session.terms.projectId,
          sessionId: session.id,
          bundles: history,
          eligible: [],
        },
        { headers: { [JITO_OWNER_SCOPE_HEADER]: serverScope } },
      );
    exactRequests.push(id);
    const record =
      id === older.manifest.id
        ? older
        : history.find((item) => item.manifest.id === id);
    if (!record)
      return Response.json(
        { error: 'unavailable' },
        { status: 404, headers: { [JITO_OWNER_SCOPE_HEADER]: serverScope } },
      );
    if (id === older.manifest.id && ++olderReads >= wrongScopeAfter)
      serverScope = await jitoOwnerScope('bob');
    return Response.json(
      {
        projectId: session.terms.projectId,
        sessionId: session.id,
        bundle: record,
        attempts: id === older.manifest.id && !legacy ? [attempt] : [],
        legacyReadOnly: id === older.manifest.id && legacy,
      },
      { headers: { [JITO_OWNER_SCOPE_HEADER]: serverScope } },
    );
  });
  vi.stubGlobal('fetch', fetcher);
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
    const found = [...container.querySelectorAll('button')].find((node) =>
      node.textContent?.includes(name),
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
    expect(container.querySelectorAll('article').length).toBe(20);
    expect(button('Load bundle approvals').disabled).toBe(false);
  });
  const text = JSON.stringify(
    await createJitoPacketRecovery(f.manifest, 0, f.swap.signed.transaction),
  );
  const file = () => {
    const result = new File([text], 'old-packet.json', {
      type: 'application/json',
    });
    Object.defineProperty(result, 'arrayBuffer', {
      value: async () => new TextEncoder().encode(text).buffer,
    });
    Object.defineProperty(result, 'text', { value: async () => text });
    return result;
  };
  const choose = async (input: HTMLInputElement) => {
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [file()],
    });
    await act(async () =>
      input.dispatchEvent(new Event('change', { bubbles: true })),
    );
  };
  const locatorInput = () =>
    container.querySelector(
      'section[aria-label="Find an older Jito bundle"] input[type=file]',
    ) as HTMLInputElement;
  const locate = async () => {
    await choose(locatorInput());
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(button('Open original bundle').disabled).toBe(false);
    });
  };
  const open = async () => {
    await locate();
    await click('Open original bundle');
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(container.textContent).toContain(
        'Older bundle opened from a recovery file',
      );
    });
  };
  return {
    f,
    scope,
    session,
    older,
    history,
    attempt,
    actions,
    exactRequests,
    fetcher,
    button,
    click,
    choose,
    locatorInput,
    locate,
    open,
    setWrongScopeAfter: (count: number) => {
      wrongScopeAfter = count;
    },
  };
}

it('opens a 21st bundle separately without evicting the 20 recent records or signing', async () => {
  const f = await setup();
  await f.open();
  expect(container.querySelectorAll('article').length).toBe(21);
  for (const item of f.history)
    expect(container.textContent).toContain(item.manifest.id);
  expect(container.textContent).toContain(f.older.manifest.id);
  const link = [...container.querySelectorAll('a')].find((item) =>
    item.textContent?.includes('Go to opened bundle'),
  );
  expect(link?.getAttribute('href')).toBe(
    `#jito-bundle-${f.older.manifest.id}`,
  );
  const target = document.getElementById(`jito-bundle-${f.older.manifest.id}`);
  expect(target?.tagName).toBe('ARTICLE');
  expect(target?.getAttribute('tabindex')).toBe('-1');
  expect(f.actions).toEqual([]);
  expect(
    f.exactRequests.filter((id) => id === f.older.manifest.id).length,
  ).toBeGreaterThanOrEqual(4);
});

it('opens the older packet panel and requires separate consent before exact evidence registration', async () => {
  const f = await setup();
  await f.open();
  const article = [...container.querySelectorAll('article')].find((node) =>
    node.textContent?.includes(f.older.manifest.id),
  )!;
  const labels = [...article.querySelectorAll('label')];
  const fileLabel = labels.find(
    (node) => node.textContent === 'Signed packet recovery file',
  )!;
  await vi.waitFor(async () => {
    await act(async () => {});
    const input = document.getElementById(
      fileLabel.htmlFor,
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.disabled).toBe(false);
  });
  await f.choose(
    document.getElementById(fileLabel.htmlFor) as HTMLInputElement,
  );
  const setPassword = async () => {
    const label = [...article.querySelectorAll('label')].find(
      (node) => node.textContent === 'Vault password for recovery',
    )!;
    const input = document.getElementById(label.htmlFor) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, 'synthetic-password');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  await setPassword();
  const find = (text: string) =>
    [...article.querySelectorAll('button')].find((node) =>
      node.textContent?.includes(text),
    )!;
  await vi.waitFor(() =>
    expect(find('Verify and retain swap 1 file').disabled).toBe(false),
  );
  await act(async () => find('Verify and retain swap 1 file').click());
  await vi.waitFor(
    async () => {
      await act(async () => {});
      expect(article.textContent).toContain(
        'Exact signed packet verified and retained',
      );
    },
    { timeout: 15000 },
  );
  expect(f.actions).toEqual([]);
  const approval = [...article.querySelectorAll('label')]
    .find((node) =>
      node.textContent?.includes(
        'I approve registering only this exact retained packet',
      ),
    )!
    .querySelector('input')!;
  expect(approval.checked).toBe(false);
  await setPassword();
  await act(async () => approval.click());
  await act(async () => find('Confirm exact registration only').click());
  await vi.waitFor(
    async () => {
      await act(async () => {});
      expect(article.textContent).toContain('Exact registration confirmed');
    },
    { timeout: 15000 },
  );
  expect(f.actions).toEqual(['register']);
  expect(storage.rows.size).toBe(0);
  expect(container.querySelectorAll('article').length).toBe(21);
  for (const item of f.history)
    expect(container.textContent).toContain(item.manifest.id);
});

it('does not open a record when the authenticated owner changes during locator reads', async () => {
  const f = await setup();
  f.setWrongScopeAfter(2);
  await f.choose(f.locatorInput());
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.textContent).toContain(
      'Recovery file or owned bundle could not be verified',
    );
  });
  expect(container.textContent).not.toContain(
    'Older bundle opened from a recovery file',
  );
  expect(f.actions).toEqual([]);
});

it('discards a pending locator result when the parent session revision changes', async () => {
  const f = await setup();
  let release!: (value: Response) => void, started!: () => void;
  let oldSignal!: AbortSignal;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.fetcher.mockImplementationOnce(async (_url, init) => {
    oldSignal = init.signal as AbortSignal;
    started();
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  await f.choose(f.locatorInput());
  await act(async () => {
    await began;
  });
  await act(async () =>
    root.render(
      <JitoAtomicBundle
        projectId={f.f.manifest.projectId}
        session={{ ...f.session, revision: f.session.revision + 1 }}
        locked={false}
      />,
    ),
  );
  expect(oldSignal.aborted).toBe(true);
  await act(async () =>
    release(
      Response.json(
        {
          projectId: f.f.manifest.projectId,
          sessionId: f.session.id,
          bundle: f.older,
          attempts: [f.attempt],
          legacyReadOnly: false,
        },
        { headers: { [JITO_OWNER_SCOPE_HEADER]: f.scope } },
      ),
    ),
  );
  expect(container.textContent).not.toContain(
    'Older bundle opened from a recovery file',
  );
  expect(container.textContent).not.toContain(f.older.manifest.id);
  expect(container.textContent).not.toContain(f.f.swap.signed.signature);
  expect(f.actions).toEqual([]);
});

it('opens a legacy older bundle read-only and disables its file evidence actions', async () => {
  const f = await setup(true);
  await f.open();
  const article = [...container.querySelectorAll('article')].find((node) =>
    node.textContent?.includes(f.older.manifest.id),
  )!;
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(article.textContent).toContain('This older bundle is read-only');
  });
  const label = [...article.querySelectorAll('label')].find(
    (node) => node.textContent === 'Signed packet recovery file',
  )!;
  expect(
    (document.getElementById(label.htmlFor) as HTMLInputElement).disabled,
  ).toBe(true);
  expect(f.actions).toEqual([]);
});

it('does not open an older bundle when locator validation exceeds its deadline', async () => {
  const f = await setup(),
    timeout = new AbortController(),
    originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) =>
    ms === 15000 ? timeout.signal : originalTimeout(ms),
  );
  const original = snapshotModule.requireJitoV2Snapshot;
  let count = 0,
    started!: () => void,
    release!: () => void;
  const ready = new Promise<void>((resolve) => {
      started = resolve;
    }),
    blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
  vi.spyOn(snapshotModule, 'requireJitoV2Snapshot').mockImplementation(
    async (...args) => {
      const result = await original(...args);
      if (++count === 2) {
        started();
        await blocked;
      }
      return result;
    },
  );
  await f.choose(f.locatorInput());
  await act(async () => {
    await ready;
    timeout.abort();
    release();
  });
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.textContent).toContain(
      'Recovery file or owned bundle could not be verified',
    );
  });
  expect(container.textContent).not.toContain(
    'Older bundle opened from a recovery file',
  );
  expect(f.actions).toEqual([]);
});
