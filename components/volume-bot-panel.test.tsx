// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { VolumeBotPanel, type VolumeSession } from './volume-bot-panel';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import {
  VAULT_STORAGE_KEY,
  createVault,
  encryptVault,
  generateVaultWallets,
} from '@/lib/browser-wallet-vault';
import { solanaTransferMessage } from '@/lib/solana-funding';
import { createVolumeBatchReview } from '@/lib/volume-bot-batch';
import { planVolumeSession } from '@/lib/volume-bot-plan';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PROJECT = '00000000-0000-4000-8000-000000000001';
const project = {
  id: PROJECT,
  revision: 2,
  archived: false,
  updatedAt: '2026-10-17T00:00:00.000Z',
  document: {
    format: 'imported-token-project-v1',
    executionAllowed: false,
    token: {
      chain: 'Solana',
      address: MINT,
      decimals: 6,
      symbol: 'TEST',
      name: 'Test',
      totalSupplyRaw: '1000000',
      source: 'fixture.test',
      observedAt: '2026-10-13T12:00:00.000Z',
    },
  },
} as unknown as ImportedTokenProject;
let address: string, encrypted: string;
let container: HTMLDivElement, root: Root;
let calls: { url: string; payload: Record<string, unknown> | null }[];
let respond: (payload: Record<string, unknown> | null) => unknown;
beforeAll(async () => {
  const vault = generateVaultWallets(
    await createVault('panel synthetic vault'),
    'solana',
    1,
  );
  address = vault.payload.wallets[0].address;
  encrypted = await encryptVault(vault);
}, 30_000);
const wallet = () =>
  ({
    chain: 'Solana',
    address,
    folderId: '',
    label: 'Volume one',
    role: 'Trader',
    archived: false,
    revision: 1,
    updatedAt: '2026-10-17T00:00:00.000Z',
  }) as unknown as WorkspaceWallet;
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  calls = [];
  localStorage.setItem(VAULT_STORAGE_KEY, encrypted);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      const payload = options.body
        ? (JSON.parse(options.body as string) as Record<string, unknown>)
        : null;
      calls.push({ url: String(url), payload });
      return Response.json(respond(payload));
    }),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});
const button = (text: string) =>
  [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  )!;
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

it('estimates with the chosen settings and saves the session', async () => {
  const seedPlan = (seed: string) =>
    planVolumeSession(
      {
        targetVolumeLamports: '1000000000',
        durationSeconds: 1800,
        delayMinMs: 5000,
        delayMaxMs: 20000,
        amount: { kind: 'auto' },
        wave: 'tight',
        wallets: [address],
      },
      [{ address, lamports: '10000000000' }],
      seed,
    );
  respond = (payload) =>
    payload?.action === 'estimate'
      ? { plan: seedPlan(payload.seed as string) }
      : payload?.action === 'create'
        ? { id: 's' }
        : { sessions: [] };
  await act(async () =>
    root.render(
      <VolumeBotPanel project={project} wallets={[wallet()]} locked={false} />,
    ),
  );
  await act(async () => button('Open Volume Bot').click());
  await settle();
  await act(async () =>
    (
      container.querySelector('input[type=checkbox]') as HTMLInputElement
    ).click(),
  );
  await act(async () => button('Estimate').click());
  await vi.waitFor(() =>
    expect(container.textContent).toContain('Round trips'),
  );
  const estimate = calls.find((c) => c.payload?.action === 'estimate')!;
  expect(estimate.payload).toMatchObject({
    projectId: PROJECT,
    projectRevision: 2,
    terms: {
      targetVolumeLamports: '1000000000',
      durationSeconds: 1800,
      delayMinMs: 5000,
      delayMaxMs: 20000,
      amount: { kind: 'auto' },
      wave: 'tight',
      wallets: [address],
    },
  });
  expect(container.textContent).toContain('1 SOL');
  await act(async () => button('Save session and reserve wallets').click());
  await vi.waitFor(() =>
    expect(calls.some((c) => c.payload?.action === 'create')).toBe(true),
  );
  const create = calls.find((c) => c.payload?.action === 'create')!;
  expect(create.payload!.seed).toBe(estimate.payload!.seed);
});

it('signs an approved batch locally, registers it and sends each trade once', async () => {
  const bytes = Uint8Array.from([
    1,
    ...new Uint8Array(64),
    128,
    ...solanaTransferMessage(
      address,
      MINT,
      '11111111111111111111111111111111',
      1n,
    ),
    0,
  ]);
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer)),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
  const review = await createVolumeBatchReview({
    id: '00000000-0000-4000-8000-000000000009',
    sessionId: '00000000-0000-4000-8000-000000000008',
    batch: 0,
    mint: MINT,
    decimals: 6,
    trades: [
      {
        index: 0,
        round: 0,
        side: 'Buy',
        wallet: address,
        batchOffsetMs: 0,
        inAmountRaw: '100000000',
        minimumOutRaw: '995',
        estimatedFeesLamports: '5000',
        transaction: btoa(String.fromCharCode(...bytes)),
        packetSha256: digest,
        lastValidBlockHeight: '1000',
      },
    ],
    skipped: [],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const session = {
    id: review.sessionId,
    projectId: PROJECT,
    state: 'active',
    createdAt: '2026-10-17T00:00:00.000Z',
    plan: { batches: 2, wallets: [address] },
    realized: { finalizedTrades: 0, volumeLamports: '0', netSolLamports: '0' },
    batches: [
      {
        id: review.id,
        batch: 0,
        state: 'review',
        expiresAt: review.expiresAt,
        review,
        trades: [],
      },
    ],
  } as unknown as VolumeSession;
  respond = () => ({ sessions: [session] });
  await act(async () =>
    root.render(
      <VolumeBotPanel project={project} wallets={[wallet()]} locked={false} />,
    ),
  );
  await act(async () => button('Open Volume Bot').click());
  await settle();
  expect(container.textContent).toContain('Batch 1');
  const pass = container.querySelector(
    'input[type=password]',
  ) as HTMLInputElement;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!;
    set.call(pass, 'panel synthetic vault');
    pass.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Unlock wallets').click());
  await vi.waitFor(() =>
    expect(container.textContent).toContain('Wallets unlocked'),
  );
  // Signing needs the explicit per-batch approval first.
  expect(button('Sign and send batch').disabled).toBe(true);
  const approval = [...container.querySelectorAll('input[type=checkbox]')].at(
    -1,
  ) as HTMLInputElement;
  await act(async () => approval.click());
  await act(async () => button('Sign and send batch').click());
  await vi.waitFor(() =>
    expect(calls.some((c) => c.payload?.action === 'send')).toBe(true),
  );
  const register = calls.find((c) => c.payload?.action === 'register')!;
  expect(register.payload).toMatchObject({
    batchId: review.id,
    consent: {
      reviewId: review.id,
      sha256: review.sha256,
      scope: 'volume-bot-batch',
    },
  });
  expect((register.payload!.transactions as string[])[0]).not.toBe(
    review.trades[0].transaction,
  );
  expect(
    calls.filter((c) => c.payload?.action === 'send').map((c) => c.payload),
  ).toEqual([{ action: 'send', batchId: review.id, index: 0 }]);
}, 30_000);
