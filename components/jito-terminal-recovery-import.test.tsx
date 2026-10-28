// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import { createJitoMemorySignatureRecovery } from '@/lib/jito-memory-signature-recovery';
import { createJitoPacketRecovery } from '@/lib/jito-packet-recovery';
import { JitoTerminalRecoveryImport } from './jito-terminal-recovery-import';

const owner = 'a'.repeat(64);
let host: HTMLDivElement, root: Root, unmounted: boolean;
const network = vi.fn();
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', network);
  network.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  unmounted = false;
});
afterEach(() => {
  if (!unmounted) act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function setup() {
  const f = await jitoBundleFixture();
  const coordinator = createJitoMemorySignatureRecovery();
  let current = true;
  const readTerminalSignature = vi.fn(async (): Promise<string | null> => null);
  await act(async () =>
    root.render(
      <JitoTerminalRecoveryImport
        manifest={f.manifest}
        packet={0}
        ownerScope={owner}
        coordinator={coordinator}
        disabled={false}
        isContextCurrent={() => current}
        readTerminalSignature={readTerminalSignature}
      />,
    ),
  );
  const checked = await createJitoPacketRecovery(
    f.manifest,
    0,
    f.swap.signed.transaction,
  );
  return {
    f,
    checked,
    coordinator,
    readTerminalSignature,
    changeContext: () => {
      current = false;
    },
  };
}
async function choose(text: string) {
  const file = new File([text], 'synthetic.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => text });
  const input = host.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () =>
    input.dispatchEvent(new Event('change', { bubbles: true })),
  );
}
async function until(text: string) {
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(host.textContent).toContain(text);
  });
}
function button(text: string) {
  const result = [...host.querySelectorAll('button')].find((node) =>
    node.textContent?.includes(text),
  );
  if (!result) throw Error('Button missing');
  return result;
}
it('verifies an exact packet and rechecks the terminal record before private download', async () => {
  const f = await setup();
  f.readTerminalSignature.mockResolvedValue(f.checked.signature);
  const create = vi
    .spyOn(URL, 'createObjectURL')
    .mockReturnValue('blob:synthetic');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(() => {});
  await choose(JSON.stringify(f.checked));
  await until('Exact signed packet verified');
  expect(f.readTerminalSignature).toHaveBeenCalledTimes(1);
  expect(host.textContent).not.toContain('Register');
  expect(host.textContent).not.toContain('Sign only');
  await act(async () => button('Download verified packet privately').click());
  await vi.waitFor(() => expect(click).toHaveBeenCalledOnce());
  expect(f.readTerminalSignature).toHaveBeenCalledTimes(2);
  expect(create).toHaveBeenCalledOnce();
  expect(network).not.toHaveBeenCalled();
});
it('refuses conflicting saved signatures and tampered or wrong-packet files', async () => {
  const f = await setup();
  f.readTerminalSignature.mockResolvedValue(f.f.tip.signed.signature);
  await choose(JSON.stringify(f.checked));
  await until('Saved bundle signature differs');
  expect(host.textContent).not.toContain('Exact signed packet verified');
  const altered = { ...f.checked, packet: 1 };
  await choose(JSON.stringify(altered));
  await until('Recovery file belongs to a different bundle or packet');
  expect(f.readTerminalSignature).toHaveBeenCalledTimes(1);
  expect(network).not.toHaveBeenCalled();
});
it('refuses a wrong project, wrong session or tampered signature without reading the saved row', async () => {
  const f = await setup();
  for (const altered of [
    { ...f.checked, projectId: '00000000-0000-4000-8000-000000000000' },
    { ...f.checked, sessionId: '00000000-0000-4000-8000-000000000000' },
    { ...f.checked, signature: f.f.tip.signed.signature },
  ]) {
    await choose(JSON.stringify(altered));
    await until('Recovery');
    expect(host.textContent).not.toContain('Exact signed packet verified');
  }
  expect(f.readTerminalSignature).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
});
it('does not replace a pending original outcome or call the exact-record reader', async () => {
  const f = await setup();
  await f.coordinator.reserve(owner, f.f.manifest, 0);
  await choose(JSON.stringify(f.checked));
  await until('Original Jito packet recovery is pending');
  expect(f.readTerminalSignature).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
});
it('allows export-only inspection of another packet without changing its pending outcome', async () => {
  const f = await setup();
  const reservation = await f.coordinator.reserve(owner, f.f.manifest, 1);
  f.coordinator.markStarted(reservation);
  await choose(JSON.stringify(f.checked));
  await until('Exact signed packet verified');
  expect((await f.coordinator.inspect(owner, f.f.manifest, 1)).status).toBe(
    'started',
  );
  expect(f.coordinator.has(owner, f.f.manifest.id, 0)).toBe(false);
  expect(network).not.toHaveBeenCalled();
});
it('rechecks the current owner context before downloading a previously inspected packet', async () => {
  const f = await setup();
  await choose(JSON.stringify(f.checked));
  await until('Exact signed packet verified');
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(() => {});
  f.changeContext();
  await act(async () => button('Download verified packet privately').click());
  expect(click).not.toHaveBeenCalled();
  expect(f.readTerminalSignature).toHaveBeenCalledTimes(1);
  expect(network).not.toHaveBeenCalled();
});
it('does not download if the context changes during the fresh export read', async () => {
  const f = await setup();
  await choose(JSON.stringify(f.checked));
  await until('Exact signed packet verified');
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(() => {});
  let resolve!: (signature: string | null) => void;
  f.readTerminalSignature.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () => button('Download verified packet privately').click());
  await vi.waitFor(() =>
    expect(f.readTerminalSignature).toHaveBeenCalledTimes(2),
  );
  f.changeContext();
  await act(async () => resolve(null));
  expect(click).not.toHaveBeenCalled();
  expect(f.coordinator.operationActive()).toBe(false);
  expect(network).not.toHaveBeenCalled();
});
it('does not publish a packet after the context changes during the exact read', async () => {
  const f = await setup();
  let resolve!: (signature: string | null) => void;
  f.readTerminalSignature.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await choose(JSON.stringify(f.checked));
  await vi.waitFor(() =>
    expect(f.readTerminalSignature).toHaveBeenCalledOnce(),
  );
  f.changeContext();
  await act(async () => resolve(null));
  expect(host.textContent).not.toContain('Exact signed packet verified');
  expect(f.coordinator.operationActive()).toBe(false);
  expect(network).not.toHaveBeenCalled();
});
it('releases its operation and does not publish if unmounted during the exact read', async () => {
  const f = await setup();
  let resolve!: (signature: string | null) => void;
  f.readTerminalSignature.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await choose(JSON.stringify(f.checked));
  await vi.waitFor(() =>
    expect(f.readTerminalSignature).toHaveBeenCalledOnce(),
  );
  await act(async () => root.unmount());
  unmounted = true;
  await act(async () => resolve(null));
  expect(f.coordinator.operationActive()).toBe(false);
  expect(network).not.toHaveBeenCalled();
});
