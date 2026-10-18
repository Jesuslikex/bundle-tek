'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  validatedAccountLaunchEvidence,
  type AccountLaunchEvidence,
} from '@/lib/account-launch-evidence';
import styles from './account-launch-evidence.module.css';

export function AccountLaunchEvidencePanel({
  reviewId,
  mint,
}: {
  reviewId: string;
  mint: string;
}) {
  const context = reviewId + ':' + mint;
  const [state, setState] = useState<{
    context: string;
    busy: boolean;
    error: string;
    signIn: boolean;
    value: AccountLaunchEvidence | null;
  } | null>(null);
  const current = useRef<AbortController | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    identity = useRef<{ context: string; id: string } | null>(null);
  useEffect(
    () => () => {
      current.current?.abort();
      current.current = null;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      identity.current = null;
    },
    [context],
  );
  const view = state?.context === context ? state : null;
  async function load(save: boolean) {
    current.current?.abort();
    if (timer.current !== null) clearTimeout(timer.current);
    const controller = new AbortController();
    current.current = controller;
    const empty = {
      context,
      busy: false,
      error: '',
      signIn: false,
      value: null,
    };
    setState({ ...empty, busy: true });
    const deadline = setTimeout(() => {
      controller.abort();
      if (current.current === controller)
        setState({
          ...empty,
          error:
            'Checking receipt history took too long. Load saved evidence to check whether it was saved, or retry the same save.',
        });
    }, 50_000);
    timer.current = deadline;
    try {
      if (save && identity.current?.context !== context)
        identity.current = { context, id: crypto.randomUUID() };
      const response = await fetch(
        '/api/account-launch-activity/evidence' +
          (save ? '' : '?reviewId=' + encodeURIComponent(reviewId)),
        {
          cache: 'no-store',
          signal: controller.signal,
          ...(save
            ? {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  reviewId,
                  requestId: identity.current!.id,
                }),
              }
            : {}),
        },
      );
      const body: unknown = await response.json().catch(() => null);
      if (current.current !== controller || controller.signal.aborted) return;
      if (response.status === 401) {
        setState({ ...empty, signIn: true });
        return;
      }
      if (!response.ok)
        throw new Error(
          response.status === 404
            ? 'A saved signed launch group is required. Open the project’s launch history to review its signing state.'
            : response.status === 429
              ? 'Wait five seconds, then retry. Saved evidence can still be loaded.'
              : response.status === 409
                ? 'The save was not confirmed. Load saved evidence before retrying; the group may have changed or history capacity may be full.'
                : response.status === 503
                  ? 'Receipt history is unavailable. Load saved evidence or retry the same save when storage and provider access are available.'
                  : 'Launch receipt history could not be checked. Try again.',
        );
      const value = validatedAccountLaunchEvidence(body, { reviewId, mint });
      setState({ ...empty, value });
      if (save || value.entry?.id === identity.current?.id)
        identity.current = null;
    } catch (e) {
      if (current.current === controller && !controller.signal.aborted)
        setState({
          ...empty,
          error:
            e instanceof Error
              ? e.message
              : 'Launch receipt history is unavailable.',
        });
    } finally {
      clearTimeout(deadline);
      if (timer.current === deadline) timer.current = null;
    }
  }
  const entry = view?.value?.entry;
  return (
    <details className={styles.evidence}>
      <summary>Saved launch receipts</summary>
      <p>
        Keep finalized launch receipt details for later cost checks. Saving
        reads the provider and stores a snapshot. It does not sign, send or
        change settlement.
      </p>
      <div className={styles.actions}>
        <Button
          type="button"
          variant="outline"
          disabled={view?.busy}
          onClick={() => void load(false)}
        >
          Load saved evidence
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={view?.busy}
          onClick={() => void load(true)}
        >
          Save finalized receipts
        </Button>
      </div>
      {view?.busy && <output>Checking launch receipt history…</output>}
      {view?.signIn && (
        <p>
          <Link href="/sign-in">Sign in</Link> to review launch receipts.
        </p>
      )}
      {view?.error && <p role="alert">{view.error}</p>}
      {view?.value?.entry === null && (
        <p>
          No receipt snapshot is saved yet. Save finalized receipts when they
          are available.
        </p>
      )}
      {entry && (
        <>
          <output>
            Saved receipt snapshot: {entry.successfulPackets} successful,{' '}
            {entry.failedPackets} failed, {entry.missingPackets} not observed.
          </output>
          <p>
            {entry.balanceCoverageComplete
              ? 'Receipt balance coverage is complete.'
              : 'Receipt balance coverage is incomplete. Missing amounts remain unknown.'}{' '}
            Acquisition cost and launch profit are not verified.
          </p>
          <small>
            Saved{' '}
            <time dateTime={entry.observedAt}>
              {new Date(entry.observedAt).toLocaleString()}
            </time>
            . Reloading uses saved evidence only.
          </small>
          <details>
            <summary>Evidence details</summary>
            <p>
              {entry.instructionMetadataPackets} of {entry.packetCount} packets
              include instruction metadata. Its presence alone does not verify
              rent or purchase spending. The separate Jito tip is excluded.
            </p>
            <p>
              Snapshot <code>{entry.id}</code>
              <br />
              Hash <code>{entry.sha256}</code>
            </p>
            <p>
              Up to eight snapshots per group are retained. Earlier snapshots
              are preserved; saving does not overwrite them.
            </p>
          </details>
        </>
      )}
    </details>
  );
}
