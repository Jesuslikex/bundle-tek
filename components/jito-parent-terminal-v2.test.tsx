// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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

const auth = vi.hoisted(() => ({ owner: 'alice' }));
vi.mock('better-auth/react', () => ({
  createAuthClient: () => ({
    useSession: () => ({
      data: { user: { id: auth.owner } },
      isPending: false,
    }),
  }),
}));
vi.mock('./jito-packet-signing', () => ({ JitoPacketSigning: () => null }));
let root: Root, container: HTMLDivElement;
const locks = new Set<string>();
const createObjectURL = vi.fn(() => 'blob:synthetic');
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  auth.owner = 'alice';
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
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: createObjectURL,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  locks.clear();
  createObjectURL.mockClear();
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

async function setup(state: 'cancelled' | 'expired' | 'finalized') {
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
    state,
    bundleId: null,
    signatures:
      state === 'finalized'
        ? [f.swap.signed.signature, f.tip.signed.signature]
        : [null, null],
    updatedAt: f.manifest.createdAt,
    finalization: null,
  };
  const calls: string[] = [];
  let serverScope = scope;
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method) {
      calls.push(init.method);
      throw Error('Unexpected mutation');
    }
    calls.push('GET');
    const body = String(url).includes('bundleId=')
      ? {
          projectId: session.terms.projectId,
          sessionId: session.id,
          bundle,
          attempts: [],
          legacyReadOnly: true,
        }
      : {
          projectId: session.terms.projectId,
          sessionId: session.id,
          bundles: [bundle],
          eligible: [],
        };
    return Response.json(body, {
      headers: { [JITO_OWNER_SCOPE_HEADER]: serverScope },
    });
  });
  vi.stubGlobal('fetch', fetcher);
  const swapSigner = vi.spyOn(warmup, 'signApprovedWarmupPacket');
  const tipSigner = vi.spyOn(nativeWithdrawal, 'signNativeWithdrawal');
  const render = async (chosenSession = session) =>
    act(async () =>
      root.render(
        <JitoAtomicBundle
          projectId={f.manifest.projectId}
          session={chosenSession}
          locked={false}
        />,
      ),
    );
  await render();
  const button = (name: string) =>
    [...container.querySelectorAll('button')].find((item) =>
      item.textContent?.includes(name),
    )!;
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(button('Load bundle approvals')?.disabled).toBe(false);
  });
  await act(async () => button('Load bundle approvals').click());
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.textContent).toContain('This older bundle is read-only');
  });
  const fileText = JSON.stringify(
    await createJitoPacketRecovery(f.manifest, 0, f.swap.signed.transaction),
  );
  const choose = async (source?: () => Promise<ArrayBuffer>) => {
    const label = [...container.querySelectorAll('label')].find((el) =>
      el.textContent?.includes('Verify saved recovery file for packet 1'),
    )!;
    const input = document.getElementById(label.htmlFor) as HTMLInputElement;
    expect(input.disabled).toBe(false);
    const bytes = new TextEncoder().encode(fileText);
    const file = new File([bytes], 'packet.json', { type: 'application/json' });
    Object.defineProperty(file, 'arrayBuffer', {
      value: source ?? (async () => bytes.buffer),
    });
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [file],
    });
    await act(async () =>
      input.dispatchEvent(new Event('change', { bubbles: true })),
    );
  };
  const wait = async (phrase: string) =>
    vi.waitFor(
      async () => {
        await act(async () => {});
        expect(container.textContent).toContain(phrase);
      },
      { timeout: 15000 },
    );
  return {
    f,
    session,
    calls,
    fetcher,
    swapSigner,
    tipSigner,
    button,
    choose,
    wait,
    render,
    setScope: (next: string) => {
      serverScope = next;
    },
  };
}

it.each(['cancelled', 'expired', 'finalized'] as const)(
  'inspects and explicitly exports %s evidence through the real parent with no mutation',
  async (state) => {
    const f = await setup(state);
    await f.choose();
    await f.wait('Exact signed packet verified');
    if (state === 'finalized')
      expect(container.textContent).toContain(
        'historical finalization receipt was not retained',
      );
    expect(createObjectURL).not.toHaveBeenCalled();
    await act(async () =>
      f.button('Download verified packet privately').click(),
    );
    await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
    expect(f.calls.every((value) => value === 'GET')).toBe(true);
    expect(f.swapSigner).not.toHaveBeenCalled();
    expect(f.tipSigner).not.toHaveBeenCalled();
  },
);

it('refuses a changed owner on the terminal exact read without publishing or sending', async () => {
  const f = await setup('cancelled');
  f.setScope(await jitoOwnerScope('bob'));
  await f.choose();
  await f.wait('could not be verified');
  expect(container.textContent).not.toContain('Exact signed packet verified');
  expect(createObjectURL).not.toHaveBeenCalled();
  expect(f.calls.every((value) => value === 'GET')).toBe(true);
  expect(f.swapSigner).not.toHaveBeenCalled();
  expect(f.tipSigner).not.toHaveBeenCalled();
});

it('discards the old terminal file when the parent session changes during file read', async () => {
  const f = await setup('expired');
  let release!: (value: ArrayBuffer) => void, started!: () => void;
  const blocked = new Promise<ArrayBuffer>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  await f.choose(() => {
    started();
    return blocked;
  });
  await act(async () => {
    await began;
  });
  await f.render({ ...f.session, id: `${f.session.id}-other` });
  await act(async () => release(new TextEncoder().encode('not used').buffer));
  expect(container.textContent).not.toContain('Exact signed packet verified');
  expect(createObjectURL).not.toHaveBeenCalled();
  expect(f.calls.every((value) => value === 'GET')).toBe(true);
  expect(f.swapSigner).not.toHaveBeenCalled();
  expect(f.tipSigner).not.toHaveBeenCalled();
});
it('discards the old terminal file when the signed-in owner changes during the file read', async () => {
  const f = await setup('cancelled');
  let release!: (value: ArrayBuffer) => void, started!: () => void;
  const blocked = new Promise<ArrayBuffer>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  await f.choose(() => {
    started();
    return blocked;
  });
  await act(async () => {
    await began;
  });
  auth.owner = 'bob';
  await f.render();
  await act(async () => release(new TextEncoder().encode('not used').buffer));
  expect(container.textContent).not.toContain('Exact signed packet verified');
  expect(createObjectURL).not.toHaveBeenCalled();
  expect(f.calls.every((value) => value === 'GET')).toBe(true);
  expect(f.swapSigner).not.toHaveBeenCalled();
  expect(f.tipSigner).not.toHaveBeenCalled();
});

it('describes legacy expiry without asserting an unretained RPC observation', async () => {
  await setup('expired');
  expect(container.textContent).toContain(
    'This bundle was recorded as expired.',
  );
  expect(container.textContent).toContain(
    'does not establish whether a signed packet landed',
  );
  expect(container.textContent).not.toContain(
    'no outcome found by the configured RPC',
  );
});
