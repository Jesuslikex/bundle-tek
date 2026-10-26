'use client';
import { useEffect, useRef, useState } from 'react';
import { autoSellRunEnrollmentScope } from '@/lib/auto-sell-run-enrollment-client';
import { loadAutoSellRunProgress } from '@/lib/auto-sell-run-progress-client';
import type {
  AutoSellRunProgress as Progress,
  AutoSellRunProgressLifecycle,
} from '@/lib/auto-sell-run-progress';
import { rawToDecimal } from '@/lib/auto-sell';
import { Button } from './ui/button';
import styles from './auto-sell-run-progress.module.css';

type Run = {
  id: string;
  runSha256: string;
  attemptCount: number;
  accountedRaw: string;
  stopped: boolean;
};
type Props = {
  owner: string;
  projectId: string;
  run: Run;
  disabled: boolean;
  startedAttemptIds?: string[];
  minimumHead?: { sequence: number; sha256: string };
  onObserved: (progress: Progress) => void;
};
const lifecycle: Record<AutoSellRunProgressLifecycle, string> = {
  scheduled: 'Original start not reached',
  open: 'Journal open at observation',
  expired: 'Original duration ended',
  stopped: 'Journal stopped',
  'allowance-exhausted': 'Recorded allowance exhausted',
};
const units = (raw: string, decimals: number) =>
  rawToDecimal(BigInt(raw), decimals);
