// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createJitoMemorySignatureRecovery } from '@/lib/jito-memory-signature-recovery';
import { createJitoPacketRecovery } from '@/lib/jito-packet-recovery';
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import { JitoMemoryRecovery } from './jito-memory-recovery';
import { JitoRecoveryLookup } from './jito-recovery-lookup';

const owner = 'a'.repeat(64);
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('crypto', webcrypto);
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
async function retainedFixture() {
  const f = await jitoBundleFixture();
  const coordinator = createJitoMemorySignatureRecovery();
  const reservation = await coordinator.reserve(owner, f.manifest, 0);
  coordinator.markStarted(reservation);
  await coordinator.capture(reservation, f.manifest, f.swap.signed.transaction);
  const recovery = await createJitoPacketRecovery(
    f.manifest,
    0,
    f.swap.signed.transaction,
  );
  return { f, coordinator, recovery };
}
it('does not erase the only retained packet when history alone has a matching signature', async () => {
  const { f, coordinator, recovery } = await retainedFixture();
  const register = vi.fn();
  await act(async () =>
    root.render(
      <JitoMemoryRecovery
        ownerScope={owner}
        manifest={f.manifest}
        packet={0}
        coordinator={coordinator}
        revision={0}
        registrationAllowed={false}
        serverSignature={recovery.signature}
        isContextCurrent={() => true}
        register={register}
      />,
    ),
  );
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.textContent).toContain(
      'Download original packet recovery file',
    );
  });
  expect((await coordinator.inspect(owner, f.manifest, 0)).status).toBe(
    'retained',
  );
  expect(register).not.toHaveBeenCalled();
});
it('keeps legacy saved-signature confirmation read-only and retains original memory evidence', async () => {
  const { f, coordinator, recovery } = await retainedFixture();
  const record = {
    manifest: f.manifest,
    state: 'reviewed' as const,
    bundleId: null,
    signatures: [null, null] as (string | null)[],
    updatedAt: f.manifest.createdAt,
  };
  const observed = { ...record, signatures: [recovery.signature, null] };
  const setView = vi.fn(),
    register = vi.fn(),
    read = vi.fn(async () => observed);
  await act(async () =>
    root.render(
      <JitoRecoveryLookup
        projectId={f.manifest.projectId}
        sessionId={f.manifest.sessionId}
        ownerScope={owner}
        coordinator={coordinator}
        revision={0}
        disabled={false}
        isContextCurrent={() => true}
        readExactBundle={read}
        canRegister={() => false}
        registerPacket={register}
        view={{ kind: 'retained', record, packet: 0, recovery }}
        setView={setView}
        beginOperation={() => coordinator.startOperation(owner)}
        finishOperation={(token) => coordinator.finishOperation(token)}
        observedRecord={observed}
      />,
    ),
  );
  const button = [...container.querySelectorAll('button')].find((node) =>
    node.textContent?.includes('Confirm saved signature'),
  )!;
  await act(async () => button.click());
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.textContent).toContain(
      'This older view cannot clear recovery',
    );
  });
  expect(read).toHaveBeenCalledOnce();
  expect((await coordinator.inspect(owner, f.manifest, 0)).status).toBe(
    'retained',
  );
  expect(setView).not.toHaveBeenCalled();
  expect(register).not.toHaveBeenCalled();
});
