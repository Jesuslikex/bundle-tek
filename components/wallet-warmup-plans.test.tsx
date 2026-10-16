// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WalletWarmupPlans } from './wallet-warmup-plans';
import { buildWarmupPlan } from '@/lib/wallet-warmup';
import type { SavedWarmup } from '@/lib/wallet-warmup-storage';
let container: HTMLDivElement, root: Root;
const wallet = '11111111111111111111111111111111',
  id = '6ef53658-0746-4567-9e63-af3d4428d144';
const now = Date.UTC(2026, 9, 16);
const plan = buildWarmupPlan(
  {
    chain: 'Solana',
    addresses: [wallet],
    tokens: ['So11111111111111111111111111111111111111112'],
    amount: '0.001',
    feeReserve: '0.002',
    cycles: 2,
    intervalMinutes: 15,
    startAt: new Date(now + 3600000).toISOString(),
  },
  now,
);
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('crypto', { randomUUID: () => id });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const alert = () => container.querySelector('[role="alert"]')?.textContent;
async function mount(fetcher: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetcher);
  await act(async () =>
    root.render(
      <WalletWarmupPlans
        chain="Solana"
        addresses={[wallet]}
        walletRevisions={[{ address: wallet, revision: 3 }]}
        plan={plan}
        onLoad={() => {}}
      />,
    ),
  );
}
async function click(text: string) {
  const button = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent === text,
  );
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
const broken = () =>
  new Response('<html>Bad gateway</html>', {
    status: 502,
    headers: { 'content-type': 'text/html' },
  });
it.each([
  'HTML',
  'malformed JSON',
  'null JSON',
  'empty error',
  'object error',
] as const)(
  'shows a usable saved-plan loading error for %s',
  async (format) => {
    const response =
      format === 'HTML'
        ? broken()
        : format === 'malformed JSON'
          ? new Response('{', {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          : Response.json(
              format === 'null JSON'
                ? null
                : format === 'empty error'
                  ? { error: '' }
                  : { error: { detail: 'gateway' } },
              { status: 503 },
            );
    await mount(vi.fn(async () => response));
    expect(alert()).toBe('Warmup plans unavailable.');
    expect(container.textContent).not.toContain('Bad gateway');
  },
);
it('retains existing saved rows when a reload returns HTML, then allows a successful reload', async () => {
  const other: SavedWarmup = {
    id,
    revision: 1,
    archived: false,
    updatedAt: new Date(now).toISOString(),
    document: {
      name: 'Other chain draft',
      chain: 'Base',
      addresses: ['0x0000000000000000000000000000000000000001'],
      tokens: ['0x0000000000000000000000000000000000000002'],
      amount: '0.001',
      feeReserve: '0.002',
      cycles: 1,
      intervalMinutes: 15,
      startAt: plan.startAt,
      totalBudget: '0.003',
      walletRevisions: [
        { address: '0x0000000000000000000000000000000000000001', revision: 1 },
      ],
    },
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ plans: [other] }))
    .mockResolvedValueOnce(broken())
    .mockResolvedValueOnce(Response.json({ plans: [other] }));
  await mount(fetcher);
  expect(container.textContent).toContain('1/100 saved');
  await click('Reload warmup plans');
  expect(alert()).toBe('Warmup plans unavailable.');
  expect(container.textContent).toContain('1/100 saved');
  await click('Reload warmup plans');
  expect(alert()).toBeUndefined();
  expect(container.querySelector('output')?.textContent).toContain(
    'Saved plans reloaded.',
  );
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it('sanitizes an HTML mutation failure without changing the reviewed save payload or retrying', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ plans: [] }))
    .mockResolvedValueOnce(broken());
  await mount(fetcher);
  await click('Save warmup draft');
  expect(alert()).toBe('Warmup save failed.');
  expect(container.querySelector('output')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
  const init = fetcher.mock.calls[1][1] as RequestInit;
  expect(init.method).toBe('POST');
  expect(typeof init.body).toBe('string');
  expect(JSON.parse(init.body as string)).toEqual({
    id,
    expectedRevision: 0,
    action: 'save',
    document: {
      name: 'Wallet warmup',
      chain: 'Solana',
      addresses: plan.addresses,
      tokens: plan.tokens,
      amount: plan.buyAmount,
      feeReserve: plan.feeReserve,
      cycles: plan.cycles,
      intervalMinutes: plan.intervalMinutes,
      startAt: plan.startAt,
      walletRevisions: [{ address: wallet, revision: 3 }],
    },
  });
});
it('does not show save success when the subsequent plan refresh returns HTML', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ plans: [] }))
    .mockResolvedValueOnce(Response.json({ ok: true }))
    .mockResolvedValueOnce(broken());
  await mount(fetcher);
  await click('Save warmup draft');
  expect(alert()).toBe('Warmup plans unavailable.');
  expect(container.querySelector('output')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it('preserves a JSON revision-conflict explanation without resending the mutation', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ plans: [] }))
    .mockResolvedValueOnce(
      Response.json(
        { error: 'Saved plan changed. Reload before saving.' },
        { status: 409 },
      ),
    );
  await mount(fetcher);
  await click('Save warmup draft');
  expect(alert()).toBe('Saved plan changed. Reload before saving.');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
