// Trending meme narratives from public, keyless market feeds. Read-only: this
// only suggests launch draft text; nothing here prepares or signs anything.

export type NarrativeSource =
  | 'DexScreener boosts'
  | 'DexScreener profiles'
  | 'CoinGecko trending'
  | 'pump.fun live';

export type NarrativeSignal = {
  source: NarrativeSource;
  chain: string;
  name: string;
  symbol: string;
  description: string;
  url: string;
  /** Relative pull of this signal inside its source, 1..3. */
  weight: number;
};

export type Narrative = {
  keyword: string;
  score: number;
  sources: NarrativeSource[];
  related: string[];
  tokens: NarrativeSignal[];
};

export type NarrativeSourceStatus = {
  source: NarrativeSource;
  ok: boolean;
  count: number;
};

export type NarrativeFeed = {
  observedAt: string;
  narratives: Narrative[];
  sources: NarrativeSourceStatus[];
};

export type NarrativeDraft = {
  tokenName: string;
  ticker: string;
  description: string;
  imagePrompt: string;
};

const MAX_BYTES = 1_048_576;
const DEX_CHAINS = 3;
const DEX_BATCH = 30;

// Control, zero-width and bidi-override characters can hide or reorder text.
const hidden = (code: number) =>
  code < 32 ||
  (code >= 127 && code <= 159) ||
  (code >= 0x200b && code <= 0x200f) ||
  (code >= 0x202a && code <= 0x202e);
const text = (value: unknown, max: number) =>
  typeof value === 'string'
    ? Array.from(value, (c) => (hidden(c.charCodeAt(0)) ? ' ' : c))
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
    : '';
const record = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const list = (value: unknown) => (Array.isArray(value) ? value : []);
const safeUrl = (value: unknown, hosts: string[]) => {
  try {
    const url = new URL(text(value, 2048));
    return url.protocol === 'https:' && hosts.includes(url.hostname)
      ? url.toString()
      : '';
  } catch {
    return '';
  }
};

/** Reads a JSON body without letting a feed send an unbounded response. */
export async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`Feed returned ${response.status}.`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty feed response.');
  const decoder = new TextDecoder();
  let body = '',
    length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) {
        await reader.cancel();
        throw new Error('Feed response too large.');
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(body);
}

type DexEntry = {
  chainId: string;
  tokenAddress: string;
  description: string;
  url: string;
  amount: number;
};

export function decodeDexEntries(value: unknown): DexEntry[] {
  return list(value).flatMap((item) => {
    const row = record(item);
    const chainId = text(row?.chainId, 32);
    const tokenAddress = text(row?.tokenAddress, 64);
    if (!/^[a-z0-9-]+$/.test(chainId) || !/^[A-Za-z0-9]+$/.test(tokenAddress))
      return [];
    const amount = Number(row?.totalAmount ?? row?.amount ?? 0);
    return [
      {
        chainId,
        tokenAddress,
        description: text(row?.description, 400),
        url: safeUrl(row?.url, ['dexscreener.com']),
        amount: Number.isFinite(amount) && amount > 0 ? amount : 0,
      },
    ];
  });
}

/** Maps token address to its name and symbol from a /tokens/v1 pair list. */
export function decodeDexTokenNames(value: unknown) {
  const names = new Map<string, { name: string; symbol: string }>();
  for (const item of list(value)) {
    const base = record(record(item)?.baseToken);
    const address = text(base?.address, 64);
    const name = text(base?.name, 64);
    const symbol = text(base?.symbol, 24);
    if (address && name && symbol && !names.has(address))
      names.set(address, { name, symbol });
  }
  return names;
}

export function decodeCoinGeckoTrending(value: unknown): NarrativeSignal[] {
  const coins = list(record(value)?.coins);
  return coins.flatMap((entry, index) => {
    const item = record(record(entry)?.item);
    const name = text(item?.name, 64);
    const symbol = text(item?.symbol, 24);
    const id = text(item?.id, 100);
    if (!name || !symbol || !/^[a-z0-9-]+$/.test(id)) return [];
    return [
      {
        source: 'CoinGecko trending' as const,
        chain: 'Multi',
        name,
        symbol,
        description: '',
        url: `https://www.coingecko.com/en/coins/${id}`,
        weight: index < 5 ? 3 : 2,
      },
    ];
  });
}

export function decodePumpLive(value: unknown): NarrativeSignal[] {
  const coins = Array.isArray(value) ? value : list(record(value)?.coins);
  return coins.flatMap((entry, index) => {
    const coin = record(entry);
    const name = text(coin?.name, 64);
    const symbol = text(coin?.symbol, 24);
    const mint = text(coin?.mint, 64);
    if (!name || !symbol || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint))
      return [];
    return [
      {
        source: 'pump.fun live' as const,
        chain: 'Solana',
        name,
        symbol,
        description: text(coin?.description, 400),
        url: `https://pump.fun/coin/${mint}`,
        weight: index < 10 ? 2 : 1,
      },
    ];
  });
}

