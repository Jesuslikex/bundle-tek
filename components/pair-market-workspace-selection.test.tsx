// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { ImportedTokenMarket } from './imported-token-market';
import { ImportedPairOrderReview } from './imported-pair-order-review';
import { usePairMarketSelection } from './pair-market-selection';
import {
  pairReviewUiRequest,
  pairReviewUiFixture,
} from '../test/pair-order-first-ui-fixture';
import { pairRuntimeDigest } from '../lib/pair-runtime-trace';
import type { ImportedTokenProject } from '../lib/imported-token-project';
vi.mock('./imported-pool-candles', () => ({ ImportedPoolCandles: () => null }));
vi.mock('./imported-pool-trades', () => ({ ImportedPoolTrades: () => null }));
vi.mock('./market-condition-review', () => ({
  MarketConditionReview: () => null,
}));
vi.mock('./token-stats-strip', () => ({ TokenStatsStrip: () => null }));
let root: Root, node: HTMLDivElement;
const now = Date.UTC(2026, 9, 16);
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(now);
  vi.stubGlobal('crypto', {
    subtle: {
      digest: async (_algorithm: string, bytes: Uint8Array) =>
        Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer,
    },
  });
  node = document.createElement('div');
  document.body.appendChild(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const button = (text: string) =>
  Array.from(node.querySelectorAll('button')).find(
    (b) => b.textContent === text,
  )!;
const boxes = () =>
  Array.from(node.querySelectorAll<HTMLInputElement>('input[type=checkbox]'));
function Consumer() {
  const marketPair = usePairMarketSelection(pairReviewUiRequest.id, 1);
  return (
    <ImportedPairOrderReview request={{ ...pairReviewUiRequest, marketPair }} />
  );
}
it('publishes the real chart selection into the review and invalidates checked consent before another review', async () => {
  const saved = await pairReviewUiFixture(now);
  const mint = saved.review.outputMint,
    poolA = pairReviewUiRequest.quoteMint,
    poolB = mint;
  const project = {
    id: pairReviewUiRequest.id,
    revision: 1,
    archived: false,
    document: {
      token: {
        chain: 'Solana',
        address: mint,
        name: 'TEST',
        symbol: 'TEST',
        decimals: 6,
      },
    },
  } as ImportedTokenProject;
  const observation = {
    chain: 'Solana',
    address: mint,
    projectRevision: 1,
    source: 'api.dexscreener.com',
    observedAt: new Date(now).toISOString(),
    executionAllowed: false,
    returnedPairCount: 2,
    quoteOnlyPairCount: 0,
    pairs: [poolA, poolB].map((address, i) => ({
      address,
      dex: 'test',
      url: 'https://dexscreener.com/solana/' + address,
      quoteSymbol: 'USDC',
      priceUsd: i ? '2' : '1',
      liquidityUsd: 100,
      volume24hUsd: null,
      change24h: null,
      marketCapUsd: null,
    })),
  };
  const selected: string[] = [];
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).startsWith('/api/imported-projects/market?'))
      return Response.json({
        id: project.id,
        revision: 1,
        executionAllowed: false,
        observations: [observation],
      });
    if (url !== '/api/imported-projects/pair-order-reviews')
      throw Error('Unexpected request');
    const body = JSON.parse(String(init?.body));
    expect(body.action).toBe('prepare');
    selected.push(body.request.marketPair);
    const { sha256: _old, ...terms } = saved.review;
    const review = { ...terms, marketPair: body.request.marketPair };
    return Response.json({
      id: saved.id,
      review: { ...review, sha256: await pairRuntimeDigest(review) },
    });
  });
  vi.stubGlobal('fetch', fetcher);
  await act(async () =>
    root.render(
      <>
        <ImportedTokenMarket project={project} />
        <Consumer />
      </>,
    ),
  );
  const market = node.querySelector<HTMLSelectElement>(
    'select[aria-label="Market pair"]',
  )!;
  expect(market.value).toBe(poolA);
  await act(async () => button('Prepare order review').click());
  expect(selected).toEqual([poolA]);
  expect(boxes()).toHaveLength(2);
  await act(async () => {
    for (const box of boxes()) box.click();
  });
  expect(button('Request signing authorization').disabled).toBe(false);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      'value',
    )!.set!;
    setter.call(market, poolB);
    market.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(boxes()).toHaveLength(0);
  expect(button('Request signing authorization')).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () => button('Prepare order review').click());
  expect(selected).toEqual([poolA, poolB]);
  expect(boxes().every((box) => !box.checked)).toBe(true);
  expect(button('Request signing authorization').disabled).toBe(true);
});
