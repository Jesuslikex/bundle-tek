'use client';
import { createAuthClient } from 'better-auth/react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { SavedAutoSellProfile } from '@/lib/auto-sell-profile';
import { autoSellMaximumLabel, formatDuration } from '@/lib/auto-sell';
import {
  autoSellRunEnrollmentScope,
  loadAutoSellRunEnrollmentReminder,
  reviewAutoSellRunEnrollmentProfile,
  recordAutoSellRunEnrollment,
  recoverAutoSellRunEnrollment,
  type AutoSellRunEnrollmentReminder,
  type AutoSellRunEnrollmentResult,
} from '@/lib/auto-sell-run-enrollment-client';
import {
  loadAutoSellRunRecordStopCapability,
  stopAutoSellRunRecord,
  recoverAutoSellRunRecordStop,
  AutoSellRunRecordStopNotFoundError,
  type AutoSellRunRecordStopResult,
} from '@/lib/auto-sell-run-record-stop-client';
import { AutoSellStrategySummary } from './auto-sell-strategy-summary';
import { Button } from './ui/button';
import styles from './auto-sell-run-enrollment.module.css';

type Props = {
  project: ImportedTokenProject;
  profile: SavedAutoSellProfile | null;
  disabled: boolean;
};
type Review = {
  profile: SavedAutoSellProfile;
  mode: 'new' | 'retry';
  runId?: string;
};
const auth = createAuthClient();
export function AutoSellRunEnrollment(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className={styles.panel}
      onToggle={(event) => {
        if (event.target === event.currentTarget)
          setOpen(event.currentTarget.open);
      }}
    >
      <summary>Record a saved run journal</summary>
      <p>
        Record an exact saved configuration for recovery. This fixes its journal
        clocks now, but does not start trades or connect the current tab-only
        runner.
      </p>
      {open ? <EnrollmentIdentity {...props} /> : null}
    </details>
  );
}
function EnrollmentIdentity(props: Props) {
  const { data: session, isPending } = auth.useSession();
  const owner = session?.user.id ?? null;
  const context = JSON.stringify([
    owner,
    isPending,
    props.project.id,
    props.project.revision,
    props.project.archived,
    props.project.document.token,
    props.profile?.id,
    props.profile?.sha256,
    props.disabled,
  ]);
  return (
    <EnrollmentPanel
      key={context}
      {...props}
      owner={owner}
      checking={isPending}
    />
  );
}
function EnrollmentPanel({
  project,
  profile,
  disabled,
  owner,
  checking,
}: Props & { owner: string | null; checking: boolean }) {
  const [scope, setScope] = useState<string | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [reminder, setReminder] =
    useState<AutoSellRunEnrollmentReminder | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [approved, setApproved] = useState(false);
  const [stopApproved, setStopApproved] = useState(false);
  const [stopped, setStopped] = useState<AutoSellRunRecordStopResult | null>(
    null,
  );
  const [result, setResult] = useState<AutoSellRunEnrollmentResult | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    let alive = true;
    if (owner && !checking)
      void autoSellRunEnrollmentScope(owner)
        .then((value) => {
          if (!alive) return;
          setScope(value);
          try {
            setReminder(loadAutoSellRunEnrollmentReminder(value, project.id));
            setStorageReady(true);
          } catch {
            setError(
              'Browser recovery storage is unavailable or damaged. No new journal record can be sent. Use saved run history and keep any original record ID.',
            );
          }
        })
        .catch(() => {
          if (alive)
            setError(
              'The signed-in recovery scope could not be verified. No record was sent.',
            );
        });
    return () => {
      alive = false;
      active.current?.abort();
      active.current = null;
    };
  }, [owner, checking, project.id]);
  function refreshReminder() {
    if (!scope) return;
    try {
      setReminder(loadAutoSellRunEnrollmentReminder(scope, project.id));
      setStorageReady(true);
    } catch {
      setStorageReady(false);
      setError(
        'The original recovery reminder could not be read. No new record can be sent. Keep its original ID and inspect saved history.',
      );
    }
  }
  async function perform(
    work: (signal: AbortSignal, current: () => boolean) => Promise<void>,
  ) {
    if (!scope || !owner || checking) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(15_000),
    ]);
    const current = () => active.current === controller && !signal.aborted;
    setBusy(true);
    setApproved(false);
    setStopApproved(false);
    setError('');
    setNotice('');
    try {
      await work(signal, current);
    } catch (cause) {
      if (active.current === controller && !controller.signal.aborted) {
        setError(
          signal.aborted
            ? 'Waiting timed out. The server may have recorded the run. Check the original request before recording again.'
            : cause instanceof Error
              ? cause.message
              : 'The original journal record was not confirmed. Keep its original ID.',
        );
        refreshReminder();
      }
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
    setApproved(false);
    setStopApproved(false);
    setReview(null);
    setNotice(
      'Waiting stopped locally. An original record may still be saved; its reminder is retained. Check it before recording another.',
    );
    refreshReminder();
  }
  function begin(mode: 'new' | 'retry') {
    if (!scope) return;
    const source =
      mode === 'retry'
        ? reminder
        : profile
          ? { profileSaveId: profile.id, profileSha256: profile.sha256 }
          : null;
    if (!source) return;
    const runId = mode === 'retry' && reminder ? reminder.runId : undefined;
    setReview(null);
    setResult(null);
    setStopped(null);
    void perform(async (signal, current) => {
      const saved = await reviewAutoSellRunEnrollmentProfile(
        {
          ownerScope: scope,
          projectId: project.id,
          profileSaveId: source.profileSaveId,
          profileSha256: source.profileSha256,
          ...(runId ? { runId } : {}),
        },
        signal,
      );
      if (current())
        setReview({ profile: saved, mode, ...(runId ? { runId } : {}) });
    });
  }
  function record() {
    if (!scope || !review || !approved || writeBlocked) return;
    const captured = review;
    void perform(async (signal, current) => {
      await loadAutoSellRunRecordStopCapability(scope, signal);
      if (!current()) return;
      const confirmed = await recordAutoSellRunEnrollment(
        {
          ownerScope: scope,
          projectId: project.id,
          profileSaveId: captured.profile.id,
          profileSha256: captured.profile.sha256,
          profile: captured.profile,
          approved: true,
          mode: captured.mode,
          ...(captured.runId ? { runId: captured.runId } : {}),
        },
        signal,
      );
      if (current()) {
        setResult(confirmed);
        setReview(null);
        refreshReminder();
        setNotice(
          confirmed.reminderRetained
            ? 'Original run confirmed. Its local reminder could not be cleared; check the same record again before a new record.'
            : 'Original journal record confirmed. No trade, preparation or vault unlock was started.',
        );
      }
    });
  }
  function recover(reference: AutoSellRunEnrollmentReminder) {
    setReview(null);
    void perform(async (signal, current) => {
      try {
        const terminal = await recoverAutoSellRunRecordStop(reference, signal);
        if (current()) {
          setStopped(terminal);
          setResult(null);
          refreshReminder();
          setNotice(
            'The original recording request has a verified terminal receipt. Existing run records and held allowance are unchanged.',
          );
        }
        return;
      } catch (cause) {
        if (!(cause instanceof AutoSellRunRecordStopNotFoundError)) throw cause;
      }
      if (!current()) return;
      const confirmed = await recoverAutoSellRunEnrollment(reference, signal);
      if (current()) {
        setStopped(null);
        setResult(confirmed);
        refreshReminder();
        setNotice(
          confirmed.reminderRetained
            ? 'Original record found; its reminder is still retained. No new record was sent.'
            : 'Original record verified from saved history. No new record was sent.',
        );
      }
    });
  }
  function stopRecord() {
    if (!reminder || !stopApproved || readBlocked) return;
    const original = reminder;
    setReview(null);
    void perform(async (signal, current) => {
      const terminal = await stopAutoSellRunRecord(
        { reminder: original, approved: true },
        signal,
      );
      if (current()) {
        setStopped(terminal);
        setResult(null);
        refreshReminder();
        setNotice(
          terminal.reminderRetained
            ? 'Original request stopped on the server. Its local reminder is retained; check the same original request to finish recovery.'
            : 'Original request stopped on the server. No run was deleted, resumed or traded.',
        );
      }
    });
  }
  const readBlocked = busy || checking || !scope || !owner;
  const writeBlocked =
    readBlocked || disabled || project.archived || !storageReady;
  const selectedMatches =
    profile &&
    profile.terms.projectId === project.id &&
    profile.terms.projectRevision === project.revision &&
    profile.terms.token.mint === project.document.token.address &&
    profile.terms.token.decimals === project.document.token.decimals &&
    profile.terms.token.totalSupplyRaw ===
      project.document.token.totalSupplyRaw;
  return (
    <div>
      {checking ? (
        <output>Checking sign-in…</output>
      ) : !owner ? (
        <p>
          <Link href="/sign-in">Sign in</Link> before inspecting or recording a
          run.
        </p>
      ) : null}
      {!profile ? (
        <p>
          Open a saved configuration version above to review a new journal
          record. Original-request recovery remains available below.
        </p>
      ) : !selectedMatches ? (
        <p>
          The selected version differs from this current project. Save and
          review a current configuration before recording a new journal.
        </p>
      ) : null}
      {disabled || project.archived ? (
        <p>
          New recording and retries are unavailable while the project is
          archived or other configuration/session work is active. Original saved
          records can still be checked.
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button
          type="button"
          variant="outline"
          disabled={writeBlocked || !!reminder || !selectedMatches}
          onClick={() => begin('new')}
        >
          Review saved configuration for journal
        </Button>
        {busy ? (
          <Button type="button" variant="outline" onClick={cancel}>
            Stop waiting
          </Button>
        ) : null}
      </div>
      {busy ? (
        <output>Checking or recording the original journal request…</output>
      ) : null}
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {notice ? <output>{notice}</output> : null}
      {reminder ? (
        <section
          className={styles.section}
          aria-label="Original journal request recovery"
        >
          <h4>Check the original request</h4>
          <p>
            The server may already have recorded this run. A missing response or
            404 does not permit a new ID. Nothing is retried automatically.
          </p>
          <dl>
            <dt>Original run ID</dt>
            <dd>{reminder.runId}</dd>
            <dt>Saved version ID</dt>
            <dd>{reminder.profileSaveId}</dd>
          </dl>
          <div className={styles.actions}>
            <Button
              type="button"
              variant="outline"
              disabled={readBlocked}
              onClick={() => recover(reminder)}
            >
              Check original journal record
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={writeBlocked}
              onClick={() => begin('retry')}
            >
              Review original request for retry
            </Button>
          </div>
          <p>
            Stop this recording request if it cannot be recovered or retried. If
            it already created a run, that run and its allowance remain
            unchanged. Otherwise the server prevents a delayed request from
            creating it.
          </p>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={stopApproved}
              disabled={readBlocked}
              onChange={(event) => setStopApproved(event.target.checked)}
            />
            I approve stopping only this original journal-recording request.
            Existing runs and held allowance stay unchanged.
          </label>
          <Button
            type="button"
            variant="outline"
            disabled={readBlocked || !stopApproved}
            onClick={stopRecord}
          >
            Stop original recording request
          </Button>
        </section>
      ) : null}
      {stopped ? (
        <section
          className={styles.section}
          aria-label="Stopped original recording request"
        >
          <h4>Original recording request stopped</h4>
          <p>
            {stopped.stop.status === 'record-found'
              ? 'The original run already exists and is preserved. This did not stop that run or release its allowance.'
              : 'No original run existed when the stop was recorded. A delayed creation request for this ID is now refused.'}
          </p>
          <dl>
            <dt>Original run ID</dt>
            <dd>{stopped.stop.runId}</dd>
            <dt>Stop receipt time</dt>
            <dd>{stopped.stop.createdAt}</dd>
            <dt>Request hash</dt>
            <dd>{stopped.stop.requestSha256}</dd>
          </dl>
          {stopped.reminderRetained ? (
            <p>
              The original local reminder remains. Check the original request
              again before recording another journal.
            </p>
          ) : null}
          <Button
            type="button"
            variant="outline"
            disabled={readBlocked}
            onClick={() => recover(stopped.reminder)}
          >
            Inspect original stop receipt
          </Button>
        </section>
      ) : null}
      {review ? (
        <section
          className={styles.section}
          aria-label="Exact journal recording review"
        >
          <h4>
            {review.mode === 'retry'
              ? 'Retry the same original record'
              : 'Review a new journal record'}
          </h4>
          <p>
            {review.profile.terms.name} · version {review.profile.version}. This
            is the original saved version, not the current unsaved form.
          </p>
          <dl>
            <dt>Saved project revision</dt>
            <dd>{review.profile.terms.projectRevision}</dd>
            <dt>Selected wallets</dt>
            <dd>{review.profile.terms.wallets.length}</dd>
            <dt>Start delay</dt>
            <dd>
              {formatDuration(
                review.profile.terms.configuration.session.startDelaySeconds,
              )}
            </dd>
            <dt>Session duration</dt>
            <dd>
              {review.profile.terms.configuration.session.endDurationSeconds
                ? formatDuration(
                    review.profile.terms.configuration.session
                      .endDurationSeconds,
                  )
                : 'No duration end set'}
            </dd>
            <dt>Session maximum</dt>
            <dd>
              {autoSellMaximumLabel(review.profile.terms.configuration.session)}
            </dd>
            <dt>Configuration hash</dt>
            <dd>{review.profile.sha256}</dd>
          </dl>
          {review.profile.terms.configuration.strategies.map((strategy) => (
            <article key={strategy.id}>
              <h5>{strategy.name}</h5>
              <AutoSellStrategySummary strategy={strategy} />
            </article>
          ))}
          <p>
            Recording fixes the server start and expiry clocks for this
            immutable record now. All owned workspace wallets are captured as
            exclusions. It does not approve trading, resume a session or change
            the counters in this tab.
          </p>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={approved}
              disabled={writeBlocked}
              onChange={(event) => setApproved(event.target.checked)}
            />
            I approve recording this exact saved version as a journal record. No
            trading is started.
          </label>
          <Button
            type="button"
            disabled={writeBlocked || !approved}
            onClick={record}
          >
            {review.mode === 'retry'
              ? 'Retry original journal record'
              : 'Record journal only'}
          </Button>
        </section>
      ) : null}
      {result ? (
        <section
          className={styles.section}
          aria-label="Confirmed original journal basis"
        >
          <h4>Original journal record confirmed</h4>
          <p>
            No progress counters are restored and no trading starts. Use Saved
            run recovery to inspect attempts for this run; this view verifies
            its original basis only.
          </p>
          <dl>
            <dt>Run ID</dt>
            <dd>{result.run.id}</dd>
            <dt>Original record time</dt>
            <dd>
              <time dateTime={result.run.createdAt}>
                {result.run.createdAt}
              </time>
            </dd>
            <dt>Original active time</dt>
            <dd>{result.run.activeAt}</dd>
            <dt>Original end time</dt>
            <dd>{result.run.endsAt ?? 'No session duration end set'}</dd>
            <dt>Recorded version</dt>
            <dd>
              {result.run.profile.terms.name} · {result.run.profile.version}
            </dd>
            <dt>Owned-wallet exclusions captured</dt>
            <dd>{result.run.ownWallets.length}</dd>
            <dt>Run hash</dt>
            <dd>{result.run.sha256}</dd>
          </dl>
          <Button
            type="button"
            variant="outline"
            disabled={readBlocked}
            onClick={() => recover(result.reminder)}
          >
            Inspect original journal record
          </Button>
        </section>
      ) : null}
    </div>
  );
}
