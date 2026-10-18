// @vitest-environment jsdom
import { act } from 'react';
import { webcrypto } from 'node:crypto';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountLaunchSaleAllocationsPanel } from './account-launch-sale-allocations';
import { accountLaunchPurchasesFixture } from '../test/account-launch-purchases-fixture';
import { launchPurchaseDigest } from '../lib/account-launch-purchases';
let host: HTMLDivElement,
  root: Root,
  f: Awaited<ReturnType<typeof accountLaunchPurchasesFixture>>;
const request = vi.fn<typeof fetch>();
const saleId = 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  projectId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status });
let lose = false,
  saved: unknown = null,
  evidence: unknown = null,
  plan: Record<string, unknown>;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('crypto', webcrypto);
  f = await accountLaunchPurchasesFixture();
  const s = f.history.sources[0];
  const core = {
    format: 'launch-sale-allocation-v1',
    policy: 'recorded-launch-units-v1',
    saleReceiptId: saleId,
    saleEvidenceSha256: 'a'.repeat(64),
    saleSignature: 'sig',
    wallet: s.wallet,
    mint: f.context.mint,
    decimals: 6,
    saleSlot: '300',
    soldRaw: '1000',
    allocations: [
      {
        originId: s.originId,
        sourceSha256: s.sha256,
        receiptSha256: 'b'.repeat(64),
        buySlot: '250',
        beforeRaw: '0',
        unitsRaw: '1000',
        afterRaw: '1000',
      },
    ],
    executionAllowed: false,
    signingAllowed: false,
    profitCalculated: false,
    acquisitionBasisVerified: false,
  };
  plan = { ...core, sha256: await launchPurchaseDigest(core) };
  saved = null;
  evidence = null;
  lose = false;
  request.mockReset();
  request.mockImplementation(async (input, init) => {
    const url = input as string;
    const body = init?.body ? JSON.parse(init.body as string) : null;
    const summary = {
      receiptId: saleId,
      mint: f.context.mint,
      wallet: s.wallet,
      entry: evidence,
    };
    if (url === '/api/imported-projects')
      return json({
        projects: [
          {
            id: projectId,
            archived: false,
            document: { token: { address: f.context.mint, symbol: 'TEST' } },
          },
          {
            id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
            archived: false,
            document: { token: { address: 'other' } },
          },
        ],
      });
    if (url.startsWith('/api/imported-projects/receipts'))
      return json({
        mint: f.context.mint,
        receipts: [
          {
            id: saleId,
            createdAt: '2026-10-18T00:00:00Z',
            document: {
              side: 'Sell',
              commitment: 'finalized',
              wallet: s.wallet,
              tokenUnitsRaw: '1000',
              slot: 300,
            },
          },
          {
            id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
            createdAt: '2026-10-18T00:00:00Z',
            document: {
              side: 'Buy',
              commitment: 'finalized',
              wallet: s.wallet,
              tokenUnitsRaw: '1',
              slot: 1,
            },
          },
        ],
        nextCursor: url.includes('cursor') ? null : saleId,
      });
    if (url.includes('/sale-evidence')) {
      if (init?.method === 'POST') {
        expect(body).toEqual({ saleReceiptId: saleId });
        evidence = {
          sha256: 'a'.repeat(64),
          observedAt: '2026-10-18T00:00:00Z',
          slot: 300,
          tokenUnitsRaw: '1000',
          networkFeeLamports: '5000',
          nativeSettlementRaw: '-5000',
          executionAllowed: false,
          profitCalculated: false,
        };
        return json({ ...summary, entry: evidence });
      }
      return json(summary);
    }
    if (url.includes('/purchases')) return json(f.history);
    if (url.includes('/sale-allocations')) {
      // Real contract: allocation reads need retained sale evidence.
      if (!evidence)
        return json({ error: 'Retained sale evidence was not found.' }, 404);
      if (init?.method === 'POST' && body.action === 'record' && lose) {
        saved = plan;
        throw new TypeError('Failed to fetch');
      }
      if (init?.method === 'POST' && body.action === 'review')
        return json({ plan, executionAllowed: false, profitCalculated: false });
      if (init?.method === 'POST' && body.action === 'record') {
        expect(body).toMatchObject({
          approved: true,
          planSha256: plan.sha256,
          policy: 'recorded-launch-units-v1',
        });
        saved = plan;
      }
      return json({
        saleReceiptId: saleId,
        plan: saved,
        executionAllowed: false,
        profitCalculated: false,
      });
    }
    return json({ error: 'unexpected' }, 500);
  });
  vi.stubGlobal('fetch', request);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <AccountLaunchSaleAllocationsPanel
        reviewId={f.context.reviewId}
        mint={f.context.mint}
      />,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(label),
  );
