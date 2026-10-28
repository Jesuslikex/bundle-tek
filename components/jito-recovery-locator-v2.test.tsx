// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createJitoMemorySignatureRecovery } from '@/lib/jito-memory-signature-recovery';
import { createJitoPacketRecovery } from '@/lib/jito-packet-recovery';
import * as recoveryModule from '@/lib/jito-packet-recovery';
import {
  JITO_OWNER_SCOPE_HEADER,
  jitoOwnerScope,
} from '@/lib/jito-owner-scope';
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import * as snapshotModule from '@/lib/jito-v2-snapshot';
import { JitoRecoveryLocatorV2 } from './jito-recovery-locator-v2';

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
  const f = await jitoBundleFixture(),
    scope = await jitoOwnerScope('alice');
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
    packet: 0,
    attemptId: crypto.randomUUID(),
    signer: f.review.wallet,
    intentId: f.review.id,
    state: 'unknown',
    signature: null as string | null,
    transaction: null as string | null,
  };
  const raw = await createJitoPacketRecovery(
    f.manifest,
    0,
    f.swap.signed.transaction,
  );
  const text = JSON.stringify(raw),
    bytes = new TextEncoder().encode(text);
  let serverScope = scope,
    legacy = false,
    attempts = [attempt],
    active = true;
  let onFetch: undefined | ((count: number) => void);
  const calls: string[] = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    expect(init.method).toBeUndefined();
    expect(init.credentials).toBe('same-origin');
    expect(init.cache).toBe('no-store');
    expect((init.headers as Record<string, string>)['x-jito-protocol']).toBe(
      '2',
    );
    expect(
      (init.headers as Record<string, string>)[JITO_OWNER_SCOPE_HEADER],
    ).toBe(scope);
    calls.push(url);
    onFetch?.(calls.length);
    return Response.json(
      {
        projectId: f.manifest.projectId,
        sessionId: f.manifest.sessionId,
        bundle,
        attempts,
        legacyReadOnly: legacy,
      },
      { headers: { [JITO_OWNER_SCOPE_HEADER]: serverScope } },
    );
  });
  vi.stubGlobal('fetch', fetcher);
  const opened = vi.fn();
  const render = async (ownerId = 'alice', ownerScope = scope) =>
    act(async () =>
      root.render(
        <JitoRecoveryLocatorV2
          ownerId={ownerId}
          ownerScope={ownerScope}
          projectId={f.manifest.projectId}
          sessionId={f.manifest.sessionId}
          coordinator={createJitoMemorySignatureRecovery()}
          disabled={false}
          isContextCurrent={() => active}
          onOpen={opened}
        />,
      ),
    );
  await render();
  const choose = async (
    contents = bytes,
    mutate?: (source: Uint8Array) => void,
  ) => {
    const file = new File([contents], 'packet.json', {
      type: 'application/json',
    });
    const copy = Uint8Array.from(contents);
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => {
        mutate?.(copy);
        return copy.buffer;
      },
    });
    const input = container.querySelector(
      'input[type=file]',
    ) as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [file],
    });
    await act(async () =>
      input.dispatchEvent(new Event('change', { bubbles: true })),
    );
    return copy;
  };
  const click = async () => {
    const button = [...container.querySelectorAll('button')].find((node) =>
      node.textContent?.includes('Open original bundle'),
    );
    if (!button) throw Error('Open unavailable');
    await act(async () => button.click());
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
    bundle,
    attempt,
    raw,
    bytes,
    text,
    scope,
    calls,
    fetcher,
    opened,
    choose,
    click,
    wait,
    render,
    setScope: (value: string) => {
      serverScope = value;
    },
    setLegacy: () => {
      legacy = true;
      attempts = [];
    },
    setAttempts: (value: typeof attempts) => {
      attempts = value;
    },
    setActive: (value: boolean) => {
      active = value;
    },
    onFetch: (value: (count: number) => void) => {
      onFetch = value;
    },
  };
}

