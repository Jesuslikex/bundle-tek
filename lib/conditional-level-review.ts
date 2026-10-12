import type { ConditionalSellOrder } from './conditional-sell-order';
import { marketUsdMicros, reviewMarketTrigger } from './market-trigger';
import type { SavedTokenMarket } from './token-market';
import type { ImportedTokenProject } from './imported-token-project';
export type ConditionalLevelReview = ReturnType<typeof reviewMarketTrigger>;
export function sampledSavedConditions(
  order: ConditionalSellOrder,
  project: ImportedTokenProject,
  pair: string,
  observation: SavedTokenMarket,
  now = Date.now(),
) {
  const terms = order.terms;
  if (
    order.state !== 'draft' ||
    project.archived ||
    terms.projectId !== project.id ||
    terms.projectRevision !== project.revision ||
    terms.mint !== project.document.token.address ||
    project.document.token.chain !== 'Solana' ||
    terms.pair !== pair
  )
    throw new Error(
      'Saved order differs from the selected active project and pool.',
    );
  const reviews = terms.levels.map((level) =>
    reviewMarketTrigger(
      {
        pair: terms.pair,
        direction: terms.direction,
        targetUsd: level.targetUsd,
      },
      observation,
      { chain: 'Solana', mint: terms.mint, revision: terms.projectRevision },
      now,
    ),
  );
  return conditionalLevelReviews(
    {
      orderId: order.id,
      revision: order.revision,
      executionAllowed: false,
      reviews,
    },
    order,
    now,
  );
}
export function conditionalLevelReviews(
  value: unknown,
  order: ConditionalSellOrder,
  now = Date.now(),
): ConditionalLevelReview[] {
  const page = value as {
    orderId: string;
    revision: number;
    executionAllowed: boolean;
    reviews: ConditionalLevelReview[];
  };
  if (
    !page ||
    page.orderId !== order.id ||
    page.revision !== order.revision ||
    page.executionAllowed !== false ||
    !Array.isArray(page.reviews) ||
    page.reviews.length !== order.terms.levels.length ||
    !Number.isFinite(now)
  )
    throw new Error('Saved condition response differs.');
  for (let i = 0; i < page.reviews.length; i++) {
    const r = page.reviews[i],
      level = order.terms.levels[i],
      first = page.reviews[0];
    if (
      !r ||
      Object.keys(r).sort().join(',') !==
        'direction,executionAllowed,expiresAt,met,observedAt,observedMarketCapUsd,pair,source,targetUsd' ||
      r.executionAllowed !== false ||
      r.source !== 'api.dexscreener.com' ||
      r.pair !== order.terms.pair ||
      r.direction !== order.terms.direction ||
      r.targetUsd !== level.targetUsd ||
      typeof r.met !== 'boolean' ||
      typeof r.observedAt !== 'string' ||
      !Number.isFinite(Date.parse(r.observedAt)) ||
      typeof r.expiresAt !== 'string' ||
      Date.parse(r.expiresAt) !== Date.parse(r.observedAt) + 30000 ||
      Date.parse(r.observedAt) > now + 1000 ||
      Date.parse(r.expiresAt) <= now ||
      r.observedAt !== first.observedAt ||
      r.expiresAt !== first.expiresAt ||
      r.observedMarketCapUsd !== first.observedMarketCapUsd
    )
      throw new Error('Saved condition sample changed or expired.');
    const cap = marketUsdMicros(r.observedMarketCapUsd),
      target = marketUsdMicros(r.targetUsd);
    if (
      r.met !== (r.direction === 'at-or-above' ? cap >= target : cap <= target)
    )
      throw new Error('Saved condition comparison differs.');
  }
  return page.reviews;
}
