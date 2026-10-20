'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  MarketplaceInventoryClockError,
  type MarketplaceOwnedInventory,
} from '@/lib/marketplace-owned-inventory';
import type { OperatorListingReview } from '@/lib/marketplace-operator-review';
import {
  admitMarketplaceControlEvidence,
  MarketplaceControlClockError,
  type MarketplaceControlEvidence,
} from '@/lib/marketplace-control-evidence';
import { readPanelJson } from './read-panel-json';
import styles from './marketplace-owned-wallets.module.css';
const labels = {
  'no-record': 'No saved control record',
  'challenge-unavailable': 'Original ownership challenge unavailable',
  'recent-record': 'Recent same-site verification record',
  'expired-record': 'Original ownership challenge expired',
  'other-origin': 'Verification belongs to another site origin',
};
export function MarketplaceControlEvidencePanel({
  inventory,
  selection,
}: {
  inventory: MarketplaceOwnedInventory;
  selection: OperatorListingReview['selection'];
}) {
  const [result, setResult] = useState<MarketplaceControlEvidence | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      pending.current?.abort();
      pending.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(
      () => {
        setResult(null);
        setMessage(
          'Control record snapshot expired. Check it again manually; this does not renew the original ownership proof.',
        );
      },
      Math.max(0, Date.parse(result.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [result]);
  function cancel() {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setResult(null);
    setMessage('Control record check cancelled. Nothing was changed.');
  }
  async function inspect() {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    const live = () =>
      pending.current === controller && !controller.signal.aborted;
    setBusy(true);
    setResult(null);
    setMessage('');
    try {
      const response = await fetch(
        '/api/marketplace/operator/control-evidence',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(selection),
          cache: 'no-store',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(15000),
          ]),
        },
      );
      const data = await readPanelJson(
        response,
        'Saved control records unavailable.',
      );
      if (!live()) return;
      if (!response.ok) {
        setMessage(
          response.status === 401
            ? 'Sign in before checking seller records.'
            : response.status === 403
              ? 'Seller access changed. Sign in again.'
              : response.status === 409
                ? 'Seller wallet changed. Reload seller inventory and review again.'
                : [400, 413, 415].includes(response.status)
                  ? 'The record request was rejected. Reload seller inventory and review the selected wallet and price again.'
                  : response.status === 408
                    ? 'Control record check stopped. Check again manually.'
                    : 'Saved control records unavailable. No sale was authorized.',
        );
        return;
      }
      const admitted = await admitMarketplaceControlEvidence(
        data,
        inventory,
        selection,
        window.location.origin,
      );
      if (!live()) return;
      if (Date.now() >= Date.parse(admitted.expiresAt))
        throw new MarketplaceControlClockError();
      setResult(admitted);
    } catch (error) {
      if (live())
        setMessage(
          error instanceof MarketplaceControlClockError ||
            error instanceof MarketplaceInventoryClockError
            ? error.message
            : 'The control record could not be verified. Reload seller inventory and check again.',
        );
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <section
      className={styles.notice}
      aria-label="Saved seller control record"
      aria-busy={busy}
    >
      <h2>Wallet control record</h2>
      <p>
        Check the existing ownership verification saved for this address. This
        reads Bundle’s records only and does not request a signature.
      </p>
      <code>{selection.address}</code>
      <div className={styles.controls}>
        <button disabled={busy} onClick={() => void inspect()}>
          {busy ? 'Checking control record…' : 'Check saved control record'}
        </button>
        {busy && <button onClick={cancel}>Cancel control check</button>}
      </div>
      {message && <output>{message}</output>}
      {result && (
        <div aria-label="Control record result" aria-live="polite">
          <strong>{labels[result.state]}</strong>
          {result.record ? (
            <dl>
              <div>
                <dt>Saved verification time</dt>
                <dd>{new Date(result.record.verifiedAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt>Original challenge</dt>
                <dd>
                  <code>{result.record.challengeId}</code>
                </dd>
              </div>
              {result.record.challenge && (
                <>
                  <div>
                    <dt>Original site</dt>
                    <dd>{result.record.challenge.origin}</dd>
                  </div>
                  <div>
                    <dt>Original message window</dt>
                    <dd>
                      {new Date(
                        result.record.challenge.issuedAt,
                      ).toLocaleString()}{' '}
                      to{' '}
                      {new Date(
                        result.record.challenge.expiresAt,
                      ).toLocaleString()}
                    </dd>
                  </div>
                </>
              )}
            </dl>
          ) : (
            <p>No ownership verification is saved for this address.</p>
          )}
          <p>
            The original signature is not stored or replayed here. This record
            does not approve the asking price or wallet revision, prove current
            or exclusive key control, or qualify a sale. Payment and key
            delivery remain unavailable.
          </p>
        </div>
      )}
      <details>
        <summary>
          Verify ownership again through the existing wallet flow
        </summary>
        <ol>
          <li>Open Bundle’s My wallets view and unlock your browser vault.</li>
          <li>Choose this saved address and select Verify ownership.</li>
          <li>
            Review the ownership message and approve it only if you agree. It
            does not authorize a transaction or sale.
          </li>
          <li>
            Return here, reload seller inventory and request a new listing
            review before checking the record again.
          </li>
        </ol>
        <Link href="/">Open Bundle workspace</Link>
      </details>
    </section>
  );
}
