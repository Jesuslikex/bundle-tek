// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TokenToolsPanel } from './token-tools-panel';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import { prepareAirdrop } from '@/lib/token-airdrop-server';
import type {
  TokenAirdropAction,
  TokenAirdropReview,
} from '@/lib/token-airdrop';
import {
  airdropChain,
  CREATOR,
  MINT,
  OUT1,
  OUT2,
  signal,
} from '../test/token-airdrop-fixture';

const wallet = (address: string, label: string): WorkspaceWallet => ({
  chain: 'Solana',
  address,
  folderId: '',
  label,
  role: 'Deployer' as WorkspaceWallet['role'],
  archived: false,
  revision: 1,
  updatedAt: '2026-10-17T00:00:00.000Z',
});
const WALLETS = [
  wallet(CREATOR, 'Dev'),
  wallet(OUT1, 'Out one'),
  wallet(OUT2, 'Out two'),
];
const row = (
  document: TokenAirdropReview,
  state: TokenAirdropAction['state'] = 'awaiting_signature',
): TokenAirdropAction => ({
  id: document.id,
  airdropId: document.terms.airdropId,
  wallet: document.wallet,
  walletRevision: 1,
  kind: document.kind,
  mint: MINT,
  state,
  signature:
    state === 'finalized'
      ? '5'.repeat(88) // 64 bytes in base58
      : null,
  document,
  receipt:
    state === 'finalized'
      ? {
          network: 'mainnet',
          commitment: 'finalized',
          signature: '5'.repeat(88),
          failed: false,
          error: null,
          slot: 200,
          blockTime: 1,
          networkFeeLamports: '5000',
          walletLamportsChange: '-5000',
          tokenChangeRaw: document.tokenChangeRaw,
          observedAt: document.preparedAt,
        }
      : null,
  createdAt: document.preparedAt,
  updatedAt: document.preparedAt,
});
let root: Root, container: HTMLDivElement;
const responses: (() => unknown)[] = [];
const requests: { url: string; body: Record<string, unknown> | null }[] = [];
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  responses.length = 0;
  requests.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit = {}) => {
      requests.push({
        url,
        body: options.body ? JSON.parse(options.body as string) : null,
      });
      const next = responses.shift();
      if (!next) throw new Error('unexpected request ' + url);
      return new Response(JSON.stringify(next()), { status: 200 });
    }),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const button = (text: string) =>
  [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  )!;
const click = (el: Element) =>
  act(async () => {
    (el as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 40));
  });
async function type(el: Element, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const labelled = (text: string) => {
  const label = [...container.querySelectorAll('label')].find((l) =>
    l.textContent?.trim().startsWith(text),
  )!;
  return label.htmlFor
    ? document.getElementById(label.htmlFor)!
    : label.querySelector('input')!;
};
async function mount() {
  await act(async () => root.render(<TokenToolsPanel wallets={WALLETS} />));
  await click(button('Open token tools'));
  await click(button('Streamflow Airdrop'));
  await type(labelled('Token mint'), MINT);
}
const createReview = (chain = airdropChain()) =>
  prepareAirdrop(
    {
      kind: 'create',
      wallet: CREATOR,
      walletRevision: 1,
      mint: MINT,
      percentPpm: 500_000n,
      recipients: [OUT1, OUT2],
    },
    signal(),
    chain.fetcher,
  );

it('drafts an airdrop only with output wallets and the acknowledgement, and gates signing on approval', async () => {
  const document = await createReview();
  await mount();
  await type(labelled('Amount (% of the input'), '50');
  expect(button('Draft airdrop').disabled).toBe(true);
  // The input wallet is not offered as an output.
  expect(
    [...container.querySelectorAll('fieldset label')].map((l) =>
      l.textContent?.trim(),
    ),
  ).toEqual(['Out one · Deployer', 'Out two · Deployer']);
  await click(labelled('Out one'));
  await click(labelled('Out two'));
  expect(button('Draft airdrop').disabled).toBe(true);
  await click(labelled('I understand the tokens leave'));
  responses.push(() => ({ action: row(document) }));
  await click(button('Draft airdrop'));
  expect(requests[0].body).toEqual({
    action: 'prepare_create',
    wallet: CREATOR,
    walletRevision: 1,
    mint: MINT,
    percent: '50',
    recipients: [OUT1, OUT2],
    acknowledgeAirdrop: true,
  });
  expect(container.textContent).toContain(
    `500 tokens (50% of the balance) leave ${CREATOR} for 2 output wallets, 250 each.`,
  );
  expect(container.textContent).toContain('0 claimed · 0 failed · 2 open');
  expect(button('Sign in this browser').disabled).toBe(true);
  await type(labelled('Vault password'), 'pw');
  expect(button('Sign in this browser').disabled).toBe(true);
  await click(labelled('I approve signing'));
  expect(button('Sign in this browser').disabled).toBe(false);
  // Nothing was signed or sent by drafting.
  expect(requests).toHaveLength(1);
});

it('refuses a server review whose packet does not match its terms', async () => {
  const document = await createReview();
  await mount();
  await type(labelled('Amount (% of the input'), '50');
  await click(labelled('Out one'));
  await click(labelled('I understand the tokens leave'));
  responses.push(() => ({
    action: row({
      ...document,
      terms: { ...document.terms, recipients: [OUT1, CREATOR] },
    }),
  }));
  await click(button('Draft airdrop'));
  expect(container.querySelector('[role=alert]')?.textContent).toBeTruthy();
  expect(button('Sign in this browser')).toBeUndefined();
});

it('shows claim counts and resumes with the next unclaimed wallet', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const chain = airdropChain();
  const document = await createReview(chain);
  chain.state.created = true;
  chain.state.vault = 500_000_000n;
  chain.state.balances[CREATOR] -= 500_000_000n;
  vi.setSystemTime(document.terms.startTs * 1000 + 30_000);
  const claim = (who: string) =>
    prepareAirdrop(
      { kind: 'claim', wallet: who, walletRevision: 1, parent: document },
      signal(),
      chain.fetcher,
    );
  const first = await claim(OUT1),
    second = await claim(OUT2);
  await mount();
  responses.push(() => ({ actions: [row(document, 'finalized')] }));
  await click(button('Reload airdrops'));
  expect(requests[0].url).toContain('?wallet=' + CREATOR);
  responses.push(() => ({
    actions: [row(first, 'finalized'), row(document, 'finalized')],
  }));
  await click(button('Open'));
  expect(requests[1].url).toContain('?airdrop=' + document.id);
  expect(container.textContent).toContain('1 claimed · 0 failed · 1 open');
  expect(container.textContent).toContain('Out one · 250 · claimed');
  expect(container.textContent).toContain('Out two · 250 · not claimed');
  // Take-back stays locked until its date.
  expect(button('Take back unclaimed').disabled).toBe(true);
  responses.push(() => ({ action: row(second) }));
  await click(button('Resume / Retry Airdrop'));
  expect(requests[2].body).toEqual({
    action: 'prepare_claim',
    airdropId: document.id,
    wallet: OUT2,
    walletRevision: 1,
  });
  expect(container.textContent).toContain(
    `${OUT2} claims 250 tokens from the airdrop.`,
  );
  expect(button('Sign in this browser').disabled).toBe(true);
});