it('finds an owned bundle outside history, verifies the exact file and rechecks before explicit open', async () => {
  const f = await setup();
  await f.choose();
  await f.wait('verified signature');
  expect(f.calls).toHaveLength(2);
  expect(
    f.calls.every((url) => url.includes(`bundleId=${f.f.manifest.id}`)),
  ).toBe(true);
  expect(f.opened).not.toHaveBeenCalled();
  await f.click();
  await vi.waitFor(() => expect(f.opened).toHaveBeenCalledOnce());
  expect(f.calls).toHaveLength(4);
  expect(f.opened.mock.calls[0][0]).toMatchObject({
    locator: { bundleId: f.f.manifest.id, packet: 0 },
    snapshot: { legacyReadOnly: false },
  });
  expect(JSON.stringify(f.opened.mock.calls[0][0])).not.toContain(
    'transaction":"' + f.f.swap.signed.transaction,
  );
});

it('rejects duplicate fields, wrong project and oversized files before any lookup', async () => {
  const f = await setup();
  const duplicate = new TextEncoder().encode(
    f.text.replace('{', '{"format":"jito-signed-packet-recovery-v1",'),
  );
  await f.choose(duplicate);
  await f.wait('could not be verified');
  expect(f.calls).toHaveLength(0);
  const changed = new TextEncoder().encode(
    JSON.stringify({ ...f.raw, projectId: crypto.randomUUID() }),
  );
  await f.choose(changed);
  await f.wait('could not be verified');
  expect(f.calls).toHaveLength(0);
  await f.choose(new Uint8Array(4097));
  await f.wait('could not be verified');
  expect(f.calls).toHaveLength(0);
});

it('refuses a different authenticated owner and a forged packet without opening or sending', async () => {
  const f = await setup();
  f.setScope(await jitoOwnerScope('bob'));
  await f.choose();
  await f.wait('could not be verified');
  expect(f.opened).not.toHaveBeenCalled();
  f.setScope(f.scope);
  await f.choose(
    new TextEncoder().encode(
      JSON.stringify({ ...f.raw, transaction: f.f.tip.signed.transaction }),
    ),
  );
  await f.wait('could not be verified');
  expect(f.opened).not.toHaveBeenCalled();
});

it('keeps an owned file snapshot if the original buffer is changed during lookup', async () => {
  const f = await setup();
  let source!: Uint8Array;
  f.onFetch((count) => {
    if (count === 1) source.fill(0);
  });
  await f.choose(f.bytes, (copy) => {
    source = copy;
  });
  await f.wait('verified signature');
  expect(source.every((value) => value === 0)).toBe(true);
  await f.click();
  await vi.waitFor(() => expect(f.opened).toHaveBeenCalledOnce());
});

it('does not read an owned bundle if another tab holds the owner lock', async () => {
  const f = await setup();
  locks.add(`PulseForge/JitoRecoveryJournal/v1:${f.scope}`);
  await f.choose();
  await f.wait('could not be verified');
  expect(f.calls).toEqual([]);
  expect(f.opened).not.toHaveBeenCalled();
});

it('does not offer opening if the saved record changes between exact reads', async () => {
  const f = await setup();
  f.onFetch((count) => {
    if (count === 2) f.bundle.signatures[0] = f.f.swap.signed.signature;
  });
  await f.choose();
  await f.wait('could not be verified');
  expect(f.opened).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain('Open original bundle');
});

it('refuses a v2 bundle without the exact existing signing attempt', async () => {
  const f = await setup();
  f.setAttempts([]);
  await f.choose();
  await f.wait('could not be verified');
  expect(f.opened).not.toHaveBeenCalled();
});

it('opens a legacy bundle only with its read-only flag and no mutation', async () => {
  const f = await setup();
  f.setLegacy();
  await f.choose();
  await f.wait('legacy bundle is read-only');
  await f.click();
  await vi.waitFor(() => expect(f.opened).toHaveBeenCalledOnce());
  expect(f.opened.mock.calls[0][0].snapshot.legacyReadOnly).toBe(true);
  expect(f.fetcher.mock.calls.every(([, init]) => !init.method)).toBe(true);
});

