'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from './ui/dialog';
import { readPanelJson } from './read-panel-json';
import type { CartReview } from '@/lib/marketplace-cart';
import { operatorDraftId } from '@/lib/marketplace-operator-draft-view';
import { marketplaceSol } from '@/lib/marketplace-catalog';
import {
  admitReservationReview,
  makeReservationRequest,
  reservationState,
  RESERVATION_ACK,
  RESERVATION_CANCEL_ACK,
  type ReservationRequest,
} from '@/lib/marketplace-reservation';
import {
  admitBuyerReservation,
  type BuyerReservation,
} from '@/lib/marketplace-reservation-view';
import styles from './marketplace-reservation-buyer.module.css';
import { MarketplaceReservationContext } from './marketplace-reservation-context';
const recoveryKey = 'bundle.marketplace.reservation-id.v1';
function retainedId() {
  try {
    const value = sessionStorage.getItem(recoveryKey);
    return operatorDraftId.safeParse(value).success ? value! : '';
  } catch {
    return '';
  }
}
export function MarketplaceReservationBuyer({
  children,
}: {
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false),
    [candidate, setCandidate] = useState<CartReview | null>(null),
    [receipt, setReceipt] = useState<BuyerReservation | null>(null),
    [id, setId] = useState(''),
    [lookup, setLookup] = useState(''),
    [ack, setAck] = useState(false),
    [releaseAck, setReleaseAck] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [missing, setMissing] = useState(false),
    [signIn, setSignIn] = useState(false),
    [clock, setClock] = useState(0),
    [retentionFailed, setRetentionFailed] = useState(false),
    [version, setVersion] = useState(0);
  const pending = useRef<AbortController | null>(null),
    expected = useRef<ReservationRequest | undefined>(undefined),
    recoveryButton = useRef<HTMLButtonElement | null>(null);
  useEffect(
    () => () => {
      pending.current?.abort();
      pending.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!open) return;
    const next = [candidate?.expiresAt, receipt?.record.expiresAt]
      .filter((s): s is string => !!s)
      .map(Date.parse)
      .filter((t) => t > clock);
    if (!next.length) return;
    const timer = setTimeout(
      () => {
        setClock(Date.now());
        setAck(false);
        setReleaseAck(false);
      },
      Math.max(0, Math.min(...next) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [open, candidate, receipt, clock]);
  const live = (c: AbortController) =>
    pending.current === c && !c.signal.aborted;
  function remember(value: string) {
    try {
      sessionStorage.setItem(recoveryKey, value);
      setRetentionFailed(false);
    } catch {
      setRetentionFailed(true);
    }
  }
  function show(review: CartReview | null) {
    const saved = retainedId() || id;
    setId(saved);
    setLookup('');
    setCandidate(saved ? null : review);
    setReceipt(null);
    setAck(false);
    setReleaseAck(false);
    setError('');
    setMessage('');
    setMissing(false);
    setSignIn(false);
    setClock(Date.now());
    if (expected.current?.id !== saved) expected.current = undefined;
    setOpen(true);
  }
  function close() {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setOpen(false);
    setAck(false);
    setReleaseAck(false);
  }
  function stop() {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setAck(false);
    setReleaseAck(false);
    setMessage(
      'Stopped waiting. Recover this same ID before another write. Closing does not release a hold.',
    );
  }
  async function run(action: 'reserve' | 'recover' | 'release') {
    if (pending.current) return;
    if (
      action === 'reserve' &&
      (!candidate ||
        !ack ||
        id ||
        Date.now() >= Date.parse(candidate.expiresAt))
    )
      return;
    if (
      action === 'release' &&
      (!receipt ||
        !releaseAck ||
        reservationState(receipt.record, receipt.releasedAt) !== 'held')
    )
      return;
    const c = new AbortController();
    pending.current = c;
    setBusy(true);
    setError('');
    setMessage('');
    setSignIn(false);
    setMissing(false);
    let activeId = id;
    try {
      let value: unknown;
      if (action === 'reserve') {
        await admitReservationReview(candidate!);
        if (!live(c)) return;
        activeId = crypto.randomUUID();
        expected.current = makeReservationRequest(activeId, candidate!, ack);
        value = { action, ...expected.current };
        remember(activeId);
        setId(activeId);
        setAck(false);
      } else if (action === 'release') {
        value = {
          action,
          id,
          contextSha256: receipt!.record.contextSha256,
          acknowledgement: RESERVATION_CANCEL_ACK,
        };
        setReleaseAck(false);
        setReceipt(null);
      } else {
        activeId = operatorDraftId.parse(id || lookup.trim());
        if (expected.current?.id !== activeId) expected.current = undefined;
        setId(activeId);
        remember(activeId);
      }
      if (action !== 'recover') setVersion((value) => value + 1);
      const response = await fetch(
        action === 'recover'
          ? `/api/marketplace/reservations?id=${encodeURIComponent(activeId)}`
          : '/api/marketplace/reservations',
        {
          ...(action === 'recover'
            ? {}
            : {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(value),
              }),
          cache: 'no-store',
          signal: AbortSignal.any([c.signal, AbortSignal.timeout(10000)]),
        },
      );
      const body = await readPanelJson(response, 'Wallet hold unavailable.');
      if (!live(c)) return;
      if (!response.ok) {
        setSignIn(response.status === 401);
        setReceipt(null);
        if (action === 'recover' && response.status === 404) {
          setMissing(true);
          setError(
            'No reservation was found for this signed-in account and ID. Check the account before clearing the local ID.',
          );
        } else
          setError(
            response.status === 401
              ? 'Sign in to recover this wallet hold.'
              : response.status === 429
                ? 'New holds are limited to one attempt every 15 seconds. Recover this ID before another write.'
                : response.status === 409
                  ? 'The selection or hold changed. Recover this ID, then refresh inventory before another review.'
                  : 'Wallet hold unavailable. Recover this ID before another write.',
          );
        return;
      }
      const checked = await admitBuyerReservation(
        body,
        activeId,
        expected.current,
      );
      if (!live(c)) return;
      setReceipt(checked);
      setCandidate(null);
      setClock(Date.now());
      setAck(false);
      setReleaseAck(false);
      setMessage(
        checked.state === 'held'
          ? 'Wallet hold verified. No payment or key delivery was authorized.'
          : checked.state === 'released'
            ? 'Hold released. Refresh inventory to see current availability.'
            : 'Hold expired. Refresh inventory and request a new cart review.',
      );
    } catch {
      if (live(c)) {
        setReceipt(null);
        setError(
          activeId
            ? 'The result could not be verified. Recover this same ID before another write.'
            : 'The cart could not be verified. Request a fresh cart review.',
        );
      }
    } finally {
      if (pending.current === c) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  const state = receipt
    ? reservationState(
        receipt.record,
        receipt.releasedAt,
        Math.max(clock, Date.parse(receipt.record.createdAt)),
      )
    : null;
  const fresh = !!candidate && clock < Date.parse(candidate.expiresAt);
  function forget() {
    if (!missing && state !== 'released' && state !== 'expired') return;
    try {
      if (sessionStorage.getItem(recoveryKey) === id)
        sessionStorage.removeItem(recoveryKey);
    } catch {}
    expected.current = undefined;
    setId('');
    setLookup('');
    setReceipt(null);
    setCandidate(null);
    setMissing(false);
    close();
  }
  return (
    <MarketplaceReservationContext.Provider value={{ open: show, version }}>
      <div className={styles.toolbar}>
        <button ref={recoveryButton} onClick={() => show(null)}>
          Recover wallet hold
        </button>
      </div>
      {children}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!value) close();
        }}
      >
        <DialogContent className={styles.popup} finalFocus={recoveryButton}>
          <DialogTitle>
            {receipt
              ? 'Wallet hold status'
              : id
                ? 'Recover wallet hold'
                : 'Review wallet hold'}
          </DialogTitle>
          <DialogDescription>
            A hold lasts five minutes. Payment, purchase and secure key delivery
            are not yet available. Closing this window does not release an
            existing hold.
          </DialogDescription>
          {candidate && !id && (
            <>
              <dl className={styles.facts}>
                <div>
                  <dt>Network / seller</dt>
                  <dd>Solana / Bundle</dd>
                </div>
                <div>
                  <dt>Wallets</dt>
                  <dd>{candidate.count}</dd>
                </div>
                <div>
                  <dt>Asking price</dt>
                  <dd>{marketplaceSol(candidate.askingPriceLamports)} SOL</dd>
                </div>
                <div>
                  <dt>Network fees</dt>
                  <dd>Not quoted</dd>
                </div>
                <div>
                  <dt>Review expires</dt>
                  <dd>{new Date(candidate.expiresAt).toLocaleTimeString()}</dd>
                </div>
              </dl>
              <details>
                <summary>Selected wallets</summary>
                {candidate.items.map((e) => (
                  <p key={e.id}>
                    <code>{e.listing.address}</code>
                    {marketplaceSol(e.listing.priceLamports)} SOL
                  </p>
                ))}
              </details>
              {!fresh ? (
                <p role="alert">
                  This review expired. Close and request a new cart review.
                </p>
              ) : (
                <label className={styles.ack}>
                  <input
                    type="checkbox"
                    checked={ack}
                    disabled={busy}
                    onChange={(e) => setAck(e.target.checked)}
                  />
                  <span>{RESERVATION_ACK}</span>
                </label>
              )}
              <div className={styles.controls}>
                <button
                  disabled={!fresh || !ack || busy}
                  onClick={() => void run('reserve')}
                >
                  Hold these wallets
                </button>
              </div>
            </>
          )}
          {(id || !candidate) && (
            <>
              <label className={styles.lookup}>
                Reservation ID
                <input
                  value={id || lookup}
                  maxLength={36}
                  readOnly={!!id}
                  disabled={busy && !id}
                  onChange={(e) => setLookup(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <p>
                Only this ID is kept in this tab for recovery. Recovery is a
                read and does not renew or approve a hold.
              </p>
              {retentionFailed && (
                <p role="alert">
                  This browser could not retain the ID. Copy it before closing
                  or reloading.
                </p>
              )}
              <div className={styles.controls}>
                <button
                  disabled={
                    busy ||
                    !operatorDraftId.safeParse(id || lookup.trim()).success
                  }
                  onClick={() => void run('recover')}
                >
                  Recover this hold
                </button>
              </div>
            </>
          )}
          {receipt && (
            <>
              <h3>
                {state === 'held'
                  ? 'Held · payment unavailable'
                  : state === 'released'
                    ? 'Released'
                    : 'Expired'}
              </h3>
              <dl className={styles.facts}>
                <div>
                  <dt>Wallets</dt>
                  <dd>{receipt.record.review.count}</dd>
                </div>
                <div>
                  <dt>Asking price</dt>
                  <dd>
                    {marketplaceSol(receipt.record.review.askingPriceLamports)}{' '}
                    SOL
                  </dd>
                </div>
                <div>
                  <dt>Hold expires</dt>
                  <dd>
                    {new Date(receipt.record.expiresAt).toLocaleTimeString()}
                  </dd>
                </div>
              </dl>
              {state === 'held' && (
                <>
                  <label className={styles.ack}>
                    <input
                      type="checkbox"
                      checked={releaseAck}
                      disabled={busy}
                      onChange={(e) => setReleaseAck(e.target.checked)}
                    />
                    <span>{RESERVATION_CANCEL_ACK}</span>
                  </label>
                  <div className={styles.controls}>
                    <button
                      disabled={!releaseAck || busy}
                      onClick={() => void run('release')}
                    >
                      Release this hold
                    </button>
                  </div>
                </>
              )}
              <details>
                <summary>Saved hold details</summary>
                <code>{receipt.record.contextSha256}</code>
                {receipt.record.review.items.map((e) => (
                  <p key={e.id}>
                    <code>{e.listing.address}</code>
                    {marketplaceSol(e.listing.priceLamports)} SOL
                  </p>
                ))}
              </details>
            </>
          )}
          {message && <output>{message}</output>}
          {error && <p role="alert">{error}</p>}
          {signIn && <Link href="/sign-in">Sign in</Link>}
          <div className={styles.controls}>
            {busy && <button onClick={stop}>Stop waiting for hold</button>}
            {(missing || state === 'released' || state === 'expired') &&
              !busy && (
                <button onClick={forget}>Clear local recovery ID</button>
              )}
            <button onClick={close}>Close hold window</button>
          </div>
        </DialogContent>
      </Dialog>
    </MarketplaceReservationContext.Provider>
  );
}
