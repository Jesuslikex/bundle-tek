import { expect, it } from 'vitest';
import { requireSelectedConditionalPreparation } from './conditional-preparation-selection';
import {
  conditionalSellTerms,
  type ConditionalSellOrder,
} from './conditional-sell-order';
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
  const now = Date.parse('2026-10-11T12:00:00.000Z');
  const order: ConditionalSellOrder = {
    id: id(2),
    state: 'draft',
    revision: 1,
    terms,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
  const capture = {
    format: 'conditional-preparation-v1',
    orderId: order.id,
    orderRevision: 1,
    level: 1,
    termsSha256: Buffer.from(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(terms)),
      ),
    ).toString('hex'),
    pair: mint,
    direction: terms.direction,
    targetUsd: terms.levels[0].targetUsd,
    unitsRaw: terms.levels[0].unitsRaw,
    observedMarketCapUsd: '200',
    observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30000).toISOString(),
    source: 'api.dexscreener.com',
  };
  const request = { orderId: order.id, revision: 1, level: 1 };
  const context = {
    projectId: terms.projectId,
    projectRevision: 2,
    wallet,
    walletRevision: 3,
    mint,
    decimals: 6,
    side: 'Sell',
    unitsRaw: capture.unitsRaw,
  };
  return { order, capture, request, context, now };
}

it('admits the exact fresh saved level before showing signing controls', async () => {
  const f = await fixture();
  await expect(
    requireSelectedConditionalPreparation(
      f.capture,
      f.request,
      f.order,
      f.context,
      f.now,
    ),
  ).resolves.toEqual(f.capture);
});
it('rejects substituted conditions, full terms fingerprint, malformed and expired samples', async () => {
  const f = await fixture();
  for (const patch of [
    { orderId: id(4) },
    { orderRevision: 2 },
    { level: 2 },
    { pair: wallet },
    { direction: 'at-or-below' },
    { targetUsd: '150' },
    { unitsRaw: '99' },
    { termsSha256: 'a'.repeat(64) },
    { source: 'other-source' },
    { observedMarketCapUsd: '99' },
    {
      observedAt: new Date(f.now + 1001).toISOString(),
      expiresAt: new Date(f.now + 31001).toISOString(),
    },
    { expiresAt: new Date(f.now + 30001).toISOString() },
    { unexpected: true },
  ])
    await expect(
      requireSelectedConditionalPreparation(
        { ...f.capture, ...patch },
        f.request,
        f.order,
        f.context,
        f.now,
      ),
    ).rejects.toThrow();
  await expect(
    requireSelectedConditionalPreparation(
      f.capture,
      f.request,
      f.order,
      f.context,
      f.now + 30000,
    ),
  ).rejects.toThrow();
});
it('rejects unavailable, cancelled or changed selections and trade contexts', async () => {
  const f = await fixture();
  await expect(
    requireSelectedConditionalPreparation(
      f.capture,
      f.request,
      undefined,
      f.context,
      f.now,
    ),
  ).rejects.toThrow();
  await expect(
    requireSelectedConditionalPreparation(
      f.capture,
      f.request,
      { ...f.order, state: 'cancelled', revision: 2 },
      f.context,
      f.now,
    ),
  ).rejects.toThrow();
  for (const patch of [{ orderId: id(4) }, { revision: 2 }, { level: 2 }])
    await expect(
      requireSelectedConditionalPreparation(
        f.capture,
        { ...f.request, ...patch },
        f.order,
        f.context,
        f.now,
      ),
    ).rejects.toThrow();
  for (const patch of [
    { projectId: id(4) },
    { projectRevision: 4 },
    { wallet: mint },
    { walletRevision: 4 },
    { mint: wallet },
    { decimals: 9 },
    { side: 'Buy' },
    { unitsRaw: '99' },
  ])
    await expect(
      requireSelectedConditionalPreparation(
        f.capture,
        f.request,
        f.order,
        { ...f.context, ...patch },
        f.now,
      ),
    ).rejects.toThrow();
  const changed = structuredClone(f.order);
  changed.terms.totalRaw = '4';
  changed.terms.levels = changed.terms.levels.map((level) => ({
    ...level,
    unitsRaw: '2',
    amount: '0.000002',
  }));
  await expect(
    requireSelectedConditionalPreparation(
      f.capture,
      f.request,
      changed,
      f.context,
      f.now,
    ),
  ).rejects.toThrow();
  const changedOtherLevel = structuredClone(f.order);
  changedOtherLevel.terms.levels[1].targetUsd = '201';
  await expect(
    requireSelectedConditionalPreparation(
      f.capture,
      f.request,
      changedOtherLevel,
      f.context,
      f.now,
    ),
  ).rejects.toThrow('fingerprint');
});
