// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  PumpOrganicHolderBuys,
  decimalToRaw,
} from './pump-organic-holder-buys';

let root: Root, container: HTMLDivElement;
const launchId = '00000000-0000-4000-8000-000000000001';
const holder = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
let posted: Record<string, unknown>[];
let sequences: unknown[];
const sequence = (batchState?: string) => ({
  id: '00000000-0000-4000-8000-000000000002',
  launchReviewId: launchId,
  mint: 'mint',
  state: 'active',
  plan: {
    mode: 'Organic',
    rows: [
      {
        index: 0,
        address: holder,
        batch: 0,
        offsetMs: 0,
        batchOffsetMs: 0,
        maximumQuoteCostRaw: '1050000',
      },
    ],
    batches: [{ batch: 0, indexes: [0] }],
    maximumQuoteCostRaw: '1050000',
  },
  batches: batchState
    ? [
        {
          id: '00000000-0000-4000-8000-000000000003',
          batch: 0,
          state: batchState,
          expiresAt: new Date(Date.now() + 40_000).toISOString(),
          review: {
            id: '00000000-0000-4000-8000-000000000003',
            sha256: 'a'.repeat(64),
            buys: [{ holder, maximumQuoteCostRaw: '1050000' }],
          },
          buys:
            batchState === 'signed'
              ? [
                  {
                    index: 0,
                    holder,
                    signature: 's',
                    state: 'signed',
                    batchOffsetMs: 0,
                  },
                ]
              : [],
        },
      ]
    : [],
});
const find = (text: string) =>
  [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.startsWith(text),
  );
const flush = () => act(async () => {});
const render = async () => {
  await act(async () => root.render(<PumpOrganicHolderBuys projectId="p1" />));
  await act(async () => find('Organic and Stagger')!.click());
  await flush();
};
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  posted = [];
  sequences = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.body) {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        posted.push(body);
        return Response.json({ ok: true });
      }
      if (path.startsWith('/api/launch/pump/organic'))
        return Response.json({ sequences });
      if (path.startsWith('/api/launch/pump/holders'))
        return Response.json({ launches: [] });
      return Response.json({
        launches: [{ state: 'finalized', review: { id: launchId } }],
      });
    }),
  );
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('converts exact decimals to raw units and refuses extra precision', () => {
  expect(decimalToRaw('1.5', 6n)).toBe('1500000');
  expect(decimalToRaw('0.004', 9n)).toBe('4000000');
  expect(() => decimalToRaw('1.0000001', 6n)).toThrow('decimal places');
  expect(() => decimalToRaw('0', 6n)).toThrow('above zero');
});

it('plans from a finalized launch with exact raw terms', async () => {
  await render();
  const textarea = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!.call(textarea, `${holder} 2.5`);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => find('Plan holder buys')!.click());
  expect(posted[0]).toEqual({
    action: 'plan',
    terms: {
      launchReviewId: launchId,
      mode: 'Organic',
      buys: [{ address: holder, tokenAmountRaw: '2500000' }],
      delayMinMs: 3000,
      delayMaxMs: 15000,
      slippageBps: 500,
      rentAllowanceRaw: '4000000',
    },
  });
});

it('needs approval before signing and a separate send approval before sending', async () => {
  sequences = [sequence('review')];
  await render();
  expect(find('Sign batch 1')!.disabled).toBe(true);
  act(() => root.unmount());
  root = createRoot(container);
  sequences = [sequence('signed')];
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  await render();
  expect(find('Start batch 1')!.disabled).toBe(true);
  const box = [...container.querySelectorAll('input[type=checkbox]')].at(
    -1,
  ) as HTMLInputElement;
  await act(async () => box.click());
  await act(async () => find('Start batch 1')!.click());
  await act(async () => vi.advanceTimersByTime(1));
  expect(posted).toContainEqual({
    action: 'send',
    batchId: '00000000-0000-4000-8000-000000000003',
    index: 0,
    sendApproved: true,
  });
  await act(async () => find('Stop')!.click());
  expect(posted.at(-1)).toEqual({
    action: 'stop',
    sequenceId: '00000000-0000-4000-8000-000000000002',
  });
});
