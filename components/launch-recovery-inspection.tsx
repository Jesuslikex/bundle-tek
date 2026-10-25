'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import bs58 from 'bs58';
import { Button } from '@/components/ui/button';
import {
  launchRecoveryInspectionUrl,
  readLaunchRecoveryInspection,
  LaunchInspectionReadError,
  type LaunchInspectionReference,
  type LaunchRecoveryInspection,
} from '@/lib/launch-recovery-inspection';
import styles from './launch-recovery-inspection.module.css';

const labels: Record<string, string> = {
  'fee-rent-limit': 'Fee and rent limit from saved review',
  'terms-fee-rent-limit': 'Fee and rent limit from saved terms',
  'developer-input-max-quote': 'Developer saved-input maximum quote cost',
  'holder-input-max-quote': 'Holder saved-input maximum quote cost',
  'holder-input-min-output': 'Holder saved-input minimum token output',
  'deployer-fee-rent-limit': 'Deployer fee and rent limit',
  'developer-max-quote': 'Developer maximum quote allowance',
  'developer-token-output': 'Developer token output',
  'holder-fee-rent-limit': 'Holder fee and rent limit',
  'holder-token-output': 'Holder exact token output',
  'holder-quote-input': 'Holder exact quote input',
  'holder-max-quote': 'Holder maximum quote allowance',
  'holder-min-output': 'Holder minimum token output allowance',
  'developer-buy': 'Developer buy',
  'minimum-token-output': 'Minimum token output',
  'sol-cost-estimate':
    'Recorded simulated SOL cost (includes SOL creator buy when applicable)',
  'sol-spend-limit': 'SOL fee/rent allowance (creator buy is separate)',
  'pool-creation-fee':
    'Pool creation fee (included in the venue fee allowance)',
};
const BUDGET_PAGE_SIZE = 25;
function intentLabel(
  mode: LaunchRecoveryInspection['participants'][number]['mode'],
) {
  switch (mode) {
    case 'not-requested':
      return 'No buy requested in this saved review';
    case 'exact-base-output':
      return 'Exact token output requested (saved intent)';
    case 'exact-quote-input':
      return 'Exact quote input requested (saved intent)';
    case 'unavailable':
      return 'Unavailable; this does not establish that no buy was requested';
  }
}
function referenceText(value: LaunchInspectionReference) {
  return `Venue: ${value.source}\nReview kind: ${value.reviewKind}\nProject ID: ${value.projectId}\nMint: ${value.mint}\nRecord ID: ${value.id}\nCreated: ${value.createdAt}\nOriginal review expiry: ${value.expiresAt}`;
}
function publicSignature(value: string | null) {
  try {
    if (typeof value !== 'string' || value.length > 90) return false;
    const bytes = bs58.decode(value);
    return bytes.length === 64 && bs58.encode(bytes) === value;
  } catch {
    return false;
  }
}

export function LaunchRecoveryInspectionPanel({
  reference,
}: {
  reference: LaunchInspectionReference;
}) {
  const key = JSON.stringify([
    reference.source,
    reference.reviewKind,
    reference.id,
    reference.projectId,
    reference.mint,
    reference.createdAt,
    reference.expiresAt,
  ]);
  return <Inspection key={key} reference={reference} />;
}

