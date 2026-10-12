'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSessionJobStatus } from './use-session-job-status';
import {
  decodeSessionJobStatus,
  requireCurrentJobStatus,
} from '@/lib/session-job-status';
import { Button } from './ui/button';
import { SessionJobTimeline } from './session-job-timeline';
import {
  decodeSessionJobs,
  type SessionPreparationJob,
} from '@/lib/session-preparation-jobs';
import type { TradeSession } from '@/lib/imported-trade-session';
export function SessionPreparationJobs({
  session,
  disabled,
  onReview,
}: {
  session: TradeSession;
  disabled: boolean;
  onReview: (job: SessionPreparationJob) => void;
}) {
  const [historyRevision, setHistoryRevision] = useState(0);
  const [open, setOpen] = useState(false),
    [jobs, setJobs] = useState<SessionPreparationJob[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null),
    retry = useRef<{ entry: number; id: string } | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const acceptSnapshot = useCallback(
    (value: unknown) => {
      const rows = decodeSessionJobStatus(value, session);
      requireCurrentJobStatus(rows, jobs);
      if (JSON.stringify(rows) !== JSON.stringify(jobs)) {
        setJobs(rows);
        setHistoryRevision((v) => v + 1);
      }
    },
    [session, jobs],
  );
  const live = useSessionJobStatus(
    session.terms.projectId,
    session.id,
    busy || !open,
    acceptSnapshot,
  );
  async function request(body?: unknown) {
    pending.current?.abort();
    const c = new AbortController();
    pending.current = c;
    const response = await fetch(
      '/api/imported-projects/session-preparation-jobs' +
        (body
          ? ''
          : `?${new URLSearchParams({ projectId: session.terms.projectId, sessionId: session.id })}`),
      {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        signal: AbortSignal.any([c.signal, AbortSignal.timeout(40000)]),
      },
    );
    const value = (await response.json()) as {
      error?: string;
      jobs: unknown;
      job: SessionPreparationJob;
      executionAllowed: boolean;
      projectId: string;
      sessionId: string;
      processed: number;
    };
    if (!response.ok)
      throw new Error(value.error || 'Preparation jobs unavailable.');
    c.signal.throwIfAborted();
    return value;
  }
  async function reload() {
    const value = await request();
    acceptSnapshot(value);
    setHistoryRevision((v) => v + 1);
  }
  async function action(entry?: number) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (entry !== undefined) {
        if (disabled) return;
        if (retry.current?.entry !== entry)
          retry.current = { entry, id: crypto.randomUUID() };
        const value = await request({
          action: 'queue',
          id: retry.current.id,
          projectId: session.terms.projectId,
          sessionId: session.id,
          entry,
        });
        const [job] = decodeSessionJobs(
          [value.job],
          session.terms.projectId,
          session.id,
        );
        if (
          job.id !== retry.current.id ||
          job.entry !== entry ||
          value.executionAllowed !== false
        )
          throw new Error('Queued job differs. Reload before retrying.');
        retry.current = null;
      } else if (disabled) return;
      else {
        const value = await request({
          action: 'runDue',
          projectId: session.terms.projectId,
          sessionId: session.id,
        });
        if (
          value.executionAllowed !== false ||
          !Number.isInteger(value.processed) ||
          value.processed < 0 ||
          value.processed > 1
        )
          throw new Error('Preparation result differs.');
      }
      await reload();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Job update unavailable. Reload before retrying.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function read() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Jobs unavailable.');
    } finally {
      setBusy(false);
    }
  }
  async function cancel(j: SessionPreparationJob) {
    if (busy || !['queued', 'running'].includes(j.state)) return;
    setBusy(true);
    setError('');
    try {
      const value = await request({
        action: 'cancel',
        id: j.id,
        projectId: session.terms.projectId,
        sessionId: session.id,
      });
      const [job] = decodeSessionJobs(
        [value.job],
        session.terms.projectId,
        session.id,
      );
      if (
        value.executionAllowed !== false ||
        job.id !== j.id ||
        job.entry !== j.entry ||
        job.state !== 'cancelled'
      )
        throw new Error('Cancellation response differs. Reload jobs.');
      await reload();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Cancellation unavailable. Reload before retrying.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="Scheduled unsigned preparation jobs"
      className="min-w-0 space-y-2 break-words"
    >
      <Button
        variant="outline"
        className="h-auto max-w-full whitespace-normal break-words py-2"
        disabled={busy}
        onClick={() => {
          if (open) live.stop();
          setOpen((v) => !v);
          if (!open) void read();
        }}
      >
        {' '}
        {open ? 'Hide' : 'View'} unsigned preparation jobs
      </Button>
      {open && (
        <>
          <p>
            Queue exact saved entries for unsigned preparation after their
            scheduled start. Processing reads balances, requests a quote and
            simulates the packet. Each wallet still requires your signature and
            separate submission. A queued job does not confirm background
            processing is active. You can prepare the next due job here.
          </p>
          <Button
            variant="outline"
            className="h-auto max-w-full whitespace-normal break-words py-2"
            disabled={busy}
            onClick={() =>
              live.state.status === 'off' ? live.start() : live.stop()
            }
          >
            {live.state.status === 'off'
              ? 'Start live preparation status'
              : 'Stop live preparation status'}
          </Button>
          <output className="block">
            Live preparation status: {live.state.status}. {live.state.reads}{' '}
            successful refreshes.
            {live.readAt
              ? ` Last read ${new Date(live.readAt).toLocaleString()}.`
              : ''}
            {live.state.reason ? ` ${live.state.reason}` : ''}
          </output>
          <p>
            Reads saved job state every five seconds while visible and online.
            Failed reads back off up to thirty seconds. Closing this panel stops
            refreshes. This does not prepare, sign or submit trades.
          </p>
          {live.error && <p role="alert">{live.error}</p>}
          <Button
            variant="outline"
            className="h-auto max-w-full whitespace-normal break-words py-2"
            disabled={busy}
            onClick={() => void read()}
          >
            Reload preparation jobs
          </Button>
          <Button
            variant="outline"
            className="h-auto max-w-full whitespace-normal break-words py-2"
            disabled={
              busy || disabled || !jobs.some((j) => j.state === 'queued')
            }
            onClick={() => void action()}
          >
            Prepare next due job
          </Button>
          {session.terms.entries.map((e) => (
            <div key={e.entry}>
              <Button
                variant="outline"
                className="h-auto max-w-full whitespace-normal break-words py-2"
                disabled={
                  busy ||
                  disabled ||
                  jobs.some(
                    (j) =>
                      j.entry === e.entry &&
                      ['queued', 'running'].includes(j.state),
                  )
                }
                onClick={() => void action(e.entry)}
              >
                Queue unsigned preparation for entry {e.entry}
              </Button>
            </div>
          ))}
          {jobs.map((j) => (
            <article key={j.id} className="rounded-md border p-2">
              <p>
                Entry {j.entry}: {j.state}. Attempts {j.attempts}/3. Due{' '}
                {j.notBefore}. Next attempt {j.nextAttemptAt}.
              </p>
              {j.lastError && <p>Preparation status: {j.lastError}.</p>}
              {['queued', 'running'].includes(j.state) && (
                <>
                  <Button
                    variant="outline"
                    className="h-auto max-w-full whitespace-normal break-words py-2"
                    disabled={busy}
                    onClick={() => void cancel(j)}
                  >
                    Cancel preparation job for entry {j.entry}
                  </Button>
                  <p>
                    Cancellation prevents this job from retaining a prepared
                    result. An already started unsigned provider read may
                    finish.
                  </p>
                </>
              )}
              {j.preparationId && (
                <>
                  <p>
                    Unsigned preparation {j.preparationId}. Short-lived packets
                    must still pass fresh approval checks. Expired packets
                    require a new job.
                  </p>
                  <Button
                    variant="outline"
                    className="h-auto max-w-full whitespace-normal break-words py-2"
                    disabled={busy || disabled}
                    onClick={() => onReview(j)}
                  >
                    Review prepared entry {j.entry}
                  </Button>
                </>
              )}
            </article>
          ))}
          <SessionJobTimeline
            projectId={session.terms.projectId}
            sessionId={session.id}
            revision={historyRevision}
          />
          {error && <p role="alert">{error}</p>}
          {busy && <output>Reading or preparing the saved job…</output>}
        </>
      )}
    </section>
  );
}
