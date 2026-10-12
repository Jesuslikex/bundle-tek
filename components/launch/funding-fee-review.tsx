'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { FundingFeeReview } from '@/lib/funding-fees';
import type { UnsignedFundingBatch } from '@/lib/funding-transactions';
export function FundingFeeReviewPanel({
  id,
  revision,
  enabled,
}: {
  id: string;
  revision: number;
  enabled: boolean;
}) {
  const [review, setReview] = useState<FundingFeeReview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [batch, setBatch] = useState<UnsignedFundingBatch | null>(null);
  const [action, setAction] = useState<'review' | 'prepare'>('review');
  const [now, setNow] = useState(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!batch) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [batch]);
  async function refresh(mode: 'review' | 'prepare' = 'review') {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError('');
    setReview(null);
    setBatch(null);
    setAction(mode);
    try {
      const response = await fetch('/api/funding/fees', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, revision, action: mode }),
        signal: request.signal,
      });
      const data = (await response.json()) as {
        review?: FundingFeeReview;
        error?: string;
        batch?: UnsignedFundingBatch;
        id?: string;
        revision?: number;
      };
      if (!response.ok || !data.review)
        throw new Error(data.error || 'Fee review unavailable.');
      if (data.id !== id || data.revision !== revision)
        throw new Error('Funding revision changed. Reload the draft.');
      if (
        mode === 'prepare' &&
        (!data.batch ||
          data.batch.version !== 1 ||
          data.batch.signed !== false ||
          data.batch.executionAllowed !== false ||
          !Number.isFinite(Date.parse(data.batch.expiresAt)) ||
          Date.parse(data.batch.expiresAt) <= Date.now())
      )
        throw new Error(
          'Unsigned preparation is missing or expired. Refresh preparation.',
        );
      if (!request.signal.aborted) {
        setReview(data.review);
        setBatch(data.batch ?? null);
        setNow(Date.now());
      }
    } catch (failure) {
      if (!request.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Fee review unavailable.',
        );
    } finally {
      if (!request.signal.aborted) setBusy(false);
    }
  }
  return (
    <section className="wallet-holdings-panel" aria-label="Funding fee review">
      <h3>Transfer fees and funder balance</h3>
      <p className="source-note">
        Check the saved wallet funding draft. Estimates use current provider gas
        prices and independent recipient calls. Additional rollup data fees,
        token taxes and later price changes are excluded. Scheduling and
        transactions remain inactive.
      </p>
      <Button disabled={!enabled || busy} onClick={() => void refresh()}>
        {busy && action === 'review' ? 'Checking fees…' : 'Check transfer fees'}
      </Button>
      <Button
        variant="outline"
        disabled={!enabled || busy}
        onClick={() => void refresh('prepare')}
      >
        {busy && action === 'prepare'
          ? 'Preparing transactions…'
          : 'Prepare unsigned transactions'}
      </Button>
      {!enabled && <p>Save the current draft before checking fees.</p>}
      {error && (
        <p role="alert" className="draft-error">
          {error}
        </p>
      )}
      {review && (
        <>
          <p className="source-note">
            {review.chain} · {review.source} · block {review.blockNumber} ·{' '}
            {new Date(review.observedAt).toLocaleString()} · saved revision{' '}
            {revision}
          </p>
          <p className="source-note">
            Transfer asset:{' '}
            {review.contract ? (
              <code>{review.contract}</code>
            ) : (
              'Native currency'
            )}
          </p>
          <dl className="funding-fee-summary">
            <dt>Transfer units required</dt>
            <dd>
              {review.transferTotal} {review.currency}
            </dd>
            <dt>Observed transfer balance</dt>
            <dd>
              {review.transferBalance} {review.currency}
            </dd>
            <dt>Transfer shortfall</dt>
            <dd>
              {review.transferShortfall} {review.currency}
            </dd>
            <dt>Observed native balance</dt>
            <dd>
              {review.nativeBalance} {review.nativeCurrency}
            </dd>
            <dt>Estimated gas fees</dt>
            <dd>
              {review.estimatedFee === null
                ? 'Unavailable until transfer balance covers the batch'
                : review.estimatedFee + ' ' + review.nativeCurrency}
            </dd>
            <dt>Native amount plus estimated gas</dt>
            <dd>
              {review.nativeRequired === null
                ? 'Unavailable'
                : review.nativeRequired + ' ' + review.nativeCurrency}
            </dd>
            <dt>Native shortfall against estimate</dt>
            <dd>
              {review.nativeShortfall === null
                ? 'Unavailable'
                : review.nativeShortfall + ' ' + review.nativeCurrency}
            </dd>
          </dl>
          <p>
            These observations do not establish that the batch is ready to
            execute.
          </p>
          <div className="wallet-roster-table evm-token-balance-table funding-fee-table">
            <table className="project-table">
              <thead>
                <tr>
                  <th>Recipient</th>
                  <th>Amount</th>
                  <th>Estimated gas</th>
                  <th>Estimated fee</th>
                </tr>
              </thead>
              <tbody>
                {review.transfers.map((item) => (
                  <tr key={item.recipient}>
                    <td data-label="Recipient">
                      <code>{item.recipient}</code>
                    </td>
                    <td data-label="Amount">
                      {item.amount} {review.currency}
                    </td>
                    <td data-label="Estimated gas">
                      {item.gas ?? 'Unavailable'}
                    </td>
                    <td data-label="Estimated fee">
                      {item.estimatedFee === null
                        ? 'Unavailable'
                        : item.estimatedFee + ' ' + review.nativeCurrency}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {batch && (
        <section
          className="funding-unsigned-review"
          aria-label="Unsigned funding transactions"
        >
          <h3>Unsigned transaction batch</h3>
          <p>
            {batch.chain} · chain ID {batch.chainId} · starting nonce{' '}
            {batch.startingNonce}. These sequential transfers are not atomic.
            Nonces are not reserved.
          </p>
          <p>
            Gas limits include a 20% allowance. Execution gas budget:{' '}
            {batch.maximumGasFee} {batch.nativeCurrency}. Native transfers plus
            execution gas: {batch.nativeRequired} {batch.nativeCurrency}. Extra
            rollup fees and token taxes are excluded.
          </p>
          <output>
            {Date.parse(batch.expiresAt) <= now
              ? 'Expired. Prepare again before using these transactions.'
              : `Review expires in ${Math.max(0, Math.ceil((Date.parse(batch.expiresAt) - now) / 1000))} seconds.`}
          </output>
          <div className="wallet-roster-table funding-fee-table">
            <table className="project-table">
              <thead>
                <tr>
                  <th>Recipient</th>
                  <th>Amount</th>
                  <th>Nonce</th>
                  <th>Gas limit</th>
                </tr>
              </thead>
              <tbody>
                {batch.transactions.map((item) => (
                  <tr key={item.recipient}>
                    <td data-label="Recipient">
                      <code>{item.recipient}</code>
                    </td>
                    <td data-label="Amount">
                      {item.amount} {batch.currency}
                    </td>
                    <td data-label="Nonce">
                      {BigInt(item.transaction.nonce).toString()}
                    </td>
                    <td data-label="Gas limit">
                      {BigInt(item.transaction.gas).toString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary>Inspect transaction fields</summary>
            <pre>{JSON.stringify(batch.transactions, null, 2)}</pre>
          </details>
          <Button
            variant="outline"
            disabled={Date.parse(batch.expiresAt) <= now || busy}
            onClick={() => {
              if (Date.parse(batch.expiresAt) <= Date.now()) {
                setNow(Date.now());
                setError('Unsigned batch expired. Prepare again.');
                return;
              }
              const url = URL.createObjectURL(
                new Blob(
                  [
                    JSON.stringify(
                      {
                        format: 'pulseforge-unsigned-funding-v1',
                        id,
                        revision,
                        ...batch,
                      },
                      null,
                      2,
                    ),
                  ],
                  { type: 'application/json' },
                ),
              );
              const link = document.createElement('a');
              link.href = url;
              link.download = `funding-${id}-r${revision}-unsigned.json`;
              link.click();
              window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            Download unsigned JSON
          </Button>
          <p>
            Review only. Revalidate the draft, balances, fees and nonce before
            signing. This app does not sign or submit these transactions.
          </p>
        </section>
      )}
    </section>
  );
}
