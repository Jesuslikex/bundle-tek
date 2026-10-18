'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { FundingDocument, SavedFunding } from '@/lib/funding-plan';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import { readWorkspaceResponse } from '@/lib/workspace-response';
import {
  decodeExchangeFundingReview,
  exchangeSolDisplay,
  exchangeSolLamports,
  type ExchangeFundingReview as Review,
} from '@/lib/exchange-funding-review';
import styles from './exchange-funding-review.module.css';
import { ExchangeOrderHistory } from './exchange-order-history';

type Props = {
  plan: SavedFunding | null;
  draft: FundingDocument;
  enabled: boolean;
};
export function ExchangeFundingReview(props: Props) {
  const [reload, setReload] = useState(0);
  return (
    <ExchangeFundingReviewContent
      key={JSON.stringify(props) + ':' + reload}
      initial={props}
      onReload={() => setReload((v) => v + 1)}
    />
  );
}
function payoutInput(value: string, total: string) {
  try {
    const raw = exchangeSolLamports(value);
    return {
      raw,
      error:
        BigInt(raw) < BigInt(exchangeSolLamports(total))
          ? 'Expected payout must cover the saved distribution total.'
          : '',
    };
  } catch {
    return {
      raw: '',
      error: 'Enter a positive SOL amount with up to 9 decimal places.',
    };
  }
}
function ExchangeFundingReviewContent({
  initial,
  onReload,
}: {
  initial: Props;
  onReload: () => void;
}) {
  // A new serialized context remounts this view and cancels its in-flight work.
  const [context] = useState(initial),
    [controllers] = useState(() => new Set<AbortController>());
  const { plan, draft, enabled } = context;
  const supported =
    draft.chain === 'Solana' &&
    draft.currency === 'SOL' &&
    draft.assetAddress === undefined &&
    !draft.recipients.some((r) => r.proxies?.length);
  const field = useId(),
    generation = useRef(0),
    pending = useRef<AbortController | null>(null);
  const [requested, setRequested] = useState(draft.total),
    [configured, setConfigured] = useState(false),
    [funder, setFunder] = useState<WorkspaceWallet | null>(null),
    [history, setHistory] = useState<Review | null>(null),
    [loading, setLoading] = useState(Boolean(supported && plan)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [historyNotice, setHistoryNotice] = useState(''),
    [clock, setClock] = useState(Date.now);
  useEffect(() => {
    const controller = new AbortController();
    controllers.add(controller);
    if (!supported || !plan) {
      return () => controller.abort();
    }
    void (async () => {
      let failure =
        'Exchange funding details are unavailable. Reload to try again.';
      try {
        const get = async (url: string) => {
          const response = await fetch(url, {
            cache: 'no-store',
            signal: controller.signal,
          });
          if (response.status === 401)
            failure = 'Sign in to review exchange funding.';
          return readWorkspaceResponse(
            response,
            'Exchange funding details are unavailable. Reload to try again.',
            'Sign in to review exchange funding.',
          );
        };
        const [statusResult, workspaceResult, savedResult] =
          await Promise.allSettled([
            get('/api/funding/exchange-quote?status=1'),
            get('/api/wallet-workspace'),
            get(
              '/api/funding/exchange-quote?planId=' +
                encodeURIComponent(plan.id),
            ),
          ]);
        if (
          statusResult.status !== 'fulfilled' ||
          workspaceResult.status !== 'fulfilled' ||
          failure === 'Sign in to review exchange funding.'
        )
          throw new Error(failure);
        const status = statusResult.value,
          workspace = workspaceResult.value;
        if (
          status.provider !== 'ChangeNOW' ||
          typeof status.quotesConfigured !== 'boolean' ||
          status.orderCreationAllowed !== false ||
          status.fundingAllowed !== false ||
          status.signingAllowed !== false ||
          status.executionAllowed !== false ||
          !Array.isArray(workspace.wallets)
        )
          throw new Error(
            'Exchange funding details are unavailable. Reload to try again.',
          );
        const wallets = workspace.wallets as WorkspaceWallet[];
        const matches = wallets.filter(
          (w) =>
            w.chain === 'Solana' &&
            w.address === draft.funderAddress &&
            w.archived === false &&
            Number.isSafeInteger(w.revision) &&
            w.revision > 0,
        );
        const saved =
          savedResult.status === 'fulfilled' ? savedResult.value : null;
        const review =
          !saved || saved.quote === null
            ? null
            : decodeExchangeFundingReview(saved.quote);
        if (review && review.planId !== plan.id)
          throw new Error('Saved exchange review did not match this draft.');
        if (!controller.signal.aborted) {
          setConfigured(status.quotesConfigured);
          setFunder(matches.length === 1 ? matches[0] : null);
          setHistory(review);
          if (!saved) {
            const storageFailure =
              'Saved exchange quotes are unavailable. Complete or restore exchange storage setup, then reload.';
            setHistoryNotice(storageFailure);
            if (status.quotesConfigured) setError(storageFailure);
          }
          setClock(Date.now());
        }
      } catch {
        if (!controller.signal.aborted) setError(failure);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => {
      controller.abort();
      controllers.forEach((c) => c.abort());
    };
  }, [controllers, draft, plan, supported]);
  useEffect(() => {
    if (!history) return;
    const timer = setTimeout(
      () => setClock(Date.now()),
      Math.min(
        2147483647,
        Math.max(0, Date.parse(history.expiresAt) - Date.now()),
      ),
    );
    return () => clearTimeout(timer);
  }, [history]);
  const { raw, error: amountError } = payoutInput(requested, draft.total);
  const reason = !supported
    ? 'This exchange route supports native SOL drafts without proxy routes. Other assets need their own funding route.'
    : !plan || !enabled || plan.archived
      ? 'Save this active CEX draft before requesting a quote.'
      : loading
        ? 'Loading exchange setup and saved funding details…'
        : error
          ? error
          : !funder
            ? 'Add the receiving funder to Wallets, then reload funding details.'
            : !configured
              ? 'Exchange quotes need server setup. Your saved draft is unchanged.'
              : amountError;
  const stale =
    history &&
    (history.revision !== plan?.revision ||
      history.planUpdatedAt !== plan?.updatedAt ||
      history.funder !== draft.funderAddress ||
      history.funderRevision !== funder?.revision ||
      history.distributionTotalLamports !== exchangeSolLamports(draft.total));
  const expired = Boolean(history && Date.parse(history.expiresAt) <= clock);
  async function quote() {
    if (reason || busy || !plan || !funder) return;
    pending.current?.abort();
    const controller = new AbortController();
    controllers.add(controller);
    pending.current = controller;
    const current = ++generation.current;
    setBusy(true);
    setError('');
    let failure =
      'Quote unavailable or changed. Reload funding details before trying again.';
    try {
      const response = await fetch('/api/funding/exchange-quote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          planId: plan.id,
          revision: plan.revision,
          funderRevision: funder.revision,
          minimumPayoutLamports: raw,
        }),
      });
      if (response.status === 429)
        failure =
          'Exchange quotes are busy. Wait 15 seconds, then reload funding details.';
      if (response.status === 401)
        failure = 'Sign in to review exchange funding.';
      const data = await readWorkspaceResponse(
        response,
        failure,
        'Sign in to review exchange funding.',
      );
      const result = decodeExchangeFundingReview(data.quote);
      if (
        result.planId !== plan.id ||
        result.revision !== plan.revision ||
        result.planUpdatedAt !== plan.updatedAt ||
        result.funder !== draft.funderAddress ||
        result.funderRevision !== funder.revision ||
        result.expectedPayoutLamports !== raw ||
        result.distributionTotalLamports !== exchangeSolLamports(draft.total) ||
        Date.parse(result.expiresAt) <= Date.now()
      )
        throw new Error('Quote did not match the current funding draft.');
      if (!controller.signal.aborted && current === generation.current) {
        setHistory(result);
        setClock(Date.now());
      }
    } catch {
      if (!controller.signal.aborted && current === generation.current)
        setError(failure);
    } finally {
      if (!controller.signal.aborted && current === generation.current)
        setBusy(false);
    }
  }
  return (
    <section className={styles.panel} aria-label="Exchange funding review">
      <header>
        <h3>Fund through an exchange</h3>
        <span className={styles.badge}>Quote review</span>
      </header>
      <p>
        Review the SOL deposit cost and expected payout to your funder before
        distributing to launch wallets.
      </p>
      <ol className={styles.steps} aria-label="Exchange funding steps">
        <li aria-current="step">1. Review quote</li>
        <li>2. Deposit</li>
        <li>3. Verify payout</li>
        <li>4. Distribute</li>
      </ol>
      <p className={styles.note}>
        Deposit, payout verification and distribution handoff are not connected
        yet. No deposit address or payment is requested here.
      </p>
      <div className={styles.address}>
        <span>Receiving funder</span>
        <code>
          {draft.funderAddress ||
            'Choose a funder public address in this draft.'}
        </code>
      </div>
      <label htmlFor={field}>Expected SOL payout to funder</label>
      <Input
        id={field}
        inputMode="decimal"
        value={requested}
        disabled={!supported || !plan || !enabled}
        onChange={(event) => {
          generation.current++;
          pending.current?.abort();
          setBusy(false);
          setRequested(event.target.value);
          setError('');
        }}
      />
      <p className={styles.note}>
        Distribution: {draft.total} {draft.currency}. Add room for distribution
        fees and the SOL you want to retain. A quote does not estimate those
        costs.
      </p>
      <div className={styles.actions}>
        <Button
          type="button"
          disabled={Boolean(reason) || busy}
          aria-describedby={field + '-reason'}
          onClick={() => void quote()}
        >
          {busy ? 'Requesting quote…' : 'Get exchange quote'}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={loading || busy}
          onClick={onReload}
        >
          Reload funding details
        </Button>
      </div>
      <p id={field + '-reason'} role={error ? 'alert' : 'status'}>
        {reason ||
          'ChangeNOW · Solana Mainnet. Requesting a quote creates no exchange order.'}
      </p>
      {historyNotice && <p className={styles.note}>{historyNotice}</p>}
      {history && enabled && (
        <div className={styles.review} aria-label="Saved exchange quote">
          <h4>
            Saved quote{' '}
            {expired
              ? '· expired'
              : stale
                ? '· draft or wallet changed'
                : '· review only'}
          </h4>
          <p className={styles.note}>
            Saved {new Date(history.quotedAt).toLocaleString()} · expires{' '}
            {new Date(history.expiresAt).toLocaleString()} · draft revision{' '}
            {history.revision}
          </p>
          {(stale || expired || history.expectedPayoutLamports !== raw) && (
            <p className={styles.note}>
              This is historical evidence. Request a fresh quote for your
              current draft and amount.
            </p>
          )}
          <dl>
            {[
              ['Provider deposit cost', history.depositLamports],
              ['Expected payout', history.expectedPayoutLamports],
              ['Exchange cost included', history.providerCostLamports],
              ['Saved distribution total', history.distributionTotalLamports],
              ['Unallocated payout', history.undistributedPayoutLamports],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{exchangeSolDisplay(value)} SOL</dd>
              </div>
            ))}
          </dl>
          <p>{history.warning}</p>
          <div className={styles.address}>
            <span>Receiving funder saved with this quote</span>
            <code>{history.funder}</code>
          </div>
          {history.providerWarning && (
            <p>Provider note: {history.providerWarning}</p>
          )}
        </div>
      )}
      {plan && <ExchangeOrderHistory planId={plan.id} />}
    </section>
  );
}
