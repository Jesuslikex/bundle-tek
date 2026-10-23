'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from './ui/button';
import Link from 'next/link';
import {
  admitWarmupExecutionInventory,
  WARMUP_EXECUTION_INVENTORY_LABELS,
  type WarmupExecutionInventoryView,
} from '@/lib/wallet-warmup-execution-inventory-view';
import styles from './warmup-execution-inventory.module.css';
const ENDPOINT = '/api/wallet-workspace/warmup/execution-history';
const bytes = (value: number) => `${value.toLocaleString('en-US')} bytes`;
function focusMetadataResult(heading: HTMLHeadingElement | null) {
  if (
    heading &&
    (document.activeElement === document.body ||
      heading.parentElement?.contains(document.activeElement))
  )
    heading.focus();
}
async function boundedMetadataJson(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) throw Error();
  const stop = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', stop, { once: true });
  let complete = false;
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > 262144) throw Error();
      chunks.push(next.value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(body),
    );
    complete = true;
    return parsed;
  } finally {
    signal.removeEventListener('abort', stop);
    if (!complete) stop();
    reader.releaseLock();
  }
}
export function WarmupExecutionInventory() {
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <section className={styles.panel} aria-labelledby={titleId}>
      <h4 id={titleId}>Stored warmup reviews and capacity</h4>
      <p>
        Account-wide metadata across all saved warmup proposals, not a filter
        for the wallets selected above. These are stored review records, not
        running activity or trades.
      </p>
      {!open ? (
        <Button ref={opener} variant="outline" onClick={() => setOpen(true)}>
          Read stored warmup reviews and capacity
        </Button>
      ) : (
        <InventoryRead
          onClose={() => {
            setOpen(false);
            queueMicrotask(() => opener.current?.focus());
          }}
        />
      )}
    </section>
  );
}
function InventoryRead({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<WarmupExecutionInventoryView | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [status, setStatus] = useState(''),
    [signIn, setSignIn] = useState(false),
    [page, setPage] = useState(1);
  const pending = useRef<AbortController | null>(null);
  const deadline = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const cancel = useCallback(() => {
    pending.current?.abort();
    pending.current = null;
    if (deadline.current !== null) clearTimeout(deadline.current);
    deadline.current = null;
  }, []);
  const read = useCallback(async (cursor?: string, pageNumber = 1) => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    setStatus('');
    setSignIn(false);
    setData(null);
    focusMetadataResult(resultHeading.current);
    deadline.current = setTimeout(() => {
      if (pending.current !== controller) return;
      controller.abort();
      pending.current = null;
      deadline.current = null;
      setBusy(false);
      setStatus('Metadata read did not complete.');
      setError(
        'Metadata read ended before confirmation. Read newest records to try again.',
      );
      focusMetadataResult(resultHeading.current);
    }, 23000);
    try {
      const response = await fetch(
        ENDPOINT + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''),
        { method: 'GET', cache: 'no-store', signal: controller.signal },
      );
      if (pending.current !== controller || controller.signal.aborted) return;
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        setSignIn(response.status === 401);
        setError(
          response.status === 401
            ? 'Sign in to read stored warmup metadata.'
            : 'Stored warmup metadata is unavailable. No record was changed.',
        );
        return;
      }
      const body = await boundedMetadataJson(response, controller.signal);
      if (pending.current !== controller || controller.signal.aborted) return;
      const checked = admitWarmupExecutionInventory(body, cursor);
      if (pending.current === controller && !controller.signal.aborted) {
        setData(checked);
        setPage(pageNumber);
        setStatus(
          `Stored metadata page ${pageNumber} loaded, ${checked.rows.length} records. No stored record was changed.`,
        );
      }
    } catch {
      if (pending.current === controller)
        setError(
          controller.signal.aborted
            ? 'Metadata read ended before confirmation. Read newest records to try again.'
            : 'Stored warmup metadata response could not be verified. No record was changed.',
        );
    } finally {
      if (pending.current === controller) {
        controller.abort();
        pending.current = null;
        if (deadline.current !== null) clearTimeout(deadline.current);
        deadline.current = null;
        setBusy(false);
        focusMetadataResult(resultHeading.current);
      }
    }
  }, []);
  useEffect(() => {
    let live = true;
    void Promise.resolve().then(() => {
      if (live) return read();
    });
    return () => {
      live = false;
      cancel();
    };
  }, [read, cancel]);
  function clear() {
    cancel();
    setData(null);
    setBusy(false);
    setError('');
    setStatus('Metadata view cleared. No stored record was changed.');
    setSignIn(false);
    setPage(1);
    focusMetadataResult(resultHeading.current);
  }
  return (
    <div aria-busy={busy}>
      <h5 ref={resultHeading} tabIndex={-1}>
        Stored warmup metadata results
      </h5>
      <div className={styles.actions}>
        <Button variant="outline" onClick={onClose}>
          Close stored warmup metadata
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void read()}>
          Read newest stored metadata
        </Button>
        <Button variant="outline" onClick={clear}>
          {busy ? 'Cancel metadata read' : 'Clear metadata view'}
        </Button>
      </div>
      <p>
        Read-only stored metadata. Proposal contents, receipts, current wallet
        state and human approval have not been reverified here. Signing and
        automatic execution remain off.
      </p>
      <output aria-live="polite" aria-atomic="true">
        {busy ? 'Reading stored warmup metadata…' : status}
      </output>
      <p role="alert" aria-atomic="true">
        {error}
      </p>
      {signIn && (
        <Link className={styles.signIn} href="/sign-in">
          Sign in
        </Link>
      )}
      {data && (
        <>
          <p>
            Account snapshot:{' '}
            <time dateTime={data.snapshotAt}>{data.snapshotAt}</time>. Page{' '}
            {page}, up to 25 records. Each read has its own snapshot; pages are
            not combined.
          </p>
          <h5>Lifetime metadata capacity</h5>
          <dl className={styles.capacity}>
            <div>
              <dt>Stored proposal slots</dt>
              <dd>
                {data.quota.proposals} of {data.quota.maximumProposals};{' '}
                {data.quota.remainingProposals} remaining
              </dd>
            </div>
            <div>
              <dt>Declared byte reservations</dt>
              <dd>
                {bytes(data.quota.declaredBytes)} of{' '}
                {bytes(data.quota.maximumDeclaredBytes)};{' '}
                {bytes(data.quota.remainingDeclaredBytes)} remaining
              </dd>
            </div>
            <div>
              <dt>Stored chunk data</dt>
              <dd>
                {bytes(data.quota.storedChunkBytes)} in{' '}
                {data.quota.storedChunks} chunks
              </dd>
            </div>
            <div>
              <dt>Incomplete proposals, still counted</dt>
              <dd>{data.quota.incomplete}</dd>
            </div>
            <div>
              <dt>Expired, never approved, still counted</dt>
              <dd>{data.quota.expiredNeverApproved}</dd>
            </div>
            <div>
              <dt>Approval / root metadata records</dt>
              <dd>
                {data.quota.approved} / {data.quota.roots}
              </dd>
            </div>
          </dl>
          <p>
            Expired and incomplete proposals continue to consume their original
            lifetime slots and declared byte reservations. No pruning is
            available. Remaining capacity is advisory, not reserved by this
            read. Stored chunk bytes exclude database, index, header and backup
            overhead.
          </p>
          {!data.rows.length && (
            <p>
              {data.quota.proposals === 0
                ? 'No stored execution proposals in this account.'
                : 'No older stored proposals on this page. Return to newest metadata for the account totals.'}
            </p>
          )}
          <ul
            className={styles.records}
            aria-label="Stored warmup metadata page"
          >
            {data.rows.map((row) => (
              <li key={row.id}>
                <strong>{WARMUP_EXECUTION_INVENTORY_LABELS[row.status]}</strong>
                <p>
                  {row.expired
                    ? 'Expired at this snapshot; still counted.'
                    : 'Unexpired at this snapshot; this is not a fresh approval.'}
                </p>
                <p>
                  Created <time dateTime={row.createdAt}>{row.createdAt}</time>
                  <br />
                  Original expiry{' '}
                  <time dateTime={row.expiresAt}>{row.expiresAt}</time>
                </p>
                <p>
                  {row.storedChunks} / {row.expectedChunks} chunks stored;{' '}
                  {bytes(row.storedBytes)} stored / {bytes(row.declaredBytes)}{' '}
                  declared.
                </p>
                <details>
                  <summary>Original identifiers and metadata</summary>
                  <dl>
                    <dt>Proposal ID</dt>
                    <dd>
                      <code>{row.id}</code>
                    </dd>
                    <dt>Consent ID</dt>
                    <dd>
                      <code>{row.consentId}</code>
                    </dd>
                    <dt>Review ID</dt>
                    <dd>
                      <code>{row.reviewId}</code>
                    </dd>
                    <dt>Header hash</dt>
                    <dd>
                      <code>{row.headerSha256}</code>
                    </dd>
                    <dt>Request hash</dt>
                    <dd>
                      <code>{row.requestSha256}</code>
                    </dd>
                    <dt>Publication recorded</dt>
                    <dd>{row.publishedAt ?? 'Not recorded'}</dd>
                    <dt>Approval recorded</dt>
                    <dd>{row.approvedAt ?? 'Not recorded'}</dd>
                    <dt>Root recorded</dt>
                    <dd>{row.rootCreatedAt ?? 'Not recorded'}</dd>
                    <dt>Root hash</dt>
                    <dd>
                      <code>{row.rootSha256 ?? 'Not recorded'}</code>
                    </dd>
                    <dt>Manifest hash</dt>
                    <dd>
                      <code>{row.manifestSha256 ?? 'Not recorded'}</code>
                    </dd>
                  </dl>
                </details>
              </li>
            ))}
          </ul>
          {data.nextCursor && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void read(data.nextCursor!, page + 1)}
            >
              Read older stored metadata
            </Button>
          )}
        </>
      )}
    </div>
  );
}
