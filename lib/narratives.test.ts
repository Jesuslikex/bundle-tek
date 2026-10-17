import { describe, expect, it } from 'vitest';
import {
  collectNarrativeSignals,
  decodeCoinGeckoTrending,
  decodeDexEntries,
  decodePumpLive,
  draftFromNarrative,
  narrativeKeywords,
  rankNarratives,
  type NarrativeSignal,
} from './narratives';

const MINT = 'So11111111111111111111111111111111111111112';
const signal = (
  name: string,
  symbol: string,
  source: NarrativeSignal['source'] = 'pump.fun live',
  description = '',
): NarrativeSignal => ({
  source,
  chain: 'Solana',
  name,
  symbol,
  description,
  url: `https://pump.fun/coin/${MINT}`,
  weight: 1,
});

describe('narrativeKeywords', () => {
  it('splits compound names and drops filler words', () => {
    expect(
      narrativeKeywords({
        name: 'BabyPepe',
        symbol: 'BPEPE',
        description: 'The official meme coin on Solana',
      }),
    ).toEqual(['baby', 'pepe', 'bpepe']);
    expect(
      narrativeKeywords({ name: 'AI Cat', symbol: 'X', description: '' }),
    ).toEqual(['ai', 'cat']);
  });
});

describe('rankNarratives', () => {
  it('needs two tokens and weights spread across sources', () => {
    const ranked = rankNarratives([
      signal('Pepe Classic', 'PEPEC'),
      signal('Baby Pepe', 'BPEPE', 'DexScreener boosts'),
      signal('Pepe Frog', 'PFROG', 'CoinGecko trending'),
      signal('Lonely Dog', 'LDOG'),
      signal('Trump Cat', 'TCAT'),
      signal('Cat Wif Hat', 'CWH'),
    ]);
    expect(ranked.map((n) => n.keyword)).toEqual(['pepe', 'cat']);
    expect(ranked[0].sources).toHaveLength(3);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it('ignores the same token repeated by one source', () => {
    expect(
      rankNarratives([signal('Moo Deng', 'MOO'), signal('Moo Deng', 'MOO')]),
    ).toEqual([]);
  });

  it('drops a weaker theme made of the same tokens', () => {
    const ranked = rankNarratives([
      signal('Pepe Frog', 'A'),
      signal('Frog Pepe', 'B'),
    ]);
    expect(ranked).toHaveLength(1);
  });
});

describe('draftFromNarrative', () => {
  const [narrative] = rankNarratives([
    signal('Pepe One', 'PEPE'),
    signal('Pepe Two', 'PEPE2'),
  ]);
  it('builds launch text that fits the draft form and avoids taken tickers', () => {
    const draft = draftFromNarrative(narrative);
    expect(draft.tokenName).toBe('Pepe Coin');
    expect(draft.ticker).not.toBe('PEPE');
    expect(draft.ticker).toMatch(/^[A-Z0-9]{2,10}$/);
    expect(draft.description.length).toBeLessThanOrEqual(280);
    expect(draft.imagePrompt).toContain('pepe');
  });
  it('cycles names with the variant', () => {
    expect(draftFromNarrative(narrative, 1).tokenName).toBe('Pepe Season');
    expect(draftFromNarrative(narrative, 8).tokenName).toBe('Pepe Coin');
  });
});

describe('decoders', () => {
  it('reject malformed rows and unsafe links', () => {
    expect(
      decodeDexEntries([
        {
          chainId: 'solana',
          tokenAddress: MINT,
          url: 'https://evil.example/x',
          totalAmount: 500,
        },
        { chainId: 'sol ana', tokenAddress: MINT },
        null,
      ]),
    ).toEqual([
      {
        chainId: 'solana',
        tokenAddress: MINT,
        description: '',
        url: '',
        amount: 500,
      },
    ]);
    expect(
      decodeCoinGeckoTrending({
        coins: [{ item: { id: 'x/../y', name: 'A', symbol: 'B' } }],
      }),
    ).toEqual([]);
    expect(decodePumpLive([{ mint: 'bad', name: 'A', symbol: 'B' }])).toEqual(
      [],
    );
  });
});

describe('collectNarrativeSignals', () => {
  it('names DexScreener tokens and keeps going when a source fails', async () => {
    const calls: string[] = [];
    const fetcher = (async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      const body = url.includes('token-boosts')
        ? [{ chainId: 'solana', tokenAddress: MINT, totalAmount: 100 }]
        : url.includes('token-profiles')
          ? []
          : url.includes('/tokens/v1/solana/')
            ? [
                {
                  baseToken: {
                    address: MINT,
                    name: 'Pepe Max',
                    symbol: 'PMAX',
                  },
                },
              ]
            : url.includes('coingecko')
              ? {
                  coins: [
                    { item: { id: 'pepe', name: 'Pepe', symbol: 'PEPE' } },
                  ],
                }
              : null;
      return body === null
        ? new Response('no', { status: 403 })
        : Response.json(body);
    }) as typeof fetch;
    const { signals, sources } = await collectNarrativeSignals(
      new AbortController().signal,
      fetcher,
    );
    expect(sources).toEqual([
      { source: 'DexScreener boosts', ok: true, count: 1 },
      { source: 'DexScreener profiles', ok: true, count: 0 },
      { source: 'CoinGecko trending', ok: true, count: 1 },
      { source: 'pump.fun live', ok: false, count: 0 },
    ]);
    expect(signals.map((s) => s.symbol)).toEqual(['PMAX', 'PEPE']);
    expect(signals[0].url).toBe(`https://dexscreener.com/solana/${MINT}`);
    expect(calls.filter((c) => c.includes('/tokens/v1/'))).toHaveLength(1);
  });
});
