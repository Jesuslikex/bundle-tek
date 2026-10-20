'use client';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  admitPublicationPreview,
  admitPublicationRecord,
  publicationRequest,
  withdrawalRequest,
  PUBLICATION_ACK,
  WITHDRAWAL_ACK,
  type PublicationPreview,
  type PublicationRecord,
} from '@/lib/marketplace-publication';
import type { OperatorDraftRecord } from '@/lib/marketplace-operator-draft-view';
import { marketplaceSol } from '@/lib/marketplace-catalog';
import { readPanelJson } from './read-panel-json';
import styles from './marketplace-owned-wallets.module.css';
import controls from './marketplace-operator-drafts.module.css';
const reminder = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('publish'), request: publicationRequest })
    .strict(),
  z
    .object({ kind: z.literal('withdraw'), request: withdrawalRequest })
    .strict(),
]);
type Reminder = z.infer<typeof reminder>;
function envelope(value: unknown, key: string) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, key)
  )
    throw Error('Invalid publication response');
  return (value as Record<string, unknown>)[key];
}
export function MarketplacePublication({
  draft,
}: {
  draft: OperatorDraftRecord;
}) {
  const key = `bundle:publication:${draft.id}`;
  const pending = useRef<AbortController | null>(null);
  const [preview, setPreview] = useState<PublicationPreview | null>(null),
    [record, setRecord] = useState<PublicationRecord | null>(null),
    [marker, setMarker] = useState<Reminder | null>(null),
    [resolved, setResolved] = useState(false),
    [invalid, setInvalid] = useState(false),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [approved, setApproved] = useState(''),
    [withdrawApproved, setWithdrawApproved] = useState(''),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const unresolved = Boolean(marker && !resolved);
  useEffect(() => {
    let mounted = true;
    void Promise.resolve().then(() => {
      if (!mounted) return;
      try {
        const raw = sessionStorage.getItem(key);
        if (raw) {
          const found = reminder.parse(JSON.parse(raw));
          if (found.kind === 'publish' && found.request.draftId !== draft.id)
            throw Error('Other draft');
          setMarker(found);
          setMessage(
            'A publication recovery ID is available. Recover it before another write.',
          );
        }
      } catch {
        setInvalid(true);
        setError(
          'Publication recovery reminder is unavailable. No write can be sent.',
        );
      }
      setReady(true);
    });
    return () => {
      mounted = false;
      pending.current?.abort();
      pending.current = null;
    };
  }, [key, draft.id]);
  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(
      () => {
        setPreview(null);
        setApproved('');
        setMessage(
          'Publication review expired. Request a fresh review; any pending write still needs recovery.',
        );
      },
      Math.max(0, Date.parse(preview.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [preview]);
  function begin() {
    const c = new AbortController();
    pending.current = c;
    setBusy(true);
    setError('');
    setMessage('');
    return c;
  }
  const owns = (c: AbortController) => pending.current === c;
  const live = (c: AbortController) => owns(c) && !c.signal.aborted;
  function stop() {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setMessage(
      'Stopped waiting. Recover the original publication ID before another write. No retry was sent.',
    );
  }
  async function review() {
    if (pending.current || unresolved || invalid) return;
    const c = begin();
    setPreview(null);
    setApproved('');
    try {
      const response = await fetch('/api/marketplace/operator/publications', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'review', draftId: draft.id }),
        cache: 'no-store',
        signal: AbortSignal.any([c.signal, AbortSignal.timeout(10000)]),
      });
      const body = await readPanelJson(
        response,
        'Publication review unavailable.',
      );
      if (!live(c)) return;
      if (!response.ok) {
        setError(
          response.status === 422
            ? 'Verify control of this wallet, then save a fresh listing draft before publication.'
            : response.status === 409
              ? 'Wallet evidence changed. Save a fresh listing draft before publication.'
              : 'Publication review unavailable. Nothing was published.',
        );
        return;
      }
      const checked = await admitPublicationPreview(
        envelope(body, 'preview'),
        draft,
      );
      if (live(c)) setPreview(checked);
    } catch {
      if (live(c))
        setError(
          'Publication preview could not be verified. Nothing was published.',
        );
    } finally {
      if (owns(c)) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  async function write(kind: 'publish' | 'withdraw') {
    if (!ready || pending.current || invalid || unresolved) return;
    let input: Reminder;
    if (kind === 'publish') {
      if (
        !preview ||
        approved !== preview.contextSha256 ||
        Date.parse(preview.expiresAt) <= Date.now() ||
        (record && !record.withdrawnAt)
      )
        return;
      input = {
        kind,
        request: publicationRequest.parse({
          id: crypto.randomUUID(),
          draftId: draft.id,
          reviewedAt: preview.reviewedAt,
          contextSha256: preview.contextSha256,
          acknowledgement: PUBLICATION_ACK,
        }),
      };
    } else {
      if (!record || record.withdrawnAt || withdrawApproved !== record.id)
        return;
      input = {
        kind,
        request: withdrawalRequest.parse({
          id: record.id,
          contextSha256: record.preview.contextSha256,
          acknowledgement: WITHDRAWAL_ACK,
        }),
      };
    }
    try {
      sessionStorage.setItem(key, JSON.stringify(input));
    } catch {
      setError(
        'The publication recovery ID could not be retained. Nothing was sent.',
      );
      return;
    }
    setMarker(input);
    setResolved(false);
    setApproved('');
    setWithdrawApproved('');
    const c = begin();
    try {
      const response = await fetch('/api/marketplace/operator/publications', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: kind, ...input.request }),
        cache: 'no-store',
        signal: AbortSignal.any([c.signal, AbortSignal.timeout(10000)]),
      });
      const body = await readPanelJson(
        response,
        'Publication outcome unavailable.',
      );
      if (!live(c)) return;
      if (!response.ok) {
        setError(
          'Operation was not confirmed. Recover this publication ID before another write.',
        );
        return;
      }
      const checked = await admitPublicationRecord(
        envelope(body, 'publication'),
        draft,
        input.kind === 'publish' ? input.request : undefined,
      );
      if (
        checked.id !== input.request.id ||
        (input.kind === 'withdraw' &&
          (checked.preview.contextSha256 !== input.request.contextSha256 ||
            !checked.withdrawnAt))
      )
        throw Error('Different result');
      if (!live(c)) return;
      setRecord(checked);
      setResolved(true);
      setPreview(null);
      setMessage(
        checked.withdrawnAt
          ? 'Withdrawal recorded. The listing is excluded from new catalog snapshots.'
          : 'Publication recorded for signed-in customers. Purchases remain unavailable.',
      );
    } catch {
      if (live(c))
        setError(
          'Operation outcome is unknown or differs. Recover the same publication ID; no retry was sent.',
        );
    } finally {
      if (owns(c)) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  async function recover() {
    if (pending.current) return;
    const captured = marker,
      c = begin();
    try {
      const response = await fetch(
        '/api/marketplace/operator/publications?' +
          (captured
            ? 'id=' + encodeURIComponent(captured.request.id)
            : 'draftId=' + encodeURIComponent(draft.id)),
        {
          cache: 'no-store',
          signal: AbortSignal.any([c.signal, AbortSignal.timeout(10000)]),
        },
      );
      const body = await readPanelJson(
        response,
        'Publication recovery unavailable.',
      );
      if (!live(c)) return;
      if (response.status === 404) {
        setResolved(true);
        setRecord(null);
        setMessage(
          'This publication ID was not found for this operator. No write or retry was sent.',
        );
        return;
      }
      if (!response.ok) {
        setError(
          'Publication recovery unavailable. No write or retry was sent.',
        );
        return;
      }
      const checked = await admitPublicationRecord(
        envelope(body, 'publication'),
        draft,
        captured?.kind === 'publish' ? captured.request : undefined,
      );
      if (
        (captured && checked.id !== captured.request.id) ||
        (captured?.kind === 'withdraw' &&
          checked.preview.contextSha256 !== captured.request.contextSha256)
      )
        throw Error('Different identity');
      if (!live(c)) return;
      setRecord(checked);
      setResolved(true);
      setPreview(null);
      setApproved('');
      setWithdrawApproved('');
      setMessage(
        checked.withdrawnAt
          ? 'Recovered: listing withdrawn. No write was sent.'
          : 'Recovered: publication recorded. No write was sent; purchases remain unavailable.',
      );
    } catch {
      if (live(c))
        setError(
          'Publication recovery could not be verified. No write or retry was sent.',
        );
    } finally {
      if (owns(c)) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  function clear() {
    if (pending.current || unresolved) return;
    try {
      sessionStorage.removeItem(key);
    } catch {
      setError('The local reminder could not be cleared.');
      return;
    }
    setMarker(null);
    setInvalid(false);
    setResolved(false);
    setError('');
    setMessage('Publication reminder cleared. No server history was deleted.');
  }
  return (
    <section
      className={styles.notice}
      aria-label="Publish or withdraw Bundle listing"
      aria-busy={busy}
    >
      <h3>Catalog publication</h3>
      <p>
        Only the wallet address, asking price and historical activity summary
        are shared with signed-in customers. Internal wallet labels, operator
        identity and private keys are excluded. Purchases are unavailable.
      </p>
      <div className={styles.controls}>
        {!marker && (
          <button disabled={!ready || busy} onClick={() => void recover()}>
            Check existing publication
          </button>
        )}
        <button
          disabled={!ready || busy || unresolved || invalid || Boolean(record)}
          onClick={() => void review()}
        >
          Review catalog publication
        </button>
        {busy && <button onClick={stop}>Stop publication wait</button>}
      </div>
      {preview && (
        <>
          <h4>Exactly what customers will see</h4>
          <code>{preview.listing.address}</code>
          <p>
            Asking price: {marketplaceSol(preview.listing.priceLamports)} SOL
          </p>
          <p>
            Oldest recorded activity:{' '}
            {preview.listing.oldestRecordedActivityAt
              ? new Date(
                  preview.listing.oldestRecordedActivityAt,
                ).toLocaleString()
              : 'Not established'}
            . This is not a first-funding date.
          </p>
          <dl>
            <div>
              <dt>Historical balance</dt>
              <dd>
                {preview.listing.historicalBalance
                  ? `${marketplaceSol(preview.listing.historicalBalance.balanceLamports)} SOL, observed ${new Date(preview.listing.historicalBalance.observedAt).toLocaleString()}`
                  : 'Not recorded'}
              </dd>
            </div>
            <div>
              <dt>Saved history checks</dt>
              <dd>{preview.listing.savedHistoryChecks}</dd>
            </div>
            <div>
              <dt>Unique recorded warmup signatures</dt>
              <dd>{preview.listing.warmupUniqueSignatures}</dd>
            </div>
          </dl>
          <p>
            Historical balances are not a current balance guarantee or an
            approved purchase entitlement. Review expires at{' '}
            {new Date(preview.expiresAt).toLocaleTimeString()}.
          </p>
          <p>{preview.listing.disclosure}</p>
          <label className={controls.acknowledgement}>
            <input
              type="checkbox"
              checked={approved === preview.contextSha256}
              disabled={busy || unresolved}
              onChange={(e) =>
                setApproved(e.target.checked ? preview.contextSha256 : '')
              }
            />
            <span>{PUBLICATION_ACK}</span>
          </label>
          <div className={styles.controls}>
            <button
              disabled={
                busy || unresolved || approved !== preview.contextSha256
              }
              onClick={() => void write('publish')}
            >
              Publish catalog listing
            </button>
          </div>
        </>
      )}
      {marker && (
        <>
          <p>
            Publication recovery ID: <code>{marker.request.id}</code>.
          </p>
          <div className={styles.controls}>
            <button disabled={busy} onClick={() => void recover()}>
              Recover publication
            </button>
            <button disabled={busy || unresolved} onClick={clear}>
              Clear publication reminder
            </button>
          </div>
        </>
      )}
      {invalid && !marker && (
        <div className={styles.controls}>
          <button disabled={busy} onClick={clear}>
            Clear invalid publication reminder
          </button>
        </div>
      )}
      {unresolved && (
        <p>
          The last write is unresolved. Recover its original ID before
          publishing or withdrawing again.
        </p>
      )}
      {record && (
        <>
          <h4>
            {record.withdrawnAt ? 'Listing withdrawn' : 'Publication recorded'}
          </h4>
          <p>
            <code>{record.id}</code> ·{' '}
            {marketplaceSol(record.preview.listing.priceLamports)} SOL
          </p>
          <p>
            {record.withdrawnAt
              ? 'Future catalog reads exclude this listing. Existing screenshots or cached views cannot be erased. Save a fresh listing draft and review it separately to publish again.'
              : 'Catalog visibility also requires this operator and wallet to remain active. No purchase, payment or delivery is enabled.'}
          </p>
          {!record.withdrawnAt && (
            <>
              <label className={controls.acknowledgement}>
                <input
                  type="checkbox"
                  checked={withdrawApproved === record.id}
                  disabled={busy || unresolved}
                  onChange={(e) =>
                    setWithdrawApproved(e.target.checked ? record.id : '')
                  }
                />
                <span>{WITHDRAWAL_ACK}</span>
              </label>
              <div className={styles.controls}>
                <button
                  disabled={
                    busy || unresolved || withdrawApproved !== record.id
                  }
                  onClick={() => void write('withdraw')}
                >
                  Withdraw catalog listing
                </button>
              </div>
            </>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {message && <output>{message}</output>}
    </section>
  );
}
