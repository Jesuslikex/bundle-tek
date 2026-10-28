// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as snapshotModule from '@/lib/jito-v2-snapshot';
import * as warmup from '@/lib/warmup-signing';
import * as nativeWithdrawal from '@/lib/native-withdrawal';
import { createJitoMemorySignatureRecovery } from '@/lib/jito-memory-signature-recovery';
import {
  JITO_OWNER_SCOPE_HEADER,
  jitoOwnerScope,
} from '@/lib/jito-owner-scope';
import { createJitoPacketRecovery } from '@/lib/jito-packet-recovery';
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import { JitoTerminalRecoveryV2 } from './jito-terminal-recovery-v2';

let root: Root, container: HTMLDivElement;
const locks = new Set<string>();
const createObjectURL = vi.fn(() => 'blob:synthetic');
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

async function setup(
  state: 'cancelled' | 'expired' | 'finalized' = 'cancelled',
  packet = 0,
  legacy = true,
) {
  const f = await jitoBundleFixture(),
    ownerScope = await jitoOwnerScope('alice');
  const signatures =
    state === 'finalized'
      ? [f.swap.signed.signature, f.tip.signed.signature]
      : [null, null];
  const bundle = {
    manifest: f.manifest,
    state,
    bundleId: null,
    signatures: signatures as (string | null)[],
    updatedAt: f.manifest.createdAt,
    finalization: null,
  };
  const signed = packet === 0 ? f.swap.signed : f.tip.signed;
  if (!legacy) bundle.signatures[packet] = signed.signature;
  const attempts = legacy
    ? []
    : [
        {
          bundleId: f.manifest.id,
          manifestSha256: f.manifest.sha256,
          packet,
          attemptId: crypto.randomUUID(),
          signer: f.manifest.swaps[packet]?.wallet ?? f.manifest.tip.wallet,
          intentId: f.manifest.swaps[packet]?.id ?? null,
          state: 'registered',
          signature: signed.signature,
          transaction: signed.transaction,
        },
      ];
  const fileText = JSON.stringify(
    await createJitoPacketRecovery(f.manifest, packet, signed.transaction),
  );
  let scope = ownerScope,
    active = true,
    onFetch: undefined | ((count: number) => void);
  const calls: string[] = [],
    writes: string[] = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method) {
      writes.push(init.method);
      throw Error('unexpected write');
    }
    expect(init.credentials).toBe('same-origin');
    expect(init.cache).toBe('no-store');
    expect(
      (init.headers as Record<string, string>)[JITO_OWNER_SCOPE_HEADER],
    ).toBe(ownerScope);
    expect((init.headers as Record<string, string>)['x-jito-protocol']).toBe(
      '2',
    );
    calls.push(url);
    onFetch?.(calls.length);
    return Response.json(
      {
        projectId: f.manifest.projectId,
        sessionId: f.manifest.sessionId,
        bundle,
        legacyReadOnly: legacy,
        attempts,
      },
      { headers: { [JITO_OWNER_SCOPE_HEADER]: scope } },
    );
  });
  vi.stubGlobal('fetch', fetcher);
  const swapSigner = vi.spyOn(warmup, 'signApprovedWarmupPacket');
  const tipSigner = vi.spyOn(nativeWithdrawal, 'signNativeWithdrawal');
  const coordinator = createJitoMemorySignatureRecovery();
  const render = async (disabled = false) =>
    act(async () =>
      root.render(
        <JitoTerminalRecoveryV2
          ownerId="alice"
          ownerScope={ownerScope}
          manifest={f.manifest}
          packet={packet}
          state={state}
          coordinator={coordinator}
          disabled={disabled}
          isContextCurrent={() => active}
        />,
      ),
    );
  await render();
  const button = (text: string) =>
    [...container.querySelectorAll('button')].find((node) =>
      node.textContent?.includes(text),
    );
  const choose = async (
    text = fileText,
    source?: () => Promise<ArrayBuffer>,
  ) => {
    const contents = new TextEncoder().encode(text),
      file = new File([contents], 'packet.json', { type: 'application/json' });
    Object.defineProperty(file, 'arrayBuffer', {
      value: source ?? (async () => contents.buffer),
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
  };
  const wait = async (phrase: string) =>
    vi.waitFor(
      async () => {
        await act(async () => {});
        expect(container.textContent).toContain(phrase);
      },
      { timeout: 15000 },
    );
  const download = async () => {
    const value = button('Download verified packet privately');
    if (!value) throw Error('No download button');
    await act(async () => value.click());
  };
  return {
    f,
    ownerScope,
    bundle,
    signed,
    fileText,
    fetcher,
    calls,
    writes,
    swapSigner,
    tipSigner,
    coordinator,
    render,
    button,
    choose,
    wait,
    download,
    setScope: (value: string) => {
      scope = value;
    },
    setActive: (value: boolean) => {
      active = value;
    },
    onFetch: (value: (count: number) => void) => {
      onFetch = value;
    },
  };
}

it.each(['cancelled', 'expired', 'finalized'] as const)(
  'inspects %s history and exports only after a fresh explicit action',
  async (state) => {
    const f = await setup(state);
    await f.choose();
    await f.wait('Exact signed packet verified');
    expect(f.calls).toHaveLength(2);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(container.textContent).toContain('legacy bundle is read-only');
    if (state === 'finalized')
      expect(container.textContent).toContain(
        'historical finalization receipt was not retained',
      );
    else
      expect(container.textContent).toContain('signature is not recorded here');
    await f.download();
    await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
    expect(f.calls).toHaveLength(4);
    expect(f.writes).toEqual([]);
    expect(f.swapSigner).not.toHaveBeenCalled();
    expect(f.tipSigner).not.toHaveBeenCalled();
  },
);
it('verifies and exports the exact tip packet', async () => {
  const f = await setup('finalized', 1);
  await f.choose();
  await f.wait('Exact signed packet verified');
  expect(container.textContent).toContain('signature matches the saved record');
  await f.download();
  await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
  expect(f.writes).toEqual([]);
});
it('inspects and exports a v2 terminal packet only when its stored receipt matches', async () => {
  const f = await setup('expired', 0, false);
  await f.choose();
  await f.wait('Exact signed packet verified');
  expect(container.textContent).toContain('signature matches the saved record');
  expect(container.textContent).not.toContain('legacy bundle is read-only');
  await f.download();
  await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
  expect(f.writes).toEqual([]);
  expect(f.swapSigner).not.toHaveBeenCalled();
  expect(f.tipSigner).not.toHaveBeenCalled();
});
it('rejects duplicate keys, wrong packet and an oversized file before an owner read', async () => {
  const f = await setup();
  await f.choose(
    f.fileText.replace('{', '{"format":"jito-signed-packet-recovery-v1",'),
  );
  await f.wait('could not be verified');
  const tip = JSON.stringify(
    await createJitoPacketRecovery(f.f.manifest, 1, f.f.tip.signed.transaction),
  );
  await f.choose(tip);
  await f.wait('could not be verified');
  await f.choose('x'.repeat(4097));
  await f.wait('could not be verified');
  expect(f.calls).toEqual([]);
  expect(f.writes).toEqual([]);
});
it('refuses changed owner or changed terminal state before publishing', async () => {
  const f = await setup();
  f.setScope(await jitoOwnerScope('bob'));
  await f.choose();
  await f.wait('could not be verified');
  expect(container.textContent).not.toContain('Exact signed packet verified');
  f.setScope(f.ownerScope);
  f.onFetch(() => {
    f.bundle.state = 'expired';
  });
  await f.choose();
  await f.wait('could not be verified');
  expect(createObjectURL).not.toHaveBeenCalled();
});
it('refuses a terminal state that changes between the two exact reads', async () => {
  const f = await setup();
  f.onFetch((count) => {
    if (count === 2) f.bundle.state = 'expired';
  });
  await f.choose();
  await f.wait('could not be verified');
  expect(f.button('Download verified packet privately')).toBeUndefined();
  expect(f.writes).toEqual([]);
});
it('refuses a different saved signature and never offers export', async () => {
  const f = await setup('finalized');
  f.bundle.signatures[0] = f.f.tip.signed.signature;
  await f.choose();
  await f.wait('could not be verified');
  expect(f.button('Download verified packet privately')).toBeUndefined();
});
it('checks the terminal record again before export and blocks on an owner change', async () => {
  const f = await setup();
  await f.choose();
  await f.wait('Exact signed packet verified');
  f.setScope(await jitoOwnerScope('bob'));
  await f.download();
  await f.wait('could not be verified');
  expect(createObjectURL).not.toHaveBeenCalled();
  expect(f.writes).toEqual([]);
});
it('holds the owner lock through the user-triggered download click', async () => {
  const f = await setup();
  await f.choose();
  await f.wait('Exact signed packet verified');
  let denied: boolean | null = null;
  createObjectURL.mockImplementationOnce(() => {
    void navigator.locks.request(
      `PulseForge/JitoRecoveryJournal/v1:${f.ownerScope}`,
      { ifAvailable: true },
      async (held) => {
        denied = held === null;
      },
    );
    return 'blob:synthetic';
  });
  await f.download();
  await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
  expect(denied).toBe(true);
  expect(f.writes).toEqual([]);
});
it('does not inspect when another tab holds the owner lock', async () => {
  const f = await setup();
  locks.add(`PulseForge/JitoRecoveryJournal/v1:${f.ownerScope}`);
  await f.choose();
  await f.wait('could not be verified');
  expect(f.calls).toEqual([]);
});
it('does not inspect while another local Jito operation is active', async () => {
  const f = await setup();
  const operation = f.coordinator.startOperation(f.ownerScope);
  try {
    await f.choose();
    await f.wait('another Jito action is pending');
    expect(f.calls).toEqual([]);
    expect(f.writes).toEqual([]);
  } finally {
    f.coordinator.finishOperation(operation);
  }
});
it('does not publish a late file read after its context changes', async () => {
  const f = await setup();
  let release!: (value: ArrayBuffer) => void, started!: () => void;
  const waiting = new Promise<ArrayBuffer>((resolve) => {
      release = resolve;
    }),
    began = new Promise<void>((resolve) => {
      started = resolve;
    });
  await f.choose(f.fileText, () => {
    started();
    return waiting;
  });
  await act(async () => {
    await began;
  });
  f.setActive(false);
  await act(async () => release(new TextEncoder().encode(f.fileText).buffer));
  expect(container.textContent).not.toContain('Exact signed packet verified');
  expect(f.writes).toEqual([]);
});
it('does not export if its deadline expires during the last async snapshot check', async () => {
  const f = await setup();
  await f.choose();
  await f.wait('Exact signed packet verified');
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  const original = snapshotModule.requireJitoV2Snapshot;
  let count = 0,
    started!: () => void,
    release!: () => void;
  const began = new Promise<void>((resolve) => {
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
  await f.download();
  await act(async () => {
    await began;
    deadline.abort();
    release();
  });
  await f.wait('could not be verified');
  expect(createObjectURL).not.toHaveBeenCalled();
  expect(f.writes).toEqual([]);
});
it('does not publish inspection if its deadline expires during the last snapshot check', async () => {
  const f = await setup(),
    deadline = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  const original = snapshotModule.requireJitoV2Snapshot;
  let count = 0,
    started!: () => void,
    release!: () => void;
  const began = new Promise<void>((resolve) => {
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
  await f.choose();
  await act(async () => {
    await began;
    deadline.abort();
    release();
  });
  await f.wait('could not be verified');
  expect(container.textContent).not.toContain('Exact signed packet verified');
  expect(createObjectURL).not.toHaveBeenCalled();
});

it('refuses an in-place manifest mutation while inspection is pending', async () => {
  const f = await setup();
  let release!: (value: ArrayBuffer) => void, started!: () => void;
  const blocked = new Promise<ArrayBuffer>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  await f.choose(f.fileText, () => {
    started();
    return blocked;
  });
  await act(async () => {
    await began;
  });
  f.f.manifest.id = 'mutated-bundle';
  await act(async () => release(new TextEncoder().encode(f.fileText).buffer));
  await f.wait('could not be verified');
  expect(f.calls).toEqual([]);
  expect(f.writes).toEqual([]);
  expect(createObjectURL).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain('Exact signed packet verified');
});

it('ignores a stale file-change event during export without clearing verified evidence', async () => {
  const f = await setup();
  await f.choose();
  await f.wait('Exact signed packet verified');
  const original = snapshotModule.requireJitoV2Snapshot;
  let started!: () => void, release!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  vi.spyOn(snapshotModule, 'requireJitoV2Snapshot').mockImplementation(
    async (...args) => {
      const snapshot = await original(...args);
      if (++calls === 1) {
        started();
        await blocked;
      }
      return snapshot;
    },
  );
  await f.download();
  await act(async () => {
    await began;
  });
  await f.choose('stale event should not replace evidence');
  expect(container.textContent).toContain('Exact signed packet verified');
  await act(async () => {
    release();
  });
  await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
  expect(container.textContent).toContain('Exact signed packet verified');
  expect(f.calls).toHaveLength(4);
  expect(f.writes).toEqual([]);
  expect(f.swapSigner).not.toHaveBeenCalled();
  expect(f.tipSigner).not.toHaveBeenCalled();
});

function capturedDownload() {
  const button = [...container.querySelectorAll('button')].find((node) =>
    node.textContent?.includes('Download verified packet privately'),
  )!;
  const key = Object.getOwnPropertyNames(button).find((name) =>
    name.startsWith('__reactProps$'),
  )!;
  return (
    button as unknown as Record<string, { onClick: (event: unknown) => void }>
  )[key].onClick;
}
it('rejects a stale export click after the live parent disables recovery', async () => {
  const f = await setup();
  await f.choose();
  await f.wait('Exact signed packet verified');
  const stale = capturedDownload();
  const reads = f.calls.length;
  await f.render(true);
  await act(async () => stale({}));
  expect(f.calls).toHaveLength(reads);
  expect(createObjectURL).not.toHaveBeenCalled();
  expect(f.writes).toEqual([]);
});
it('rejects a stale export click while a replacement file is being read', async () => {
  const f = await setup();
  await f.choose();
  await f.wait('Exact signed packet verified');
  const stale = capturedDownload();
  let release!: (value: ArrayBuffer) => void, started!: () => void;
  const blocked = new Promise<ArrayBuffer>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  await f.choose(f.fileText, () => {
    started();
    return blocked;
  });
  await act(async () => {
    await began;
  });
  const reads = f.calls.length;
  await act(async () => stale({}));
  expect(f.calls).toHaveLength(reads);
  expect(createObjectURL).not.toHaveBeenCalled();
  await act(async () => release(new TextEncoder().encode(f.fileText).buffer));
  await f.wait('Exact signed packet verified');
  expect(f.writes).toEqual([]);
});
it('rejects a stale export click after a replacement file clears the verified view', async () => {
  const f = await setup();
  await f.choose();
  await f.wait('Exact signed packet verified');
  const stale = capturedDownload();
  await f.choose('invalid replacement');
  await f.wait('could not be verified');
  const reads = f.calls.length;
  await act(async () => stale({}));
  expect(f.calls).toHaveLength(reads);
  expect(createObjectURL).not.toHaveBeenCalled();
  expect(f.writes).toEqual([]);
});
it('rejects a stale export click after a replacement has been independently verified', async () => {
  const f = await setup();
  await f.choose();
  await f.wait('Exact signed packet verified');
  const stale = capturedDownload();
  await f.choose();
  await f.wait('Exact signed packet verified');
  const reads = f.calls.length;
  await act(async () => stale({}));
  expect(f.calls).toHaveLength(reads);
  expect(createObjectURL).not.toHaveBeenCalled();
  expect(f.writes).toEqual([]);
  await f.download();
  await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
});
it('rejects an old file-change handler after a newer file has been verified', async () => {
  const f = await setup();
  const input = container.querySelector('input[type=file]') as HTMLInputElement;
  const key = Object.getOwnPropertyNames(input).find((name) =>
    name.startsWith('__reactProps$'),
  )!;
  const stale = (
    input as unknown as Record<string, { onChange: (event: unknown) => void }>
  )[key].onChange;
  await f.choose();
  await f.wait('Exact signed packet verified');
  const reads = f.calls.length;
  await act(async () =>
    stale({
      target: { files: [new File(['replacement'], 'old.json')], value: 'old' },
    }),
  );
  expect(container.textContent).toContain('Exact signed packet verified');
  expect(f.calls).toHaveLength(reads);
  expect(f.writes).toEqual([]);
  await f.download();
  await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
});