type Fetcher = typeof fetch;
const get = (fetcher: Fetcher, url: string, signal: AbortSignal) =>
  fetcher(url, {
    signal,
    redirect: 'manual',
    cache: 'no-store',
    headers: { accept: 'application/json' },
  }).then(readBoundedJson);

async function dexSignals(
  fetcher: Fetcher,
  signal: AbortSignal,
  path: 'token-boosts/top/v1' | 'token-profiles/latest/v1',
  source: 'DexScreener boosts' | 'DexScreener profiles',
) {
  const entries = decodeDexEntries(
    await get(fetcher, `https://api.dexscreener.com/${path}`, signal),
  );
  const byChain = new Map<string, DexEntry[]>();
  for (const entry of entries) {
    const rows = byChain.get(entry.chainId) ?? [];
    if (
      rows.length < DEX_BATCH &&
      !rows.some((r) => r.tokenAddress === entry.tokenAddress)
    )
      rows.push(entry);
    byChain.set(entry.chainId, rows);
  }
  // Boost and profile feeds carry no name or symbol, so one bounded lookup per
  // chain fills them in; tokens the lookup cannot name are dropped.
  const chains = [...byChain].slice(0, DEX_CHAINS);
  const named = await Promise.all(
    chains.map(async ([chainId, rows]) => {
      const names = decodeDexTokenNames(
        await get(
          fetcher,
          `https://api.dexscreener.com/tokens/v1/${chainId}/${rows.map((r) => r.tokenAddress).join(',')}`,
          signal,
        ),
      );
      const top = Math.max(1, ...rows.map((r) => r.amount));
      return rows.flatMap((row): NarrativeSignal[] => {
        const id = names.get(row.tokenAddress);
        if (!id) return [];
        return [
          {
            source,
            chain: chainId,
            name: id.name,
            symbol: id.symbol,
            description: row.description,
            url:
              row.url ||
              `https://dexscreener.com/${chainId}/${row.tokenAddress}`,
            weight:
              source === 'DexScreener boosts' ? 1 + (2 * row.amount) / top : 1,
          },
        ];
      });
    }),
  );
  return named.flat();
}

export async function collectNarrativeSignals(
  signal: AbortSignal,
  fetcher: Fetcher = fetch,
) {
  const jobs: [NarrativeSource, () => Promise<NarrativeSignal[]>][] = [
    [
      'DexScreener boosts',
      () =>
        dexSignals(
          fetcher,
          signal,
          'token-boosts/top/v1',
          'DexScreener boosts',
        ),
    ],
    [
      'DexScreener profiles',
      () =>
        dexSignals(
          fetcher,
          signal,
          'token-profiles/latest/v1',
          'DexScreener profiles',
        ),
    ],
    [
      'CoinGecko trending',
      async () =>
        decodeCoinGeckoTrending(
          await get(
            fetcher,
            'https://api.coingecko.com/api/v3/search/trending',
            signal,
          ),
        ),
    ],
    [
      'pump.fun live',
      async () =>
        decodePumpLive(
          await get(
            fetcher,
            'https://frontend-api-v3.pump.fun/coins/currently-live?offset=0&limit=50&includeNsfw=false',
            signal,
          ),
        ),
    ],
  ];
  const results = await Promise.allSettled(jobs.map(([, run]) => run()));
  const signals: NarrativeSignal[] = [];
  const sources = results.map((result, i): NarrativeSourceStatus => {
    const rows = result.status === 'fulfilled' ? result.value : [];
    signals.push(...rows);
    return {
      source: jobs[i][0],
      ok: result.status === 'fulfilled',
      count: rows.length,
    };
  });
  return { signals, sources };
}

// Words that show up on every token and say nothing about the meme.
const STOPWORDS = new Set(
  (
    'the and for you your our with this that from are was will not but all ' +
    'get has have its out now new one just can more who what when how why ' +
    'into over than them they their there here only like make made also ' +
    'coin coins token tokens crypto meme memes memecoin sol solana eth base ' +
    'bsc chain official community holders holder launch launched pump fun ' +
    'dex buy sell price market cap moon pumpfun first best real next big ' +
    'www com http https telegram twitter website join ca contract inu ' +
    'super ultra mega mini world season mode club army day time'
  ).split(' '),
);
const SHORT_WORDS = new Set(['ai', 'og', 'fed', 'cat', 'dog', 'ufo']);

