'use client';
import { useEffect, useId, useRef, useState } from 'react';
import {
  autoSellSavedOutcomePage,
  autoSellSavedSelection,
  readAutoSellSavedResponse,
} from '@/lib/auto-sell-saved-outcomes';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { UUID } from '@/lib/wallet-operation';
import styles from './auto-sell-saved-outcomes.module.css';
const labels: Record<string, string> = {
  awaiting_signature: 'Awaiting signature in saved history',
  signed: 'Signature recorded; submission not established',
  submitted: 'Submission recorded; receipt proof not loaded',
  cancelled: 'Approval cancelled in saved history',
  failed: 'Failure recorded; inspect preparation history',
  finalized: 'Finalized status recorded; receipt proof not loaded',
};
export function AutoSellSavedOutcomes(props: {
  projectId: string;
  mint: string;
}) {
  return (
    <SavedOutcomes
      key={JSON.stringify([props.projectId, props.mint])}
      {...props}
    />
  );
}
function SavedOutcomes({
  projectId,
  mint,
}: {
  projectId: string;
  mint: string;
}) {
  const [id, setId] = useState('');
  const [page, setPage] = useState<ReturnType<
    typeof autoSellSavedOutcomePage
  > | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const pending = useRef<AbortController | null>(null);
  const actions = useRef<HTMLDivElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const readButton = useRef<HTMLButtonElement>(null);
  const resultsHeading = useRef<HTMLHeadingElement>(null);
  const nextFocus = useRef<'read' | 'results' | null>(null);
  const field = useId();
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (busy) cancelButton.current?.focus();
    else if (nextFocus.current) {
      (nextFocus.current === 'results'
        ? resultsHeading.current
        : readButton.current
      )?.focus();
      nextFocus.current = null;
    }
  }, [busy, page, error]);
  function focusAfterRead(target: 'read' | 'results') {
    if (
      document.activeElement === document.body ||
      actions.current?.contains(document.activeElement)
    )
      nextFocus.current = target;
  }
  async function read(older: boolean) {
    if (busy) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    nextFocus.current = null;
    let failureMessage =
      'Saved history could not be read or its original context differs. Any previous page is unchanged; older pages may be unavailable. Try an exact approval ID or use preparation history. No transaction was changed or resent.';
    setBusy(true);
    setError('');
    setNotice('Reading saved approvals. Any previous page remains historical.');
    try {
      if (id.trim() && !UUID.test(id.trim().toLowerCase())) {
        focusAfterRead('read');
        setNotice('');
        setError(
          'Enter a complete approval ID, or leave it blank to browse. No read was made.',
        );
        return;
      }
      const selection = autoSellSavedSelection({
        projectId,
        mint,
        intentId: id.trim() ? id.trim().toLowerCase() : null,
        cursor: older ? page?.nextCursor : null,
      });
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(15000),
      ]);
      const query = new URLSearchParams({ projectId });
      if (selection.intentId) query.set('intentId', selection.intentId);
      if (selection.cursor) query.set('cursor', selection.cursor);
      const response = await fetch(`/api/imported-projects/signing?${query}`, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        signal,
      });
      if ([401, 403, 404].includes(response.status)) {
        void response.body?.cancel().catch(() => {});
        signal.throwIfAborted();
        if (pending.current === controller && !controller.signal.aborted) {
          setPage(null);
          setLoadedAt(null);
          failureMessage =
            'Saved history access is unavailable. Previously loaded records were cleared. Check sign-in and project access. No transaction was changed or resent.';
        }
        throw Error();
      }
      const body = await readAutoSellSavedResponse(response, signal);
      if (!response.ok) throw Error();
      const saved = autoSellSavedOutcomePage(body, selection);
      signal.throwIfAborted();
      if (pending.current === controller && !controller.signal.aborted) {
        focusAfterRead('results');
        setPage(saved);
        setLoadedAt(new Date().toISOString());
        setNotice(
          `Loaded ${saved.scanned} approval record${saved.scanned === 1 ? '' : 's'}; ${saved.rows.length} matching Sell approval${saved.rows.length === 1 ? '' : 's'} on this page.`,
        );
      }
    } catch {
      if (pending.current === controller && !controller.signal.aborted) {
        focusAfterRead('read');
        setNotice('');
        setError(failureMessage);
      }
    } finally {
      if (pending.current === controller && !controller.signal.aborted)
        setBusy(false);
    }
  }
  return (
    <details className={styles.panel}>
      <summary>Find saved Sell approvals</summary>
      <p>
        Find this project’s token-to-SOL Sell approvals after a reload or a
        missing activity entry. This shows Sell approvals from any source; saved
        records are not classified as Auto Sell.
      </p>
      <p>
        This reads saved status only. It does not check the chain, verify a
        receipt, restore session counters, sign or resend. Nothing is loaded
        until you request it.
      </p>
      <label htmlFor={field}>
        Approval ID (optional)
        <Input
          id={field}
          value={id}
          maxLength={64}
          disabled={busy}
          placeholder="Leave blank to browse"
          onChange={(event) => {
            setId(event.target.value);
            setPage(null);
            setLoadedAt(null);
            setError('');
            setNotice('');
            nextFocus.current = null;
          }}
        />
      </label>
      <div className={styles.buttons} ref={actions} aria-busy={busy}>
        <Button
          ref={readButton}
          variant="outline"
          disabled={busy}
          onClick={() => void read(false)}
        >
          {busy
            ? 'Reading saved approvals…'
            : id.trim()
              ? 'Find approval'
              : 'Read latest saved approvals'}
        </Button>
        {page?.nextCursor && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void read(true)}
          >
            Read older approvals
          </Button>
        )}
        {busy && (
          <Button
            ref={cancelButton}
            variant="outline"
            onClick={() => {
              focusAfterRead('read');
              pending.current?.abort();
              pending.current = null;
              setBusy(false);
              setError('');
              setNotice('Read cancelled. No transaction was changed.');
            }}
          >
            Cancel history read
          </Button>
        )}
      </div>
      <output aria-live="polite" aria-atomic="true">
        {notice}
      </output>
      {error && <p role="alert">{error}</p>}
      {page && (
        <section aria-label="Saved Sell approval page">
          <h3 ref={resultsHeading} tabIndex={-1}>
            Saved Sell approval results
          </h3>
          <p>
            Read {page.scanned} approval record{page.scanned === 1 ? '' : 's'};{' '}
            {page.rows.length} matching Sell approval
            {page.rows.length === 1 ? '' : 's'} shown on this page.{' '}
            {page.nextCursor
              ? 'Older records remain.'
              : 'No older records are reported after this page.'}{' '}
            Loaded <time dateTime={loadedAt!}>{loadedAt}</time>. This is saved
            history, not a session total.
          </p>
          {!page.rows.length && (
            <p>No matching token-to-SOL Sell approvals on this page.</p>
          )}
          <ol className={styles.rows}>
            {page.rows.map((row) => (
              <li key={row.intentId}>
                <strong>{labels[row.state]}</strong>
                <dl>
                  <div>
                    <dt>Approval</dt>
                    <dd>
                      <code>{row.intentId}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Preparation</dt>
                    <dd>
                      <code>{row.preparationId}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Wallet</dt>
                    <dd>
                      <code>{row.wallet}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Requested token atomic units</dt>
                    <dd>{row.inputRaw}</dd>
                  </div>
                  <div>
                    <dt>Original revisions</dt>
                    <dd>
                      Project {row.projectRevision}; wallet {row.walletRevision}
                    </dd>
                  </div>
                  <div>
                    <dt>Saved update</dt>
                    <dd>
                      <time dateTime={new Date(row.updatedAt).toISOString()}>
                        {new Date(row.updatedAt).toISOString()}
                      </time>
                    </dd>
                  </div>
                </dl>
                {row.signature && (
                  <a
                    href={`https://solscan.io/tx/${row.signature}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View recorded signature in explorer
                  </a>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
    </details>
  );
}
