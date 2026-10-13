import { expect, it } from 'vitest';
import { conditionalTriggerQueue } from './conditional-trigger-queue';
import {
  conditionalSellTerms,
  type ConditionalSellOrder,
} from './conditional-sell-order';
import type { ImportedTokenProject } from './imported-token-project';
import type { SavedTokenMarket } from './token-market';
import type { WorkspaceWallet } from './wallet-workspace';

const now = Date.parse('2026-10-12T12:00:00.000Z');
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const address = '11111111111111111111111111111111';
function fixture() {
  const order: ConditionalSellOrder = {
    id: id(1),
    revision: 1,
    state: 'draft',
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    terms: conditionalSellTerms(
      {
        projectId: id(2),
        projectRevision: 1,
        wallet: address,
        walletRevision: 1,
        pair: address,
        kind: 'grid',
        direction: 'at-or-above',
        amount: '0.000005',
        minimumUsd: '100',
        maximumUsd: '200',
        lines: 2,
      },
      { chain: 'Solana', address, decimals: 6 },
    ),
  };
  return {
    orders: [order],
    statuses: [],
    now,
    pair: address,
    wallets: [
      { chain: 'Solana', address, archived: false, revision: 1 },
    ] as WorkspaceWallet[],
    project: {
      id: id(2),
      revision: 1,
      archived: false,
      document: { token: { chain: 'Solana', address, decimals: 6 } },
    } as ImportedTokenProject,
    observation: {
      chain: 'Solana',
      address,
      source: 'api.dexscreener.com',
      executionAllowed: false,
      projectRevision: 1,
      observedAt: new Date(now).toISOString(),
      pairs: [{ address, marketCapUsd: 150 }],
    } as SavedTokenMarket,
  };
}
it('queues only matching levels and follows fresh changes without mutating saved terms', () => {
  const input = fixture();
  expect(conditionalTriggerQueue(input).candidates.map((c) => c.level)).toEqual(
    [1],
  );
  expect(
    conditionalTriggerQueue({
      ...input,
      observation: {
        ...input.observation,
        pairs: [{ ...input.observation.pairs[0], marketCapUsd: 250 }],
      },
    }).candidates.map((c) => c.level),
  ).toEqual([1, 2]);
  expect(input.orders[0].terms.levels.map((l) => l.targetUsd)).toEqual([
    '100',
    '200',
  ]);
});
it.each(['awaiting_signature', 'signed', 'submitted', 'filled'] as const)(
  'excludes %s levels from readiness',
  (state) => {
    const input = fixture();
    const result = conditionalTriggerQueue({
      ...input,
      statuses: [
        {
          orderId: id(1),
          level: 1,
          intentId: id(3),
          unitsRaw: input.orders[0].terms.levels[0].unitsRaw,
          state,
          signature: state === 'awaiting_signature' ? null : '1'.repeat(87),
          receiptId: state === 'filled' ? id(4) : null,
        },
      ],
    });
    expect(result.candidates).toEqual([]);
    expect(result.checkedLevels).toBe(1);
    expect(result.reservedLevels).toBe(1);
  },
);
it('requires the saved wallet revision and current project/pool', () => {
  const input = fixture();
  for (const changed of [
    { ...input, wallets: [] },
    { ...input, wallets: input.wallets.map((w) => ({ ...w, revision: 2 })) },
    { ...input, wallets: input.wallets.map((w) => ({ ...w, archived: true })) },
    { ...input, wallets: [...input.wallets, ...input.wallets] },
    { ...input, project: { ...input.project, revision: 2 } },
    { ...input, project: { ...input.project, archived: true } },
    { ...input, pair: 'different' },
  ]) {
    expect(conditionalTriggerQueue(changed).candidates).toEqual([]);
    expect(conditionalTriggerQueue(changed).unavailableOrders).toBe(1);
  }
  expect(
    conditionalTriggerQueue({
      ...input,
      orders: input.orders.map((o) => ({
        ...o,
        state: 'cancelled',
        revision: 2,
      })),
    }).candidates,
  ).toEqual([]);
});
it('rejects stale, contradictory and duplicate context rather than showing matches', () => {
  const input = fixture();
  expect(() =>
    conditionalTriggerQueue({ ...input, now: now + 30000 }),
  ).toThrow();
  expect(() =>
    conditionalTriggerQueue({
      ...input,
      observation: { ...input.observation, projectRevision: 2 },
    }),
  ).toThrow();
  expect(() =>
    conditionalTriggerQueue({
      ...input,
      orders: [...input.orders, ...input.orders],
    }),
  ).toThrow('duplicate');
});
