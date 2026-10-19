'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { readPanelJson } from '@/components/read-panel-json';
import {
  parseLaunchLayerHistory,
  type LaunchLayerHistoryItem,
} from '@/lib/launch-layer-history';
import styles from './pump-layer-planner.module.css';

export function LaunchLayerHistory({
  projectId,
  mint,
  disabled,
  refreshVersion = 0,
  onOpen,
}: {
  projectId: string;
  mint: string;
  disabled: boolean;
  refreshVersion?: number;
  onOpen: (entry: LaunchLayerHistoryItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<LaunchLayerHistoryItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const active = useRef<{
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const generation = useRef(0);
  const lastRefresh = useRef(refreshVersion);
  useEffect(
    () => () => {
      generation.current++;
      active.current?.controller.abort();
      if (active.current) clearTimeout(active.current.timer);
    },
    [],
  );
  const cancel = useCallback(() => {
    generation.current++;
    active.current?.controller.abort();
    if (active.current) clearTimeout(active.current.timer);
    active.current = null;
    setLoading(false);
  }, []);
  const load = useCallback(async () => {
    if (active.current || disabled) return;
    const mine = ++generation.current,
      controller = new AbortController();
    const timer = setTimeout(() => {
      if (generation.current !== mine) return;
      cancel();
      setError('History loading timed out. Reload the history to try again.');
    }, 30000);
    active.current = { controller, timer };
    setLoading(true);
    setError('');
    try {
      const response = await fetch(
        '/api/launch/layers?history=' + encodeURIComponent(projectId),
        { signal: controller.signal, cache: 'no-store' },
      );
      const body = (await readPanelJson(
        response,
        'Saved planning history is unavailable. Reload to try again.',
      )) as { history?: unknown } | null;
      if (!response.ok)
        throw new Error(
          'Saved planning history is unavailable. Reload to try again.',
        );
      const parsed = parseLaunchLayerHistory(body?.history, projectId);
      if (generation.current === mine && !controller.signal.aborted)
        setItems(parsed.items);
    } catch (cause) {
      if (generation.current === mine)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Saved planning history is unavailable.',
        );
    } finally {
      clearTimeout(timer);
      if (generation.current === mine) {
        active.current = null;
        setLoading(false);
      }
    }
  }, [cancel, disabled, projectId]);
  useEffect(() => {
    if (lastRefresh.current === refreshVersion || disabled) return;
    let superseded = false;
    // Start the post-save read after this commit; superseded effects must not
    // consume the refresh version or start a request for an older UI context.
    void Promise.resolve().then(() => {
      if (superseded) return;
      lastRefresh.current = refreshVersion;
      cancel();
      setItems(null);
      setError('');
      if (open) void load();
    });
    return () => {
      superseded = true;
    };
  }, [cancel, disabled, load, open, refreshVersion]);
  return (
    <section className={styles.history} aria-label="Saved planning history">
      <Button
        variant="outline"
        disabled={disabled}
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open && items === null) void load();
        }}
      >
        {open ? 'Hide planning history' : 'Browse saved planning history'}
      </Button>
      {open && (
        <div>
          <p>
            Retained snapshots, newest first. Opening checks the full saved
            record and does not change your editable draft. These records do not
            authorize funding or execution.
          </p>
          <Button
            variant="outline"
            disabled={disabled || loading}
            onClick={() => void load()}
          >
            Reload planning history
          </Button>
          {loading && (
            <>
              <p>
                <output>Loading planning history…</output>
              </p>
              <Button
                variant="outline"
                onClick={() => {
                  cancel();
                  setError('History loading cancelled. Reload to try again.');
                }}
              >
                Cancel history loading
              </Button>
            </>
          )}
          {error && <p role="alert">{error}</p>}
          {!loading && items?.length === 0 && (
            <p>No saved planning snapshots yet.</p>
          )}
          {items && (
            <>
              <p>
                {items.length} retained snapshot{items.length === 1 ? '' : 's'}.
                Reload to include newer saves. Current references are checked
                when you open a record.
              </p>
              <ol className={styles.roleList}>
                {items.map((entry) => (
                  <li key={entry.id}>
                    <time dateTime={entry.createdAt}>
                      {new Date(entry.createdAt).toLocaleString()}
                    </time>
                    <span>
                      {entry.target.kind === 'new'
                        ? 'New mint'
                        : 'Imported mint'}{' '}
                      ·{' '}
                      {entry.target.mint === mint
                        ? 'Matches current mint candidate'
                        : 'Different mint'}
                    </span>
                    <code>{entry.target.mint}</code>
                    <Button
                      variant="outline"
                      disabled={disabled || loading}
                      aria-label={'Open snapshot ' + entry.id}
                      onClick={() => onOpen(entry)}
                    >
                      Open snapshot
                    </Button>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </section>
  );
}
