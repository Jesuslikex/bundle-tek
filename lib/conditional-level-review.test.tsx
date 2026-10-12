import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { it, expect } from 'vitest';
import {
  conditionalSellTerms,
  type ConditionalSellOrder,
} from './conditional-sell-order';
import {
  conditionalLevelReviews,
  sampledSavedConditions,
} from './conditional-level-review';
import type { SavedTokenMarket } from './token-market';
import type { ImportedTokenProject } from './imported-token-project';
import { ConditionalLevelPreview } from '@/components/conditional-level-preview';
const now = Date.parse('2026-10-11T12:00:00.000Z');
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const wallet = '11111111111111111111111111111111';
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
      wallet,
      walletRevision: 1,
      pair: wallet,
      kind: 'grid',
      direction: 'at-or-above',
      amount: '0.000005',
      minimumUsd: '100',
      maximumUsd: '200',
      lines: 2,
    },
    { chain: 'Solana', address: wallet, decimals: 6 },
  ),
};
const page = {
  orderId: order.id,
  revision: 1,
  executionAllowed: false,
  reviews: order.terms.levels.map((l) => ({
    executionAllowed: false as const,
    pair: wallet,
    direction: 'at-or-above' as const,
    targetUsd: l.targetUsd,
    observedMarketCapUsd: '150',
    met: l.targetUsd === '100',
    observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30000).toISOString(),
    source: 'api.dexscreener.com',
  })),
};
it('follows fresh selected-pool samples and fails closed across stale or changed project context', () => {
  const project = {
    id: order.terms.projectId,
    revision: 1,
    archived: false,
    document: { token: { chain: 'Solana', address: wallet, decimals: 6 } },
  } as ImportedTokenProject;
  const observation = {
    chain: 'Solana',
    address: wallet,
    source: 'api.dexscreener.com',
    executionAllowed: false,
    projectRevision: 1,
    observedAt: new Date(now).toISOString(),
    pairs: [{ address: wallet, marketCapUsd: 150 }],
  } as SavedTokenMarket;
  const follow = (
    o = order,
    p = project,
    obs = observation,
    time = now,
    pair = wallet,
  ) => sampledSavedConditions(o, p, pair, obs, time);
  expect(follow().map((r) => r.met)).toEqual([true, false]);
  expect(
    follow(order, project, {
      ...observation,
      pairs: [{ ...observation.pairs[0], marketCapUsd: 250 }],
    }).map((r) => r.met),
  ).toEqual([true, true]);
  for (const p of [
    { ...project, archived: true },
    { ...project, revision: 2 },
    { ...project, id: id(3) },
    {
      ...project,
      document: { token: { ...project.document.token, address: id(3) } },
    } as ImportedTokenProject,
  ])
    expect(() => follow(order, p)).toThrow();
  expect(() => follow({ ...order, state: 'cancelled' })).toThrow();
  expect(() => follow(order, project, observation, now + 30000)).toThrow();
  expect(() => follow(order, project, observation, now, id(3))).toThrow();
  expect(() =>
    follow(order, project, {
      ...observation,
      pairs: [observation.pairs[0], observation.pairs[0]],
    }),
  ).toThrow();
  expect(() =>
    follow(order, project, { ...observation, projectRevision: 2 }),
  ).toThrow();
});
it('binds each level to the same fresh sample and exact microdollar comparison', () => {
  expect(conditionalLevelReviews(page, order, now).map((r) => r.met)).toEqual([
    true,
    false,
  ]);
  for (const patch of [
    { orderId: id(3) },
    { revision: 2 },
    { executionAllowed: true },
    { reviews: page.reviews.toReversed() },
    { reviews: [page.reviews[0]] },
  ])
    expect(() =>
      conditionalLevelReviews({ ...page, ...patch }, order, now),
    ).toThrow();
  for (const patch of [
    { met: false },
    { pair: id(3) },
    { direction: 'at-or-below' },
    { targetUsd: '101' },
    { source: 'unknown' },
    { expiresAt: new Date(now + 60000).toISOString() },
    { executionAllowed: true },
    { observedAt: 'invalid' },
    { observedMarketCapUsd: '0' },
    { extra: true },
  ])
    expect(() =>
      conditionalLevelReviews(
        {
          ...page,
          reviews: [{ ...page.reviews[0], ...patch }, page.reviews[1]],
        },
        order,
        now,
      ),
    ).toThrow();
  expect(() => conditionalLevelReviews(page, order, now + 30000)).toThrow();
  expect(() => conditionalLevelReviews(page, order, now - 1001)).toThrow();
  expect(() =>
    conditionalLevelReviews(
      {
        ...page,
        reviews: [
          page.reviews[0],
          { ...page.reviews[1], observedMarketCapUsd: '151' },
        ],
      },
      order,
      now,
    ),
  ).toThrow();
});
it('renders per-level outcomes and removes current met claims after expiry', () => {
  const reviews = conditionalLevelReviews(page, order, now);
  const fresh = renderToStaticMarkup(
    <ConditionalLevelPreview order={order} reviews={reviews} now={now} />,
  );
  expect(fresh).toContain('Met in this sample');
  expect(fresh).toContain('Not met in this sample');
  expect(fresh).toContain('0.000003 tokens');
  expect(fresh).toContain('does not reserve inventory');
  const expired = renderToStaticMarkup(
    <ConditionalLevelPreview
      order={order}
      reviews={reviews}
      now={now + 30000}
    />,
  );
  expect(expired).toContain('Sample expired');
  expect(expired).not.toContain('Met in this sample');
  expect(expired).not.toContain('Not met in this sample');
});
