// The captured client hard-codes this fallback catalog in two places —
// `page-BR7nZb89.js` and `FundWalletsConfirm-DEyVv6mn.js` — as
// [{id:"binance",is_available:!0},{id:"gate",is_available:!0},{id:"kucoin",is_available:!0}]
// beside `/icons/cex/{binance,gate,kucoin}.png`. All three are available and
// served by husher. The reference prefers a server catalog and only falls back
// to this list, so a future source endpoint should override it.
//
// The capture carries no display-name map (`name` fell back to the raw id), so
// the capitalisations here are ours.
import {
  CEX_FUNDING_PROVIDER,
  type CexFundingSource,
} from './cex-funding-sources';

export const CEX_FUNDING_FALLBACK_SOURCES: readonly CexFundingSource[] =
  Object.freeze([
    {
      id: 'binance',
      name: 'Binance',
      available: true,
      provider: CEX_FUNDING_PROVIDER,
    },
    {
      id: 'gate',
      name: 'Gate',
      available: true,
      provider: CEX_FUNDING_PROVIDER,
    },
    {
      id: 'kucoin',
      name: 'KuCoin',
      available: true,
      provider: CEX_FUNDING_PROVIDER,
    },
  ]);

export const CEX_FUNDING_IDS: readonly string[] = Object.freeze(
  CEX_FUNDING_FALLBACK_SOURCES.map((source) => source.id),
);

// Funding stores a single free-text source label, so the picker writes the
// chosen names into it rather than needing a new field.
export function cexSourcesLabel(
  ids: readonly string[],
  sources: readonly CexFundingSource[] = CEX_FUNDING_FALLBACK_SOURCES,
) {
  return sources
    .filter((source) => ids.includes(source.id))
    .map((source) => source.name)
    .join(', ');
}

// Inverse of the label for restoring a draft: known names map back to ids.
export function cexIdsFromLabel(
  label: string,
  sources: readonly CexFundingSource[] = CEX_FUNDING_FALLBACK_SOURCES,
) {
  const wanted = label
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return sources
    .filter(
      (source) =>
        wanted.includes(source.id) ||
        wanted.includes(source.name.toLowerCase()),
    )
    .map((source) => source.id);
}
