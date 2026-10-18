'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { readWorkspaceResponse } from '@/lib/workspace-response';
import { exchangeSolDisplay } from '@/lib/exchange-funding-review';
import {
  decodeExchangeOrderHistory,
  decodeExchangeOrderHistoryDetail,
  exchangeOrderStateLabels,
  exchangeProviderStatusLabels,
  type ExchangeOrderHistoryPage,
  type ExchangeOrderHistoryDetail,
} from '@/lib/exchange-order-history';
import styles from './exchange-order-history.module.css';

export function ExchangeOrderHistory({ planId }: { planId: string }) {
  return <History key={planId} planId={planId} />;
}
function History({ planId }: { planId: string }) {
  const [open, setOpen] = useState(false),
    [page, setPage] = useState<ExchangeOrderHistoryPage | null>(null),
    [detail, setDetail] = useState<ExchangeOrderHistoryDetail | null>(null),
    [busy, setBusy] = useState(false),
    [verifying, setVerifying] = useState(false),
    [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null),
    generation = useRef(0),
    verificationActive = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
      pending.current?.abort();
    },
    [],
  );
  async function read(id?: string, before?: string) {
    pending.current?.abort();
    verificationActive.current = false;
    setVerifying(false);
    const controller = new AbortController(),
      request = ++generation.current;
    pending.current = controller;
    setBusy(true);
    setError('');
    if (id) setDetail(null);
    let failure = 'Saved exchange orders are unavailable. Reload to try again.';
    try {
      const query = id
        ? 'id=' + encodeURIComponent(id)
        : 'planId=' +
          encodeURIComponent(planId) +
          (before ? '&before=' + encodeURIComponent(before) : '');
      const response = await fetch('/api/funding/exchange-orders?' + query, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (response.status === 401 && request === generation.current) {
        failure = 'Sign in to read saved exchange orders.';
        setPage(null);
        setDetail(null);
      }
      const body = await readWorkspaceResponse(
        response,
        'Saved exchange orders are unavailable. Reload to try again.',
        'Sign in to read saved exchange orders.',
      );
      if (controller.signal.aborted || request !== generation.current) return;
      if (id) {
        const saved = decodeExchangeOrderHistoryDetail(body.order);
        if (saved.id !== id || saved.quote.planId !== planId)
          throw new Error('Saved exchange order context differs.');
        setDetail(saved);
      } else {
        const saved = decodeExchangeOrderHistory(body);
        if (saved.planId !== planId)
          throw new Error('Saved exchange order context differs.');
        if (before) {
          const items = [...(page?.items ?? []), ...saved.items];
          if (new Set(items.map((i) => i.id)).size !== items.length)
            throw new Error(
              'Saved exchange history overlapped. Reload to try again.',
            );
          setPage({ ...saved, items });
        } else {
          setPage(saved);
          setDetail(null);
        }
      }
    } catch {
      if (!controller.signal.aborted && request === generation.current)
        setError(failure);
    } finally {
      if (!controller.signal.aborted && request === generation.current)
        setBusy(false);
    }
  }
  async function verify() {
    if (!detail || busy || verificationActive.current) return;
    const selected = detail;
    verificationActive.current = true;
    pending.current?.abort();
    const controller = new AbortController(),
      request = ++generation.current;
    pending.current = controller;
    setBusy(true);
    setVerifying(true);
    setError('');
    let failure =
      'Verification did not return a confirmed result. Reload this saved order before trying again; a receipt may already have been saved.';
    try {
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(35000),
      ]);
      const response = await fetch('/api/funding/exchange-payout', {
        method: 'POST',
        cache: 'no-store',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: selected.id, sha256: selected.sha256 }),
      });
      signal.throwIfAborted();
      if (controller.signal.aborted || request !== generation.current) return;
      if (response.status === 401) {
        failure = 'Sign in to verify a saved payout.';
        setPage(null);
        setDetail(null);
      } else if (response.status === 429) {
        failure =
          'Verification is rate limited. Wait at least 15 seconds before checking again. You can reload saved evidence without contacting the provider.';
      } else if (response.status === 409) {
        failure =
          'The saved order or finalized payment evidence could not be matched. Reload this order; its hold remains in place.';
      }
      const body = await readWorkspaceResponse(response, failure, failure);
      signal.throwIfAborted();
      const saved = decodeExchangeOrderHistoryDetail(body.order);
      if (
        saved.id !== selected.id ||
        saved.sha256 !== selected.sha256 ||
        saved.quote.planId !== planId ||
        !saved.payoutVerified
      )
        throw new Error('Payout context differs.');
      if (controller.signal.aborted || request !== generation.current) return;
      setDetail(saved);
      setPage((current) =>
        current
          ? {
              ...current,
              items: current.items.map((item) =>
                item.id === saved.id
                  ? {
                      ...item,
                      receiptRetained: true,
                      providerStatus: saved.providerStatus,
                    }
                  : item,
              ),
            }
          : current,
      );
    } catch {
      if (!controller.signal.aborted && request === generation.current)
        setError(failure);
    } finally {
      if (request === generation.current) {
        verificationActive.current = false;
        setVerifying(false);
        setBusy(false);
      }
    }
  }
  return (
    <section className={styles.history} aria-label="Saved exchange orders">
      <header>
        <h4>Saved exchange orders</h4>
        <Button
          type="button"
          variant="outline"
          aria-expanded={open}
          onClick={() => {
            if (open) {
              generation.current++;
              pending.current?.abort();
              verificationActive.current = false;
              setVerifying(false);
              setBusy(false);
              setOpen(false);
            } else {
              setOpen(true);
              void read();
            }
          }}
        >
          {open ? 'Close saved exchange orders' : 'View saved exchange orders'}
        </Button>
      </header>
      {open && (
        <>
          <p>
            Saved records only. Opening history does not contact the exchange or
            move funds.
          </p>
          <div className={styles.actions}>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void read()}
            >
              Reload saved orders
            </Button>
          </div>
          {busy && (
            <output>
              {verifying
                ? 'Checking finalized payout evidence…'
                : 'Loading saved exchange history…'}
            </output>
          )}
          {verifying && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                generation.current++;
                pending.current?.abort();
                verificationActive.current = false;
                setVerifying(false);
                setBusy(false);
                setError(
                  'Stopped waiting for verification. A receipt may already have been saved. Reload this order to recover its result.',
                );
              }}
            >
              Stop waiting for payout check
            </Button>
          )}
          {error && <p role="alert">{error}</p>}
          {page && !page.items.length && (
            <p>
              No saved exchange orders for this funding draft. Getting a quote
              does not create an order.
            </p>
          )}
          {page && page.items.length > 0 && (
            <ul className={styles.orders}>
              {page.items.map((item) => (
                <li key={item.id}>
                  <div>
                    <time dateTime={item.createdAt}>
                      {new Date(item.createdAt).toLocaleString()}
                    </time>
                    <strong>
                      {exchangeSolDisplay(item.quote.expectedPayoutLamports)}{' '}
                      SOL expected
                    </strong>
                    <span>
                      {item.receiptRetained
                        ? 'Payout receipt saved; open to read verified details'
                        : item.providerStatus
                          ? 'Saved provider report: ' +
                            exchangeProviderStatusLabels[item.providerStatus]
                          : item.attemptRetained
                            ? 'An order attempt is retained'
                            : 'Review saved; no order attempt retained'}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void read(item.id)}
                  >
                    Open order {item.id.slice(0, 8)}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {page?.nextCursor && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void read(undefined, page.nextCursor!)}
            >
              Load older exchange orders
            </Button>
          )}
          {detail && (
            <article
              className={styles.detail}
              aria-label="Saved exchange order details"
            >
              <h5>{exchangeOrderStateLabels[detail.state]}</h5>
              <p>
                This is the saved order for draft revision{' '}
                {detail.quote.revision}. Its receiving and refund wallets can
                differ from your current draft.
              </p>
              <dl>
                {[
                  ['Receiving funder', detail.quote.funder],
                  ['Refund wallet', detail.refundAddress],
                  [
                    'Provider deposit cost',
                    exchangeSolDisplay(detail.quote.depositLamports) + ' SOL',
                  ],
                  [
                    'Expected payout',
                    exchangeSolDisplay(detail.quote.expectedPayoutLamports) +
                      ' SOL',
                  ],
                  [
                    'Distribution total saved with quote',
                    exchangeSolDisplay(detail.quote.distributionTotalLamports) +
                      ' SOL',
                  ],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              {detail.approved && (
                <p>
                  Separate order consent was recorded. That historical approval
                  does not authorize a new order, payment or signature.
                </p>
              )}
              {detail.state === 'creation-unresolved' && (
                <output>
                  The order outcome is uncertain. Its hold remains in place; do
                  not create or fund another order to replace it.
                </output>
              )}
              {detail.state === 'provider-verification-required' && (
                <p>
                  The saved provider report requested verification. No provider
                  instructions are available here.
                </p>
              )}
              {detail.state === 'payout-unverified' && (
                <div className={styles.receipt}>
                  <p>
                    A finished provider report is not an on-chain payout proof.
                    No verified payout receipt is saved for this order.
                  </p>
                  <p>
                    Check the saved payout reference against finalized Solana
                    evidence. This reads the chain and saves a matching receipt;
                    it does not move funds.
                  </p>
                  <div className={styles.actions}>
                    <Button
                      type="button"
                      disabled={busy || !detail.providerReferenceRetained}
                      onClick={() => void verify()}
                    >
                      Verify finalized payout
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void read(detail.id)}
                    >
                      Reload this saved order
                    </Button>
                  </div>
                  {!detail.providerReferenceRetained && (
                    <p>
                      A retained provider order reference is required before
                      verification.
                    </p>
                  )}
                </div>
              )}
              {detail.state === 'refund-unverified' && (
                <p>
                  The refund is a saved provider report. An independently
                  verified refund receipt is still missing.
                </p>
              )}
              {detail.payout && (
                <div className={styles.receipt}>
                  <strong>
                    Finalized payout:{' '}
                    {exchangeSolDisplay(detail.payout.amountRaw)} SOL
                  </strong>
                  <p>
                    Recorded at slot {detail.payout.slot}. Verified{' '}
                    {new Date(detail.payout.observedAt).toLocaleString()}.
                  </p>
                  <a
                    href={'https://solscan.io/tx/' + detail.payout.signature}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View payout transaction{' '}
                    {detail.payout.signature.slice(0, 8)}…
                    {detail.payout.signature.slice(-8)}
                  </a>
                  <p>
                    This receipt proves a historical incoming payment. Current
                    spendable balance has not been checked.
                  </p>
                </div>
              )}
              <p>
                New exchange orders, deposits and distribution remain
                unavailable here. Payment and signing require their own reviewed
                approval.
              </p>
            </article>
          )}
        </>
      )}
    </section>
  );
}
