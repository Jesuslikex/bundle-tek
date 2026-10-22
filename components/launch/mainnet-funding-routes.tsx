'use client';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { FundingRouteHistory } from '@/lib/mainnet-funding-route-history';
import { mainnetFundingRecordLabel } from '@/lib/mainnet-funding-history';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import styles from './mainnet-funding-routes.module.css';

export function MainnetFundingRoutes({
  view,
}: {
  view: FundingRouteHistory | null;
}) {
  const [page, setPage] = useState(0);
  const status = useRef<HTMLOutputElement>(null);
  if (!view)
    return (
      <section aria-label="Saved funding routes">
        <h5>Saved funding routes</h5>
        <p>
          Exact native SOL routes are unavailable for this response. The
          original saved Wallet funding terms are required. Older revisions need
          a retained capture with the exact whole terms hash; changed or
          unproven terms are not filled from the current draft. Captured
          transitions remain below.
        </p>
      </section>
    );
  const pages = Math.max(1, Math.ceil(view.routes.length / 25));
  const selected = Math.min(page, pages - 1);
  const steps = view.routes.flatMap((route) => route.steps);
  const delivered = view.routes.filter(
    (route) => route.steps.at(-1)!.receiptMatches,
  );
  return (
    <section className={styles.routes} aria-label="Saved funding routes">
      <h5>Saved funding routes · revision {view.revision}</h5>
      {view.sourceRevision !== view.revision && (
        <p>
          Historical funding revision {view.revision} is reconstructed from
          saved source revision {view.sourceRevision} because its complete terms
          hash matches the original retained captures. These receipts are not
          credited to the current revision.
        </p>
      )}
      <p>
        Saved allocations and the latest retained attempt per step, not a
        cumulative transfer ledger, current balances or launch readiness.
        Earlier attempts remain in the transitions below. These routes are not
        linked to a token project here. A missing receipt is not permission to
        repeat a transfer.
      </p>
      <dl className={styles.totals}>
        <div>
          <dt>Planned recipients</dt>
          <dd>{view.routes.length}</dd>
        </div>
        <div>
          <dt>Matching receipts (latest attempts)</dt>
          <dd>
            {steps.filter((step) => step.receiptMatches).length} /{' '}
            {steps.length}
          </dd>
        </div>
        <div>
          <dt>Final recipient receipts (latest attempts)</dt>
          <dd>
            {delivered.length} / {view.routes.length}
          </dd>
        </div>
        <div>
          <dt>Receipted allocations (SOL, latest attempts)</dt>
          <dd>
            {formatNativeBalance(
              delivered
                .reduce((sum, route) => sum + BigInt(route.amountRaw), 0n)
                .toString(),
              9,
            )}
          </dd>
        </div>
      </dl>
      <p>
        Each receipt is matched to its exact saved source, destination, amount,
        schedule and terms hash. This does not independently establish transfer
        order or where the funds are now. Earlier hops include the saved proxy
        fee allowance; they are not extra final allocations.
      </p>
      <output ref={status} tabIndex={-1} aria-label="Saved funding route page">
        Showing {Math.min(25, view.routes.length - selected * 25)} of{' '}
        {view.routes.length} planned recipients, page {selected + 1} of {pages}.
        Totals cover all routes.
      </output>
      <ul className={styles.list} aria-label="Planned funding recipients">
        {view.routes.slice(selected * 25, (selected + 1) * 25).map((route) => (
          <li key={route.item}>
            <div className={styles.row}>
              <strong>Recipient {route.item}</strong>
              <code>{route.recipient}</code>
              <span>
                Saved allocation: {formatNativeBalance(route.amountRaw, 9)} SOL
              </span>
              <span>
                {route.steps.at(-1)!.receiptMatches
                  ? 'Final recipient receipt matches'
                  : 'Final recipient receipt not confirmed'}
              </span>
            </div>
            <p>
              Due{' '}
              <time dateTime={route.scheduledAt}>
                {new Date(route.scheduledAt).toLocaleString()}
              </time>{' '}
              · {route.steps.filter((step) => step.receiptMatches).length} /{' '}
              {route.steps.length} matching transfer receipts.
            </p>
            <details>
              <summary>
                Inspect {route.steps.length} planned transfer{' '}
                {route.steps.length === 1 ? 'step' : 'steps'}
              </summary>
              {route.steps.map((step) => (
                <div className={styles.step} key={step.leg ?? 'direct'}>
                  <strong>
                    {step.leg === null
                      ? 'Direct transfer'
                      : `Proxy leg ${step.leg}`}
                  </strong>
                  <dl>
                    <dt>From</dt>
                    <dd>
                      <code>{step.wallet}</code>
                    </dd>
                    <dt>To</dt>
                    <dd>
                      <code>{step.recipient}</code>
                    </dd>
                    <dt>Saved transfer (SOL)</dt>
                    <dd>{formatNativeBalance(step.amountRaw, 9)}</dd>
                    <dt>Retained evidence</dt>
                    <dd>
                      {step.receiptMatches
                        ? 'Receipt matches saved transfer'
                        : step.record?.receipt
                          ? 'Receipt amount differs from saved transfer'
                          : step.record
                            ? mainnetFundingRecordLabel(step.record)
                            : 'No retained attempt for this step'}
                    </dd>
                    {step.record?.receipt && (
                      <>
                        <dt>Destination received (SOL)</dt>
                        <dd>
                          {formatNativeBalance(
                            step.record.receipt.deliveredRaw,
                            9,
                          )}{' '}
                          · slot {step.record.receipt.slot}
                          {!step.receiptMatches &&
                            ' · amount does not match the saved transfer'}
                        </dd>
                      </>
                    )}
                  </dl>
                </div>
              ))}
            </details>
          </li>
        ))}
      </ul>
      {pages > 1 && (
        <nav className={styles.pager} aria-label="Saved funding route pages">
          <Button
            type="button"
            variant="outline"
            className={styles.button}
            disabled={selected === 0}
            onClick={() => {
              setPage(selected - 1);
              status.current?.focus();
            }}
          >
            Previous funding recipients
          </Button>
          <Button
            type="button"
            variant="outline"
            className={styles.button}
            disabled={selected === pages - 1}
            onClick={() => {
              setPage(selected + 1);
              status.current?.focus();
            }}
          >
            Next funding recipients
          </Button>
        </nav>
      )}
      <details>
        <summary>Saved route source</summary>
        <p>
          Funding evidence revision {view.revision} · source revision{' '}
          {view.sourceRevision}, source saved{' '}
          <time dateTime={view.updatedAt}>
            {new Date(view.updatedAt).toLocaleString()}
          </time>
          . Terms <code>{view.termsSha256}</code>. This view grants no signing
          or execution authority.
        </p>
      </details>
    </section>
  );
}
