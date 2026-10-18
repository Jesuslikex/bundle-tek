'use client';

import {
  type CSSProperties,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import styles from './imported-workspace-frame.module.css';

type Fit = { height: number; chart: number } | null;

/** Presentation only. Keep the full chart and a usable wallet row, or use flow. */
export function ImportedWorkspaceFrame({
  compact,
  children,
}: {
  compact: boolean;
  children: ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<Fit>(null);
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const workspace = element.closest<HTMLElement>('.workspace');
    const container =
      element.closest<HTMLElement>('.imported-projects') ?? element;
    let queued = 0;
    const measure = () => {
      queued = 0;
      const chart = element.querySelector<HTMLElement>(
        ':scope > [aria-label="Open token chart"]',
      );
      const plot = chart?.querySelector<HTMLElement>(
        '[aria-label="Inspect chart candles"]',
      );
      let next: Fit = null;
      if (compact && workspace && chart && plot) {
        const bounds = element.getBoundingClientRect();
        // Use the unscrolled frame position so ordinary page scrolling does
        // not continually change its height or jump the user's location.
        const height = Math.floor(
          workspace.getBoundingClientRect().bottom -
            (bounds.top + workspace.scrollTop) -
            4,
        );
        const chartHeight = Math.ceil(
          plot.getBoundingClientRect().bottom -
            chart.getBoundingClientRect().top +
            chart.scrollTop +
            12,
        );
        if (
          window.innerWidth >= 1360 &&
          window.innerHeight >= 800 &&
          bounds.width >= 1000 &&
          chartHeight >= 310 &&
          // Narrow desktop columns wrap wallet addresses and review buttons.
          // Reserve their taller first row instead of clipping it to fit.
          height >= chartHeight + (bounds.width < 1400 ? 264 : 224) + 12
        ) {
          next = { height, chart: chartHeight };
        }
      }
      setFit((previous) =>
        previous?.height === next?.height && previous?.chart === next?.chart
          ? previous
          : next,
      );
    };
    const schedule = () => {
      if (!queued) queued = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    if (workspace) resize.observe(workspace);
    resize.observe(container);
    const mutation = new MutationObserver(schedule);
    mutation.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['open'],
    });
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      if (queued) cancelAnimationFrame(queued);
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [compact]);
  const geometry =
    compact && fit
      ? ({
          '--workspace-fit-height': `${fit.height}px`,
          '--workspace-chart-height': `${fit.chart}px`,
        } as CSSProperties)
      : undefined;
  return (
    <div
      ref={frame}
      className={`imported-live-workspace${compact ? ' imported-live-workspace--compact' : ''} ${styles.frame}${geometry ? ` ${styles.docked}` : ''}`}
      style={geometry}
      data-wallet-dock={geometry ? 'docked' : 'flow'}
    >
      {children}
    </div>
  );
}

type WorkspaceView = {
  id: string;
  title: string;
  content: ReactNode;
};

const WalletView = createContext<(() => void) | null>(null);
export function useImportedWorkspaceWalletView() {
  return useContext(WalletView);
}

/** Mounted panels retain their local review state. No fetch or financial action. */
export function ImportedWorkspaceViews({
  views,
  tabbed,
}: {
  views: readonly WorkspaceView[];
  tabbed: boolean;
}) {
  const prefix = useId();
  const viewRoot = useRef<HTMLElement>(null);
  const [selected, setSelected] = useState(views[0]?.id ?? '');
  const [updated, setUpdated] = useState<ReadonlySet<string>>(() => new Set());
  const current = views.some((view) => view.id === selected)
    ? selected
    : (views[0]?.id ?? '');
  const changedTitles = views
    .filter((view) => updated.has(view.id))
    .map((view) => view.title);
  const choose = useCallback((id: string) => {
    setSelected(id);
    setUpdated((previous) => {
      if (!previous.has(id)) return previous;
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
  }, []);
  const showWallets = useCallback(() => choose('wallets'), [choose]);
  useEffect(() => {
    const root = viewRoot.current;
    if (!root) return;
    const observer = new MutationObserver((records) => {
      const changed = new Set<string>();
      for (const record of records) {
        const target =
          record.target instanceof Element
            ? record.target
            : record.target.parentElement;
        const panel = target?.closest<HTMLElement>('[data-workspace-view]');
        if (
          panel?.hidden &&
          root.contains(panel) &&
          panel.dataset.workspaceView
        )
          changed.add(panel.dataset.workspaceView);
      }
      if (!changed.size) return;
      setUpdated((previous) => {
        if ([...changed].every((id) => previous.has(id))) return previous;
        return new Set([...previous, ...changed]);
      });
    });
    // A presentation marker for changed hidden content, not an alert count or
    // a read receipt. Switching views does not stop existing monitors.
    observer.observe(root, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, []);
  return (
    <WalletView.Provider value={showWallets}>
      <section
        ref={viewRoot}
        className={`imported-workspace-wallets ${styles.views}`}
        aria-label="Token wallet and holder views"
      >
        {tabbed && (
          <div
            role="tablist"
            aria-label="Token workspace views"
            tabIndex={-1}
            className={styles.navigation}
            onKeyDown={(event) => {
              const index = views.findIndex((view) => view.id === current);
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? views.length - 1
                    : event.key === 'ArrowRight'
                      ? (index + 1) % views.length
                      : event.key === 'ArrowLeft'
                        ? (index + views.length - 1) % views.length
                        : null;
              if (next === null || !views[next]) return;
              event.preventDefault();
              choose(views[next].id);
              event.currentTarget
                .querySelectorAll<HTMLButtonElement>('[role="tab"]')
                [next]?.focus();
            }}
          >
            {views.map((view) => (
              <button
                key={view.id}
                type="button"
                role="tab"
                id={`${prefix}-tab-${view.id}`}
                aria-selected={current === view.id}
                aria-label={view.title}
                aria-describedby={
                  updated.has(view.id)
                    ? `${prefix}-updated-${view.id}`
                    : undefined
                }
                aria-controls={`${prefix}-panel-${view.id}`}
                tabIndex={current === view.id ? 0 : -1}
                onClick={() => choose(view.id)}
              >
                {view.title}
                {updated.has(view.id) && (
                  <span
                    id={`${prefix}-updated-${view.id}`}
                    className={styles.updated}
                  >
                    Updated
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        {tabbed && (
          <output className={styles.notice} aria-live="polite">
            {changedTitles.length > 0 &&
              `Updated content: ${changedTitles.join(', ')}. `}
            Switching views keeps existing reviews and monitors active.
          </output>
        )}
        {views.map((view) => (
          <div
            key={view.id}
            id={`${prefix}-panel-${view.id}`}
            role={tabbed ? 'tabpanel' : 'region'}
            aria-label={tabbed ? undefined : view.title}
            aria-labelledby={tabbed ? `${prefix}-tab-${view.id}` : undefined}
            tabIndex={tabbed ? 0 : undefined}
            hidden={tabbed && current !== view.id}
            data-workspace-view={view.id}
            className={styles.panel}
          >
            {view.content}
          </div>
        ))}
      </section>
    </WalletView.Provider>
  );
}
