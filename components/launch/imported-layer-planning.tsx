'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  parseImportedLayerTargets,
  type ImportedLayerTargets,
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
    [error, setError] = useState('');
  const request = useRef<AbortController | null>(null),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current?.abort('unmounted');
    };
  }, []);
  const source = { projectId: project.id, projectUpdatedAt: project.updatedAt };
  async function load() {
    if (request.current || disabled || !scheduled) return;
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
              encodeURIComponent(JSON.stringify(source)),
            { signal: controller.signal, cache: 'no-store' },
          );
          if (!response.ok)
            throw new TargetReadError(
              response.status === 401
                ? 'Sign in to choose an imported token.'
                : response.status === 409
                  ? 'Save and reload a scheduled launch before choosing its imported token.'
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
            source,
          );
        })(),
      ]);
      if (
        alive.current &&
        request.current === controller &&
        !controller.signal.aborted
      )
        setTargets(value);
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
        Reloading clears the selection and closes its planner so an old record
        revision cannot be reused.
      </p>
      {targets && (
        <>
          {targets.hasMore && (
            <p>
              Showing the 100 most recently updated active Solana imports.
              Additional records are not included.
            </p>
          )}
          {targets.items.length ? (
            <>
              <label htmlFor={id}>Imported token</label>
              <select
                id={id}
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
              No active Solana imports were found. Import or restore a token in
              the workspace, then reload this list.
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
