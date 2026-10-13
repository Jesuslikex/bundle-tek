import { expect, it } from 'vitest';
import { requireConditionalApproval } from './conditional-approval-selection';
import {
  conditionalSellTerms,
  type ConditionalSellOrder,
} from './conditional-sell-order';
import type { ImportedApprovalRow } from './imported-approval-history';
import {
  acquisitionId as id,
  acquisitionWallet as wallet,
  acquisitionMint as mint,
} from '../test/imported-sell-acquisition-fixture';
async function fixture() {
  const terms = conditionalSellTerms(
    {
      projectId: id(1),
      projectRevision: 2,
      wallet,
      walletRevision: 3,
      pair: mint,
      kind: 'grid',
      direction: 'at-or-above',
      minimumUsd: '100',
      maximumUsd: '200',
      lines: 2,
      amount: '0.000003',
    },
    { chain: 'Solana', address: mint, decimals: 6 },
  );
  const order = {
    id: id(2),
    revision: 1,
    state: 'draft',
    terms,
    createdAt: '2026-10-11T12:00:00.000Z',
    updatedAt: '2026-10-11T12:00:00.000Z',
  } as ConditionalSellOrder;
  const saved = terms.levels[0];
  const hash = Buffer.from(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(terms)),
    ),
  ).toString('hex');
  const row = {
    id: id(3),
    projectId: id(1),
    projectRevision: 2,
    wallet,
    walletRevision: 3,
    side: 'Sell',
    document: {
      inputRaw: saved.unitsRaw,
      inputMint: mint,
      outputMint: 'So11111111111111111111111111111111111111112',
      conditional: {
        format: 'conditional-preparation-v1',
        orderId: order.id,
        orderRevision: 1,
        level: 1,
        termsSha256: hash,
        pair: mint,
        direction: terms.direction,
        targetUsd: saved.targetUsd,
        unitsRaw: saved.unitsRaw,
        observedMarketCapUsd: '200',
        observedAt: '2026-10-11T12:00:00.000Z',
        expiresAt: '2026-10-11T12:00:30.000Z',
        source: 'api.dexscreener.com',
      },
    },
  } as ImportedApprovalRow;
  return { row, selection: { intentId: row.id, order, level: 1 } };
}
it('binds recovery to exact saved terms and retains historical access after cancellation', async () => {
  const { row, selection } = await fixture();
  await expect(
    requireConditionalApproval(row, selection),
  ).resolves.toBeUndefined();
  await expect(
    requireConditionalApproval(row, {
      ...selection,
      order: { ...selection.order, state: 'cancelled', revision: 2 },
    }),
  ).resolves.toBeUndefined();
});
it('rejects substituted intent, project, wallet, side, units, mint, and every conditional term', async () => {
  const { row, selection } = await fixture();
  for (const patch of [
    { id: id(4) },
    { projectId: id(4) },
    { projectRevision: 4 },
    { wallet: mint },
    { walletRevision: 4 },
    { side: 'Buy' },
  ])
    await expect(
      requireConditionalApproval(
        { ...row, ...patch } as ImportedApprovalRow,
        selection,
      ),
    ).rejects.toThrow();
  for (const patch of [
    { inputRaw: '999' },
    { inputMint: wallet },
    { conditional: undefined },
  ])
    await expect(
      requireConditionalApproval(
        { ...row, document: { ...row.document, ...patch } },
        selection,
      ),
    ).rejects.toThrow();
  for (const patch of [
    { orderId: id(4) },
    { orderRevision: 2 },
    { level: 2 },
    { termsSha256: '0'.repeat(64) },
    { pair: wallet },
    { direction: 'at-or-below' },
    { targetUsd: '101' },
    { unitsRaw: '999' },
  ])
    await expect(
      requireConditionalApproval(
        {
          ...row,
          document: {
            ...row.document,
            conditional: { ...row.document.conditional!, ...patch },
          },
        } as ImportedApprovalRow,
        selection,
      ),
    ).rejects.toThrow();
  await expect(
    requireConditionalApproval(row, { ...selection, level: 50 }),
  ).rejects.toThrow();
  await expect(
    requireConditionalApproval(row, {
      ...selection,
      order: {
        ...selection.order,
        terms: { ...selection.order.terms, totalRaw: '4' },
      },
    }),
  ).rejects.toThrow();
});