async function click(label: string) {
  expect(button(label)).toBeDefined();
  await act(async () => button(label)!.click());
}
const until = (text: string) =>
  vi.waitFor(() => expect(host.textContent).toContain(text));
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
it('stays idle until asked, then captures, reviews, requires approval, saves and reloads', async () => {
  expect(request).not.toHaveBeenCalled();
  await click('Find sales');
  await until('Finalized sells in the first page');
  expect(host.textContent).toContain('Older trades are not loaded yet');
  expect(host.textContent).not.toContain('raw units, slot 1');
  await click('Load older trades');
  await until('the first 2 pages');
  await click('1000 raw units, slot 300');
  await until('not retained yet');
  await click('Retain sale evidence');
  await until('Assign all of them');
  await type(
    host.querySelector<HTMLInputElement>('input[inputmode=numeric]')!,
    '1000',
  );
  await click('Review assignment');
  await until(String(plan.sha256));
  expect(button('Save assignment')!.disabled).toBe(true);
  await act(async () =>
    host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(),
  );
  await click('Save assignment');
  await until('Saved. These buys were recorded');
  const writes = request.mock.calls.filter(([, i]) => i?.method === 'POST');
  expect(
    writes.map(([u, i]) => [
      u,
      JSON.parse(i!.body as string).action ?? 'capture',
    ]),
  ).toEqual([
    ['/api/account-launch-activity/sale-evidence', 'capture'],
    ['/api/account-launch-activity/sale-allocations', 'review'],
    ['/api/account-launch-activity/sale-allocations', 'record'],
  ]);
});
it('refuses a reviewed plan whose hash or units differ from the request', async () => {
  evidence = {
    sha256: 'a'.repeat(64),
    observedAt: 'x',
    slot: 300,
    tokenUnitsRaw: '1000',
    networkFeeLamports: '0',
    nativeSettlementRaw: '0',
    executionAllowed: false,
    profitCalculated: false,
  };
  plan = { ...plan, sha256: 'f'.repeat(64) };
  await click('Find sales');
  await click('1000 raw units, slot 300');
  await until('Assign all of them');
  await type(
    host.querySelector<HTMLInputElement>('input[inputmode=numeric]')!,
    '1000',
  );
  await click('Review assignment');
  await until('response differs');
  expect(button('Save assignment')).toBeUndefined();
});
it('explains a missing import instead of showing an empty sales list', async () => {
  request.mockImplementationOnce(async () => json({ projects: [] }));
  await click('Find sales');
  await until('No imported token matches this mint');
});

const retained = () => ({
  sha256: 'a'.repeat(64),
  observedAt: 'x',
  slot: 300,
  tokenUnitsRaw: '1000',
  networkFeeLamports: '0',
  nativeSettlementRaw: '0',
  executionAllowed: false,
  profitCalculated: false,
});
async function reviewed() {
  await click('Find sales');
  await click('1000 raw units, slot 300');
  await until('Assign all of them');
  await type(
    host.querySelector<HTMLInputElement>('input[inputmode=numeric]')!,
    '1000',
  );
  await click('Review assignment');
  await until(String(plan.sha256));
  await act(async () =>
    host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(),
  );
}
it('skips the allocation read until evidence is retained', async () => {
  await click('Find sales');
  await click('1000 raw units, slot 300');
  await until('not retained yet');
  expect(
    request.mock.calls.some(([u]) =>
      (u as string).includes('/sale-allocations'),
    ),
  ).toBe(false);
});
it('never sends a second record after a lost save, and recovers from a saved-only read', async () => {
  evidence = retained();
  lose = true;
  await reviewed();
  await click('Save assignment');
  await until('Failed to fetch');
  expect(button('Save assignment')).toBeUndefined();
  expect(
    host.querySelector<HTMLInputElement>('input[type=checkbox]'),
  ).toBeNull();
  expect(button('Find sales')!.disabled).toBe(true);
  await click('Check saved status');
  await until('Saved. These buys were recorded');
  const records = request.mock.calls.filter(
    ([, i]) =>
      i?.method === 'POST' &&
      (JSON.parse(i.body as string) as { action?: string }).action === 'record',
  );
  expect(records).toHaveLength(1);
});
it('clears all state when the launch changes and ignores the old response', async () => {
  evidence = retained();
  await reviewed();
  let release!: () => void;
  request.mockImplementationOnce(
    (_u, i) =>
      new Promise((resolve, reject) => {
        i?.signal?.addEventListener('abort', () =>
          reject(new DOMException('x', 'AbortError')),
        );
        release = () => resolve(json({ projects: [] }));
      }),
  );
  await act(async () =>
    root.render(
      <AccountLaunchSaleAllocationsPanel
        reviewId={f.context.reviewId}
        mint="Other111111111111111111111111111111111111"
      />,
    ),
  );
  expect(host.textContent).not.toContain(String(plan.sha256));
  expect(host.textContent).not.toContain('Finalized sells');
  release?.();
});
it('rejects an oversized response without buffering it whole', async () => {
  request.mockImplementationOnce(async () => new Response('x'.repeat(1048577)));
  await click('Find sales');
  await until('Response is too large');
});
it('drops consent when only the launch review changes, and does not restore it on return', async () => {
  evidence = retained();
  await reviewed();
  const other = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  await act(async () =>
    root.render(
      <AccountLaunchSaleAllocationsPanel
        reviewId={other}
        mint={f.context.mint}
      />,
    ),
  );
  expect(button('Save assignment')).toBeUndefined();
  await act(async () =>
    root.render(
      <AccountLaunchSaleAllocationsPanel
        reviewId={f.context.reviewId}
        mint={f.context.mint}
      />,
    ),
  );
  expect(button('Save assignment')).toBeUndefined();
  expect(host.querySelector('input[type=checkbox]')).toBeNull();
});
