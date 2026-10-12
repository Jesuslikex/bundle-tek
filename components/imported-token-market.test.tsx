import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarketObservationChart } from './imported-token-market';
import type { SavedTokenMarket } from '@/lib/token-market';
const observation = (
  time: string,
  address: string,
  priceUsd: string,
): SavedTokenMarket => ({
  chain: 'Solana',
  address: 'mint',
  source: 'api.dexscreener.com',
  observedAt: time,
  projectRevision: 1,
  executionAllowed: false,
  returnedPairCount: 1,
  quoteOnlyPairCount: 0,
  pairs: [
    {
      address,
      dex: 'dex',
      url: 'https://dexscreener.com/solana/pool',
      quoteSymbol: 'SOL',
      priceUsd,
      liquidityUsd: null,
      volume24hUsd: null,
      change24h: null,
      marketCapUsd: null,
    },
  ],
});
it('charts only saved observations of the selected pool and discloses read-time rather than tick coverage', () => {
  const rows = [
    observation('2026-10-10T15:02:00Z', 'pool', '0.002'),
    observation('2026-10-10T15:01:00Z', 'other', '999'),
    observation('2026-10-10T15:00:00Z', 'pool', '0.001'),
  ];
  const html = renderToStaticMarkup(
    <MarketObservationChart observations={rows} pair="pool" />,
  );
  expect(html).toContain('2 samples');
  expect(html).not.toContain('999');
  expect(html).toContain('20,120 580,20');
  expect(html).toContain('not an OHLC');
  expect(
    renderToStaticMarkup(
      <MarketObservationChart observations={rows.slice(0, 1)} pair="pool" />,
    ),
  ).toContain('Refresh this pair again');
});