it('opens an exact already registered packet without another registration', async () => {
  const f = await setup();
  f.attempt.state = 'registered';
  f.attempt.signature = f.f.swap.signed.signature;
  f.attempt.transaction = f.f.swap.signed.transaction;
  f.bundle.signatures[0] = f.f.swap.signed.signature;
  await f.choose();
  await f.wait('verified signature');
  await f.click();
  await vi.waitFor(() => expect(f.opened).toHaveBeenCalledOnce());
  expect(f.fetcher.mock.calls.every(([, init]) => !init.method)).toBe(true);
});

it('does not open when the saved outcome changes after lookup but before the open action', async () => {
  const f = await setup();
  await f.choose();
  await f.wait('verified signature');
  f.bundle.signatures[0] = f.f.swap.signed.signature;
  await f.click();
  await f.wait('could not be verified');
  expect(f.opened).not.toHaveBeenCalled();
});

it('does not publish a late result after account context changes', async () => {
  const f = await setup();
  let release!: (response: Response) => void, started!: () => void;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.fetcher.mockImplementationOnce(async () => {
    started();
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  await f.choose();
  await act(async () => {
    await begun;
  });
  f.setActive(false);
  await act(async () =>
    release(
      Response.json(
        {
          projectId: f.f.manifest.projectId,
          sessionId: f.f.manifest.sessionId,
          bundle: f.bundle,
          attempts: [f.attempt],
          legacyReadOnly: false,
        },
        { headers: { [JITO_OWNER_SCOPE_HEADER]: f.scope } },
      ),
    ),
  );
  expect(f.opened).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain('verified signature');
});

it.each(['initial lookup', 'explicit open'] as const)(
  'never publishes %s when its signal expires during the final async snapshot check',
  async (phase) => {
    const f = await setup();
    if (phase === 'explicit open') {
      await f.choose();
      await f.wait('verified signature');
    }
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    const original = snapshotModule.requireJitoV2Snapshot;
    let count = 0,
      start!: () => void,
      release!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(snapshotModule, 'requireJitoV2Snapshot').mockImplementation(
      async (...args) => {
        const result = await original(...args);
        if (++count === 2) {
          start();
          await blocked;
        }
        return result;
      },
    );
    if (phase === 'initial lookup') await f.choose();
    else await f.click();
    await act(async () => {
      await started;
      timeout.abort();
      release();
    });
    await f.wait('could not be verified');
    expect(f.opened).not.toHaveBeenCalled();
    if (phase === 'initial lookup')
      expect(container.textContent).not.toContain('verified signature');
  },
);

it.each(['initial lookup', 'explicit open'] as const)(
  'never publishes %s when the signal expires during final signature verification',
  async (phase) => {
    const f = await setup();
    f.attempt.state = 'registered';
    f.attempt.signature = f.f.swap.signed.signature;
    f.attempt.transaction = f.f.swap.signed.transaction;
    f.bundle.signatures[0] = f.f.swap.signed.signature;
    if (phase === 'explicit open') {
      await f.choose();
      await f.wait('verified signature');
    }
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    const original = recoveryModule.createJitoPacketRecovery;
    let count = 0,
      start!: () => void,
      release!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(recoveryModule, 'createJitoPacketRecovery').mockImplementation(
      async (...args) => {
        const result = await original(...args);
        if (++count === 2) {
          start();
          await blocked;
        }
        return result;
      },
    );
    if (phase === 'initial lookup') await f.choose();
    else await f.click();
    await act(async () => {
      await started;
      timeout.abort();
      release();
    });
    await f.wait('could not be verified');
    expect(f.opened).not.toHaveBeenCalled();
    if (phase === 'initial lookup')
      expect(container.textContent).not.toContain('verified signature');
  },
);