function Inspection({ reference }: { reference: LaunchInspectionReference }) {
  const [value, setValue] = useState<LaunchRecoveryInspection | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [page, setPage] = useState(0);
  const pageStatus = useRef<HTMLOutputElement | null>(null);
  const focusPageStatus = useRef(false);
  useLayoutEffect(() => {
    if (focusPageStatus.current) {
      focusPageStatus.current = false;
      pageStatus.current?.focus();
    }
  }, [page]);
  const details = useRef<HTMLDetailsElement | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
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
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop();
    };
  }, []);
  function clear() {
    focusPageStatus.current = false;
    stop();
    setBusy(false);
    setValue(null);
    setNeedsSignIn(false);
    setNotice('');
    setPage(0);
  }
  async function read() {
    if (!details.current?.open || reference.reviewKind === 'uncategorized')
      return;
    clear();
    const current = generation.current;
    const controller = new AbortController();
    setBusy(true);
    const deadline = setTimeout(() => {
      if (current !== generation.current || !mounted.current) return;
      stop();
      setBusy(false);
      setNotice(
        'Saved review inspection took too long. No previous inspection is shown. Try again manually.',
      );
    }, 15_000);
    active.current = { controller, deadline };
    try {
      const response = await fetch(launchRecoveryInspectionUrl(reference), {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'error',
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        current !== generation.current ||
        !mounted.current
      ) {
        void response.body?.cancel().catch(() => {});
        return;
      }
      const next = await readLaunchRecoveryInspection(
        response,
        reference,
        controller.signal,
      );
      if (
        !controller.signal.aborted &&
        current === generation.current &&
        mounted.current
      )
        setValue(next);
    } catch (error) {
      if (
        controller.signal.aborted ||
        current !== generation.current ||
        !mounted.current
      )
        return;
      if (error instanceof LaunchInspectionReadError && error.status === 401) {
        setNeedsSignIn(true);
        setNotice('Sign in to inspect this saved review, then retry manually.');
      } else if (
        error instanceof LaunchInspectionReadError &&
        error.status === 404
      ) {
        setNotice(
          'This saved review was not found for this account. Keep the original reference; no replacement or restored review was created.',
        );
      } else if (
        error instanceof LaunchInspectionReadError &&
        error.status === 409
      ) {
        setNotice(
          'This original saved review reference or format cannot be inspected. Keep the original reference. No alternative workflow was started.',
        );
      } else {
        setNotice(
          'Saved review inspection is unavailable. Keep the original reference. No previous inspection is shown. Try again manually.',
        );
      }
    } finally {
      if (current === generation.current && mounted.current) {
        clearTimeout(deadline);
        active.current = null;
        setBusy(false);
      }
    }
  }
  const start = page * BUDGET_PAGE_SIZE;
  const holderCount =
    value?.participants.filter((participant) => participant.role === 'holder')
      .length ?? 0;
  const developerCount =
    value?.participants.filter(
      (participant) => participant.role === 'developer',
    ).length ?? 0;
  return (
    <details
      className={styles.panel}
      ref={details}
      onToggle={(event) => {
        if (!event.currentTarget.open) clear();
      }}
    >
      <summary>Saved review inspection</summary>
      <p>
        This inspects the original stored review, without opening a current
        project. A current project may have changed, been archived or
        disappeared. Stored states, signatures and receipt presence are not
        fresh on-chain confirmation.
      </p>
      <p>
        No approval, signing, sending, restoration or receipt verification is
        available here. Expiry never makes an unresolved outcome safe to retry.
      </p>
      <pre className={styles.reference}>{referenceText(reference)}</pre>
      {reference.reviewKind === 'uncategorized' ? (
        <p>
          Inspection is unavailable for this unrecognized review kind. Keep the
          original reference. No alternative workflow was started.
        </p>
      ) : (
        <div className={styles.actions}>
          <Button
            variant="outline"
            disabled={busy}
            className="h-auto min-h-11 whitespace-normal"
            onClick={() => void read()}
          >
            {value ? 'Refresh saved inspection' : 'Inspect saved review'}
          </Button>
          {busy && (
            <Button
              variant="outline"
              className="h-auto min-h-11 whitespace-normal"
              onClick={() => {
                clear();
                setNotice(
                  'Inspection read cancelled. No saved record was changed.',
                );
              }}
            >
              Cancel inspection read
            </Button>
          )}
        </div>
      )}
      {busy && <output>Reading the original saved review…</output>}
      {notice && <output className={styles.notice}>{notice}</output>}
      {needsSignIn && (
        <a href="/sign-in" target="_blank" rel="noopener noreferrer">
          Sign in (opens a new tab)
        </a>
      )}
      {value && (
        <>
          <p>
            Stored record inspected:{' '}
            <time dateTime={value.inspectedAt}>{value.inspectedAt}</time>. This
            read does not observe the blockchain.
          </p>
          <dl className={styles.facts}>
            <dt>Original saved name</dt>
            <dd>{value.name}</dd>
            <dt>Original saved symbol</dt>
            <dd>{value.symbol}</dd>
            <dt>Recorded state</dt>
            <dd>
              {value.recordedState} (stored only; not fresh finality or
              execution proof)
            </dd>
            <dt>Payer</dt>
            <dd>
              <code>{value.payer}</code>
            </dd>
            <dt>Saved payer revision</dt>
            <dd>{value.payerRevision ?? 'Unavailable'}</dd>
            <dt>Original project version</dt>
            <dd>{value.projectUpdatedAt ?? 'Unavailable'}</dd>
            <dt>Quote mint</dt>
            <dd>
              {value.quoteMint ?? 'Unavailable. No quote currency is assumed.'}
            </dd>
            <dt>Saved packet count</dt>
            <dd>{value.packetCount}</dd>
            <dt>Stored receipt</dt>
            <dd>
              {value.receiptPresent
                ? 'Present, not verified here'
                : 'Absent; absence is not proof of no execution'}
            </dd>
          </dl>
          <details>
            <summary>Recorded wallet intents</summary>
            <p>
              {holderCount} holder wallet{holderCount === 1 ? '' : 's'} and{' '}
              {developerCount} developer wallet{developerCount === 1 ? '' : 's'}{' '}
              with saved intent labels. These describe stored requests, not
              executed buys or holdings.
            </p>
            <ul aria-label="Recorded wallet intents">
              {value.participants.map((participant) => (
                <li key={`${participant.role}/${participant.address}`}>
                  {participant.role}: <code>{participant.address}</code> ·{' '}
                  {intentLabel(participant.mode)}
                </li>
              ))}
            </ul>
          </details>
          <h4>Stored hashes</h4>
          {value.hashes.length ? (
            <ul>
              {value.hashes.map((hash) => (
                <li key={`${hash.kind}/${hash.index ?? 'none'}`}>
                  {hash.kind}
                  {hash.index !== null ? `, packet index ${hash.index}` : ''}:{' '}
                  <code>{hash.sha256}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p>No displayable stored hash was supplied.</p>
          )}
          <h4>Stored public signature</h4>
          <p>
            {value.signatureScope === 'first-group-packet'
              ? 'First group packet only. This is not a whole-group receipt or proof that all packets landed.'
              : 'Single transaction reference only; not verified here.'}
          </p>
          {value.signature ? (
            <>
              <pre className={styles.reference}>{value.signature}</pre>
              {publicSignature(value.signature) && (
                <a
                  href={`https://solscan.io/tx/${encodeURIComponent(value.signature)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerPolicy="no-referrer"
                >
                  Open stored signature on Solscan (mainnet)
                </a>
              )}
              <p>
                The explorer link leaves Bundle. Opening it does not verify this
                saved inspection.
              </p>
            </>
          ) : (
            <p>
              No public signature is stored in this record. This does not
              establish that nothing was signed or sent.
            </p>
          )}
          <h4>Original raw budgets and estimates</h4>
          <p>
            These are stored limits, targets or simulation estimates, not actual
            spending or current prices. Lamports, raw quote units and raw token
            units remain separate; unavailable values are never treated as zero.
          </p>
          {value.budgets.length ? (
            <>
              <ol
                start={start + 1}
                className={styles.budgets}
                aria-label="Saved review raw budgets"
              >
                {value.budgets
                  .slice(start, start + BUDGET_PAGE_SIZE)
                  .map((budget, index) => (
                    <li key={start + index}>
                      <strong>{labels[budget.kind] ?? budget.kind}</strong>
                      {budget.address && (
                        <>
                          <div>
                            Wallet: <code>{budget.address}</code>
                          </div>
                          <div>
                            Recorded{' '}
                            {budget.kind.startsWith('holder-')
                              ? 'holder'
                              : 'developer'}{' '}
                            intent:{' '}
                            {intentLabel(
                              value.participants.find(
                                (participant) =>
                                  participant.address === budget.address &&
                                  participant.role ===
                                    (budget.kind.startsWith('holder-')
                                      ? 'holder'
                                      : 'developer'),
                              )?.mode ?? 'unavailable',
                            )}
                          </div>
                        </>
                      )}
                      <div>
                        {budget.raw === null ? (
                          'Unavailable'
                        ) : (
                          <code>{budget.raw}</code>
                        )}{' '}
                        {budget.units === 'raw-quote'
                          ? 'raw quote units'
                          : budget.units === 'raw-token'
                            ? 'raw token units'
                            : 'lamports'}
                      </div>
                    </li>
                  ))}
              </ol>
              <nav className={styles.actions} aria-label="Saved budget pages">
                <Button
                  variant="outline"
                  className="h-auto min-h-11 whitespace-normal"
                  disabled={page === 0}
                  onClick={(event) => {
                    focusPageStatus.current =
                      page === 1 &&
                      document.activeElement === event.currentTarget;
                    setPage((current) => current - 1);
                  }}
                >
                  Previous budget rows
                </Button>
                <output
                  ref={pageStatus}
                  tabIndex={-1}
                  aria-live="polite"
                  aria-label="Saved budget page"
                  className={styles.pageStatus}
                >
                  Budget rows {start + 1} to{' '}
                  {Math.min(start + BUDGET_PAGE_SIZE, value.budgets.length)} of{' '}
                  {value.budgets.length}
                </output>
                <Button
                  variant="outline"
                  className="h-auto min-h-11 whitespace-normal"
                  disabled={start + BUDGET_PAGE_SIZE >= value.budgets.length}
                  onClick={(event) => {
                    focusPageStatus.current =
                      start + 2 * BUDGET_PAGE_SIZE >= value.budgets.length &&
                      document.activeElement === event.currentTarget;
                    setPage((current) => current + 1);
                  }}
                >
                  Next budget rows
                </Button>
              </nav>
            </>
          ) : (
            <p>No displayable raw budgets were supplied.</p>
          )}
        </>
      )}
    </details>
  );
}
