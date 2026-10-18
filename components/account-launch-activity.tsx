'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import styles from './account-launch-activity.module.css';
import {
  validatedAccountLaunchActivity,
  type AccountLaunchActivity,
  type AccountLaunchActivityItem,
} from '@/lib/account-launch-activity';

function humanize(value: string) {
  return value
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function groupStatus(item: AccountLaunchActivityItem) {
  if (item.state === 'finalized' && item.settlementState === 'finalized')
    return 'Finalized group';
  if (item.state === 'finalized') return 'Finalization record needs review';
  if (item.settlementState)
    return `${humanize(item.state)} · ${humanize(item.settlementState)}`;
  return humanize(item.state);
}

export function AccountLaunchActivitySummary({
  value,
  onRefresh,
}: {
  value: AccountLaunchActivity;
  onRefresh?: () => void;
}) {
  return (
    <section className="account-costs-panel" aria-label="Launch activity">
      <h2>Launch activity</h2>
      <p>
        Saved Pump launch groups across your projects and their recorded state.
      </p>
      {onRefresh && (
        <Button variant="outline" onClick={onRefresh}>
          Refresh launch activity
        </Button>
      )}
      <dl className={styles.counts} aria-label="Launch group counts">
        <div>
          <dt>Saved groups</dt>
          <dd>{value.savedGroups}</dd>
        </div>
        <div>
          <dt>Finalized groups</dt>
          <dd>{value.finalizedGroups}</dd>
        </div>
        <div>
          <dt>Awaiting review</dt>
          <dd>{value.awaitingReview}</dd>
        </div>
        {value.finalizationEvidenceMissing > 0 && (
          <div>
            <dt>Needs evidence review</dt>
            <dd>{value.finalizationEvidenceMissing}</dd>
          </div>
        )}
      </dl>
      {value.recent.length > 0 ? (
        <details className={styles.disclosure}>
          <summary>Recent saved groups ({value.recent.length})</summary>
          <p>
            Showing the latest {value.recent.length} of {value.savedGroups}{' '}
            saved groups.
          </p>
          <ol className={styles.recent} aria-label="Recent launch groups">
            {value.recent.map((item) => (
              <li key={item.id} className={styles.record}>
                <details>
                  <summary>
                    {item.mint.slice(0, 6)}…{item.mint.slice(-4)}
                  </summary>
                  <code className={styles.address}>{item.mint}</code>
                </details>
                <span>{groupStatus(item)}</span>
                <time
                  className={styles.time}
                  dateTime={item.settledAt ?? item.createdAt}
                >
                  {new Date(item.settledAt ?? item.createdAt).toLocaleString()}
                </time>
              </li>
            ))}
          </ol>
        </details>
      ) : (
        <p className="performance-empty">
          No saved launch groups yet. Prepare a Pump group in a project to start
          this history.
        </p>
      )}
      <details className={styles.disclosure}>
        <summary>How this is counted</summary>
        <p>
          This includes saved Pump group reviews only. Finalized groups have
          matching saved finalization records. This view does not calculate
          launch profit, include market value, or claim that every launch cost
          and external trade is recorded. It is read-only and does not sign or
          send transactions. Open a token address for its full mint, then find
          the saved project launch history and recovery controls.
        </p>
      </details>
      <small>Checked {new Date(value.observedAt).toLocaleString()}.</small>
    </section>
  );
}

export function AccountLaunchActivityPanel() {
  const [value, setValue] = useState<AccountLaunchActivity | null>(null),
    [loading, setLoading] = useState(true),
    [needsSignIn, setNeedsSignIn] = useState(false),
    [error, setError] = useState(''),
    [request, setRequest] = useState(0);

  function refresh() {
    setValue(null);
    setError('');
    setNeedsSignIn(false);
    setLoading(true);
    setRequest((previous) => previous + 1);
  }

  useEffect(() => {
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      controller.abort();
      setError('Checking saved launch activity took too long. Try again.');
      setLoading(false);
    }, 15_000);
    void (async () => {
      try {
        const response = await fetch('/api/account-launch-activity', {
          cache: 'no-store',
          signal: controller.signal,
        });
        const body = (await response.json().catch(() => null)) as unknown;
        if (response.status === 401) {
          if (!controller.signal.aborted) setNeedsSignIn(true);
          return;
        }
        if (!response.ok || !body)
          throw new Error(
            'Saved launch activity is unavailable. No partial counts are shown.',
          );
        const next = validatedAccountLaunchActivity(body);
        if (!controller.signal.aborted) setValue(next);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Saved launch activity is unavailable.',
          );
      } finally {
        clearTimeout(deadline);
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => {
      clearTimeout(deadline);
      controller.abort();
    };
  }, [request]);

  if (!value)
    return (
      <section className="account-costs-panel" aria-label="Launch activity">
        <h2>Launch activity</h2>
        <Button variant="outline" onClick={refresh} disabled={loading}>
          {loading
            ? 'Checking launch activity…'
            : error
              ? 'Try again'
              : 'Refresh launch activity'}
        </Button>
        {loading && <output>Checking saved launch groups…</output>}
        {needsSignIn && (
          <p>
            <Link href="/sign-in">Sign in</Link> to view saved launch activity.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
      </section>
    );
  return <AccountLaunchActivitySummary value={value} onRefresh={refresh} />;
}
