'use client';
import { readPanelJson } from './read-panel-json';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { SessionEntryOutcomes } from './session-entry-outcomes';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { ImportedSwapReceipt } from '@/lib/imported-approval-history';
import {
  decodeOperationPage,
  operationCategories,
  type OperationCategory,
  type OperationPage,
} from '@/lib/token-operation-history';
export function TokenOperationHistory({
  projectId,
  revision,
  project,
  onReviewBuy,
}: {
  projectId: string;
  revision: number;
  project?: ImportedTokenProject;
  onReviewBuy?: (receipt: ImportedSwapReceipt) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Token operation history">
      <Button
        variant="outline"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Close' : 'Open'} token operation history
      </Button>
      {open && (
        <OperationHistory
          key={`${projectId}:${revision}`}
          projectId={projectId}
          project={
            project?.id === projectId && project.revision === revision
              ? project
              : undefined
          }
          onReviewBuy={onReviewBuy}
        />
      )}
    </section>
  );
}
function OperationHistory({
  projectId,
  project,
  onReviewBuy,
}: {
  projectId: string;
  project?: ImportedTokenProject;
  onReviewBuy?: (receipt: ImportedSwapReceipt) => void;
}) {
  const [category, setCategory] = useState<OperationCategory>('All');
  const [page, setPage] = useState<OperationPage | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const read = useCallback(
    async (after: string | null) => {
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      setBusy(true);
      setError('');
      try {
        const q = new URLSearchParams({ projectId, category });
        if (after) q.set('cursor', after);
        const response = await fetch(
          '/api/imported-projects/operation-history?' + q,
          {
            cache: 'no-store',
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(10000),
            ]),
          },
        );
        const body = await readPanelJson(
          response,
          'Operation history unavailable.',
        );
        if (!response.ok)
          throw new Error(
            body &&
              typeof body === 'object' &&
              'error' in body &&
              typeof body.error === 'string'
              ? body.error
              : 'Operation history unavailable.',
          );
        const next = decodeOperationPage(body, projectId, category);
        if (controller.signal.aborted || pending.current !== controller) return;
        setPage((prior) =>
          after && prior
            ? {
                ...next,
                records: [
                  ...prior.records,
                  ...next.records.filter(
                    (r) => !prior.records.some((old) => old.key === r.key),
                  ),
                ],
              }
            : next,
        );
      } catch (e) {
        if (!controller.signal.aborted && pending.current === controller)
          setError(
            e instanceof Error ? e.message : 'Operation history unavailable.',
          );
      } finally {
        if (!controller.signal.aborted && pending.current === controller)
          setBusy(false);
      }
    },
    [projectId, category],
  );
  useEffect(() => {
    let disposed = false;
    void Promise.resolve().then(() => {
      if (!disposed) {
        setPage(null);
        void read(null);
      }
    });
    return () => {
      disposed = true;
      pending.current?.abort();
    };
  }, [read]);
  return (
    <div className="space-y-3 min-w-0 break-words">
      <h4>Token operation history</h4>
      <p>
        Retained operation transitions for this token project. These are event
        records, not execution counts or complete wallet history. Preparations
        and signatures do not establish successful trades. Session approval
        transitions appear once in the signing source.
      </p>
      <label>
        Operation category{' '}
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as OperationCategory)}
        >
          {operationCategories.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      <Button variant="outline" disabled={busy} onClick={() => void read(null)}>
        Reload operation history
      </Button>
      {error && <p role="alert">{error}</p>}
      {busy && <output>Loading operation history…</output>}
      {page?.missingSources.length ? (
        <output>
          History storage unavailable for: {page.missingSources.join(', ')}.
          This view has incomplete source coverage.
        </output>
      ) : null}
      {page && !busy && !error && !page.records.length && (
        <p>No retained records in this category.</p>
      )}
      <ol>
        {page?.records.map((r) => (
          <li key={r.key}>
            <details>
              <summary>
                {r.label} · {r.state} ·{' '}
                <time dateTime={r.createdAt}>
                  {new Date(r.createdAt).toLocaleString()}
                </time>
              </summary>
              <p>
                Source: {r.source} · Record: <code>{r.key}</code>
              </p>
              {r.details.map((d, i) => (
                <p key={i}>{d}</p>
              ))}
              {r.signature && (
                <a
                  href={`https://solscan.io/tx/${r.signature}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View transaction
                </a>
              )}
              {project && r.sessionEventId && (
                <SessionEntryOutcomes
                  project={project}
                  eventId={r.sessionEventId}
                  onReviewBuy={onReviewBuy}
                />
              )}
            </details>
          </li>
        ))}
      </ol>
      {page?.nextCursor && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void read(page.nextCursor)}
        >
          Load older operations
        </Button>
      )}
    </div>
  );
}
