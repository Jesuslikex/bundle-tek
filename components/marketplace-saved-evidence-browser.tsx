'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import {
  readSavedEvidencePage,
  savedEvidenceUrl,
  SavedEvidenceReadError,
  SavedEvidenceClockError,
  SAVED_EVIDENCE_CLOCK_MESSAGE,
  type SavedEvidenceRequest,
  type SavedWalletPage,
  type SavedHistoryPage,
  type SavedEvidenceWallet,
  type SavedEvidenceRecord,
} from '@/lib/marketplace-saved-evidence';
import styles from './marketplace-saved-evidence-browser.module.css';

function RecordedCheck({ record }: { record: SavedEvidenceRecord }) {
  const observation = record.observation;
  return (
    <li className={styles.record}>
      <details>
        <summary>
          Saved history record <code>{record.id}</code> · revision{' '}
          {record.revision}
        </summary>
        <p>
          Created: <time dateTime={record.createdAt}>{record.createdAt}</time>.
          Updated: <time dateTime={record.updatedAt}>{record.updatedAt}</time>.
        </p>
        <p>
          Captured wallet revision: {record.capturedWalletRevision}. A revision
          number does not verify lifecycle continuity, even when it matches the
          current saved revision.
        </p>
        {record.outcome === 'read-failed' ? (
          <p>
            A failed history read was recorded. No usable observation is
            supplied for this record.
          </p>
        ) : record.outcome === 'not-recorded' ? (
          <p>
            No result was recorded for this wallet in this history record. This
            does not establish that the wallet had no activity.
          </p>
        ) : (
          observation && (
            <>
              <p>
                Historical check:{' '}
                <time dateTime={observation.observedAt}>
                  {observation.observedAt}
                </time>
                . Recorded source: <code>{observation.source}</code>.
              </p>
              <p>
                Historical balance: <code>{observation.balanceLamports}</code>{' '}
                lamports (not current).
              </p>
              <p>
                {observation.successfulSampleCount} successful records in this{' '}
                {observation.sampleCount}-signature sample. These are not
                decoded trade or funding counts.
              </p>
              <p>
                Oldest timestamp within this sample at that check:{' '}
                {observation.oldestSampledActivityAt ?? 'Unavailable'}. Latest
                timestamp within that sample:{' '}
                {observation.latestSampledActivityAt ?? 'Unavailable'}. These
                dates do not establish wallet age or globally oldest activity.
              </p>
            </>
          )
        )}
      </details>
    </li>
  );
}

