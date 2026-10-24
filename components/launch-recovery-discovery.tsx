'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { RecoveryProjectOpenButton } from './recovery-project-navigation';
import { LaunchRecoveryInspectionPanel } from './launch-recovery-inspection';
import { Button } from '@/components/ui/button';
import {
  LAUNCH_RECOVERY_PAGE_LIMIT,
  readLaunchRecoveryDiscovery,
  type LaunchRecoveryDiscovery,
  type LaunchRecoveryItem,
} from '@/lib/launch-recovery-discovery';
import styles from './launch-recovery-discovery.module.css';

const venues = {
  pump: 'Pump',
  'meteora-dbc': 'Meteora DBC',
  stonkfun: 'StonkFun',
  launchlab: 'LaunchLab',
};
const kinds = {
  create: 'Create',
  developer: 'Developer',
  holders: 'Holders',
  groups: 'Groups',
  uncategorized: 'Uncategorized',
  single: 'Single',
};

function reference(item: LaunchRecoveryItem) {
  return `Venue: ${item.source}\nReview kind: ${item.reviewKind}\nProject ID: ${item.projectId}\nMint: ${item.mint}\nRecord ID: ${item.id}`;
}

function RecoveryRecord({ item }: { item: LaunchRecoveryItem }) {
  const [copyNotice, setCopyNotice] = useState('');
  const copyGeneration = useRef(0);
  useEffect(
    () => () => {
      copyGeneration.current += 1;
    },
    [],
  );
  async function copy() {
    const generation = ++copyGeneration.current;
    setCopyNotice('');
    try {
      if (!navigator.clipboard?.writeText) throw Error('Clipboard unavailable');
      await navigator.clipboard.writeText(reference(item));
      if (generation === copyGeneration.current)
        setCopyNotice('Reference copied.');
    } catch {
      if (generation === copyGeneration.current)
        setCopyNotice(
          'Copy unavailable. Select the full reference shown here and copy it manually.',
        );
    }
  }
  const unresolved =
    ['signed', 'submitting', 'submitted'].includes(item.state) ||
    item.hasSignature ||
    item.hasReceipt;
  return (
    <li className={styles.record}>
      <h3>{item.projectName ?? 'Saved launch project'}</h3>
      <p>
        {venues[item.source]} · {kinds[item.reviewKind]} · Recorded state:{' '}
        {item.state}
      </p>
      <p>
        {unresolved
          ? 'Outcome unresolved. A saved signing or submission state is not proof of an on-chain result. Do not resend from this record.'
          : 'Saved review state only. This is not proof that nothing was signed. It does not authorize signing or execution.'}
      </p>
      <p>
        Created: <time dateTime={item.createdAt}>{item.createdAt}</time>
        <br />
        Review expiry: <time dateTime={item.expiresAt}>{item.expiresAt}</time>.
        An expired review is old review evidence, not permission to retry or
        release funds.
      </p>
      <p>
        Stored signature: {item.hasSignature ? 'present' : 'absent'}. Stored
        receipt: {item.hasReceipt ? 'present' : 'absent'}. Neither is verified
        here.
      </p>
      <LaunchRecoveryInspectionPanel
        reference={{
          source: item.source,
          reviewKind: item.reviewKind,
          id: item.id,
          projectId: item.projectId,
          mint: item.mint,
          createdAt: item.createdAt,
          expiresAt: item.expiresAt,
        }}
      />
      <RecoveryProjectOpenButton projectId={item.projectId} />
      <details>
        <summary>Original recovery reference</summary>
        <pre className={styles.reference}>{reference(item)}</pre>
        <Button variant="outline" onClick={() => void copy()}>
          Copy recovery reference
        </Button>
        <output>{copyNotice}</output>
      </details>
    </li>
  );
}

export function LaunchRecoveryDiscoveryPanel() {
  const [value, setValue] = useState<LaunchRecoveryDiscovery | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const generation = useRef(0);
  const active = useRef<{
    controller: AbortController;
    deadline: ReturnType<typeof setTimeout>;
  } | null>(null);
  function stop() {
    generation.current += 1;
    if (active.current) {
      clearTimeout(active.current.deadline);
      active.current.controller.abort();
      active.current = null;
    }
  }
  useEffect(() => () => stop(), []);

  async function load(nextCursor: string | null) {
    stop();
    const current = generation.current;
    const controller = new AbortController();
    setCursor(nextCursor);
    setValue(null);
    setError('');
    setNeedsSignIn(false);
    setLoading(true);
    const deadline = setTimeout(() => {
      if (current !== generation.current) return;
      stop();
      setLoading(false);
      setError('Finding saved launch recovery took too long. Try again.');
    }, 15_000);
    active.current = { controller, deadline };
    try {
      const response = await fetch(
        `/api/account-launch-recoveries${nextCursor === null ? '' : `?cursor=${encodeURIComponent(nextCursor)}`}`,
        {
          cache: 'no-store',
          signal: controller.signal,
        },
      );
      if (current !== generation.current || controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        return;
      }
      if (response.status === 401) {
        void response.body?.cancel().catch(() => {});
        setNeedsSignIn(true);
        return;
      }
      const next = await readLaunchRecoveryDiscovery(
        response,
        controller.signal,
        nextCursor,
      );
      if (current === generation.current && !controller.signal.aborted)
        setValue(next);
    } catch {
      if (current === generation.current && !controller.signal.aborted)
        setError(
          'Saved launch recovery is unavailable. No previous records are shown. Try again.',
        );
    } finally {
      if (current === generation.current) {
        clearTimeout(deadline);
        active.current = null;
        setLoading(false);
      }
    }
  }

  return (
    <section className={styles.panel} aria-label="Saved launch recovery">
      <h2>Saved launch recovery</h2>
      <p>
        Find saved nonterminal Solana launch records across Pump, Meteora DBC,
        StonkFun and LaunchLab. This read-only discovery does not verify
        receipts or authorize any wallet action.
      </p>
      <p>
        Use the original reference to find its saved launch history. A project
        shortcut, when available, opens current saved settings only; those may
        differ from the original review. Select that original review manually.
        This panel does not restore a launch, renew approval or send a
        transaction.
      </p>
      <div className={styles.actions}>
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => void load(null)}
        >
          {value || cursor
            ? 'Load newest saved records'
            : 'Find saved launch recovery'}
        </Button>
        {loading && (
          <Button
            variant="outline"
            onClick={() => {
              stop();
              setLoading(false);
              setError('Read cancelled. No records were changed.');
            }}
          >
            Cancel read
          </Button>
        )}
        {!loading && (error || needsSignIn) && (
          <Button variant="outline" onClick={() => void load(cursor)}>
            Try recovery read again
          </Button>
        )}
        {value?.nextCursor && (
          <Button variant="outline" onClick={() => void load(value.nextCursor)}>
            Older saved records
          </Button>
        )}
      </div>
      {loading && <output>Finding saved launch records…</output>}
      {needsSignIn && (
        <p>
          <Link href="/sign-in">Sign in</Link> to find your saved launch
          recovery records, then try again.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {value && (
        <>
          <p>
            Current page observed:{' '}
            <time dateTime={value.observedAt}>{value.observedAt}</time>. Each
            page contains at most {LAUNCH_RECOVERY_PAGE_LIMIT} records. Records
            may change between pages; this is not a complete launch inventory.
          </p>
          {value.items.length === 0 ? (
            <p>No matching saved records on this page.</p>
          ) : (
            <ul className={styles.records}>
              {value.items.map((item) => (
                <RecoveryRecord
                  key={`${item.source}/${item.reviewKind}/${item.projectId}/${item.id}`}
                  item={item}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
