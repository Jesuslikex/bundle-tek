// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import {
  importedTokenDocument,
  type ImportedTokenProject,
} from '@/lib/imported-token-project';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import type { SavedTokenMarket } from '@/lib/token-market';
import {
  conditionalOrderTerms,
  type ConditionalOrder,
} from '@/lib/conditional-order';
import type { ImportedSwapReceipt } from '@/lib/imported-approval-history';

const prepared = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
}));
vi.mock('./imported-swap-preparation', () => ({
  ImportedSwapPreparation: (props: Record<string, unknown>) => {
    prepared.props = props;
    return (
      <output>
        Explicit unsigned {String(props.side)} preparation selected
      </output>
    );
  },
}));
vi.mock('./imported-approval-history', () => ({
  ImportedApprovalHistory: () => (
    <output>Explicit approval recovery selected</output>
  ),
}));
import { MarketConditionReview } from './market-condition-review';

const projectId = '11111111-1111-4111-8111-111111111111';
const mint = bs58.encode(new Uint8Array(32).fill(3));
const pair = bs58.encode(new Uint8Array(32).fill(4));
const wallet: WorkspaceWallet = {
  chain: 'Solana',
  address: bs58.encode(new Uint8Array(32).fill(2)),
  folderId: 'fixture',
  folderIds: ['fixture'],
  label: 'Fixture wallet',
  role: 'Recipient',
  archived: false,
  revision: 2,
  updatedAt: '2026-10-13T00:00:00.000Z',
};
let project: ImportedTokenProject, observation: SavedTokenMarket;
let container: HTMLDivElement, root: Root;
let orders: ConditionalOrder[], writes: Record<string, unknown>[];
let returnedSide: 'Buy' | 'Sell' | null;
let holdWrite: ((response: Response) => void) | null;
let writeSignal: AbortSignal | null | undefined;
let pendingWrite: boolean;
let onReviewBuy: (receipt: ImportedSwapReceipt) => void;

