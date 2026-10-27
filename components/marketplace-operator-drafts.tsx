'use client';
import { useEffect, useRef, useState } from 'react';
import type { OperatorListingReview } from '@/lib/marketplace-operator-review';
import {
  admitOperatorDraft,
  operatorDraftId,
  operatorDraftRequest,
  operatorDraftSave,
  OPERATOR_DRAFT_ACK,
  type OperatorDraftRecord,
  type OperatorDraftSave,
} from '@/lib/marketplace-operator-draft-view';
import { marketplaceSol } from '@/lib/marketplace-catalog';
import { readPanelJson } from './read-panel-json';
import styles from './marketplace-owned-wallets.module.css';
import draftStyles from './marketplace-operator-drafts.module.css';
import { MarketplacePublication } from './marketplace-publication';
const reminderKey = 'bundle:operator-draft-recovery:v1';
function draftFromResponse(value: unknown) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, 'draft')
  )
    throw Error('Invalid saved draft response.');
  return (value as { draft: unknown }).draft;
}
export function MarketplaceOperatorDrafts({
  review,
}: {
  review: OperatorListingReview | null;
}) {
  const pending = useRef<{
    controller: AbortController;
    kind: 'save' | 'recover';
  } | null>(null);
  const [marker, setMarker] = useState<OperatorDraftSave | null>(null),
    [id, setId] = useState(''),
    [resolvedId, setResolvedId] = useState(''),
    [notFoundId, setNotFoundId] = useState(''),
    [invalidReminder, setInvalidReminder] = useState(false),
    [ready, setReady] = useState(false),
    [consentedFor, setConsentedFor] = useState(''),
    [busy, setBusy] = useState(false),
    [expiredAt, setExpiredAt] = useState(''),
    [deadline, setDeadline] = useState(''),
    [record, setRecord] = useState<OperatorDraftRecord | null>(null),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  const context = review
    ? `${review.reviewedAt}:${review.requestSha256}:${review.evidenceSha256}`
    : '';
  const unresolved = Boolean(
    marker && resolvedId !== marker.id && notFoundId !== marker.id,
  );
  const alreadyRetained = Boolean(
    record &&
    review &&
    record.review.reviewedAt === review.reviewedAt &&
    record.review.requestSha256 === review.requestSha256 &&
    record.review.evidenceSha256 === review.evidenceSha256,
  );
  useEffect(() => {
    let mounted = true;
    void Promise.resolve().then(() => {
      if (!mounted) return;
      try {
        const raw = sessionStorage.getItem(reminderKey);
        if (raw) {
          const saved = operatorDraftSave.parse(JSON.parse(raw));
          setMarker(saved);
          setId(saved.id);
          setMessage(
            'A draft recovery ID is available. Recover it before saving another draft.',
          );
        }
      } catch {
        setInvalidReminder(true);
        setError(
          'The local recovery reminder is unavailable. Recover a known ID or clear the invalid reminder before saving.',
        );
      }
      setReady(true);
    });
    return () => {
      mounted = false;
      pending.current?.controller.abort();
      pending.current = null;
    };
  }, []);
  useEffect(() => {
    if (pending.current?.kind === 'save') {
      pending.current.controller.abort();
      pending.current = null;
      setBusy(false);
      setMessage(
        'Review changed while saving. Recover the same draft ID; no retry was sent.',
      );
    }
  }, [review]);
  useEffect(() => {
    if (review) setDeadline(review.reviewExpiresAt);
  }, [review]);
  useEffect(() => {
    if (!deadline) return;
    const remaining = Date.parse(deadline) - Date.now();
    if (remaining <= 0) {
      setExpiredAt(deadline);
      return;
    }
    setExpiredAt('');
    const timer = setTimeout(() => setExpiredAt(deadline), remaining);
    return () => clearTimeout(timer);
  }, [deadline]);
  function stop() {
    const kind = pending.current?.kind;
    pending.current?.controller.abort();
    pending.current = null;
    setBusy(false);
    setMessage(
      kind === 'save'
        ? 'Stopped waiting. The draft may have saved. Recover the same ID before saving again.'
        : 'Recovery stopped. No save request was sent.',
    );
  }
  function clearReminder() {
    if (pending.current || unresolved) return;
    try {
      sessionStorage.removeItem(reminderKey);
    } catch {
      setError(
        'The recovery reminder could not be cleared. No server data changed.',
      );
      return;
    }
    setMarker(null);
    setInvalidReminder(false);
    setResolvedId('');
    setNotFoundId('');
    setMessage(
      'Local recovery reminder cleared. Saved drafts were not deleted.',
    );
  }
  function abandon() {
    if (pending.current || !unresolved) return;
    try {
      sessionStorage.removeItem(reminderKey);
    } catch {
      setError(
        'The recovery reminder could not be abandoned. No server data changed.',
      );
      return;
    }
    setMarker(null);
    setResolvedId('');
    setNotFoundId('');
    setMessage(
      'Recovery reminder abandoned. The save outcome stays unknown and the draft may still exist; its ID stays in the field for a later recover. Saved drafts were not deleted.',
    );
  }
  function begin(kind: 'save' | 'recover') {
    const controller = new AbortController();
    pending.current = { controller, kind };
    setBusy(true);
    setError('');
    setMessage('');
    return controller;
  }
  const owns = (controller: AbortController) =>
    pending.current?.controller === controller;
  const live = (controller: AbortController) =>
    owns(controller) && !controller.signal.aborted;
  async function save() {
    if (
      !ready ||
      pending.current ||
      !review ||
      consentedFor !== context ||
      invalidReminder ||
      unresolved ||
      !!expiredAt ||
      alreadyRetained ||
      Date.parse(review.reviewExpiresAt) <= Date.now()
    )
      return;
    let input: OperatorDraftSave;
    try {
      input = operatorDraftRequest(crypto.randomUUID(), review, true);
      sessionStorage.setItem(reminderKey, JSON.stringify(input));
    } catch {
      setError(
        'A recovery ID could not be retained locally. Nothing was sent.',
      );
      return;
    }
    setMarker(input);
    setId(input.id);
    setResolvedId('');
    setNotFoundId('');
    setRecord(null);
    setConsentedFor('');
    const controller = begin('save');
    try {
      const response = await fetch('/api/marketplace/operator/drafts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        cache: 'no-store',
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(10000),
        ]),
      });
      const body = await readPanelJson(response, 'Draft save unavailable.');
      if (!live(controller)) return;
      if (!response.ok) {
        setError(
          response.status === 409
            ? 'The review expired or wallet evidence changed. Recover this ID before reviewing again.'
            : response.status === 403
              ? 'Seller access is unavailable. Recover this ID after access is restored.'
              : 'Save was not confirmed. Recover this same draft ID; no retry was sent.',
        );
        return;
      }
      const saved = await admitOperatorDraft(draftFromResponse(body), input);
      if (!live(controller)) return;
      setRecord(saved);
      setResolvedId(input.id);
      setMessage(
        'Draft saved. Saving does not publish a listing or authorize payment or key delivery.',
      );
    } catch {
      if (live(controller))
        setError(
          'Save outcome is unknown or could not be verified. Recover this same draft ID; no retry was sent.',
        );
    } finally {
      if (owns(controller)) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  async function recover() {
    if (pending.current || !operatorDraftId.safeParse(id).success) return;
    const captured = id,
      controller = begin('recover');
    setRecord(null);
    setNotFoundId('');
    try {
      const response = await fetch(
        '/api/marketplace/operator/drafts?id=' + encodeURIComponent(captured),
        {
          cache: 'no-store',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(10000),
          ]),
        },
      );
      const body = await readPanelJson(response, 'Draft recovery unavailable.');
      if (!live(controller)) return;
      if (!response.ok) {
        if (response.status === 404) {
          setNotFoundId(captured);
          setMessage(
            'This draft ID was not found for this account. No save or retry was sent.',
          );
          return;
        }
        setError(
          response.status === 401
            ? 'Sign in to recover the draft.'
            : response.status === 403
              ? 'Only configured Bundle operators can recover listing drafts. Abandon the unresolved save if this draft is out of reach.'
              : 'Draft recovery unavailable. The save outcome remains unresolved; abandon it to save again.',
        );
        return;
      }
      const saved = await admitOperatorDraft(
        draftFromResponse(body),
        marker?.id === captured ? marker : undefined,
      );
      if (!live(controller)) return;
      if (saved.id !== captured) throw Error('Unexpected identity');
      setRecord(saved);
      setResolvedId(captured);
      setMessage(
        'Saved draft recovered. Its evidence is historical; recovery does not refresh or publish it.',
      );
    } catch {
      if (live(controller))
        setError(
          'Saved draft response could not be verified. No save or retry was sent; abandon the unresolved save to start again.',
        );
    } finally {
      if (owns(controller)) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <section
      className={styles.notice}
      aria-label="Save and recover operator drafts"
      aria-busy={busy}
    >
      <h2>Saved listing drafts</h2>
      <p>
        Retain the reviewed price and recorded evidence for later recovery. This
        is private preparation, not a wallet listing or sale.
      </p>
      {review && (
        <>
          <label className={draftStyles.acknowledgement}>
            <input
              type="checkbox"
              checked={consentedFor === context}
              disabled={
                busy || unresolved || invalidReminder || alreadyRetained
              }
              onChange={(e) => setConsentedFor(e.target.checked ? context : '')}
            />
            <span>{OPERATOR_DRAFT_ACK}</span>
          </label>
          <div className={styles.controls}>
            <button
              disabled={
                !ready ||
                busy ||
                unresolved ||
                invalidReminder ||
                consentedFor !== context ||
                !!expiredAt ||
                alreadyRetained
              }
              onClick={() => void save()}
            >
              Save unpublished draft
            </button>
          </div>
        </>
      )}
      {!review && (
        <p>
          Request a fresh listing review before saving a new draft. Existing
          drafts can be recovered below.
        </p>
      )}
      {unresolved && (
        <p>
          A previous save has not been resolved. Recover its original ID before
          saving another draft, or abandon it if the draft is out of reach.
        </p>
      )}
      {expiredAt && (
        <p>
          This review expired at {new Date(expiredAt).toLocaleTimeString()}.
          Request a fresh review before saving; existing drafts can still be
          recovered.
        </p>
      )}
      <label className={draftStyles.recovery}>
        Draft recovery ID
        <input
          value={id}
          maxLength={36}
          onChange={(e) => {
            if (pending.current) stop();
            setId(e.target.value);
            setRecord(null);
            setError('');
          }}
        />
      </label>
      <div className={styles.controls}>
        <button
          disabled={!ready || busy || !operatorDraftId.safeParse(id).success}
          onClick={() => void recover()}
        >
          Recover saved draft
        </button>
        {busy && <button onClick={stop}>Stop waiting</button>}
        {(marker || invalidReminder) && (
          <button disabled={busy || unresolved} onClick={clearReminder}>
            Clear recovery reminder
          </button>
        )}
        {unresolved && (
          <button disabled={busy} onClick={abandon}>
            Abandon unresolved save
          </button>
        )}
      </div>
      {marker && (
        <p>
          Original save ID: <code>{marker.id}</code>. Clearing a reminder does
          not delete a saved draft.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {message && <output>{message}</output>}
      {record && (
        <div aria-label="Saved listing draft snapshot">
          <h3>Saved draft snapshot</h3>
          <dl>
            <div>
              <dt>Draft ID</dt>
              <dd>
                <code>{record.id}</code>
              </dd>
            </div>
            <div>
              <dt>Wallet</dt>
              <dd>
                <code>{record.review.selection.address}</code>
              </dd>
            </div>
            <div>
              <dt>Asking price</dt>
              <dd>
                {marketplaceSol(record.review.selection.priceLamports)} SOL
              </dd>
            </div>
            <div>
              <dt>Saved</dt>
              <dd>{new Date(record.createdAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt>Evidence captured</dt>
              <dd>{new Date(record.sourceObservedAt).toLocaleString()}</dd>
            </div>
          </dl>
          <p>{record.review.disclosure}</p>
          <p>
            These are historical details. The separate publication review below
            is required before a catalog listing. Payment, delivery and signing
            remain unavailable.
          </p>
          <details>
            <summary>Saved review hash</summary>
            <code>{record.reviewSha256}</code>
          </details>
          <MarketplacePublication key={record.id} draft={record} />
        </div>
      )}
    </section>
  );
}
