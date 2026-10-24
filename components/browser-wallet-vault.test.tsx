// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { BrowserWalletVault } from './browser-wallet-vault';
const vault = vi.hoisted(() => ({
  createVault: vi.fn(),
  unlockVault: vi.fn(),
  generateVaultWallets: vi.fn(),
  encryptVault: vi.fn(),
  saveBrowserVault: vi.fn(),
}));
vi.mock('@/lib/browser-wallet-vault', () => ({
  ...vault,
  VAULT_STORAGE_KEY: 'fixture-vault',
  VAULT_MIN_PASSWORD_LENGTH: 8,
  publicVaultWallets: (session: { wallets: unknown[] }) => session.wallets,
  parseVaultEnvelope: vi.fn(),
  importVaultWallets: vi.fn(),
  exportVaultPrivateKeys: vi.fn(),
}));
let root: Root, host: HTMLDivElement;
const address = '11111111111111111111111111111111';
const onAddPublic = vi.fn(),
  onOpenWarmup = vi.fn();
const textButton = (text: string) =>
  Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  )!;
async function click(text: string) {
  await act(async () => textButton(text).click());
}
async function input(label: string, value: string) {
  const el = Array.from(document.querySelectorAll('label')).find(
    (l) => l.textContent === label,
  )!;
  const field = document.getElementById(el.htmlFor) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit() {
  await act(async () =>
    document
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
}
const guidedSteps = () =>
  document.querySelector('.browser-vault-scope')?.textContent ?? '';
/**
 * The shared `beforeEach` has already rendered the default Solana + callback
 * case, so replacing that root is the only way to vary the chain or callback
 * without mounting two vaults into one document.
 */
async function renderGuided(options: {
  chain: 'Solana' | 'Base';
  withCallback: boolean;
}) {
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () =>
    root.render(
      <BrowserWalletVault
        chain={options.chain}
        savedAddresses={[]}
        verifiedAddresses={[]}
        onVerified={async () => {}}
        onAddPublic={onAddPublic}
        onOpenWarmup={options.withCallback ? onOpenWarmup : undefined}
      />,
    ),
  );
  await click('Create wallet');
}
async function createGuidedWallet() {
  await input('Wallet password', 'synthetic-test-only');
  await input('Confirm password', 'synthetic-test-only');
  await submit();
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  localStorage.clear();
  vault.createVault.mockResolvedValue({ wallets: [] });
  vault.unlockVault.mockResolvedValue({ wallets: [] });
  vault.generateVaultWallets.mockReturnValue({
    wallets: [{ id: 'fixture', family: 'solana', address }],
  });
  vault.encryptVault.mockResolvedValue('encrypted-fixture');
  vault.saveBrowserVault.mockImplementation(async (_old, value) =>
    localStorage.setItem('fixture-vault', value),
  );
  onAddPublic.mockResolvedValue(true);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <BrowserWalletVault
        chain="Solana"
        savedAddresses={[]}
        verifiedAddresses={[]}
        onVerified={async () => {}}
        onAddPublic={onAddPublic}
        onOpenWarmup={onOpenWarmup}
      />,
    ),
  );
  await click('Create wallet');
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it('creates, encrypts and saves exactly one wallet before offering warmup', async () => {
  expect(document.body.textContent).toContain('Create a Solana wallet');
  expect(document.body.textContent).toContain('at least 8 characters');
  expect(document.querySelector('form button')!.textContent).toBe(
    'Create wallet',
  );
  expect(document.querySelector('details')!.open).toBe(false);
  await input('Wallet password', 'synthetic-test-only');
  await input('Confirm password', 'synthetic-test-only');
  await submit();
  expect(vault.generateVaultWallets).toHaveBeenCalledWith(
    { wallets: [] },
    'solana',
    1,
  );
  expect(vault.saveBrowserVault).toHaveBeenCalledWith(
    null,
    'encrypted-fixture',
    expect.any(Function),
  );
  expect(onAddPublic).toHaveBeenCalledExactlyOnceWith([address]);
  expect(document.body.textContent).toContain('Your wallet is ready');
  await click('Continue to warmup');
  expect(onOpenWarmup).toHaveBeenCalledExactlyOnceWith(address);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it('retries public saving without generating another wallet or losing the encrypted copy', async () => {
  onAddPublic.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await input('Wallet password', 'synthetic-test-only');
  await input('Confirm password', 'synthetic-test-only');
  await submit();
  expect(localStorage.getItem('fixture-vault')).toBe('encrypted-fixture');
  expect(document.body.textContent).toContain('Your encrypted wallet is safe');
  await click('Retry saving public address');
  expect(vault.generateVaultWallets).toHaveBeenCalledTimes(1);
  expect(onAddPublic).toHaveBeenCalledTimes(2);
  expect(textButton('Continue to warmup')).toBeTruthy();
});
it('refuses mismatched passphrases before generating or saving anything', async () => {
  await input('Wallet password', 'synthetic-test-only');
  await input('Confirm password', 'different-fixture-only');
  await submit();
  expect(document.body.textContent).toContain('Passwords do not match');
  expect(vault.createVault).not.toHaveBeenCalled();
  expect(onAddPublic).not.toHaveBeenCalled();
});

it('keeps an existing vault and encrypts the added wallet against its prior ciphertext', async () => {
  await click('Close');
  localStorage.setItem('fixture-vault', 'existing-fixture');
  await click('Create wallet');
  await input('Wallet password', 'synthetic-test-only');
  await submit();
  expect(vault.createVault).not.toHaveBeenCalled();
  expect(vault.unlockVault).toHaveBeenCalledExactlyOnceWith(
    'existing-fixture',
    'synthetic-test-only',
  );
  expect(vault.saveBrowserVault).toHaveBeenCalledWith(
    'existing-fixture',
    'encrypted-fixture',
    expect.any(Function),
  );
  expect(onAddPublic).toHaveBeenCalledExactlyOnceWith([address]);
});

it('does not generate or publish a wallet after browser storage invalidates pending creation', async () => {
  let resolve!: (value: unknown) => void;
  vault.createVault.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await input('Wallet password', 'synthetic-test-only');
  await input('Confirm password', 'synthetic-test-only');
  await submit();
  await act(async () =>
    window.dispatchEvent(new StorageEvent('storage', { key: 'fixture-vault' })),
  );
  await act(async () => resolve({ wallets: [] }));
  expect(vault.generateVaultWallets).not.toHaveBeenCalled();
  expect(vault.saveBrowserVault).not.toHaveBeenCalled();
  expect(onAddPublic).not.toHaveBeenCalled();
});

it('advertises the warmup handoff in the guided steps for Solana with a warmup host', async () => {
  await renderGuided({ chain: 'Solana', withCallback: true });
  await createGuidedWallet();
  expect(guidedSteps()).toContain('3. Open warmup');
  expect(textButton('Continue to warmup')).toBeTruthy();
});

it('ends the guided steps at Done when Solana custody has no warmup host', async () => {
  await renderGuided({ chain: 'Solana', withCallback: false });
  await createGuidedWallet();
  expect(document.body.textContent).toContain('Your wallet is ready');
  expect(guidedSteps()).toContain('3. Done');
  expect(document.body.textContent).not.toContain('Open warmup');
  await click('Done');
  expect(onOpenWarmup).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('never promises warmup for EVM custody even when a warmup host is supplied', async () => {
  await renderGuided({ chain: 'Base', withCallback: true });
  await createGuidedWallet();
  expect(vault.generateVaultWallets).toHaveBeenCalledWith(
    { wallets: [] },
    'evm',
    1,
  );
  expect(document.body.textContent).toContain('Base wallet');
  expect(guidedSteps()).toContain('3. Done');
  expect(document.body.textContent).not.toContain('Open warmup');
  await click('Done');
  expect(onOpenWarmup).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
