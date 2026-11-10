'use client';
import { BarChart3 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  OVERVIEW_PERIODS,
  formatUsdCompact,
  rankByVolume,
  type MarketOverview as Overview,
  type OverviewNetworkId,
  type OverviewPeriod,
} from '@/lib/market-overview';
import styles from './market-overview.module.css';

const REFRESH_MS = 5 * 60_000;
const PERIOD_LABEL: Record<OverviewPeriod, string> = {
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
  all: 'All',
};
const change = (value: number | null) =>
  value === null ? '' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;

/**
 * Market Overview in the status bar: DEX volume, networks and launchpads
 * ranked by volume, and a trench heat score. Display only.
 */
export function MarketOverview() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Overview | null>(null);
  const [failed, setFailed] = useState(false);
  const [period, setPeriod] = useState<OverviewPeriod>('24h');
  const [network, setNetwork] = useState<OverviewNetworkId>('All');
  const wrap = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    const controller = new AbortController();
    const load = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const response = await fetch('/api/market-overview', {
          cache: 'no-store',
          signal: controller.signal,
        });
        const body = (await response.json()) as Overview;
        if (!active) return;
        if (response.ok && Array.isArray(body.networks)) {
          setData(body);
          setFailed(false);
        } else setFailed(true);
      } catch {
        if (active) setFailed(true);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    const away = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const current =
    data?.networks.find((n) => n.id === network) ??
    data?.networks.find((n) => n.id === 'All') ??
    null;
  const chains = data
    ? rankByVolume(
        data.networks.filter((n) => n.id !== 'All'),
        period,
      )
    : [];
  const launchpads = current ? rankByVolume(current.launchpads, period) : [];
  const top = chains[0]?.volume[period] ?? 0;

  return (
    <span className={styles.wrap} ref={wrap}>
      <button
        type="button"
        className="statusbar-link"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <BarChart3 /> Market
      </button>
      {open && (
        <section className={styles.panel} aria-label="Market Overview">
          <header className={styles.head}>
            <strong>Market Overview</strong>
            <div className={styles.tabs}>
              {OVERVIEW_PERIODS.map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={period === p}
                  onClick={() => setPeriod(p)}
                >
                  {PERIOD_LABEL[p]}
                </button>
              ))}
            </div>
          </header>
          {!data ? (
            <p className={styles.note} role={failed ? 'alert' : undefined}>
              {failed
                ? 'Market overview is unavailable right now.'
                : 'Loading market overview…'}
            </p>
          ) : (
            <>
              <div className={styles.tabs}>
                {data.networks.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    aria-pressed={current?.id === n.id}
                    onClick={() => setNetwork(n.id)}
                  >
                    {n.id}
                  </button>
                ))}
              </div>
              <div className={styles.summary}>
                <div>
                  <small>DEX volume ({PERIOD_LABEL[period]})</small>
                  <b>{formatUsdCompact(current?.volume[period] ?? null)}</b>
                  {period === '24h' && current?.change1d != null && (
                    <em data-up={current.change1d >= 0}>
                      {change(current.change1d)}
                    </em>
                  )}
                </div>
                <div>
                  <small>Launchpad volume ({PERIOD_LABEL[period]})</small>
                  <b>
                    {formatUsdCompact(
                      launchpads.length
                        ? launchpads.reduce(
                            (sum, pad) => sum + (pad.volume[period] ?? 0),
                            0,
                          )
                        : null,
                    )}
                  </b>
                </div>
                <div>
                  <small>Trench index</small>
                  {current?.trench ? (
                    <>
                      <b>
                        {current.trench.score}
                        <span>/100</span>
                      </b>
                      <em>{current.trench.label}</em>
                      <span className={styles.meter} aria-hidden="true">
                        <span style={{ width: `${current.trench.score}%` }} />
                      </span>
                    </>
                  ) : (
                    <b>—</b>
                  )}
                </div>
              </div>
              <div className={styles.columns}>
                <div>
                  <h4>Chains</h4>
                  <ol className={styles.list}>
                    {chains.map((chain) => (
                      <li key={chain.id}>
                        <button
                          type="button"
                          aria-pressed={current?.id === chain.id}
                          onClick={() => setNetwork(chain.id)}
                        >
                          <span>{chain.id}</span>
                          <span>{formatUsdCompact(chain.volume[period])}</span>
                          <i
                            style={{
                              width: `${top > 0 ? ((chain.volume[period] ?? 0) / top) * 100 : 0}%`,
                            }}
                          />
                        </button>
                      </li>
                    ))}
                  </ol>
                </div>
                <div>
                  <h4>Launchpads</h4>
                  {launchpads.length ? (
                    <ol className={styles.list}>
                      {launchpads.slice(0, 10).map((pad) => (
                        <li key={pad.name}>
                          <div>
                            <span title={pad.chains.join(', ')}>
                              {pad.name}
                            </span>
                            <span>
                              {formatUsdCompact(pad.volume[period])}
                              {period === '24h' && pad.change1d !== null && (
                                <em data-up={pad.change1d >= 0}>
                                  {' '}
                                  {change(pad.change1d)}
                                </em>
                              )}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className={styles.note}>No launchpad volume reported.</p>
                  )}
                </div>
              </div>
              <p className={styles.note}>
                Volume from DefiLlama, refreshed every 5 minutes. The trench
                index is Bundle&apos;s estimate: last 24h of launchpad volume
                against the 30 day daily average (50 is an average day). Display
                only.
              </p>
            </>
          )}
        </section>
      )}
    </span>
  );
}