function remaining(cap: string | null, used: string, decimals: number) {
  return cap === null
    ? 'No recorded amount cap'
    : units((BigInt(cap) - BigInt(used)).toString(), decimals) + ' tokens';
}
export function AutoSellRunProgressPanel(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className={styles.panel}
      onToggle={(event) => {
        if (event.target === event.currentTarget)
          setOpen(event.currentTarget.open);
      }}
    >
      <summary>Original progress and remaining allowance</summary>
      <p>
        Replay the complete saved journal. Reserved amounts stay charged; they
        are not evidence of tokens sold. This view never starts or resumes a
        session.
      </p>
      {open ? <ProgressPanel {...props} /> : null}
    </details>
  );
}
function ProgressPanel({
  owner,
  projectId,
  run,
  disabled,
  onObserved,
  startedAttemptIds,
  minimumHead,
}: Props) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const active = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      active.current?.abort();
      active.current = null;
    },
    [],
  );
  useEffect(() => {
    if (disabled) {
      active.current?.abort();
    }
  }, [disabled]);
  async function load() {
    if (disabled || busy) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(15000),
      ]),
      current = () => active.current === controller && !signal.aborted;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const scope = await autoSellRunEnrollmentScope(owner);
      if (!current()) return;
      const value = await loadAutoSellRunProgress(
        {
          ownerScope: scope,
          projectId,
          runId: run.id,
          runSha256: run.runSha256,
          minimum: {
            sequence: run.attemptCount,
            accountedRaw: run.accountedRaw,
            stopped: run.stopped,
            ...(startedAttemptIds ? { startedAttemptIds } : {}),
            ...(minimumHead
              ? {
                  headSequence: minimumHead.sequence,
                  headSha256: minimumHead.sha256,
                }
              : {}),
          },
          ...(progress ? { previousEvidence: progress.evidence } : {}),
        },
        signal,
      );
      if (current()) {
        onObserved(value);
        setProgress(value);
      }
    } catch (cause) {
      if (active.current === controller && !controller.signal.aborted)
        setError(
          signal.aborted
            ? 'Saved progress checking timed out. Previous evidence is retained; no session was resumed.'
            : cause instanceof Error
              ? cause.message
              : 'Saved progress could not be verified. No allowance was restored.',
        );
    } finally {
      if (active.current === controller) {
        active.current = null;
        setBusy(false);
      }
    }
  }
  function cancel() {
    active.current?.abort();
    active.current = null;
    setBusy(false);
    setNotice(
      'Waiting stopped. Previous saved evidence is retained. No session was resumed.',
    );
  }
  const decimals = progress?.run.profile.terms.token.decimals ?? 0;
  return (
    <div>
      <div className={styles.actions}>
        <Button
          type="button"
          variant="outline"
          disabled={disabled || busy}
          onClick={() => void load()}
        >
          {progress
            ? 'Refresh complete saved progress'
            : 'Load complete saved progress'}
        </Button>
        {busy ? (
          <Button type="button" variant="outline" onClick={cancel}>
            Stop progress check
          </Button>
        ) : null}
      </div>
      {busy ? <output>Replaying complete original history…</output> : null}
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {notice ? <output>{notice}</output> : null}
      {progress ? (
        <section aria-label="Verified original run progress">
          <h4>{lifecycle[progress.lifecycle]}</h4>
          <p>
            Snapshot observed by the server at{' '}
            <time dateTime={progress.evidence.observedAt}>
              {progress.evidence.observedAt}
            </time>
            . This is saved evidence, not a current permission to trade.
          </p>
          <p>
            Remaining figures are accounting only. A stopped, expired or
            not-yet-active journal cannot use them; an open journal still
            requires separately qualified execution and fresh approval.
          </p>
          <p>
            Start and Stop request timestamps were sampled before their writes.
            They do not prove the commit order of concurrent requests.
          </p>
          <dl>
            <dt>Original start</dt>
            <dd>{progress.run.activeAt}</dd>
            <dt>Original end</dt>
            <dd>{progress.run.endsAt ?? 'No duration end set'}</dd>
            <dt>Charged reservations</dt>
            <dd>
              {units(progress.accounting.accountedRaw, decimals)} tokens across{' '}
              {progress.accounting.sequence} attempts
            </dd>
            <dt>Remaining recorded session allowance</dt>
            <dd>
              {remaining(
                progress.run.limits.sessionRaw,
                progress.accounting.accountedRaw,
                decimals,
              )}
            </dd>
            <dt>Finalized sales</dt>
            <dd>
              Unavailable from this journal; no sales or profit are inferred
            </dd>
          </dl>
          {progress.strategies.map((strategy) => {
            const original =
              progress.run.profile.terms.configuration.strategies.find(
                (s) => s.id === strategy.id,
              )!;
            return (
              <article key={strategy.id} className={styles.strategy}>
                <h5>
                  {original.name} ·{' '}
                  {original.mode === 'dca'
                    ? 'DCA'
                    : original.mode === 'limit'
                      ? 'Limit Orders'
                      : 'Counter'}
                </h5>
                <p>{lifecycle[strategy.lifecycle]}</p>
                <dl>
                  <dt>Charged reservations</dt>
                  <dd>{units(strategy.chargedRaw, decimals)} tokens</dd>
                  <dt>Remaining recorded allowance</dt>
                  <dd>
                    {strategy.remainingRaw === null
                      ? 'No recorded amount cap'
                      : units(strategy.remainingRaw, decimals) + ' tokens'}
                  </dd>
                  <dt>Original strategy end</dt>
                  <dd>{strategy.endsAt ?? 'No duration end set'}</dd>
                  <dt>Consumed trigger keys</dt>
                  <dd>
                    {strategy.consumedKeys.length}; these are not rearmed by
                    reload
                  </dd>
                </dl>
                {original.mode === 'dca' ? (
                  <p>
                    Next recorded DCA occurrence: {strategy.nextDcaIndex}.
                    Earliest recorded time:{' '}
                    {strategy.nextDcaAt ?? 'None recorded'}. No catch-up, new
                    random draw or queued sale is inferred.
                  </p>
                ) : null}
                {strategy.consumedKeys.length ? (
                  <details>
                    <summary>Inspect consumed trigger references</summary>
                    <p>
                      Showing {Math.min(20, strategy.consumedKeys.length)} of{' '}
                      {strategy.consumedKeys.length} verified keys.
                    </p>
                    <ul>
                      {strategy.consumedKeys.slice(0, 20).map((key) => (
                        <li key={key}>{key}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </article>
            );
          })}
          <p>
            {progress.unresolvedAttempts.length} reserved attempts have no
            finalized settlement established by this journal. Started
            preparation and retained unsigned bytes are not proof of a sale or
            permission to retry.
          </p>
          {progress.unresolvedAttempts.length ? (
            <details>
              <summary>Inspect unresolved original references</summary>
              <p>
                Showing {Math.min(20, progress.unresolvedAttempts.length)} of{' '}
                {progress.unresolvedAttempts.length}; use the existing attempt
                pages for other references.
              </p>
              <ul>
                {progress.unresolvedAttempts.slice(0, 20).map((attempt) => (
                  <li key={attempt.id}>
                    Attempt #{attempt.sequence}: {attempt.id} ·{' '}
                    {attempt.preparationStarted
                      ? 'Preparation start recorded; outcome still unresolved'
                      : 'No preparation start in this snapshot'}{' '}
                    · {units(attempt.inputRaw, decimals)} tokens charged
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <p>
            Historical unsaved queues, skipped triggers and unreserved random
            decisions were not recorded and cannot be reconstructed. Fresh
            resume consent, qualified decisions/runtime evidence and settlement
            are still required. Signing, execution, automatic resume and
            allowance release remain disabled.
          </p>
        </section>
      ) : null}
    </div>
  );
}
