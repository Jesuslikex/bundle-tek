'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { SupplyAlertInbox } from './supply-alert-inbox';
import { SupplyDistributionSummary } from './supply-distribution-summary';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { SupplyScope } from '@/lib/supply-scope';
import {
  canonicalSupplyScope,
  requireSupplyHistoryRow,
  supplyScopeId,
  type SupplyHistoryRow,
} from '@/lib/supply-history';
import {
  createForegroundMarketFeed,
  type MarketFeedState,
  type MarketFeedReadResult,
} from '@/lib/foreground-market-feed';
import {
  fetchSupplyMonitorJson,
  supplyMonitorFailure,
} from '@/lib/supply-monitor-read';
type Scope = { id: string; scope: SupplyScope };
type Page = {
  id: string;
  revision: number;
  scopeId: string | null;
  scopes: Scope[];
  items: SupplyHistoryRow[];
  nextCursor: number | null;
  error?: string;
};

export function SupplyHistoryChart({ items }: { items: SupplyHistoryRow[] }) {
  const ordered = items.toReversed();
  if (ordered.length < 2)
    return <p>Save a second supply read to chart team ownership over time.</p>;
  const first = Date.parse(ordered[0].document.snapshot.observedAt),
    last = Date.parse(ordered.at(-1)!.document.snapshot.observedAt);
  const points = ordered
    .map(
      (row) =>
        `${40 + ((Date.parse(row.document.snapshot.observedAt) - first) / Math.max(1, last - first)) * 520},${130 - row.document.snapshot.parts.team.supplyPercent * 1.1}`,
    )
    .join(' ');
  return (
    <figure className="supply-history-chart">
      {/* oxlint-disable jsx-a11y/prefer-tag-over-role -- Accessible inline SVG supply chart. */}
      <svg
        role="img"
        aria-label={`Team supply percentage across ${ordered.length} saved observations`}
        viewBox="0 0 600 165"
      >
        <title>Observed team ownership over time</title>
        <text x="4" y="24">
          100%
        </text>
        <text x="10" y="132">
          0%
        </text>
        <line
          x1="40"
          x2="560"
          y1="130"
          y2="130"
          stroke="currentColor"
          opacity=".2"
        />
        <polyline
          points={points}
          fill="none"
          stroke="#8b87ff"
          strokeWidth="3"
        />
      </svg>
      {/* oxlint-enable jsx-a11y/prefer-tag-over-role */}
      <figcaption>
        {ordered.length} saved reads · {new Date(first).toLocaleString()} to{' '}
        {new Date(last).toLocaleString()}. Lines connect observations, not every
        on-chain movement.
      </figcaption>
    </figure>
  );
}
export function SavedSupplyMonitor({
  project,
  selected,
  onRestore,
  onReady,
}: {
  project: ImportedTokenProject;
  selected: SupplyScope['wallets'];
  onRestore: (scope: SupplyScope) => void;
  onReady?: () => void;
}) {
  const [scopes, setScopes] = useState<Scope[]>([]),
    [active, setActive] = useState(''),
    [items, setItems] = useState<SupplyHistoryRow[]>([]),
    [cursor, setCursor] = useState<number | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [feedState, setFeedState] = useState<MarketFeedState>({
    status: 'off',
    reason: '',
    reads: 0,
  });
  const pending = useRef<AbortController | null>(null),
    feed = useRef<ReturnType<typeof createForegroundMarketFeed> | null>(null);
  const body = JSON.stringify({
    id: project.id,
    revision: project.revision,
    wallets: selected,
  });
  const restoreRef = useRef(onRestore);
  const readyRef = useRef(onReady);
  // Update callback after commit; the monitor's saved selection is restored only on load or explicit scope navigation.
  useEffect(() => {
    restoreRef.current = onRestore;
    readyRef.current = onReady;
  }, [onRestore, onReady]);
  const accept = useCallback(
    async (
      data: Page,
      expected: string | null,
      older = false,
      restore = false,
      signal?: AbortSignal,
    ) => {
      if (
        data.id !== project.id ||
        data.revision !== project.revision ||
        !Array.isArray(data.scopes) ||
        data.scopes.length > 100 ||
        !Array.isArray(data.items) ||
        data.items.length > 50 ||
        (expected && data.scopeId !== expected)
      )
        throw new Error('Supply history context differs.');
      for (const scope of data.scopes) {
        if (
          scope.scope.mint !== project.document.token.address ||
          (await supplyScopeId(scope.scope)) !== scope.id
        )
          throw new Error('Saved monitor context differs.');
      }
      const scope = data.scopes.find((s) => s.id === data.scopeId);
      if (!scope && (data.items.length || data.scopeId !== null))
        throw new Error('Missing supply scope.');
      let previous = Number.MAX_SAFE_INTEGER;
      for (const item of data.items) {
        requireSupplyHistoryRow(item, scope!.scope, scope!.id);
        if (item.sequence >= previous)
          throw new Error('Supply history ordering differs.');
        previous = item.sequence;
      }
      if (
        data.nextCursor !== null &&
        (data.items.length !== 50 ||
          data.nextCursor !== data.items.at(-1)?.sequence)
      )
        throw new Error('Supply cursor differs.');
      // Scope hashing awaits Web Crypto. A superseded request must not restore
      // its watchlist or history after a newer selection has taken over.
      if (signal?.aborted) return;
      setScopes(data.scopes);
      setActive(data.scopeId ?? '');
      setCursor(data.nextCursor);
      setItems((old) =>
        older
          ? [
              ...old,
              ...data.items.filter(
                (row) =>
                  !old.some((existing) => existing.sequence === row.sequence),
              ),
            ]
          : data.items,
      );
      if (restore && scope) restoreRef.current(scope.scope);
    },
    [project.id, project.revision, project.document.token.address],
  );
  const load = useCallback(
    async (
      scope: string | null = null,
      older: number | null = null,
      restore = false,
      signal?: AbortSignal,
    ) => {
      const url = new URL(
        '/api/imported-projects/supply-history',
        location.origin,
      );
      url.searchParams.set('id', project.id);
      url.searchParams.set('revision', String(project.revision));
      if (scope) url.searchParams.set('scope', scope);
      if (older) url.searchParams.set('cursor', String(older));
      const data = await fetchSupplyMonitorJson<Page>(
        url,
        { signal, cache: 'no-store' },
        'Cannot read supply history.',
      );
      if (signal?.aborted) return;
      await accept(data, scope, Boolean(older), restore, signal);
    },
    [accept, project.id, project.revision],
  );
  useEffect(() => {
    const c = new AbortController();
    pending.current = c;
    queueMicrotask(() => {
      if (c.signal.aborted) return;
      void load(null, null, true, c.signal)
        .then(() => {
          if (!c.signal.aborted) readyRef.current?.();
        })
        .catch((e) => {
          if (!c.signal.aborted)
            setError(
              e instanceof Error ? e.message : 'Cannot load saved supply.',
            );
        });
    });
    return () => {
      c.abort();
      pending.current?.abort();
    };
  }, [load]);
  const pendingRefresh = useRef<{ body: string; scopeId: string } | null>(null);
  const save = useCallback(
    async (signal?: AbortSignal): Promise<MarketFeedReadResult> => {
      setBusy(true);
      setError('');
      try {
        // A saved observation must not be posted again just because its history GET failed.
        const refresh = pendingRefresh.current;
        if (refresh?.body === body) {
          await load(refresh.scopeId, null, false, signal);
          if (signal?.aborted) return false;
          if (pendingRefresh.current === refresh) pendingRefresh.current = null;
          return true;
        }
        const data = await fetchSupplyMonitorJson<{
          id: string;
          revision: number;
          scopeId: string;
          scope: SupplyScope;
          item: SupplyHistoryRow;
          error?: string;
        }>(
          '/api/imported-projects/supply-history',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            signal,
          },
          'Cannot save supply read.',
        );
        const expected = canonicalSupplyScope({
          mint: project.document.token.address,
          wallets: selected,
        });
        if (
          data.id !== project.id ||
          data.revision !== project.revision ||
          data.scopeId !== (await supplyScopeId(expected)) ||
          JSON.stringify(canonicalSupplyScope(data.scope)) !==
            JSON.stringify(expected)
        )
          throw new Error('Saved supply scope differs.');
        requireSupplyHistoryRow(data.item, expected, data.scopeId);
        if (signal?.aborted) return false;
        const savedRefresh = { body, scopeId: data.scopeId };
        pendingRefresh.current = savedRefresh;
        await load(data.scopeId, null, false, signal);
        if (signal?.aborted) return false;
        if (pendingRefresh.current === savedRefresh)
          pendingRefresh.current = null;
        return true;
      } catch (e) {
        if (!signal?.aborted)
          setError(e instanceof Error ? e.message : 'Cannot save supply read.');
        return signal?.aborted ? false : supplyMonitorFailure(e);
      } finally {
        if (!signal?.aborted) setBusy(false);
      }
    },
    [
      body,
      project.id,
      project.revision,
      project.document.token.address,
      selected,
      load,
    ],
  );
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);
  useEffect(() => {
    if (project.document.token.chain !== 'Solana') return;
    const f = createForegroundMarketFeed({
      available: () =>
        document.visibilityState === 'visible' &&
        navigator.onLine &&
        !project.archived,
      read: (s) => saveRef.current(s),
      onState: setFeedState,
    });
    feed.current = f;
    let current = true;
    queueMicrotask(() => {
      if (current) {
        setFeedState({ status: 'off', reason: '', reads: 0 });
        setBusy(false);
      }
    });
    const pause = () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) {
        f.pause('Hidden tab or offline browser.');
        setBusy(false);
      }
    };
    document.addEventListener('visibilitychange', pause);
    window.addEventListener('offline', pause);
    return () => {
      current = false;
      f.destroy();
      document.removeEventListener('visibilitychange', pause);
      window.removeEventListener('offline', pause);
    };
  }, [body, project.archived, project.document.token.chain]);
  async function readHistory(
    scope = active,
    older: number | null = null,
    restore = false,
  ) {
    feed.current?.stop();
    pending.current?.abort();
    const c = new AbortController();
    pending.current = c;
    setBusy(true);
    setError('');
    try {
      await load(scope || null, older, restore, c.signal);
    } catch (e) {
      if (!c.signal.aborted)
        setError(
          e instanceof Error ? e.message : 'Supply history unavailable.',
        );
    } finally {
      if (!c.signal.aborted) setBusy(false);
    }
  }
  const latest = items[0]?.document.snapshot;
  const canRead =
    project.document.token.chain === 'Solana' &&
    !project.archived &&
    selected.length > 0 &&
    selected.length <= 12;
  return (
    <section
      className="saved-supply-monitor"
      aria-label="Saved supply history and alerts"
    >
      <h3>Supply history and wallet alerts</h3>
      <p>
        Reads and net wallet changes are saved to this account and token
        project. Each classified watchlist has its own history. First reads
        establish a baseline.
      </p>
      <div className="wallet-roster-actions">
        <Button
          variant="outline"
          disabled={!canRead || busy || feedState.status === 'running'}
          onClick={() => {
            pending.current?.abort();
            const c = new AbortController();
            pending.current = c;
            void save(c.signal);
          }}
        >
          Save current supply read
        </Button>
        <Button
          variant="outline"
          disabled={feedState.status !== 'running' && (!canRead || busy)}
          onClick={() => {
            if (feedState.status === 'running') {
              feed.current?.stop();
              setBusy(false);
            } else feed.current?.start();
          }}
        >
          {feedState.status === 'running'
            ? 'Stop movement alerts'
            : 'Start movement alerts'}
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void readHistory()}
        >
          Reload saved supply history
        </Button>
      </div>
      <output>
        Monitoring {feedState.status}. {feedState.reason} {feedState.reads}{' '}
        successful reads this session. Reads repeat 30 seconds after completion
        while this project is visible and online. No background watcher runs
        after closing the page.
      </output>
      {!canRead && (
        <p>
          Choose 1 to 12 public Solana wallets to save or monitor new reads.
        </p>
      )}
      {scopes.length > 0 && (
        <label>
          Saved supply watchlist
          <select
            value={active}
            disabled={busy || feedState.status === 'running'}
            onChange={(e) => void readHistory(e.target.value, null, true)}
          >
            {scopes.map((s, i) => (
              <option key={s.id} value={s.id}>
                Watchlist {i + 1} · {s.scope.wallets.length} wallets ·{' '}
                {s.scope.wallets.filter((w) => w.group === 'team').length} team
                · {s.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
      )}
      {latest && (
        <>
          <p>
            Saved {new Date(latest.observedAt).toLocaleString()} · confirmed
            slots {latest.minSlot} to {latest.maxSlot} · {latest.source}
          </p>
          <SupplyDistributionSummary snapshot={latest} />
          <SupplyHistoryChart items={items} />
        </>
      )}
      <h4>Wallet movement alerts</h4>
      <p>
        Net changes between confirmed observations, not decoded transactions.
        Multiple buys, sells, or transfers can offset between reads. Alerts
        remain in saved history; new reads need the open page.
      </p>
      <div aria-live="polite">
        {items.slice(0, 1).map((row) => (
          <p key={row.id}>
            {row.document.alerts.length} wallet changes in the latest saved
            interval.
          </p>
        ))}
      </div>
      {active && (
        <SupplyAlertInbox
          key={`${project.id}:${project.revision}:${active}`}
          projectId={project.id}
          revision={project.revision}
          scope={active}
          items={items}
        />
      )}
      <details>
        <summary>Saved observation timeline ({items.length} loaded)</summary>
        {items.map((row) => (
          <article key={row.id}>
            <p>
              #{row.sequence} ·{' '}
              {new Date(row.document.snapshot.observedAt).toLocaleString()} ·{' '}
              {row.document.alerts.length} changes · captured project r
              {row.document.projectRevision}
            </p>
            <p>
              Team {row.document.snapshot.parts.team.amount} tokens. Total
              supply change {row.document.supplyChangeRaw} raw units.
            </p>
          </article>
        ))}
      </details>
      {cursor && (
        <Button
          variant="outline"
          disabled={busy || items.length >= 500}
          onClick={() => void readHistory(active, cursor)}
        >
          Load older supply history
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
