// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { StonkLayerPlanning } from './stonk-layer-planning';
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  persist: vi.fn(),
  parse: vi.fn(),
}));
vi.mock('@/lib/pump-mint-vault', () => ({
  createPumpMint: mocks.create,
  persistPumpMint: mocks.persist,
  parsePumpMintBackup: mocks.parse,
  pumpMintStorageKey: (id: string) => 'mint:' + id,
}));
const project = { id: 'stonk-project', updatedAt: '2026-10-18T00:00:00.000Z' };
const backup = {
  format: 'bundle-pump-mint-v1',
  projectId: project.id,
  mint: 'public-candidate',
  encrypted: 'encrypted',
};
let root: Root, container: HTMLDivElement;
const button = (name: string) =>
  [...container.querySelectorAll('button')].find(
    (b) => b.textContent === name,
  )!;
async function render(p = project, disabled = false) {
  await act(async () => {
    root.render(<StonkLayerPlanning project={p} disabled={disabled} />);
  });
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
  });
}
async function click(name: string) {
  await act(async () => button(name).click());
}
async function password(value: string) {
  await act(async () => {
    const e = container.querySelector<HTMLInputElement>(
      'input[type=password]',
    )!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(e, value);
    e.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function file(value: File) {
  await act(async () => {
    const e = container.querySelector<HTMLInputElement>('input[type=file]')!;
    Object.defineProperty(e, 'files', { value: [value], configurable: true });
    e.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  localStorage.clear();
  mocks.create.mockReset().mockResolvedValue(backup);
  mocks.persist.mockReset().mockImplementation(async (_b, current) => {
    if (!current()) throw Error('changed');
  });
  mocks.parse.mockReset().mockImplementation((text, id) => {
    const b = JSON.parse(text);
    if (b.projectId !== id) throw Error('wrong project');
    return b;
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('starts without key generation or network and requires an eight-character password', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await render();
  expect(mocks.create).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
  expect(container.textContent).toContain('up to 12 Front wallets');
  expect(container.textContent).toContain(
    'Coin creation, funding and signing are not available',
  );
  await password('1234567');
  expect(button('Generate encrypted mint candidate').disabled).toBe(true);
  await password('12345678');
  expect(button('Generate encrypted mint candidate').disabled).toBe(false);
  await click('Generate encrypted mint candidate');
  expect(mocks.create).toHaveBeenCalledExactlyOnceWith(project.id, '12345678');
  expect(mocks.persist).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain(backup.mint);
  expect(button('Plan Front wallets')).toBeDefined();
  expect(fetcher).not.toHaveBeenCalled();
});
it('loads only the saved public header without generating or persisting another key', async () => {
  localStorage.setItem('mint:' + project.id, JSON.stringify(backup));
  await render();
  expect(mocks.parse).toHaveBeenCalledWith(JSON.stringify(backup), project.id);
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.persist).not.toHaveBeenCalled();
  expect(container.textContent).toContain(
    'does not decrypt it or prove key control',
  );
});
it('suppresses a pending old candidate after the project revision changes', async () => {
  let finish!: (value: typeof backup) => void;
  mocks.create.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await password('12345678');
  await click('Generate encrypted mint candidate');
  await render({ ...project, updatedAt: '2026-10-18T00:01:00.000Z' });
  await act(async () => finish(backup));
  expect(mocks.persist).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain(backup.mint);
});
it('guards double clicks synchronously and clears the password while generating', async () => {
  let finish!: (value: typeof backup) => void;
  mocks.create.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await password('12345678');
  await act(async () => {
    const b = button('Generate encrypted mint candidate');
    b.click();
    b.click();
  });
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(
    container.querySelector<HTMLInputElement>('input[type=password]')?.value,
  ).toBe('');
  await act(async () => finish(backup));
  expect(mocks.persist).toHaveBeenCalledTimes(1);
});
it('restores the encrypted public candidate without asking for or decrypting its password', async () => {
  await render();
  const f = new File(['ignored'], 'mint.json', { type: 'application/json' });
  Object.defineProperty(f, 'text', {
    value: async () => JSON.stringify(backup),
  });
  await file(f);
  await click('Restore public mint candidate');
  expect(mocks.parse).toHaveBeenCalledWith(JSON.stringify(backup), project.id);
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.persist).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain(backup.mint);
});
it('rejects foreign and oversized backups without saving a key', async () => {
  await render();
  const f = new File(['ignored'], 'mint.json');
  Object.defineProperty(f, 'text', {
    value: async () => JSON.stringify({ ...backup, projectId: 'someone-else' }),
  });
  await file(f);
  await click('Restore public mint candidate');
  expect(mocks.persist).not.toHaveBeenCalled();
  expect(container.querySelector('[role=alert]')).not.toBeNull();
  const huge = new File(['x'.repeat(400001)], 'huge.json');
  await file(huge);
  await click('Restore public mint candidate');
  expect(mocks.persist).not.toHaveBeenCalled();
});
it('keeps planning closed after storage refusal and disables candidate actions during publication', async () => {
  mocks.persist.mockRejectedValue(Error('Storage refusal'));
  await render();
  await password('12345678');
  await click('Generate encrypted mint candidate');
  expect(container.querySelector('[role=alert]')).not.toBeNull();
  expect(button('Plan Front wallets')).toBeUndefined();
  await render(project, true);
  expect(
    [...container.querySelectorAll('button')].every((b) => b.disabled),
  ).toBe(true);
});
