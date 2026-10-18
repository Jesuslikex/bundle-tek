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
    [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null),
    generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
      pending.current?.abort();
    },
    [],
  );
  async function read(id?: string, before?: string) {
    pending.current?.abort();
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
          {busy && <output>Loading saved exchange history…</output>}
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
                <p>
                  A finished provider report is not an on-chain payout proof. No
                  verified payout receipt is saved for this order.
                </p>
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
