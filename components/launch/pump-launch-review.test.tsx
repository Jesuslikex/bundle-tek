// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { PumpLaunchReview } from './pump-launch-review';
import { DEFAULT_LAUNCH_PLAN } from '@/lib/launch-plan';
import { VAULT_STORAGE_KEY } from '@/lib/browser-wallet-vault';
const mocks = vi.hoisted(() => ({
  sign: vi.fn(),
  unlock: vi.fn(),
  clear: vi.fn(),
}));
vi.mock('@/lib/pump-mint-vault', () => ({
  parsePumpMintBackup: JSON.parse,
  pumpMintStorageKey: (id: string) => 'mint:' + id,
  unlockPumpMint: mocks.unlock,
  clearMintSession: mocks.clear,
  createPumpMint: vi.fn(),
  persistPumpMint: vi.fn(),
}));
vi.mock('@/lib/browser-wallet-vault', () => ({
  VAULT_STORAGE_KEY: 'test-vault',
  unlockVault: mocks.unlock,
}));
vi.mock('@/lib/pump-launch-signing', () => ({
  requirePumpSigningReview: async (_r: unknown, current: () => void) =>
    current(),
  signPumpLaunch: mocks.sign,
}));
const project = {
  id: 'project',
  updatedAt: '2026-10-14T00:00:00Z',
  payer: { address: 'payer', revision: 1 },
};
const plan = {
  ...DEFAULT_LAUNCH_PLAN,
  tokenName: 'Example',
  ticker: 'EX',
  developerBuy: 0,
  holdersBuy: 0,
  holdersBuyQuote: '0',
  scheduled: false,
};
const backup = {
  projectId: 'project',
  mint: 'mint',
  encrypted: 'encrypted',
  format: 'bundle-pump-mint-v1',
};
let container: HTMLDivElement,
  root: Root,
  fetcher: ReturnType<typeof vi.fn>,
  requests: string[],
  saved: ReturnType<typeof initialReview>;
function initialReview() {
  return {
    review: {
      id: 'review',
      projectId: 'project',
      projectUpdatedAt: project.updatedAt,
      releaseId: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      sha256: 'b'.repeat(64),
      transaction: 'unsigned',
      feeAndRentLimitRaw: '50000000',
      input: {
        name: 'Example',
        symbol: 'EX',
        payer: 'payer',
        mint: 'mint',
        quoteMint: 'So11111111111111111111111111111111111111112',
        uri: window.location.origin + '/api/launch/metadata/' + 'a'.repeat(64),
      },
    },
    state: 'review',
    signature: null as string | null,
    receipt: null,
    simulation: { payerDebitRaw: '3010000', networkFeeRaw: '10000' },
  };
}

const button = (text: string) =>
  [...container.querySelectorAll('button')].find(
    (b) => b.textContent === text,
  )!;
const label = (text: string) =>
  [...container.querySelectorAll('label')]
    .find((b) => b.textContent?.trim().startsWith(text))!
    .querySelector('input')!;
async function click(text: string) {
  await act(async () => button(text).click());
}
function input(text: string, value: string) {
  act(() => {
    const field = label(text);
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function check(text: string) {
  act(() => label(text).click());
}
beforeEach(async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  localStorage.setItem('mint:project', JSON.stringify(backup));
  localStorage.setItem(VAULT_STORAGE_KEY, 'encrypted payer');
  requests = [];
  saved = initialReview();
  fetcher = vi.fn(async (_path: string, init?: RequestInit) => {
    if (!init?.body) return Response.json({ launches: [saved] });
    const b = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
    requests.push(b.action);
    if (b.action === 'approve') saved = { ...saved, state: 'approved' };
    if (b.action === 'register')
      saved = { ...saved, state: 'signed', signature: '2'.repeat(88) };
    if (b.action === 'submit') saved = { ...saved, state: 'submitted' };
    return Response.json(saved);
  });
  vi.stubGlobal('fetch', fetcher);
  mocks.unlock.mockReset().mockResolvedValue({ payload: { wallets: [] } });
  mocks.sign.mockReset().mockResolvedValue({
    transaction: 'synthetic signed packet',
    signature: '2'.repeat(88),
  });
  mocks.clear.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <PumpLaunchReview
        project={project}
        plan={plan}
        releaseId={'a'.repeat(64)}
      />,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it('never prepares or signs automatically, and separates signing from broadcast consent', async () => {
  expect(fetcher).not.toHaveBeenCalled();
  expect(button('Simulate and prepare launch').disabled).toBe(true);
  check('I saved');
  await click('Simulate and prepare launch');
  expect(requests).toEqual(['prepare']);
  input('Mint backup passphrase', 'mint password');
  input('Deployer vault passphrase', 'payer password');
  expect(button('Approve and sign creation').disabled).toBe(true);
  check('I approve signing');
  await click('Approve and sign creation');
  expect(requests).toEqual(['prepare', 'approve', 'register']);
  expect(mocks.sign).toHaveBeenCalledOnce();
  expect(mocks.clear).toHaveBeenCalledTimes(2);
  expect(localStorage.getItem('bundle.pump-signed.v1:review')).toBe(
    'synthetic signed packet',
  );
  expect(button('Broadcast approved launch').disabled).toBe(true);
  check('I approve broadcasting');
  await click('Broadcast approved launch');
  expect(requests.at(-1)).toBe('submit');
});
it('disables a stale or mismatched review while retaining recovery', async () => {
  saved.review.projectUpdatedAt = 'older';
  await click('Reload saved launch');
  expect(button('Approve and sign creation').disabled).toBe(true);
  expect(container.textContent).toContain('differs from the current draft');
});
it('does not generate new signatures when an existing packet is awaiting registration', async () => {
  saved.state = 'approved';
  localStorage.setItem('bundle.pump-signed.v1:review', 'already signed');
  await click('Reload saved launch');
  check('I saved');
  input('Mint backup passphrase', 'mint password');
  input('Deployer vault passphrase', 'payer password');
  check('I approve signing');
  expect(button('Approve and sign creation').disabled).toBe(true);
  await click('Save existing signed packet');
  expect(requests).toEqual(['register']);
  expect(mocks.sign).not.toHaveBeenCalled();
});
it('shows a safe error for an HTML gateway failure', async () => {
  fetcher.mockResolvedValue(
    new Response('<html>private proxy details</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    }),
  );
  await click('Reload saved launch');
  expect(container.textContent).toContain('Launch history is unavailable');
  expect(container.textContent).not.toContain('private proxy');
});
