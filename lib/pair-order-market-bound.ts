import {
  observeTokenMarket,
  type SavedTokenMarket,
  type TokenMarket,
} from './token-market';
import type { ImportedPairQuote } from './imported-trade-pair';
import type { SolanaPairPreparation } from './warmup-swap-quote';
import { pairUiAmount } from './pair-ui-amount';

const missing = (
  reason: string,
  reasonCode:
    | 'market-unavailable'
    | 'quote-price-unavailable' = 'market-unavailable',
) => ({
  available: false as const,
  reason,
  reasonCode,
  acknowledgementRequired: false,
});
function decimal(text: string) {
  if (!/^(0|[1-9]\d{0,39})(?:\.\d{1,255})?$/.test(text))
    throw Error('Unsupported price units.');
  const [whole, fraction = ''] = text.split('.');
  const n = BigInt(whole + fraction),
    d = 10n ** BigInt(fraction.length);
  if (n <= 0n) throw Error('Positive price required.');
  return { n, d };
}
function display(n: bigint, d: bigint) {
  const scale = 10n ** 18n,
    raw = (n * scale) / d;
  return `${raw / scale}.${(raw % scale).toString().padStart(18, '0')}`;
}
/** Saved Dexscreener USD evidence, converted only with an observed quote-asset USD price. */
export function pairOrderMarketBound(
  quote: ImportedPairQuote,
  order: SolanaPairPreparation,
  base: SavedTokenMarket | null,
  counter: TokenMarket | null,
  now: number,
  selectedMarketPair: string | null = null,
) {
  if (!base) return missing('No saved token market observation is available.');
  const pair = quote.pair;
  const valid = (o: TokenMarket, address: string) =>
    o.chain === 'Solana' &&
    o.address === address &&
    o.source === 'api.dexscreener.com' &&
    Number.isFinite(Date.parse(o.observedAt)) &&
    Date.parse(o.observedAt) <= now &&
    now - Date.parse(o.observedAt) <= 300000;
  if (
    !valid(base, pair.base.address) ||
    base.projectRevision !== pair.projectRevision
  )
    return missing(
      'The latest saved token observation is stale, future-dated or from a different revision. A reading at most five minutes old is required.',
    );
  if (
    pair.base.amountPolicy.kind !== 'unscaled' ||
    pair.quote.amountPolicy.kind !== 'unscaled'
  )
    return missing(
      'The saved market feed does not attest scaled-token price units. A matching-unit comparison is unavailable.',
    );
  if (!selectedMarketPair)
    return missing(
      'Choose a market pair for the independent price comparison.',
    );
  const b = base.pairs.find((p) => p.address === selectedMarketPair);
  if (!b?.priceUsd)
    return missing(
      'The selected market pair is absent from the latest saved observation or has no comparable USD price.',
    );
  if (!counter || !valid(counter, pair.quote.address))
    return missing(
      'No fresh server USD observation for the exact pair asset. Matching price units cannot be established; no stablecoin peg is assumed.',
      'quote-price-unavailable',
    );
  const c = counter.pairs[0];
  if (!c?.priceUsd)
    return missing(
      'The server quote-asset market observation has no comparable USD price.',
    );
  try {
    const input = quote.side === 'Buy' ? pair.quote : pair.base,
      output = quote.side === 'Buy' ? pair.base : pair.quote;
    const i = decimal(
      pairUiAmount(
        order.inAmount,
        input.decimals,
        input.amountPolicy,
        pair.mintPolicy.recheckUnixTimestamp,
      ),
    );
    const o = decimal(
      pairUiAmount(
        order.outAmount,
        output.decimals,
        output.amountPolicy,
        pair.mintPolicy.recheckUnixTimestamp,
      ),
    );
    const baseUsd = decimal(b.priceUsd),
      quoteUsd = decimal(c.priceUsd);
    // Implied quote UI units per one base UI unit, times the saved quote/USD price.
    const n =
      quote.side === 'Buy' ? i.n * o.d * quoteUsd.n : i.d * o.n * quoteUsd.n;
    const d =
      quote.side === 'Buy' ? i.d * o.n * quoteUsd.d : i.n * o.d * quoteUsd.d;
    const lhs = n * baseUsd.d,
      rhs = d * baseUsd.n,
      delta = lhs - rhs;
    const worse = quote.side === 'Buy' ? delta > 0n : delta < 0n,
      distance = delta < 0n ? -delta : delta;
    return {
      available: true as const,
      source: 'saved-token-and-server-quote-dexscreener-usd' as const,
      quoteObservation: counter,
      baseObservedAt: base.observedAt,
      quoteObservedAt: counter.observedAt,
      baseMarketPair: b.address,
      quoteMarketPair: c.address,
      basePriceUsd: b.priceUsd,
      quotePriceUsd: c.priceUsd,
      orderImpliedBasePriceUsd: display(n, d),
      differenceBps: ((delta * 10000n) / rhs).toString(),
      worse,
      acknowledgementRequired: worse && distance * 10000n > rhs * 200n,
      expiresAt: new Date(
        Math.min(Date.parse(base.observedAt), Date.parse(counter.observedAt)) +
          300000,
      ).toISOString(),
    };
  } catch {
    return missing(
      'Saved market prices and order amounts do not have comparable positive decimal units.',
    );
  }
}

