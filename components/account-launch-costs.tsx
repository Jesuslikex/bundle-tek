'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import {
  validatedPumpGroupRecordedCosts,
  type PumpGroupRecordedCosts,
} from '@/lib/pump-group-recorded-costs';
import styles from './account-launch-costs.module.css';
type State = {
  context: string;
  busy: boolean;
  error: string;
  signIn: boolean;
  report: PumpGroupRecordedCosts | null;
};
export function AccountLaunchCosts({
  reviewId,
  mint,
}: {
  reviewId: string;
  mint: string;
}) {
  const context = reviewId + ':' + mint;
  const [saved, setSaved] = useState<State | null>(null);
  const current = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const state = saved?.context === context ? saved : null;
  useEffect(
    () => () => {
      current.current?.abort();
      current.current = null;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    },
    [reviewId, mint],
  );
  async function load() {
    current.current?.abort();
    if (timer.current !== null) clearTimeout(timer.current);
    const controller = new AbortController();
    current.current = controller;
    const empty = {
      context,
      busy: false,
      error: '',
      signIn: false,
      report: null,
    };
    setSaved({ ...empty, busy: true });
    const deadline = setTimeout(() => {
      controller.abort();
      if (current.current === controller)
        setSaved({
          ...empty,
          error: 'Checking recorded costs took too long. Retry when ready.',
        });
    }, 15_000);
    timer.current = deadline;
    try {
      const response = await fetch(
        '/api/account-launch-activity/costs?reviewId=' +
          encodeURIComponent(reviewId),
        { cache: 'no-store', signal: controller.signal },
      );
      const body = (await response.json().catch(() => null)) as unknown;
      if (current.current !== controller || controller.signal.aborted) return;
      if (response.status === 401) {
        setSaved({ ...empty, signIn: true });
        return;
      }
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? 'This saved group has no complete closed cost evidence to review. Use its project launch recovery history.'
            : 'Saved launch costs are unavailable. No cost totals are shown.',
        );
      const report = validatedPumpGroupRecordedCosts(body, { reviewId, mint });
      setSaved({ ...empty, report });
    } catch (error) {
      if (current.current === controller && !controller.signal.aborted)
        setSaved({
          ...empty,
          error:
            error instanceof Error
              ? error.message
              : 'Saved launch costs are unavailable.',
        });
    } finally {
      clearTimeout(deadline);
      if (timer.current === deadline) timer.current = null;
    }
  }
  const report = state?.report;
  const hasPacketFees =
    report?.packets.some((packet) => packet.networkFeeLamports !== null) ??
    false;
  const hasCostAmounts =
    hasPacketFees ||
    (report
      ? report.tipNetworkFeeLamports !== null || report.tipLamports !== null
      : false);
  return (
    <details className={styles.costs}>
      <summary>Recorded fees and tip</summary>
      <p>
        Review retained launch packet fees and the separate Jito tip. This does
        not calculate profit or current value.
      </p>
      <Button variant="outline" onClick={load} disabled={state?.busy ?? false}>
        {state?.busy
          ? 'Checking recorded costs…'
          : state?.error
            ? 'Retry recorded costs'
            : report
              ? 'Refresh recorded costs'
              : 'Review recorded costs'}
      </Button>
      {state?.busy && <output>Checking saved cost evidence…</output>}
      {state?.error && <p role="alert">{state.error}</p>}
      {state?.signIn && (
        <p>
          <Link href="/sign-in">Sign in</Link> to review saved launch costs.
        </p>
      )}
      {report && (
        <>
          <p>
            Recorded outcome:{' '}
            {report.outcome === 'partial'
              ? 'Mixed or partial outcome'
              : report.outcome === 'expired-unobserved'
                ? 'Expired without a finalized launch observation'
                : report.outcome === 'failed'
                  ? 'Finalized failure'
                  : 'Finalized group'}
            .
          </p>
          {hasCostAmounts ? (
            <p>
              <strong>
                {formatNativeBalance(report.knownTotalLamports, 9)} SOL
              </strong>{' '}
              {report.feeAndTipCoverageComplete
                ? 'recorded packet fees and tip.'
                : 'known fee and tip subtotal. Missing evidence is not zero.'}
            </p>
          ) : (
            <p>
              Recorded cost total is unavailable. No finalized cost amounts are
              retained.
            </p>
          )}
          <dl className={styles.amounts}>
            <div>
              <dt>Launch packet fees</dt>
              <dd>
                {!hasPacketFees ? (
                  'Unknown'
                ) : (
                  <>
                    {formatNativeBalance(report.groupNetworkFeeLamports, 9)} SOL{' '}
                    {report.packets.some(
                      (p) => p.networkFeeLamports === null,
                    ) && '(known subtotal)'}
                  </>
                )}
              </dd>
            </div>
            <div>
              <dt>Tip transaction fee</dt>
              <dd>
                {report.tipNetworkFeeLamports === null
                  ? 'Unknown'
                  : formatNativeBalance(report.tipNetworkFeeLamports, 9) +
                    ' SOL'}
              </dd>
            </div>
            <div>
              <dt>Jito tip paid</dt>
              <dd>
                {report.tipLamports === null
                  ? 'Unknown'
                  : formatNativeBalance(report.tipLamports, 9) + ' SOL'}
              </dd>
            </div>
          </dl>
          <details>
            <summary>Cost evidence and scope</summary>
            <ul>
              {report.packets.map((packet) => (
                <li key={packet.index}>
                  Packet {packet.index + 1}:{' '}
                  {packet.outcome === 'unobserved'
                    ? 'No finalized receipt retained'
                    : packet.outcome === 'success'
                      ? 'Finalized success'
                      : 'Finalized failure'}
                  . Fee:{' '}
                  {packet.networkFeeLamports === null
                    ? 'Unknown'
                    : formatNativeBalance(packet.networkFeeLamports, 9) +
                      ' SOL'}
                  .
                </li>
              ))}
            </ul>
            <p>
              Retained observation:{' '}
              <time dateTime={report.observedAt}>
                {new Date(report.observedAt).toLocaleString()}
              </time>
              . Includes successful and failed packet fees when known. Purchase
              principal, rent, external trades and market value are excluded.
              These figures are separate from the account swap-cost totals. No
              funding, signing, transaction or reservation change is performed.
            </p>
          </details>
        </>
      )}
    </details>
  );
}