export function MarketplaceSavedEvidenceBrowser() {
  const [walletPage, setWalletPage] = useState<SavedWalletPage | null>(null);
  const [historyPage, setHistoryPage] = useState<SavedHistoryPage | null>(null);
  const [target, setTarget] = useState<SavedEvidenceWallet | null>(null);
  const [walletTrail, setWalletTrail] = useState<(string | null)[]>([null]);
  const [historyTrail, setHistoryTrail] = useState<(string | null)[]>([null]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const details = useRef<HTMLDetailsElement | null>(null);
  const loadButton = useRef<HTMLButtonElement | null>(null);
  const walletStatus = useRef<HTMLOutputElement | null>(null);
  const historyStatus = useRef<HTMLOutputElement | null>(null);
  const noticeStatus = useRef<HTMLOutputElement | null>(null);
  const focus = useRef<'wallets' | 'history' | 'load' | null>(null);
  const [lastRequest, setLastRequest] = useState<SavedEvidenceRequest | null>(
    null,
  );
  const lastTrail = useRef<(string | null)[] | undefined>(undefined);
  const mounted = useRef(false);
  const generation = useRef(0);
  const active = useRef<{
    controller: AbortController;
    deadline: ReturnType<typeof setTimeout>;
  } | null>(null);
  function stop() {
    generation.current += 1;
    if (active.current) {
      clearTimeout(active.current.deadline);
      active.current.controller.abort();
      active.current = null;
    }
  }
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop();
    };
  }, []);
  useLayoutEffect(() => {
    if (busy) return;
    const element = notice
      ? noticeStatus.current
      : focus.current === 'load'
        ? loadButton.current
        : focus.current === 'wallets'
          ? walletStatus.current
          : focus.current === 'history'
            ? historyStatus.current
            : null;
    if (focus.current && element) {
      focus.current = null;
      element.focus();
    }
  }, [busy, notice, walletPage, historyPage]);

  function reset() {
    stop();
    setBusy(false);
    setWalletPage(null);
    setHistoryPage(null);
    setTarget(null);
    setNotice('');
    setNeedsSignIn(false);
    setWalletTrail([null]);
    setHistoryTrail([null]);
    setLastRequest(null);
    lastTrail.current = undefined;
    focus.current = null;
  }
  async function read(
    request: SavedEvidenceRequest,
    trail?: (string | null)[],
  ) {
    if (!details.current?.open) return;
    stop();
    const current = generation.current,
      controller = new AbortController();
    setBusy(true);
    setWalletPage(null);
    setHistoryPage(null);
    setNeedsSignIn(false);
    setNotice('');
    if (request.view === 'wallets') {
      setTarget(null);
      setHistoryTrail([null]);
    }
    setLastRequest(request);
    lastTrail.current =
      trail ?? (request.view === 'wallets' ? walletTrail : historyTrail);
    const deadline = setTimeout(() => {
      if (current !== generation.current || !mounted.current) return;
      stop();
      setBusy(false);
      setNotice(
        'Saved evidence read took too long. No previous page is shown. Retry explicitly or load saved wallets again.',
      );
    }, 15_000);
    active.current = { controller, deadline };
    try {
      const response = await fetch(savedEvidenceUrl(request), {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'error',
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        current !== generation.current ||
        !mounted.current
      ) {
        void response.body?.cancel().catch(() => {});
        return;
      }
      const next = await readSavedEvidencePage(
        response,
        request,
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        current !== generation.current ||
        !mounted.current
      )
        return;
      if (next.view === 'wallets') {
        setWalletPage(next);
        if (trail) setWalletTrail(trail);
      } else {
        setHistoryPage(next);
        if (trail) setHistoryTrail(trail);
      }
    } catch (error) {
      if (
        controller.signal.aborted ||
        current !== generation.current ||
        !mounted.current
      )
        return;
      if (error instanceof SavedEvidenceClockError) {
        setNeedsSignIn(false);
        setNotice(SAVED_EVIDENCE_CLOCK_MESSAGE);
        return;
      }
      const status =
        error instanceof SavedEvidenceReadError ? error.status : null;
      setNeedsSignIn(status === 401);
      if (status === 409) {
        setTarget(null);
        setHistoryTrail([null]);
        setLastRequest(null);
      }
      setNotice(
        error instanceof SavedEvidenceReadError
          ? new SavedEvidenceReadError(error.status).message
          : 'Saved wallet evidence is unavailable. No partial page is shown.',
      );
    } finally {
      if (current === generation.current && mounted.current) {
        clearTimeout(deadline);
        active.current = null;
        setBusy(false);
      }
    }
  }
  function history(cursor: string | null, trail?: (string | null)[]) {
    if (target)
      void read(
        {
          view: 'history',
          address: target.address,
          revision: target.revision,
          cursor,
        },
        trail,
      );
  }
  const observedAt = walletPage?.observedAt ?? historyPage?.observedAt;
  return (
    <details
      className={styles.panel}
      ref={details}
      onToggle={(event) => {
        if (!event.currentTarget.open) reset();
      }}
    >
      <summary>Inspect saved wallet evidence</summary>
      <p>
        Browse saved workspace wallet records, 20 per page. Historical data is
        not a current balance, wallet age or proof of control.
      </p>
      <details>
        <summary>Coverage and custody limits</summary>
        <p>
          This separate browser reads saved wallet metadata and individual
          retained checks only. It is not a complete inventory, history, age,
          creation date, first-funding date, current balance or
          listing-eligibility check.
        </p>
        <p>
          A workspace saved address is not proof of control or exclusive
          custody. Captured revision numbers never verify lifecycle continuity.
          No payment, delivery, approval, signing or execution is available
          here.
        </p>
        <p>
          Pages are independent saved reads. Records may change between pages.
          Pages cover matching saved records, not all possible history. A
          malformed or oversized matched record can block a page. Keep your
          saved history.
        </p>
      </details>
      <div className={styles.actions}>
        <button
          ref={loadButton}
          type="button"
          disabled={busy}
          onClick={() => void read({ view: 'wallets', cursor: null }, [null])}
        >
          Load saved wallets
        </button>
        {busy && (
          <button
            type="button"
            onClick={() => {
              focus.current = 'load';
              stop();
              setBusy(false);
              setWalletPage(null);
              setHistoryPage(null);
              setTarget(null);
              setLastRequest(null);
              setNeedsSignIn(false);
              setNotice(
                'Saved evidence read cancelled. No saved wallet or history was changed.',
              );
            }}
          >
            Cancel saved evidence read
          </button>
        )}
        {!busy && notice && lastRequest && (
          <button
            type="button"
            onClick={() => {
              const request = lastRequest;
              if (request) void read(request, lastTrail.current);
            }}
          >
            Retry saved evidence read
          </button>
        )}
      </div>
      {busy && <output>Reading saved evidence only…</output>}
      {notice && (
        <output className={styles.notice} ref={noticeStatus} tabIndex={-1}>
          {notice}
        </output>
      )}
      {needsSignIn && (
        <a href="/sign-in" target="_blank" rel="noopener noreferrer">
          Sign in (opens a new tab), then retry explicitly
        </a>
      )}
      {observedAt && (
        <p>
          Saved page read: <time dateTime={observedAt}>{observedAt}</time>. At
          most 20 rows are shown on each page; this is not one complete or
          atomic inventory.
        </p>
      )}
      {walletPage && (
        <>
          {!walletPage.wallets.length && (
            <p>
              No current saved Solana wallets on this page. This is not a
              statement about on-chain activity or custody.
            </p>
          )}
          <ul className={styles.wallets} aria-label="Saved Solana wallet page">
            {walletPage.wallets.map((wallet) => (
              <li key={`${wallet.address}/${wallet.revision}`}>
                <strong>{wallet.label || 'Unnamed saved wallet'}</strong>
                <code>{wallet.address}</code>
                <p>
                  Saved revision: {wallet.revision}. Saved metadata updated:{' '}
                  <time dateTime={wallet.updatedAt}>{wallet.updatedAt}</time>.
                  This is not a creation date.
                </p>
                <button
                  type="button"
                  aria-label={`Select saved evidence read target ${wallet.address}, revision ${wallet.revision}`}
                  aria-pressed={
                    target?.address === wallet.address &&
                    target.revision === wallet.revision
                  }
                  onClick={() => {
                    stop();
                    setBusy(false);
                    setTarget(wallet);
                    setHistoryPage(null);
                    setHistoryTrail([null]);
                    setNotice('');
                    setNeedsSignIn(false);
                    setLastRequest(null);
                    lastTrail.current = undefined;
                  }}
                >
                  Select this saved read target
                </button>
              </li>
            ))}
          </ul>
          <nav className={styles.actions} aria-label="Saved wallet pages">
            <button
              type="button"
              disabled={walletTrail.length < 2}
              onClick={() => {
                focus.current = 'wallets';
                const trail = walletTrail.slice(0, -1);
                void read(
                  { view: 'wallets', cursor: trail.at(-1) ?? null },
                  trail,
                );
              }}
            >
              Previous wallet page
            </button>
            <output ref={walletStatus} tabIndex={-1} aria-live="polite">
              Saved wallet page {walletTrail.length}
            </output>
            <button
              type="button"
              disabled={!walletPage.nextCursor}
              onClick={() => {
                if (walletPage.nextCursor) {
                  focus.current = 'wallets';
                  void read(
                    { view: 'wallets', cursor: walletPage.nextCursor },
                    [...walletTrail, walletPage.nextCursor],
                  );
                }
              }}
            >
              Next wallet page
            </button>
          </nav>
        </>
      )}
      {target && (
        <section
          className={styles.target}
          aria-label="Saved history read target"
        >
          <h4>Read target only</h4>
          <code>{target.address}</code>
          <p>
            Current saved revision selected: {target.revision}. This selection
            cannot approve, list or fund a wallet.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => history(null, [null])}
          >
            Load retained history
          </button>
        </section>
      )}
      {historyPage && (
        <>
          {!historyPage.records.length && (
            <p>
              No matching retained history records on this page. This does not
              establish that the wallet had no activity.
            </p>
          )}
          <ul className={styles.records} aria-label="Retained history page">
            {historyPage.records.map((record) => (
              <RecordedCheck
                key={`${record.id}/${record.revision}/${historyPage.observedAt}`}
                record={record}
              />
            ))}
          </ul>
          <nav className={styles.actions} aria-label="Retained history pages">
            <button
              type="button"
              disabled={historyTrail.length < 2}
              onClick={() => {
                focus.current = 'history';
                const trail = historyTrail.slice(0, -1);
                history(trail.at(-1) ?? null, trail);
              }}
            >
              Previous history page
            </button>
            <output ref={historyStatus} tabIndex={-1} aria-live="polite">
              Retained history page {historyTrail.length}
            </output>
            <button
              type="button"
              disabled={!historyPage.nextCursor}
              onClick={() => {
                if (historyPage.nextCursor) {
                  focus.current = 'history';
                  history(historyPage.nextCursor, [
                    ...historyTrail,
                    historyPage.nextCursor,
                  ]);
                }
              }}
            >
              Next history page
            </button>
          </nav>
        </>
      )}
    </details>
  );
}
