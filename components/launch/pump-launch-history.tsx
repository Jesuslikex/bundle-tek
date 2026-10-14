'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { readPanelJson } from '@/components/read-panel-json';

const sources = [
  { name: 'Create only', path: '/api/launch/pump' },
  { name: 'Developer buy', path: '/api/launch/pump/initial-buy' },
  { name: 'Holder buys', path: '/api/launch/pump/holders' },
] as const;
type Source = (typeof sources)[number];
type Entry = {
  id: string;
  state: string;
  signature: string | null;
  source: Source;
  unresolved: boolean;
};
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const terminal = new Set(['finalized', 'failed', 'cancelled']);
function entry(value: unknown, source: Source, projectId: string): Entry {
  if (
    !record(value) ||
    !record(value.review) ||
    value.review.projectId !== projectId ||
    typeof value.review.id !== 'string' ||
    !value.review.id ||
    value.review.id.length > 128 ||
    typeof value.state !== 'string' ||
    ![
      'review',
      'approved',
      'signed',
      'submitting',
      'submitted',
      ...terminal,
    ].includes(value.state) ||
    !(
      value.signature === null ||
      (typeof value.signature === 'string' &&
        /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value.signature))
    )
  )
    throw new Error('Saved launch summary is invalid.');
  return {
    id: value.review.id,
    state: value.state,
    signature: value.signature,
    source,
    unresolved:
      record(value.receipt) && value.receipt.kind === 'expired-unobserved',
  };
}

function History({ projectId }: { projectId: string }) {
  const [rows, setRows] = useState<Entry[]>([]),
    [errors, setErrors] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false);
  const [cursors, setCursors] = useState<Record<string, string | null>>({});
  const active = useRef(true),
    running = useRef(false),
    abort = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      abort.current?.abort();
    };
  }, []);
  async function request(
    source: Source,
    body?: { action: 'recover'; id: string },
    cursor?: string,
  ) {
    const response = await fetch(
      source.path +
        (body
          ? ''
          : '?projectId=' +
            encodeURIComponent(projectId) +
            '&page=1' +
            (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')),
      {
        ...(body
          ? {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }
          : {}),
        signal: AbortSignal.any([
          abort.current!.signal,
          AbortSignal.timeout(25000),
        ]),
      },
    );
    const value = await readPanelJson(
      response,
      'Launch history service is unavailable.',
    );
    if (!response.ok) throw new Error('Launch history service is unavailable.');
    return value;
  }
  async function run(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    abort.current = new AbortController();
    setBusy(true);
    setErrors([]);
    try {
      await action();
    } catch {
      if (active.current)
        setErrors([
          'Status check did not complete. Reload saved launches before retrying.',
        ]);
    } finally {
      running.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function load() {
    const results = await Promise.all(
      sources.map(async (source) => {
        try {
          return {
            ...parsePage(await request(source), source),
            source,
            error: '',
          };
        } catch {
          return {
            entries: [],
            next: null,
            source,
            error:
              source.name +
              ' history is unavailable. Other launch types can still be checked.',
          };
        }
      }),
    );
    if (!active.current) return;
    setRows(results.flatMap((r) => r.entries));
    setCursors(Object.fromEntries(results.map((r) => [r.source.path, r.next])));
    setErrors(results.map((r) => r.error).filter(Boolean));
    setLoaded(true);
  }
  function parsePage(value: unknown, source: Source, previous?: string) {
    if (
      !record(value) ||
      !Array.isArray(value.launches) ||
      value.launches.length > 20 ||
      !(
        value.nextCursor === null ||
        (typeof value.nextCursor === 'string' &&
          /^[A-Za-z0-9_-]{1,1024}$/.test(value.nextCursor))
      ) ||
      value.nextCursor === previous ||
      (value.nextCursor !== null && !value.launches.length)
    )
      throw new Error('Saved history page is invalid.');
    const entries = value.launches.map((v) => entry(v, source, projectId));
    if (new Set(entries.map((r) => r.id)).size !== entries.length)
      throw new Error('Saved history page repeats records.');
    return { entries, next: value.nextCursor as string | null };
  }
  async function older(source: Source) {
    const cursor = cursors[source.path];
    if (!cursor) return;
    const page = parsePage(
      await request(source, undefined, cursor),
      source,
      cursor,
    );
    if (
      page.entries.some((item) =>
        rows.some(
          (row) => row.source.path === source.path && row.id === item.id,
        ),
      )
    )
      throw new Error('Saved history page overlaps. Reload the first page.');
    if (!active.current) return;
    setRows((all) => [...all, ...page.entries]);
    setCursors((all) => ({ ...all, [source.path]: page.next }));
  }
  return (
    <section
      aria-label="Saved launch recovery"
      style={{ marginTop: 20, minWidth: 0, overflowWrap: 'anywhere' }}
    >
      <h3>Saved launch recovery</h3>
      <p>
        Check saved create, developer and holder launches even after changing
        this draft. This panel never signs or broadcasts transactions.
      </p>
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        onClick={() => void run(load)}
      >
        Reload all saved launches
      </Button>
      {loaded && !rows.length && !errors.length && (
        <p>No saved launch reviews.</p>
      )}
      <ul>
        {rows.map((row) => (
          <li key={row.source.path + ':' + row.id} style={{ marginBlock: 12 }}>
            <strong>
              {row.source.name}: {row.state}
            </strong>
            <div>Review: {row.id}</div>
            {row.signature && <div>Signature: {row.signature}</div>}
            {row.unresolved && (
              <p>
                No finalized receipt was observed. Network fees remain
                unresolved.
              </p>
            )}
            {row.state === 'review' && (
              <p>
                Unsigned review. Open its launch review to continue or discard
                it.
              </p>
            )}
            {row.state !== 'review' && !terminal.has(row.state) && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                aria-label={`Check ${row.source.name.toLowerCase()} status: ${row.id}`}
                onClick={() =>
                  void run(async () => {
                    const updated = entry(
                      await request(row.source, {
                        action: 'recover',
                        id: row.id,
                      }),
                      row.source,
                      projectId,
                    );
                    if (updated.id !== row.id) throw new Error();
                    if (active.current)
                      setRows((all) =>
                        all.map((r) =>
                          r.id === row.id && r.source.path === row.source.path
                            ? updated
                            : r,
                        ),
                      );
                  })
                }
              >
                Check saved status
              </Button>
            )}
          </li>
        ))}
      </ul>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {sources.map(
          (source) =>
            cursors[source.path] && (
              <Button
                key={source.path}
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void run(() => older(source))}
              >
                Load older {source.name.toLowerCase()} launches
              </Button>
            ),
        )}
      </div>
      <div aria-live="polite">
        {busy && <p>Checking saved launches…</p>}
        {errors.map((error) => (
          <p role="alert" key={error}>
            {error}
          </p>
        ))}
      </div>
    </section>
  );
}
export function PumpLaunchHistory({ projectId }: { projectId: string }) {
  return <History key={projectId} projectId={projectId} />;
}
