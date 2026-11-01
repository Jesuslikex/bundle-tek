// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import type { VaultSession } from '@/lib/browser-wallet-vault';
import {
  distributionMessage,
  toBase64,
  verifySignedBatch,
  type DistributionBatch,
} from '@/lib/sol-distribution';

const vault = vi.hoisted(() => ({ unlockVault: vi.fn() }));
vi.mock('@/lib/browser-wallet-vault', async (actual) => ({
  ...(await actual<typeof import('@/lib/browser-wallet-vault')>()),
  unlockVault: vault.unlockVault,
}));
import { createVault, generateVaultWallets } from '@/lib/browser-wallet-vault';
import {
  SolDistributionDialog,
  checkPrepared,
} from './sol-distribution-dialog';

const blockhash = bs58.encode(nacl.sign.keyPair().publicKey);
let root: Root, host: HTMLDivElement, session: VaultSession;
let funder: string, a: string, b: string;
const posts: Record<string, unknown>[] = [];

function prepared(
  mode: 'fund' | 'return',
  transfers: { address: string; lamports: string }[],
) {
  const batch: DistributionBatch = { mode, funder, blockhash, transfers };
  return {
    mode,
    funder,
    blockhash,
    lastValidBlockHeight: '1',
    funderLamports: '1000000000',
    totalLamports: transfers
      .reduce((s, t) => s + BigInt(t.lamports), 0n)
      .toString(),
    feeLamports: '5000',
    batches: [{ ...batch, message: toBase64(distributionMessage(batch)) }],
    skipped: [],
  };
}

const button = (text: string) =>
  Array.from(document.querySelectorAll('button')).find(
    (x) => x.textContent?.trim() === text,
  )!;
async function setInput(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  posts.length = 0;
  session = generateVaultWallets(
    await createVault('fixture-password'),
    'solana',
    3,
  );
  [funder, a, b] = session.payload.wallets.map((w) => w.address);
  vault.unlockVault.mockReset().mockResolvedValue(session);
  localStorage.setItem('pulseforge.wallet-vault.v1', 'x');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/wallet-workspace')
        return Response.json({
          wallets: [funder, a, b].map((address, i) => ({
            chain: 'Solana',
            address,
            label: `W${i}`,
            archived: false,
          })),
        });
      const body = JSON.parse(init!.body as string);
      posts.push(body);
      if (body.action === 'prepare')
        return Response.json({ prepared: prepared('fund', body.transfers) });
      if (body.action === 'submit') {
        const { signature } = verifySignedBatch(body.batch, body.transaction);
        return Response.json({ signature });
      }
      return Response.json({ statuses: ['finalized'] });
    }),
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('funds every selected wallet with a fixed amount after one password approval', async () => {
  await act(async () =>
    root.render(
      <SolDistributionDialog
        mode="fund"
        funder={funder}
        open
        onOpenChange={() => {}}
      />,
    ),
  );
  expect(document.body.textContent).toContain('Select all (2/2)');
  const amount = document.querySelector(
    '.sol-distribution-amount input[inputmode="decimal"]',
  ) as HTMLInputElement;
  await setInput(amount, '0.05');
  await act(async () => button('Review transfers').click());
  expect(posts[0]).toMatchObject({
    action: 'prepare',
    mode: 'fund',
    funder,
    transfers: [
      { address: a, lamports: '50000000' },
      { address: b, lamports: '50000000' },
    ],
  });
  expect(document.body.textContent).toContain('0.1 SOL');
  const send = button('Approve and send');
  expect(send.disabled).toBe(true);
  await setInput(
    document.querySelector('input[type="password"]') as HTMLInputElement,
    'fixture-password',
  );
  await act(async () =>
    (
      document.querySelector(
        '.sol-distribution-review input[type="checkbox"]',
      ) as HTMLInputElement
    ).click(),
  );
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  await act(async () =>
    document
      .querySelector('form.sol-distribution-review')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2500);
  });
  expect(vault.unlockVault).toHaveBeenCalledOnce();
  const submits = posts.filter((p) => p.action === 'submit');
  expect(submits).toHaveLength(1);
  expect(JSON.stringify(posts)).not.toContain('fixture-password');
  expect(
    document.querySelector('.sol-distribution-results')!.textContent,
  ).toContain('finalized');
  // Vault key material was wiped after signing.
  expect(session.payload.wallets).toHaveLength(0);
});

it('refuses server packets that change amounts, recipients or bytes', () => {
  const asked = [{ address: a, lamports: 10n }];
  expect(
    checkPrepared(
      prepared('fund', [{ address: a, lamports: '10' }]) as never,
      'fund',
      funder,
      asked,
    ),
  ).toBe(10n);
  expect(() =>
    checkPrepared(
      prepared('fund', [{ address: a, lamports: '11' }]) as never,
      'fund',
      funder,
      asked,
    ),
  ).toThrow('amounts differ');
  expect(() =>
    checkPrepared(
      prepared('fund', [{ address: b, lamports: '10' }]) as never,
      'fund',
      funder,
      asked,
    ),
  ).toThrow();
  const tampered = prepared('fund', [{ address: a, lamports: '10' }]);
  tampered.batches[0].transfers = [{ address: a, lamports: '999' }];
  expect(() => checkPrepared(tampered as never, 'fund', funder, asked)).toThrow(
    'differs',
  );
  expect(() =>
    checkPrepared(
      prepared('return', [{ address: b, lamports: '5' }]) as never,
      'return',
      funder,
      [a],
    ),
  ).toThrow('sources differ');
  expect(() =>
    checkPrepared(
      prepared('fund', [{ address: a, lamports: '10' }]) as never,
      'return',
      funder,
      [a],
    ),
  ).toThrow();
});