export async function readPairOrderMarketBound(
  db: D1Database,
  owner: string,
  quote: ImportedPairQuote,
  order: SolanaPairPreparation,
  now: number,
  options: {
    selectedMarketPair?: string | null;
    quoteObservation?: TokenMarket | null;
    signal?: AbortSignal;
    observeQuote?: typeof observeTokenMarket;
    clock?: () => number;
  } = {},
) {
  const read = async (address: string, id?: string) => {
    const row = await db
      .prepare(
        "SELECT m.document,p.revision FROM imported_token_projects p JOIN imported_market_observations m ON m.owner_id=p.owner_id AND m.project_id=p.id WHERE p.owner_id=? AND p.chain='Solana' AND p.address=? AND p.archived=0 AND (? IS NULL OR p.id=?) ORDER BY m.observed_at DESC,p.id LIMIT 1",
      )
      .bind(owner, address, id ?? null, id ?? null)
      .first<{ document: string; revision: number }>();
    if (!row) return null;
    const items: unknown = JSON.parse(row.document);
    if (!Array.isArray(items) || items.length > 20) return null;
    const latest = items[0] as SavedTokenMarket | undefined;
    return latest && latest.projectRevision === row.revision ? latest : null;
  };
  const base = await read(quote.pair.base.address, quote.pair.projectId);
  const selected = options.selectedMarketPair ?? null;
  const preliminary = pairOrderMarketBound(
    quote,
    order,
    base,
    options.quoteObservation ?? null,
    now,
    selected,
  );
  if (
    preliminary.available ||
    preliminary.reasonCode !== 'quote-price-unavailable' ||
    Object.hasOwn(options, 'quoteObservation')
  )
    return preliminary;
  const counter = await readPairQuoteUsdObservation(
    quote.pair.quote.address,
    options.signal ?? new AbortController().signal,
    options.observeQuote,
  );
  options.signal?.throwIfAborted();
  return pairOrderMarketBound(
    quote,
    order,
    base,
    counter,
    (options.clock ?? Date.now)(),
    selected,
  );
}

/** Server-only read of an exact mint through the existing bounded USD-market adapter.
 * Never assumes a stablecoin peg or uses Jupiter as the independent source. */
export async function readPairQuoteUsdObservation(
  address: string,
  signal: AbortSignal,
  observe: typeof observeTokenMarket = observeTokenMarket,
): Promise<TokenMarket | null> {
  try {
    return await observe(
      { chain: 'Solana', address },
      AbortSignal.any([signal, AbortSignal.timeout(3000)]),
    );
  } catch {
    return null;
  }
}
export type PairOrderMarketBound = ReturnType<typeof pairOrderMarketBound>;
