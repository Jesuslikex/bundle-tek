// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { creatorFeeFixture } from '../test/creator-fee-fixture';
import {
  prepareCreatorFeeClaim,
  scanCreatorFees,
  DEFAULT_CLAIM_QUOTES,
} from '@/lib/pump-creator-fees-server';
import { vaultKey, type CreatorFeeClaimReview } from '@/lib/pump-creator-fees';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';

const vault = vi.hoisted(() => ({ seed: '', address: '', unlocks: 0 }));
vi.mock('@/lib/browser-wallet-vault', () => ({
  VAULT_STORAGE_KEY: 'vault',
  unlockVault: async () => {
    vault.unlocks++;
    return {
      payload: {
        wallets: [
          { family: 'solana', address: vault.address, seed: vault.seed },
        ],
      },
    };
  },
}));
import { CreatorFeeClaimPanel } from './creator-fee-claim-panel';

let root: Root, container: HTMLDivElement;
let bodies: Record<string, unknown>[];
let review: CreatorFeeClaimReview;
let scan: Awaited<ReturnType<typeof scanCreatorFees>>;
let submitResponse: () => Response;
let wallets: WorkspaceWallet[];
beforeEach(async () => {
  const f = await creatorFeeFixture();
  vault.seed = Buffer.from(f.seed).toString('hex');
  vault.address = f.wallet;
  vault.unlocks = 0;
  const signal = AbortSignal.timeout(10000);
  scan = await scanCreatorFees(
    f.wallet,
    DEFAULT_CLAIM_QUOTES,
    signal,
    f.fetcher,
  );
  review = await prepareCreatorFeeClaim(
    { wallet: f.wallet, walletRevision: 4, select: scan.vaults.map(vaultKey) },
    DEFAULT_CLAIM_QUOTES,
    signal,
    f.fetcher,
  );
  wallets = [
    {
      chain: 'Solana',
      address: f.wallet,
      folderId: 'f',
      label: 'Dev wallet',
      role: 'Deployer',
      archived: false,
      revision: 4,
      updatedAt: new Date().toISOString(),
    },
  ];
  bodies = [];
  submitResponse = () => Response.json({ signature: 'sig' });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      bodies.push(body);
      if (body.action === 'scan') return Response.json({ scan });
      if (body.action === 'prepare') return Response.json({ review });
      if (body.action === 'submit') return submitResponse();
      return Response.json({
        receipt: {
          failed: false,
          networkFeeLamports: '5000',
          walletChangeLamports: '287955720',
          tokens: [],
        },
      });
    }),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(<CreatorFeeClaimPanel wallets={wallets} />),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const button = (text: string) =>
  [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(text),
  ) as HTMLButtonElement | undefined;
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
const click = (text: string) =>
  act(async () => {
    button(text)!.click();
    await settle();
  });
const type = (input: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
async function toReview() {
  await click('Open creator fees');
  await click('Check creator fees');
  expect(container.textContent).toContain('0.25 SOL');
  expect(container.textContent).toContain('12.5 USDC');
  expect(container.textContent).toContain('PumpSwap');
  await click('Review claim');
}

it('reads nothing until asked and reviews the selected vaults', async () => {
  expect(fetch).not.toHaveBeenCalled();
  await toReview();
  expect(bodies.map((b) => b.action)).toEqual(['scan', 'prepare']);
  expect(bodies[1]).toMatchObject({
    walletRevision: 4,
    select: scan.vaults.map(vaultKey),
  });
  expect(container.textContent).toContain('Network fee: 0.000005 SOL');
  expect(container.textContent).toContain('arrives as native SOL');
  expect(container.textContent).toContain('Nothing is signed or sent yet');
});

it('needs explicit approval and a password before signing, then a separate send', async () => {
  await toReview();
  expect(button('Sign in browser')!.disabled).toBe(true);
  await type(container.querySelector('input[type=password]')!, 'pw');
  expect(button('Sign in browser')!.disabled).toBe(true);
  const approve = [...container.querySelectorAll('input[type=checkbox]')].at(
    -1,
  ) as HTMLInputElement;
  await act(async () => approve.click());
  await click('Sign in browser');
  expect(vault.unlocks).toBe(1);
  expect(container.textContent).toContain('Nothing has been sent yet');
  expect(bodies.some((b) => b.action === 'submit')).toBe(false);
  await click('Send claim');
  const submits = bodies.filter((b) => b.action === 'submit');
  expect(submits).toHaveLength(1);
  expect(submits[0].transaction).not.toBe(review.transaction);
  expect(button('Send claim')).toBeUndefined();
  await click('Check finalized outcome');
  expect(container.textContent).toContain('Claimed. SOL change 0.28795572 SOL');
});

it('never offers a resend after an unknown submission outcome', async () => {
  submitResponse = () =>
    Response.json(
      {
        error:
          'Submission outcome is unknown. Check the signature before preparing another claim.',
      },
      { status: 502 },
    );
  await toReview();
  await type(container.querySelector('input[type=password]')!, 'pw');
  const approve = [...container.querySelectorAll('input[type=checkbox]')].at(
    -1,
  ) as HTMLInputElement;
  await act(async () => approve.click());
  await click('Sign in browser');
  await click('Send claim');
  expect(container.textContent).toContain('outcome is unknown');
  expect(button('Send claim')).toBeUndefined();
  expect(button('Check finalized outcome')).toBeDefined();
});
