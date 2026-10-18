// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WalletWarmupPlans } from './wallet-warmup-plans';
import { buildWarmupPlan } from '@/lib/wallet-warmup';
import type { SavedWarmup } from '@/lib/wallet-warmup-storage';
import { warmupUiFixture } from '../test/warmup-ui-fixture';
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
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
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
  vi.useRealTimers();
});
const alert = () => container.querySelector('[role="alert"]')?.textContent;
async function mount(fetcher: ReturnType<typeof vi.fn>, onLoad = vi.fn()) {
  vi.stubGlobal('fetch', fetcher);
  await act(async () =>
    root.render(
      <WalletWarmupPlans
        chain="Solana"
        addresses={[wallet]}
        walletRevisions={[{ address: wallet, revision: 3 }]}
        plan={plan}
        onLoad={onLoad}
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
  await click('Reload drafts');
  expect(alert()).toBe('Warmup plans unavailable.');
  expect(container.textContent).toContain('1/100 saved');
  await click('Reload drafts');
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
  await click('Save draft');
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
  await click('Save draft');
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
  await click('Save draft');
  expect(alert()).toBe('Saved plan changed. Reload before saving.');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('times out stalled plan reads, enables manual retry and ignores a late response', async () => {
  vi.useFakeTimers();
  let resolve!: (response: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((r) => {
        resolve = r;
      }),
  );
  await mount(fetcher);
  await act(async () => vi.advanceTimersByTime(30000));
  expect(alert()).toContain('Plan request took too long');
  const reload = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent === 'Reload drafts',
  )!;
  expect(reload.disabled).toBe(false);
  await act(async () =>
    resolve(Response.json({ plans: [{ id: 'late-untrusted' }] })),
  );
  expect(container.textContent).toContain('0/100 saved');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('reuses a new draft identity on explicit save retry instead of creating duplicates', async () => {
  const uuid = vi.fn().mockReturnValueOnce(id).mockReturnValueOnce('other-id');
  vi.stubGlobal('crypto', { randomUUID: uuid });
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ plans: [] }))
    .mockResolvedValueOnce(broken())
    .mockResolvedValueOnce(broken());
  await mount(fetcher);
  await click('Save draft');
  await click('Save draft');
  const first = JSON.parse(
    (fetcher.mock.calls[1][1] as RequestInit).body as string,
  ) as { id: string };
  const second = JSON.parse(
    (fetcher.mock.calls[2][1] as RequestInit).body as string,
  ) as { id: string };
  expect(first.id).toBe(id);
  expect(second.id).toBe(first.id);
  expect(uuid).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('Reload saved plans before retrying');
});
it('recovers a save that completed after cancellation by reloading its original identity', async () => {
  const stored: SavedWarmup = {
    id,
    revision: 1,
    archived: false,
    updatedAt: new Date(now).toISOString(),
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
      totalBudget: plan.totalBudget,
      walletRevisions: [{ address: wallet, revision: 3 }],
    },
  };
  let resolve!: (response: Response) => void;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ plans: [] }))
    .mockImplementationOnce(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    )
    .mockResolvedValueOnce(Response.json({ plans: [stored] }));
  const onLoad = vi.fn();
  await mount(fetcher, onLoad);
  await click('Save draft');
  await click('Cancel plan request');
  await click('Reload drafts');
  expect(container.textContent).toContain('Saved draft found');
  expect(container.textContent).toContain('Editing draft');
  expect(onLoad).toHaveBeenCalledWith(stored.document);
  await act(async () => resolve(Response.json({ ok: true })));
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(container.textContent).toContain('Editing draft');
});
it.each(['changed', 'missing', 'archived'] as const)(
  'blocks stale saves after reload finds the draft %s',
  async (state) => {
    const stored = warmupUiFixture().plan;
    const latest = {
      ...stored,
      revision: stored.revision + 1,
      archived: state === 'archived',
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ plans: [stored] }))
      .mockResolvedValueOnce(
        Response.json({ plans: state === 'missing' ? [] : [latest] }),
      );
    const onLoad = vi.fn();
    await mount(fetcher, onLoad);
    await click('Edit draft');
    onLoad.mockClear();
    await click('Reload drafts');
    expect(container.textContent).toContain('Your edits are kept');
    const save = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save changes',
    )!;
    expect(save.disabled).toBe(true);
    expect(onLoad).not.toHaveBeenCalled();
    if (state === 'changed') {
      await click('Edit draft');
      expect(onLoad).toHaveBeenCalledWith(latest.document);
      expect(save.disabled).toBe(false);
    } else {
      await click('New draft');
      expect(container.textContent).toContain('New saved draft');
      expect(save.disabled).toBe(false);
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);

it('refuses an expired reviewed start locally and provides a review recovery action', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ plans: [] }));
  await mount(fetcher);
  await act(async () => vi.advanceTimersByTime(61 * 60000));
  await click('Save draft');
  expect(alert()).toContain('Choose a fresh start time and review');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('keeps the editing draft identity and revision across a normal reload', async () => {
  const stored = warmupUiFixture().plan;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'POST' ? broken() : Response.json({ plans: [stored] }),
  );
  const onLoad = vi.fn();
  await mount(fetcher, onLoad);
  await click('Edit draft');
  onLoad.mockClear();
  await click('Reload drafts');
  expect(container.textContent).toContain('Editing draft');
  expect(onLoad).not.toHaveBeenCalled();
  await click('Save changes');
  const writes = fetcher.mock.calls.filter(
    (call) => call[1]?.method === 'POST',
  );
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0][1]!.body as string)).toMatchObject({
    id: stored.id,
    expectedRevision: stored.revision,
  });
});
