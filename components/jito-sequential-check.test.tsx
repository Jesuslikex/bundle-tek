// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JitoSequentialCheck } from './jito-sequential-check';
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import {
  JITO_SEQUENTIAL_CHECK_AUTHORITY,
  type JitoSequentialCheckResult,
} from '@/lib/jito-sequential-check-result';
import type { JitoBundleManifest } from '@/lib/jito-bundle';
let root: Root | null, container: HTMLDivElement;
const fetcher = vi.fn();
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', fetcher);
  fetcher.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const button = () => container.querySelector('button')!;
async function render(manifest: JitoBundleManifest, disabled = false) {
  await act(async () => {
    root!.render(
      <JitoSequentialCheck manifest={manifest} disabled={disabled} />,
    );
  });
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200 && !predicate(); i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  expect(predicate()).toBe(true);
}
function dto(
  manifest: JitoBundleManifest,
  observed = false,
): JitoSequentialCheckResult {
  const slot = manifest.tip.slot;
  return {
    format: 'jito-sequential-check-v1',
    bundleId: manifest.id,
    manifestSha256: manifest.sha256,
    expiresAt: manifest.expiresAt,
    observedAt: new Date().toISOString(),
    status: observed ? 'frames-observed' : 'refused',
    reason: observed ? 'frame-integrity-only' : 'bank-unavailable',
    packetCount: manifest.swaps.length + 1,
    minimumSlot: slot,
    simulationSlot: slot,
    fees: [
      ...manifest.swaps.map((s) => s.maximumFeeLamports),
      manifest.tip.feeLamports,
    ].map((feeLamports, packet) => ({ packet, feeLamports, slot })),
    ...JITO_SEQUENTIAL_CHECK_AUTHORITY,
  };
}
it('performs no automatic read and explains unsigned-only availability', async () => {
  const { manifest } = await jitoBundleFixture();
  await render(manifest);
  expect(fetcher).not.toHaveBeenCalled();
  expect(button().disabled).toBe(false);
  expect(container.textContent).toContain(
    'This check is optional. Sign and Submit do not depend on this check;',
  );
  expect(container.textContent).toContain(
    'each still requires its own checks and approval.',
  );
  expect(container.textContent).toContain(
    'does not establish provider readiness or complete bundle economic and runtime qualification.',
  );
  await render(manifest, true);
  expect(button().disabled).toBe(true);
  expect(container.textContent).toContain(
    'requires a current, unsigned bundle',
  );
  expect(fetcher).not.toHaveBeenCalled();
});
it('sends only the explicit saved identity and renders an exact-bank refusal without wallet access', async () => {
  const { manifest } = await jitoBundleFixture();
  const storage = vi.spyOn(Storage.prototype, 'getItem');
  fetcher.mockResolvedValue(Response.json({ sequentialCheck: dto(manifest) }));
  await render(manifest);
  act(() => button().click());
  await until(() => Boolean(container.querySelector('output')));
  expect(fetcher).toHaveBeenCalledOnce();
  const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
  expect(url).toBe('/api/imported-projects/jito-bundles');
  expect(JSON.parse(init.body as string)).toEqual({
    action: 'check-sequential',
    id: manifest.id,
    sha256: manifest.sha256,
  });
  expect(init).toMatchObject({
    method: 'POST',
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
  });
  expect(container.textContent).toContain(
    'exact simulation bank is unavailable',
  );
  expect(container.textContent).toContain(
    'This check is optional. Sign and Submit do not depend on this check;',
  );
  expect(container.textContent).toContain(
    'does not establish provider readiness or complete bundle economic and runtime qualification.',
  );
  expect(container.textContent).toContain('never signs, sends or retries');
  expect(storage).not.toHaveBeenCalled();
});
it('labels successful frame checks as diagnostic and unqualified', async () => {
  const { manifest } = await jitoBundleFixture();
  fetcher.mockResolvedValue(
    Response.json({ sequentialCheck: dto(manifest, true) }),
  );
  await render(manifest);
  act(() => button().click());
  await until(() => Boolean(container.querySelector('output')));
  expect(container.textContent).toContain(
    'Local sequential frame checks passed',
  );
  expect(container.textContent).toContain(
    'Economic outcomes, provider provenance, program and signature readiness remain unverified',
  );
  expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  expect(fetcher).toHaveBeenCalledOnce();
});
it.each(['authority', 'binding', 'raw'])(
  'rejects a returned %s mismatch without publishing it',
  async (kind) => {
    const { manifest } = await jitoBundleFixture();
    const result: Record<string, unknown> = { ...dto(manifest) };
    if (kind === 'authority') result.signingAllowed = true;
    else if (kind === 'binding') result.manifestSha256 = '00'.repeat(32);
    else result.rawResponse = 'FAKE_PRIVATE_RAW_SECRET';
    fetcher.mockResolvedValue(Response.json({ sequentialCheck: result }));
    await render(manifest);
    act(() => button().click());
    await until(() => Boolean(container.querySelector('[role="alert"]')));
    expect(container.querySelector('output')).toBeNull();
    expect(container.textContent).not.toContain('FAKE_PRIVATE_RAW_SECRET');
    expect(fetcher).toHaveBeenCalledOnce();
  },
);
it('hides HTML and provider text without automatic retry', async () => {
  const { manifest } = await jitoBundleFixture();
  fetcher.mockResolvedValue(
    new Response('<html>FAKE_PROVIDER_SECRET</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    }),
  );
  await render(manifest);
  act(() => button().click());
  await until(() => Boolean(container.querySelector('[role="alert"]')));
  expect(container.textContent).not.toContain('FAKE_PROVIDER_SECRET');
  expect(container.textContent).not.toContain('Unexpected token');
  expect(fetcher).toHaveBeenCalledOnce();
});
it('allows only one in-flight explicit read', async () => {
  const { manifest } = await jitoBundleFixture();
  let resolve!: (value: Response) => void;
  fetcher.mockReturnValue(
    new Promise<Response>((done) => {
      resolve = done;
    }),
  );
  await render(manifest);
  act(() => {
    button().click();
    button().click();
  });
  await until(() => fetcher.mock.calls.length === 1);
  expect(button().disabled).toBe(true);
  await act(async () => {
    resolve(Response.json({ sequentialCheck: dto(manifest) }));
  });
  await until(() => !button().disabled);
  expect(fetcher).toHaveBeenCalledOnce();
});
it.each(['context', 'disabled', 'unmount'])(
  'aborts a pending read and ignores its late result on %s',
  async (kind) => {
    const { manifest } = await jitoBundleFixture();
    let resolve!: (value: Response) => void;
    fetcher.mockReturnValue(
      new Promise<Response>((done) => {
        resolve = done;
      }),
    );
    await render(manifest);
    act(() => button().click());
    await until(() => fetcher.mock.calls.length === 1);
    const signal = (fetcher.mock.calls[0][1] as RequestInit).signal!;
    if (kind === 'context')
      await render({ ...manifest, id: crypto.randomUUID() });
    else if (kind === 'disabled') await render(manifest, true);
    else {
      act(() => root!.unmount());
      root = null;
    }
    expect(signal.aborted).toBe(true);
    await act(async () => {
      resolve(Response.json({ sequentialCheck: dto(manifest) }));
    });
    expect(container.querySelector('output')).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  },
);
it('refuses an expired review before the read starts', async () => {
  const { manifest } = await jitoBundleFixture();
  await render(manifest);
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(manifest.expiresAt) + 1);
  act(() => button().click());
  await until(() => Boolean(container.querySelector('[role="alert"]')));
  expect(fetcher).not.toHaveBeenCalled();
});

it('explains the existing owner review gate without showing server text or retrying', async () => {
  const { manifest } = await jitoBundleFixture();
  fetcher.mockResolvedValue(
    Response.json({ error: 'FAKE_RATE_PRIVATE_TEXT' }, { status: 429 }),
  );
  await render(manifest);
  act(() => button().click());
  await until(() => Boolean(container.querySelector('[role="alert"]')));
  expect(container.textContent).toContain('Wait at least 15 seconds');
  expect(container.textContent).toContain('does not retry automatically');
  expect(container.textContent).not.toContain('FAKE_RATE_PRIVATE_TEXT');
  expect(container.querySelector('output')).toBeNull();
  expect(fetcher).toHaveBeenCalledOnce();
});
