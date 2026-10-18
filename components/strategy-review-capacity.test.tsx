// @vitest-environment jsdom
import { act } from 'react';
import { createHash } from 'node:crypto';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StrategyReviewCapacity } from './strategy-review-capacity';
import { planStrategySession } from '@/lib/strategy-session-plan';
import {
  applyReviewCapacity,
  capacityDigest,
  emptyReviewCapacity,
  reviewCapacityTotals,
  type ReviewCapacityEvent,
} from '@/lib/strategy-review-capacity';
import {
  strategyContext,
  strategyInput,
} from '../test/strategy-session-fixture';
import type { SavedStrategyDraft } from '@/lib/strategy-session-drafts';
let host: HTMLDivElement,
  root: Root,
  draft: SavedStrategyDraft,
  capacity: ReturnType<typeof emptyReviewCapacity>,
  calls: Record<string, unknown>[],
  responder:
    | ((body: Record<string, unknown> | null) => Promise<Response>)
    | null;
const payload = async () => ({
  draftId: draft.id,
  projectId: draft.plan.input.projectId,
  planSha256: await capacityDigest(draft.plan),
  revision:
    capacity.holds.length +
    capacity.holds.filter((h) => h.state === 'released').length,
  state: capacity,
  summary: reviewCapacityTotals(draft.plan, capacity),
  planningOnly: true,
  fundingAllowed: false,
  signingAllowed: false,
  executionAllowed: false,
});
beforeEach(() => {
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(
    async (_algorithm, data) =>
      Uint8Array.from(
        createHash('sha256')
          .update(new Uint8Array(data as ArrayBuffer))
          .digest(),
      ).buffer,
  );
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const input = strategyInput();
  input.startAt = new Date(Date.now() + 1800000).toISOString();
  draft = {
    id: '00000000-0000-4000-8000-000000000099',
    revision: 1,
    archived: false,
    createdAt: new Date().toISOString(),
    plan: planStrategySession(input, strategyContext()),
  };
  capacity = emptyReviewCapacity();
  calls = [];
  responder = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, options: RequestInit) => {
      const body = options.body
        ? (JSON.parse(options.body as string) as Record<string, unknown>)
        : null;
      if (body) calls.push(body);
      if (responder) return responder(body);
      if (body)
        capacity = applyReviewCapacity(
          draft.plan,
          capacity,
          body.event as ReviewCapacityEvent,
          new Date().toISOString(),
        );
      return Response.json(await payload());
    }),
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const mount = (disabled = false, contextKey = 'current') =>
  act(async () =>
    root.render(
      <StrategyReviewCapacity
        draft={draft}
        disabled={disabled}
        contextKey={contextKey}
      />,
    ),
  );
const button = (name: string) =>
  [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === name,
  )!;
const click = (name: string) => act(async () => button(name).click());
const reserve = () =>
  act(async () =>
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
it('performs no background fetch and saves/releases only review capacity after explicit actions', async () => {
  await mount();
  expect(fetch).not.toHaveBeenCalled();
  await click('Review shared budget');
  expect(host.textContent).toContain('0 SOL');
  expect(host.textContent).toContain('never reserve wallet funds');
  await reserve();
  expect(host.textContent).toContain('0.005 SOL');
  expect(capacity.holds).toHaveLength(1);
  expect(button('Reserve for review').disabled).toBe(true);
  await click('Release review slot 1.1');
  expect(capacity.holds[0].state).toBe('released');
  expect(host.textContent).toContain('No active review slots');
  await reserve();
  expect(capacity.holds).toHaveLength(2);
  expect(capacity.holds[1].id).not.toBe(capacity.holds[0].id);
  expect(calls.map((c) => (c.event as ReviewCapacityEvent).kind)).toEqual([
    'hold',
    'release',
    'hold',
  ]);
});
it('retains the same hold ID after an ambiguous cancelled mutation and ignores a late reply', async () => {
  await mount();
  await click('Review shared budget');
  let resolve!: (response: Response) => void;
  responder = async (body) =>
    body
      ? new Promise<Response>((r) => {
          resolve = r;
        })
      : Response.json(await payload());
  await reserve();
  await click('Cancel slot request');
  expect(host.textContent).toContain('outcome not confirmed');
  const event = calls[0].event as ReviewCapacityEvent;
  responder = null;
  await click('Reload review slots');
  await reserve();
  expect((calls[1].event as ReviewCapacityEvent).id).toBe(event.id);
  await act(async () =>
    resolve(Response.json({ ...(await payload()), executionAllowed: true })),
  );
  expect(host.textContent).not.toContain('authority differs');
  expect(capacity.holds).toHaveLength(1);
});
it('allows release in a locked or archived context while refusing new claims', async () => {
  capacity = applyReviewCapacity(
    draft.plan,
    capacity,
    {
      kind: 'hold',
      id: '00000000-0000-4000-8000-000000000098',
      strategyId: draft.plan.input.strategies[0].id,
      candidate: 0,
    },
    new Date().toISOString(),
  );
  draft.archived = true;
  await mount(true);
  await click('Review shared budget');
  expect(host.querySelector('form')).toBeNull();
  await click('Release review slot 1.1');
  expect(capacity.holds[0].state).toBe('released');
});
it('clears cached capacity on context change and requires reload', async () => {
  await mount();
  await click('Review shared budget');
  await reserve();
  await mount(true, 'wallet-changed');
  expect(host.querySelector('form')).toBeNull();
  expect(host.textContent).toContain('Reload review slots');
  expect(host.textContent).not.toContain('Release review slot 1.1');
});
it('explains an exhausted shared cap before sending another claim', async () => {
  const input = strategyInput();
  input.maxAmount = '0.01';
  input.startAt = draft.plan.input.startAt;
  draft.plan = planStrategySession(input, strategyContext());
  await mount();
  await click('Review shared budget');
  await reserve();
  const select = host.getElementsByTagName('select').item(0)!;
  await act(async () => {
    select.value = draft.plan.input.strategies[1].id;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(button('Reserve for review').disabled).toBe(true);
  expect(host.textContent).toContain('Release an unused review slot first');
  expect(calls).toHaveLength(1);
});
it.each(['foreign', 'totals', 'authority'])(
  'refuses %s successful response without enabling a mutation',
  async (kind) => {
    responder = async () => {
      const p = await payload();
      if (kind === 'foreign')
        p.draftId = '00000000-0000-4000-8000-000000000097';
      if (kind === 'totals') p.summary.heldRaw = '1';
      if (kind === 'authority') p.signingAllowed = true;
      return Response.json(p);
    };
    await mount();
    await click('Review shared budget');
    expect(host.querySelector('form')).toBeNull();
    expect(host.querySelector('[role=alert]')).toBeTruthy();
  },
);
