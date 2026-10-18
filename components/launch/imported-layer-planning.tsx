'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  parseImportedLayerTargets,
  type ImportedLayerTargets,
  type LayerTargetCursor,
} from '@/lib/launch-layer-targets';
import { LaunchLayerPlanningEntry } from './launch-layer-planning-entry';
import styles from './imported-layer-planning.module.css';
class TargetReadError extends Error {}
type Props = {
  project: { id: string; updatedAt: string };
  scheduled: boolean;
  frontOnly?: boolean;
  disabled?: boolean;
};
function Picker({
  project,
  scheduled,
  frontOnly = false,
  disabled = false,
}: Props) {
  const id = useId();
  const [targets, setTargets] = useState<ImportedLayerTargets | null>(null),
    [selected, setSelected] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [search, setSearch] = useState(''),
    [page, setPage] = useState(0),
    [starts, setStarts] = useState<(LayerTargetCursor | undefined)[]>([
      undefined,
    ]);
  const request = useRef<AbortController | null>(null),
    alive = useRef(true);
  const selectionField = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (targets) selectionField.current?.focus();
  }, [targets]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current?.abort('unmounted');
    };
  }, []);
  const source = { projectId: project.id, projectUpdatedAt: project.updatedAt };
  async function load(cursor?: LayerTargetCursor, pageIndex = 0) {
    if (request.current || disabled || !scheduled) return;
    const query = {
      ...source,
      search: search.trim(),
      ...(cursor ? { cursor } : {}),
    };
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setTargets(null);
    setSelected('');
    setError('');
    const timer = setTimeout(() => controller.abort('timeout'), 30000);
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error('Read aborted'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const value = await Promise.race([
        aborted,
        (async () => {
          const response = await fetch(
            '/api/launch/layers?targets=' +
              encodeURIComponent(JSON.stringify(query)),
            { signal: controller.signal, cache: 'no-store' },
          );
          if (!response.ok)
            throw new TargetReadError(
              response.status === 401
                ? 'Sign in to choose an imported token.'
                : response.status === 409
                  ? cursor
                    ? 'Imported records changed. Reload the first page before continuing.'
                    : 'Save and reload a scheduled launch before choosing its imported token.'
                  : 'Imported tokens are unavailable. Reload the list to try again.',
            );
          const text = await response.text();
          if (new TextEncoder().encode(text).byteLength > 524288)
            throw new Error('Imported token response is too large.');
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            throw new Error('Imported token list was unreadable.');
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw new Error('Imported token list was incomplete.');
          return parseImportedLayerTargets(
            (parsed as Record<string, unknown>).targets,
            query,
          );
        })(),
      ]);
      if (
        alive.current &&
        request.current === controller &&
        !controller.signal.aborted
      ) {
        setTargets(value);
        setPage(pageIndex);
        setStarts((previous) =>
          pageIndex === 0
            ? [undefined]
            : [...previous.slice(0, pageIndex), cursor],
        );
      }
    } catch (cause) {
      if (alive.current && request.current === controller)
        setError(
          controller.signal.aborted
            ? controller.signal.reason === 'timeout'
              ? 'Loading timed out. Reload imported tokens to try again.'
              : 'Loading cancelled. Reload imported tokens when ready.'
            : cause instanceof TargetReadError
              ? cause.message
              : 'Imported tokens could not be confirmed. Reload the list before planning.',
        );
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      if (alive.current && request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  const target = targets?.items.find((row) => row.id === selected);
  return (
    <section
      className={styles.panel}
      aria-label="Existing-token layer planning"
    >
      <h3>Plan an existing imported token</h3>
      <p>
        Choose an active Solana token saved in this account. This plans buyer
        and holder stages for an existing token; it does not create a coin, fund
        wallets or enable signing.
      </p>
      {!scheduled && (
        <p>
          Save this launch with scheduling enabled before choosing an imported
          token.
        </p>
      )}
      <label htmlFor={id + '-search'}>Search imported tokens</label>
      <Input
        id={id + '-search'}
        className={styles.search}
        type="search"
        maxLength={80}
        value={search}
        disabled={disabled || busy || !scheduled}
        placeholder="Token name, symbol or mint"
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void load();
          }
        }}
        onChange={(event) => {
          setSearch(event.target.value);
          setTargets(null);
          setSelected('');
          setPage(0);
          setStarts([undefined]);
          setError('');
        }}
      />
      <Button
        type="button"
        variant="outline"
        disabled={disabled || busy || !scheduled}
        onClick={() => void load()}
      >
        {busy
          ? 'Loading imported tokens…'
          : targets
            ? 'Reload imported tokens'
            : search.trim()
              ? 'Search imported tokens'
              : 'Load imported tokens'}
      </Button>
      {busy && (
        <Button
          type="button"
          variant="outline"
          onClick={() => request.current?.abort('cancelled')}
        >
          Cancel token loading
        </Button>
      )}
      <p>
        Searching, changing pages or reloading clears the selection and closes
        its planner. Reload returns to the first page. Imports may change while
        browsing.
      </p>
      {targets && (
        <>
          <output aria-live="polite">
            Page {page + 1} · {targets.items.length} active Solana imports
            {targets.search ? ' matching “' + targets.search + '”' : ''}. Up to
            100 per page.
          </output>
          <nav className={styles.pages} aria-label="Imported token pages">
            <Button
              type="button"
              variant="outline"
              disabled={disabled || busy || page === 0}
              onClick={() => void load(starts[page - 1], page - 1)}
            >
              Previous imports
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={disabled || busy || !targets.nextCursor}
              onClick={() =>
                void load(targets.nextCursor ?? undefined, page + 1)
              }
            >
              Next imports
            </Button>
          </nav>
          {targets.items.length ? (
            <>
              <label htmlFor={id}>Imported token</label>
              <select
                id={id}
                ref={selectionField}
                className={styles.select}
                value={selected}
                disabled={disabled || busy}
                onChange={(event) => setSelected(event.target.value)}
              >
                <option value="">Choose an imported token</option>
                {targets.items.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.symbol} · {row.name} · rev {row.revision} · {row.mint}{' '}
                    · {row.id}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <p>
              {targets.search
                ? 'No active Solana imports match this search. Change the name, symbol or mint and search again.'
                : 'No active Solana imports were found. Import or restore a token in the workspace, then reload this list.'}
            </p>
          )}
          {target && (
            <>
              <p className={styles.address}>
                {target.name} ({target.symbol}) · revision {target.revision}
                <br />
                Mint: <code>{target.mint}</code>
                <br />
                Record: <code>{target.id}</code>
              </p>
              <LaunchLayerPlanningEntry
                selection={{
                  ...source,
                  target: {
                    kind: 'imported',
                    projectId: target.id,
                    revision: target.revision,
                    mint: target.mint,
                  },
                }}
                frontOnly={frontOnly}
                disabled={disabled || busy}
              />
            </>
          )}
        </>
      )}
      <div aria-live="polite">{error && <p role="alert">{error}</p>}</div>
    </section>
  );
}
export function ImportedLayerPlanning(props: Props) {
  return (
    <Picker
      key={JSON.stringify([props.project, props.scheduled, props.frontOnly])}
      {...props}
    />
  );
}