/** Distinct theme words in a token's name, symbol and description. */
export function narrativeKeywords(
  signal: Pick<NarrativeSignal, 'name' | 'symbol' | 'description'>,
) {
  const raw = `${signal.name} ${signal.symbol} ${signal.description}`
    // BabyPepe -> Baby Pepe, so compound names share words with plain ones.
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
  const words = new Set<string>();
  for (const word of raw.split(/[^a-z]+/)) {
    if (word.length > 20 || STOPWORDS.has(word)) continue;
    if (word.length >= 3 || SHORT_WORDS.has(word)) words.add(word);
  }
  return [...words];
}

/**
 * Groups signals by shared theme words. A narrative needs at least two
 * distinct tokens; spread across sources counts more than one loud feed.
 */
export function rankNarratives(
  signals: NarrativeSignal[],
  limit = 12,
): Narrative[] {
  const seen = new Set<string>();
  const unique = signals.filter((s) => {
    const key = `${s.source}|${s.symbol.toLowerCase()}|${s.name.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const groups = new Map<
    string,
    { signals: NarrativeSignal[]; words: string[][] }
  >();
  for (const signal of unique) {
    const words = narrativeKeywords(signal);
    for (const word of words) {
      const group = groups.get(word) ?? { signals: [], words: [] };
      group.signals.push(signal);
      group.words.push(words);
      groups.set(word, group);
    }
  }
  const ranked: Narrative[] = [];
  for (const [keyword, group] of groups) {
    const tokens = new Set(group.signals.map((s) => s.symbol.toLowerCase()));
    if (tokens.size < 2) continue;
    const sources = [...new Set(group.signals.map((s) => s.source))];
    const weight = group.signals.reduce((sum, s) => sum + s.weight, 0);
    const counts = new Map<string, number>();
    for (const words of group.words)
      for (const word of words)
        if (word !== keyword) counts.set(word, (counts.get(word) ?? 0) + 1);
    const related = [...counts]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([word]) => word);
    ranked.push({
      keyword,
      score: Math.round(weight * (1 + 0.5 * (sources.length - 1)) * 10) / 10,
      sources,
      related,
      tokens: [...group.signals]
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 5),
    });
  }
  ranked.sort(
    (a, b) => b.score - a.score || a.keyword.localeCompare(b.keyword),
  );
  // Drop a narrative whose tokens are all already listed under a stronger one,
  // e.g. "pepe" and "frog" from the same three coins.
  const kept: Narrative[] = [];
  for (const narrative of ranked) {
    const symbols = narrative.tokens.map((t) => t.symbol.toLowerCase());
    const covered = kept.some((k) => {
      const other = new Set(k.tokens.map((t) => t.symbol.toLowerCase()));
      return symbols.every((s) => other.has(s));
    });
    if (!covered) kept.push(narrative);
    if (kept.length >= limit) break;
  }
  return kept;
}

const SUFFIXES = [
  'Coin',
  'Season',
  'Army',
  'Club',
  'World',
  'Mode',
  'Gang',
  'Cult',
];
const title = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * Suggests original launch text for a narrative. The ticker avoids the
 * symbols already trading in it; `variant` cycles through name ideas.
 */
export function draftFromNarrative(
  narrative: Narrative,
  variant = 0,
): NarrativeDraft {
  const base = narrative.keyword.replace(/[^a-z]/g, '').slice(0, 20) || 'meme';
  const suffix =
    SUFFIXES[((variant % SUFFIXES.length) + SUFFIXES.length) % SUFFIXES.length];
  const tokenName = `${title(base)} ${suffix}`.slice(0, 32);
  const taken = new Set(narrative.tokens.map((t) => t.symbol.toUpperCase()));
  const candidates = [
    base.toUpperCase().slice(0, 10),
    `${base.slice(0, 6)}${suffix.slice(0, 4)}`.toUpperCase(),
    `${base.toUpperCase().slice(0, 8)}${suffix.charAt(0).toUpperCase()}`,
  ];
  let ticker =
    candidates.find((c) => /^[A-Z]{2,10}$/.test(c) && !taken.has(c)) ?? '';
  for (let n = 2; !ticker; n++)
    ticker = `${base.toUpperCase().slice(0, 8)}${n}`;
  const theme = [base, ...narrative.related.slice(0, 2)].join(', ');
  const description =
    `${tokenName} ($${ticker}) is a community meme coin riding the ${base} ` +
    `narrative${narrative.related.length ? ` (${narrative.related.slice(0, 2).join(', ')})` : ''}. ` +
    'No promises, just memes. Not financial advice.';
  const imagePrompt =
    `Square 1:1 meme coin logo for "${tokenName}", a bold cartoon mascot themed ` +
    `around ${theme}, thick black outlines, flat bright colors, simple solid ` +
    'background, centered, expressive face, no text, no letters, no real logos.';
  return {
    tokenName,
    ticker,
    description: description.slice(0, 280),
    imagePrompt,
  };
}
