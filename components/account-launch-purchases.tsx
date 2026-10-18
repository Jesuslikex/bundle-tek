'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import {
  validatedLaunchPurchaseView,
  validatedLaunchPurchaseHistory,
  type AccountLaunchPurchaseView,
  type AccountLaunchPurchaseHistory,
} from '@/lib/account-launch-purchases';
import styles from './account-launch-purchases.module.css';
type State = {
  context: string;
  busy: boolean;
  error: string;
  signIn: boolean;
  approved: boolean;
  view: AccountLaunchPurchaseView | null;
  history: AccountLaunchPurchaseHistory | null;
  unknownSave: boolean;
};
export function AccountLaunchPurchasesPanel({
  reviewId,
  mint,
  receipt,
}: {
  reviewId: string;
  mint: string;
  receipt?: { id: string; sha256: string };
}) {
  const context = [
      reviewId,
      mint,
      receipt?.id ?? '',
      receipt?.sha256 ?? '',
    ].join(':'),
    [state, setState] = useState<State | null>(null),
    active = useRef<AbortController | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    pending = useRef<{ context: string; hash: string } | null>(null);
  useEffect(
    () => () => {
      active.current?.abort();
      active.current = null;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      pending.current = null;
    },
    [context],
  );
  const current = state?.context === context ? state : null;
  const empty = (): State => ({
    context,
    busy: false,
    error: '',
    signIn: false,
    approved: false,
    view: null,
    history: null,
    unknownSave: pending.current?.context === context,
  });
  async function readJson(response: Response, signal: AbortSignal) {
    const reader = response.body?.getReader();
    if (!reader)
      throw Error('Buy costs could not be read. Try loading them again.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      signal.throwIfAborted();
      while (true) {
        const part = await reader.read();
        signal.throwIfAborted();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 1048576)
          throw Error('Buy cost response is too large to verify.');
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.byteLength;
      }
      try {
        return JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        ) as unknown;
      } catch {
        throw Error(
          'The buy cost response could not be verified. Load it again.',
        );
      }
    } finally {
      signal.removeEventListener('abort', cancel);
      cancel();
      reader.releaseLock();
    }
  }
  async function load(mode: 'review' | 'history' | 'save') {
    if (mode !== 'history' && !receipt) return;
    if (
      mode === 'save' &&
      (!current?.approved ||
        !current.view ||
        pending.current?.context === context)
    )
      return;
    active.current?.abort();
    if (timer.current !== null) clearTimeout(timer.current);
    const controller = new AbortController();
    active.current = controller;
    const reviewed = current?.view;
    if (mode === 'save')
      pending.current = { context, hash: reviewed!.plan.sha256 };
    setState({ ...empty(), busy: true });
    const timeout = setTimeout(() => {
      controller.abort();
      if (active.current === controller) {
        active.current = null;
        setState({
          ...empty(),
          error:
            pending.current?.context === context
              ? 'The save response did not finish. Check saved status before trying again.'
              : 'Checking buy costs took too long. You can try again or load saved buys.',
        });
      }
    }, 65000);
    timer.current = timeout;
    try {
      const response = await fetch(
        '/api/account-launch-activity/purchases' +
          (mode === 'save'
            ? ''
            : '?reviewId=' +
              encodeURIComponent(reviewId) +
              (mode === 'review'
                ? '&receiptId=' + encodeURIComponent(receipt!.id)
                : '')),
        {
          cache: 'no-store',
          signal: controller.signal,
          ...(mode === 'save'
            ? {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  reviewId,
                  receiptId: receipt!.id,
                  policy: 'reviewed-buy-shares-v1',
                  planSha256: pending.current!.hash,
                  approved: true,
                }),
              }
            : {}),
        },
      ).catch(() => {
        throw Error(
          mode === 'save'
            ? 'The save response was not received. Check saved status before trying again.'
            : 'Could not reach buy cost history. Try loading it again.',
        );
      });
      if (controller.signal.aborted || active.current !== controller) return;
      if (response.status === 401) {
        setState({ ...empty(), signIn: true });
        return;
      }
      if (!response.ok)
        throw Error(
          response.status === 404
            ? 'The saved launch or receipt was not found. Reload its receipt history.'
            : response.status === 409
              ? 'Buy costs are not ready to confirm. Check the launch settlement history, or load previously saved buys.'
              : response.status === 503
                ? 'Buy cost storage is unavailable. Existing receipt history is still available.'
                : response.status === 408
                  ? 'The request timed out. Load saved status before retrying a save.'
                  : 'Buy costs could not be checked. Try loading them again.',
        );
      const body = await readJson(response, controller.signal);
      if (mode === 'history') {
        const history = await validatedLaunchPurchaseHistory(body, {
          reviewId,
          mint,
        });
        if (controller.signal.aborted || active.current !== controller) return;
        setState({ ...empty(), history });
      } else {
        const view = await validatedLaunchPurchaseView(body, {
          reviewId,
          mint,
          receiptId: receipt!.id,
          receiptSha256: receipt!.sha256,
        });
        if (controller.signal.aborted || active.current !== controller) return;
        if (
          pending.current?.context === context &&
          view.plan.sha256 !== pending.current.hash
        )
          throw Error(
            'The reviewed costs changed. Keep the saved history for recovery and reload the launch.',
          );
        if (mode === 'save' && !view.saved)
          throw Error('The save was not confirmed. Check saved status.');
        pending.current = null;
        setState({ ...empty(), view, unknownSave: false });
      }
    } catch (error) {
      if (active.current === controller && !controller.signal.aborted)
        setState({
          ...empty(),
          error:
            error instanceof Error
              ? error.message
              : 'Buy costs are unavailable.',
        });
    } finally {
      clearTimeout(timeout);
      if (timer.current === timeout) timer.current = null;
      if (active.current === controller) active.current = null;
    }
  }
  function stop() {
    active.current?.abort();
    active.current = null;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setState({
      ...empty(),
      error:
        pending.current?.context === context
          ? 'Stopped waiting for the save. Check saved status before trying again.'
          : 'Stopped checking buy costs. You can load them again.',
    });
  }
  const view = current?.view,
    rows = view?.plan.sources ?? current?.history?.sources,
    remaining = view
      ? view.plan.sources.length - view.recordedOriginIds.length
      : 0,
    quote =
      rows?.[0]?.quoteMint === 'So11111111111111111111111111111111111111112'
        ? 'SOL'
        : 'quote tokens',
    total = (
      field:
        | 'purchaseQuoteRaw'
        | 'executionCostLamports'
        | 'walletSetupFundingLamports',
    ) => rows!.reduce((s, r) => s + BigInt(r[field]), 0n).toString();
  return (
    <details className={styles.panel}>
      <summary>Saved buy costs</summary>
      <p>
        Review and save the buy costs already recorded in your launch receipts.
        No wallet unlock or transaction is needed.
      </p>
      <div className={styles.actions}>
        <Button
          type="button"
          variant="outline"
          disabled={current?.busy || !receipt}
          onClick={() => void load('review')}
        >
          {current?.unknownSave ? 'Check saved status' : 'Review these buys'}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={current?.busy}
          onClick={() => void load('history')}
        >
          Load saved buys
        </Button>
        {current?.busy && (
          <Button type="button" variant="outline" onClick={stop}>
            Stop checking
          </Button>
        )}
      </div>
      {!receipt && (
        <p>
          Load a saved receipt above to review new costs. Previously saved buys
          can still be loaded here.
        </p>
      )}
      {current?.busy && <output>Checking retained buy costs…</output>}
      {current?.signIn && (
        <p>
          <Link href="/sign-in">Sign in</Link> to review buy costs.
        </p>
      )}
      {current?.error && <p role="alert">{current.error}</p>}
      {current?.unknownSave && !current.busy && (
        <output>
          The last save is unconfirmed. Use Check saved status before saving
          again.
        </output>
      )}
      {rows && (
        <>
          <output>
            {current?.history
              ? `${rows.length} saved ${rows.length === 1 ? 'buy' : 'buys'} loaded.`
              : remaining === 0 && rows.length > 0
                ? `${rows.length} ${rows.length === 1 ? 'buy is' : 'buys are'} already saved.`
                : `${rows.length} ${rows.length === 1 ? 'buy' : 'buys'} verified${view?.plan.omitted.length ? `; ${view.plan.omitted.length} still ${view.plan.omitted.length === 1 ? 'needs' : 'need'} evidence` : ''}.`}
          </output>
          {rows.length > 0 && (
            <dl className={styles.totals}>
              <div>
                <dt>Buy spending</dt>
                <dd>
                  {formatNativeBalance(
                    total('purchaseQuoteRaw'),
                    rows[0].quoteDecimals,
                  )}{' '}
                  {quote}
                </dd>
              </div>
              <div>
                <dt>Allocated fees &amp; tip</dt>
                <dd>
                  {formatNativeBalance(total('executionCostLamports'), 9)} SOL
                </dd>
              </div>
            </dl>
          )}
          {rows.length === 0 && (
            <p>
              {current?.history
                ? 'No buy costs have been saved for this launch yet.'
                : 'This receipt has no verified buys to save. Load earlier saved buys or check the launch receipt history.'}
            </p>
          )}
          {view && remaining > 0 && !current?.unknownSave && (
            <>
              <label className={styles.consent}>
                <input
                  type="checkbox"
                  checked={current?.approved ?? false}
                  onChange={(event) => {
                    const approved = event.target.checked;
                    setState((previous) =>
                      previous?.context === context
                        ? { ...previous, approved }
                        : previous,
                    );
                  }}
                />
                <span>Save these buys with the fee shares shown.</span>
              </label>
              <Button
                type="button"
                disabled={!current?.approved || current.busy}
                onClick={() => void load('save')}
              >
                Save {remaining} new {remaining === 1 ? 'buy' : 'buys'}
              </Button>
            </>
          )}
          <p>
            Setup funding stays separate. Sale profit is not calculated yet.
          </p>
          <details className={styles.details}>
            <summary>Cost details</summary>
            <p>
              Each packet fee is shared across that packet’s original buys. Tip
              costs are shared across all original buys. Missing or failed buys
              keep their share separate.
            </p>
            {rows.length > 0 && (
              <p>
                Recorded setup funding for these buys:{' '}
                {formatNativeBalance(total('walletSetupFundingLamports'), 9)}{' '}
                SOL. Rent and refunds are not verified.
              </p>
            )}
            {view && (
              <>
                <p>
                  {view.plan.allocationComplete
                    ? 'All reviewed buy costs are covered by this snapshot.'
                    : 'This snapshot is incomplete. Missing amounts remain unknown.'}{' '}
                  These snapshot totals are not additional expenses to add to
                  other snapshots.
                </p>
                <p>
                  Unallocated packet fees:{' '}
                  {formatNativeBalance(
                    view.plan.unallocatedPacketFeesLamports,
                    9,
                  )}{' '}
                  SOL. Unallocated tip:{' '}
                  {formatNativeBalance(view.plan.unallocatedTipLamports, 9)}{' '}
                  SOL. Unallocated tip fee:{' '}
                  {formatNativeBalance(view.plan.unallocatedTipFeeLamports, 9)}{' '}
                  SOL. Unknown packet fees: {view.plan.unknownFeePackets.length}
                  .
                </p>
                <p>
                  Receipt <code>{view.receiptId}</code>
                  <br />
                  Plan <code>{view.plan.sha256}</code>
                </p>
              </>
            )}
            {rows.map((row) => (
              <details key={row.originId}>
                <summary>
                  Wallet {row.wallet.slice(0, 6)}…{row.wallet.slice(-4)}
                </summary>
                <dl>
                  <dt>Buy quote debit</dt>
                  <dd>
                    {formatNativeBalance(
                      row.purchaseQuoteRaw,
                      row.quoteDecimals,
                    )}{' '}
                    {quote}
                  </dd>
                  <dt>Fee and tip share</dt>
                  <dd>
                    {formatNativeBalance(row.executionCostLamports, 9)} SOL
                  </dd>
                  <dt>Quote mint</dt>
                  <dd>
                    <code>{row.quoteMint}</code>
                  </dd>
                  <dt>Received raw token units</dt>
                  <dd>{row.acquiredRaw}</dd>
                  <dt>Wallet</dt>
                  <dd>
                    <code>{row.wallet}</code>
                  </dd>
                </dl>
              </details>
            ))}
          </details>
        </>
      )}
    </details>
  );
}
