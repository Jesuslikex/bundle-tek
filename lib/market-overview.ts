/**
 * Market Overview (Proxima "Market Overview" bottom bar): DEX volume by
 * network, launchpads ranked by volume and a trench heat score.
 *
 * Display only, built from DefiLlama's public DEX volume overview. It never
 * feeds a quote, a size or a transaction. DefiLlama does not publish trade
 * counts, wallets per day or tokens created, so those are not shown.
 */
export const OVERVIEW_PERIODS = ['24h', '7d', '30d', 'all'] as const;
export type OverviewPeriod = (typeof OVERVIEW_PERIODS)[number];
/** Bundle network name -> DefiLlama chain slug. */
export const OVERVIEW_NETWORKS = [
  ['Solana', 'solana'],
  ['Base', 'base'],
  ['BNB', 'bsc'],
  ['Ethereum', 'ethereum'],
] as const;
export type OverviewNetworkId = 'All' | (typeof OVERVIEW_NETWORKS)[number][0];
export type OverviewVolumes = Record<OverviewPeriod, number | null>;
export type OverviewLaunchpad = {
  name: string;
  chains: string[];
  volume: OverviewVolumes;
  change1d: number | null;
};
export type TrenchIndex = { score: number; label: string };
export type OverviewNetwork = {
  id: OverviewNetworkId;
  volume: OverviewVolumes;
  change1d: number | null;
  launchpads: OverviewLaunchpad[];
  trench: TrenchIndex | null;
};
export type MarketOverview = {
  observedAt: string;
  source: 'DefiLlama';
  networks: OverviewNetwork[];
};

const amount = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
const signed = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const volumes = (row: Record<string, unknown>): OverviewVolumes => ({
  '24h': amount(row.total24h),
  '7d': amount(row.total7d),
  '30d': amount(row.total30d),
  all: amount(row.totalAllTime),
});

export const TRENCH_LABELS = [
  'Ded',
  'Cold',
  'Neutral',
  'Hot',
  'Euphoric',
] as const;
/**
 * Bundle's own heat score, 0 to 100: the last 24h of launchpad volume against
 * the 30 day daily average. An average day scores 50, double scores 100.
 * This is not Proxima's formula, which is not public.
 */
export function trenchIndex(
  launchpads: Pick<OverviewLaunchpad, 'volume'>[],
): TrenchIndex | null {
  let day = 0,
    month = 0;
  for (const pad of launchpads) {
    day += pad.volume['24h'] ?? 0;
    month += pad.volume['30d'] ?? 0;
  }
  if (month <= 0) return null;
  const score = Math.round(
    Math.min(100, Math.max(0, (day / (month / 30)) * 50)),
  );
  return { score, label: TRENCH_LABELS[Math.min(4, Math.floor(score / 20))] };
}

/** One DefiLlama `/overview/dexs[/chain]` body to a network summary. */
export function parseOverviewNetwork(
  id: OverviewNetworkId,
  raw: unknown,
): OverviewNetwork | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const volume = volumes(body);
  if (volume['24h'] === null && volume['30d'] === null) return null;
  const launchpads: OverviewLaunchpad[] = [];
  for (const entry of Array.isArray(body.protocols) ? body.protocols : []) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    if (row.category !== 'Launchpad') continue;
    const name =
      typeof row.displayName === 'string'
        ? row.displayName
        : typeof row.name === 'string'
          ? row.name
          : '';
    const padVolume = volumes(row);
    if (!name || name.length > 60) continue;
    if (!(padVolume['30d'] ?? 0) && !(padVolume['24h'] ?? 0)) continue;
    launchpads.push({
      name,
      chains: Array.isArray(row.chains)
        ? row.chains
            .filter((c): c is string => typeof c === 'string' && c.length <= 30)
            .slice(0, 12)
        : [],
      volume: padVolume,
      change1d: signed(row.change_1d),
    });
  }
  launchpads.sort((a, b) => (b.volume['24h'] ?? 0) - (a.volume['24h'] ?? 0));
  return {
    id,
    volume,
    change1d: signed(body.change_1d),
    launchpads: launchpads.slice(0, 25),
    trench: trenchIndex(launchpads),
  };
}

/** Rank rows by the chosen period, biggest first; unknown volumes go last. */
export function rankByVolume<T extends { volume: OverviewVolumes }>(
  rows: T[],
  period: OverviewPeriod,
): T[] {
  return rows
    .slice()
    .sort((a, b) => (b.volume[period] ?? -1) - (a.volume[period] ?? -1));
}

export function formatUsdCompact(value: number | null) {
  if (value === null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    minimumFractionDigits: 0,
    maximumFractionDigits: value >= 1000 ? 2 : 0,
  }).format(value);
}