function order(
  side: 'Buy' | 'Sell',
  amount: string,
  kind: 'limit' | 'grid' = 'limit',
): ConditionalOrder {
  return {
    id: crypto.randomUUID(),
    revision: 1,
    state: 'draft',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    terms: conditionalOrderTerms(
      {
        side,
        amount,
        kind,
        projectId,
        projectRevision: 1,
        wallet: wallet.address,
        walletRevision: 2,
        pair,
        direction: side === 'Buy' ? 'at-or-below' : 'at-or-above',
        targetUsd: '100',
        minimumUsd: '100',
        maximumUsd: '200',
        lines: 3,
      },
      project.document.token,
    ),
  };
}
function button(name: string) {
  const found = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(name),
  );
  if (!found) throw new Error('Missing button: ' + name);
  return found;
}
async function click(name: string) {
  await act(async () => button(name).click());
}
async function select(label: string, value: string) {
  const found = [...container.querySelectorAll('label')].find((l) =>
    l.textContent?.trim().startsWith(label),
  );
  const element = found?.querySelector('select');
  if (!element) throw new Error('Missing select: ' + label);
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function input(suffix: string, value: string) {
  const element = [
    ...container.querySelectorAll<HTMLInputElement>(`input[id$='${suffix}']`),
  ].find(
    (candidate) => suffix !== 'amount' || !candidate.id.endsWith('limitamount'),
  );
  if (!element) throw new Error('Missing input: ' + suffix);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function buyLimit() {
  await select('Conditional trade direction', 'Buy');
  await input('target', '100');
  await input('limitamount', '0.000000011');
  await click('Review market-cap condition');
  await click('Load saved orders');
  await select('Draft buy wallet', wallet.address);
}
beforeEach(async () => {
  const now = new Date().toISOString();
  project = {
    id: projectId,
    revision: 1,
    archived: false,
    updatedAt: now,
    document: importedTokenDocument(
      { chain: 'Solana', address: mint },
      {
        chain: 'Solana',
        address: mint,
        name: 'Fixture token',
        symbol: 'FIX',
        decimals: 6,
        totalSupplyRaw: '1000000000000',
        metadataUri: '',
        observedAt: now,
        source: 'https://fixture.test',
        contextSlot: 1,
      },
    ),
  };
  observation = {
    executionAllowed: false,
    chain: 'Solana',
    address: mint,
    source: 'api.dexscreener.com',
    observedAt: now,
    projectRevision: 1,
    returnedPairCount: 1,
    quoteOnlyPairCount: 0,
    pairs: [
      {
        address: pair,
        dex: 'fixture',
        url: 'https://fixture.test/pool',
        quoteSymbol: 'SOL',
        priceUsd: '0.01',
        marketCapUsd: 80,
        liquidityUsd: 100,
        volume24hUsd: null,
        change24h: null,
      },
    ],
  };
  orders = [];
  writes = [];
  returnedSide = null;
  pendingWrite = false;
  holdWrite = null;
  writeSignal = null;
  prepared.props = null;
  onReviewBuy = vi.fn();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/wallet-workspace')
        return Response.json({ wallets: [wallet] });
      if (init?.method !== 'POST')
        return Response.json({
          projectId,
          orders,
          levels: [],
          executionAllowed: false,
        });
      if (typeof init.body !== 'string')
        throw new Error('Expected a JSON-string request body.');
      const body = JSON.parse(init.body) as Record<string, unknown>;
      writes.push(body);
      if (pendingWrite) {
        writeSignal = init.signal;
        return new Promise<Response>((resolve) => {
          holdWrite = resolve;
        });
      }
      const terms = conditionalOrderTerms(
        returnedSide ? { ...body, side: returnedSide, amount: '1' } : body,
        project.document.token,
      );
      const saved = {
        id: body.orderId,
        revision: 1,
        state: 'draft',
        terms,
        createdAt: now,
        updatedAt: now,
      };
      return Response.json({ executionAllowed: false, order: saved });
    }),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <MarketConditionReview
        project={project}
        observation={observation}
        pair={pair}
        onReviewBuy={onReviewBuy}
      />,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it('saves an exact nine-decimal SOL Buy limit for a six-decimal token and prepares only after explicit selection', async () => {
  expect(fetch).not.toHaveBeenCalled();
  await buyLimit();
  expect(prepared.props).toBeNull();
  await click('Save limit draft');
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    side: 'Buy',
    direction: 'at-or-below',
    amount: '0.000000011',
    kind: 'limit',
    wallet: wallet.address,
    walletRevision: 2,
  });
  expect(container.textContent).toContain('0.000000011 SOL input budget');
  expect(container.textContent).toContain('Buy with 0.000000011 SOL');
  expect(prepared.props).toBeNull();
  await click('Prepare level 1');
  expect(prepared.props).toMatchObject({
    side: 'Buy',
    amount: '0.000000011',
    onReviewBuy,
  });
  expect(writes).toHaveLength(1);
});
it('allocates a SOL Buy grid without rounding away lamports and saves its below-market direction', async () => {
  await select('Conditional trade direction', 'Buy');
  await input('minimum', '100');
  await input('maximum', '200');
  await input('lines', '3');
  await input('amount', '0.000000011');
  await click('Review grid allocations');
  const rows = [...container.querySelectorAll('tbody tr')].map((row) =>
    [...row.querySelectorAll('td')].map((cell) => cell.textContent),
  );
  expect(rows.map((row) => row[3])).toEqual(['3', '3', '5']);
  expect(container.textContent).toContain('SOL input budget');
  await click('Load saved orders');
  await select('Draft buy wallet', wallet.address);
  await click('Save grid draft');
  expect(writes[0]).toMatchObject({
    side: 'Buy',
    direction: 'at-or-below',
    amount: '0.000000011',
    lines: 3,
  });
  expect(prepared.props).toBeNull();
});
it('renders mixed legacy Sell and new Buy drafts with their own denominations and queue actions', async () => {
  orders = [order('Sell', '2.5'), order('Buy', '0.000000011')];
  await click('Load saved orders');
  expect(container.textContent).toContain('2.5 FIX total');
  expect(container.textContent).toContain('0.000000011 SOL input budget');
  await click('Follow incoming market samples');
  const queue = container.querySelector(
    "section[aria-label='Conditional trigger queue']",
  )!;
  expect(queue.textContent).toContain('buy with 0.000000011 SOL');
  expect(queue.textContent).not.toContain('sell 0.000000011 tokens');
  await click('Review matching level 1');
  expect(prepared.props).toMatchObject({ side: 'Buy', amount: '0.000000011' });
  expect(writes).toHaveLength(0);
});
it('refuses a Sell-denominated response to a Buy save and never selects a preparation', async () => {
  await buyLimit();
  returnedSide = 'Sell';
  await click('Save limit draft');
  expect(container.querySelector('[role=alert]')?.textContent).toContain(
    'Saved draft terms differ',
  );
  expect(container.textContent).not.toContain('SOL input budget');
  expect(prepared.props).toBeNull();
});
it('aborts an in-flight Buy save and clears the SOL previews when the direction changes', async () => {
  await buyLimit();
  pendingWrite = true;
  await click('Save limit draft');
  expect(writeSignal?.aborted).toBe(false);
  await select('Conditional trade direction', 'Sell');
  expect(writeSignal?.aborted).toBe(true);
  expect(
    container.querySelector<HTMLInputElement>("input[id$='limitamount']")!
      .value,
  ).toBe('');
  const body = writes[0];
  await act(async () =>
    holdWrite!(
      Response.json({
        executionAllowed: false,
        order: {
          id: body.orderId,
          revision: 1,
          state: 'draft',
          terms: conditionalOrderTerms(body, project.document.token),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }),
    ),
  );
  expect(container.textContent).not.toContain('SOL input budget');
  expect(prepared.props).toBeNull();
});
