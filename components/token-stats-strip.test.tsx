import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { TokenStatsStrip } from './token-stats-strip';
vi.stubGlobal('React', React);

const now = Date.parse('2026-10-15T12:00:00.000Z');
const pair = {
  address: 'pool',
  dex: 'raydium',
  quoteSymbol: 'SOL',
  url: 'https://example.invalid/pool',
  priceUsd: '0.00004567891',
  liquidityUsd: 98_400,
  volume24hUsd: 1_250_000,
  change24h: -28.37,
  marketCapUsd: 4060,
} as Parameters<typeof TokenStatsStrip>[0]['pair'];

it('shows headline numbers with exact price on hover and a fresh read time', () => {
  const html = renderToStaticMarkup(
    <TokenStatsStrip
      pair={pair}
      symbol="DINGER"
      observedAt={new Date(now - 90_000).toISOString()}
      now={now}
    />,
  );
  expect(html).toContain('aria-label="DINGER market stats"');
  expect(html).toContain('title="$0.00004567891"');
  expect(html).toContain('$0.0₄4567');
  expect(html).toContain('$4.06K');
  expect(html).toContain('$98.4K');
  expect(html).toContain('$1.25M');
  expect(html).toContain('data-tone="down"');
  expect(html).toContain('−28.4%');
  expect(html).toContain('read 1m ago');
  expect(html).not.toContain('stale');
});

it('flags an old reading as stale', () => {
  const html = renderToStaticMarkup(
    <TokenStatsStrip
      pair={{ ...pair, change24h: null }}
      symbol="DINGER"
      observedAt={new Date(now - 20 * 60_000).toISOString()}
      now={now}
    />,
  );
  expect(html).toContain('data-stale="true"');
  expect(html).toContain('stale, refresh for current numbers');
  expect(html).not.toContain('data-tone');
});
