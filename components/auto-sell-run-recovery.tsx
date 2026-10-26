'use client';
import { createAuthClient } from 'better-auth/react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import { rawToDecimal } from '@/lib/auto-sell';
import {
  loadAutoSellRunIndex,
  loadAutoSellRunAttempts,
  loadAutoSellRunPacketRecovery,
} from '@/lib/auto-sell-run-recovery-client';
import { Button } from './ui/button';
import { AutoSellRunProgressPanel } from './auto-sell-run-progress';
import styles from './auto-sell-run-recovery.module.css';

const auth = createAuthClient();
type Index = Awaited<ReturnType<typeof loadAutoSellRunIndex>>;
type Run = Index['runs'][number];
type Attempts = Awaited<ReturnType<typeof loadAutoSellRunAttempts>>;
type Attempt = Attempts['attempts'][number];
type Recovery = Awaited<ReturnType<typeof loadAutoSellRunPacketRecovery>>;
const date = (value: string) =>
  new Date(value)
    .toISOString()
    .replace('T', ' ')
    .replace('.000Z', ' UTC')
    .replace('Z', ' UTC');
const short = (value: string) => `${value.slice(0, 8)}…${value.slice(-4)}`;
const units = (value: string, decimals: number) =>
  rawToDecimal(BigInt(value), decimals);
const label = {
  retained: 'Original unsigned preparation retained',
  'summary-only': 'Summary only: packet not retained',
  'started-without-result': 'Preparation outcome unknown',
  'not-started': 'Preparation not started',
} as const;

export function AutoSellRunRecovery({
  project,
}: {
  project: ImportedTokenProject;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className={styles.panel}
      onToggle={(event) => {
        if (event.target === event.currentTarget)
          setOpen(event.currentTarget.open);
      }}
    >
      <summary>Saved run recovery</summary>
      <p>
        Inspect recorded Auto Sell attempts without signing, resending or
        resuming. Current tab-only runs are not recorded in this journal yet.
      </p>
      {open ? <AuthenticatedRecovery project={project} /> : null}
    </details>
  );
}

function AuthenticatedRecovery({ project }: { project: ImportedTokenProject }) {
  const { data: session, isPending } = auth.useSession();
  const owner = session?.user.id ?? null;
  // Remount before another account/project can see the previous account's
  // in-memory evidence. No reminders, packet bytes or credentials are cached.
  const context = JSON.stringify([
    owner,
    isPending,
    project.id,
    project.revision,
    project.archived,
    project.document.token,
  ]);
  return (
    <RecoveryPanel
      key={context}
      projectId={project.id}
      owner={owner}
      checking={isPending}
    />
  );
}

function RecoveryPanel({
  projectId,
  owner,
  checking,
}: {
  projectId: string;
  owner: string | null;
  checking: boolean;
}) {
  const [index, setIndex] = useState<Index | null>(null);
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const [page, setPage] = useState<Attempts | null>(null);
  const [selectedAttempt, setSelectedAttempt] = useState<Attempt | null>(null);
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pending = useRef<AbortController | null>(null);
  const observedRuns = useRef(new Map<string, Run>());
  const observedStarts = useRef(new Map<string, Set<string>>());
  const [startedFloor, setStartedFloor] = useState(new Map<string, string[]>());
  const runHeading = useRef<HTMLHeadingElement | null>(null);
  const preparationHeading = useRef<HTMLHeadingElement | null>(null);
  useEffect(
    () => () => {
      pending.current?.abort();
      pending.current = null;
    },
    [],
  );
  useEffect(() => {
    if (selectedAttempt) preparationHeading.current?.focus();
    else if (selectedRun) runHeading.current?.focus();
  }, [selectedRun, selectedAttempt]);

  async function read(
    work: (signal: AbortSignal, current: () => boolean) => Promise<void>,
  ) {
    if (!owner || checking) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(15_000),
    ]);
    const current = () => pending.current === controller && !signal.aborted;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work(signal, current);
    } catch (cause) {
      if (pending.current === controller && !controller.signal.aborted)
        setError(
          signal.aborted
            ? 'The saved read timed out. No allowance was released. Load the same history again.'
            : cause instanceof Error
              ? cause.message
              : 'Saved recovery evidence is unavailable. No allowance was released.',
        );
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  function cancel() {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setError('');
    setNotice(
      'Reading stopped. Saved records and charged allowance are unchanged.',
    );
  }
  function loadRuns(before?: Index['nextCursor']) {
    setSelectedRun(null);
    setPage(null);
    setSelectedAttempt(null);
    setRecovery(null);
    void read(async (signal, current) => {
      const value = await loadAutoSellRunIndex(
        { projectId, ...(before ? { before } : {}) },
        signal,
      );
      if (current()) {
        // Validate the complete page before replacing any observed floor.
        if (
          observedRuns.current.size +
            value.runs.filter((run) => !observedRuns.current.has(run.id))
              .length >
          100
        )
          throw Error(
            'This saved run view exceeds its complete 100-run capacity. No previous observation was discarded.',
          );
        for (const run of value.runs) checkObservedRun(run);
        for (const run of value.runs) observedRuns.current.set(run.id, run);
        setIndex(value);
      }
    });
  }
  function checkObservedRun(run: Run) {
    const previous = observedRuns.current.get(run.id);
    if (
      (!previous && observedRuns.current.size >= 100) ||
      (previous &&
        (previous.runSha256 !== run.runSha256 ||
          previous.profileSha256 !== run.profileSha256 ||
          previous.profileSaveId !== run.profileSaveId ||
          previous.createdAt !== run.createdAt ||
          run.attemptCount < previous.attemptCount ||
          BigInt(run.accountedRaw) < BigInt(previous.accountedRaw) ||
          (previous.stopped && !run.stopped)))
    )
      throw Error(
        'Saved run history moved backwards or differs from an earlier verified read. The previous allowance and Stop observation are retained.',
      );
  }
  function rememberStarted(runId: string, ids: string[]) {
    const known = observedStarts.current.get(runId) ?? new Set<string>();
    const merged = new Set([...known, ...ids]);
    if (
      merged.size > 1000 ||
      (!observedStarts.current.has(runId) && observedStarts.current.size >= 100)
    )
      throw Error(
        'Saved preparation observations exceed this complete view. No earlier start was discarded.',
      );
    observedStarts.current.set(runId, merged);
    setStartedFloor((previous) => new Map(previous).set(runId, [...merged]));
  }
  function inspectRun(run: Run, beforeSequence?: number) {
    const observed = observedRuns.current.get(run.id) ?? run;
    const minimumAccounting = {
      sequence: observed.attemptCount,
      accountedRaw: observed.accountedRaw,
      stopped: observed.stopped,
    };
    setSelectedRun(run);
    setPage(null);
    setSelectedAttempt(null);
    setRecovery(null);
    void read(async (signal, current) => {
      const value = await loadAutoSellRunAttempts(
        {
          projectId,
          runId: run.id,
          runSha256: run.runSha256,
          minimumAccounting,
          ...(beforeSequence ? { beforeSequence } : {}),
        },
        signal,
      );
      if (current()) {
        if (
          value.attempts.some(
            (attempt) =>
              observedStarts.current.get(run.id)?.has(attempt.id) &&
              !attempt.preparationStarted,
          )
        )
          throw Error(
            'Saved preparation history moved backwards. Earlier start observations are retained.',
          );
        const updated = {
          ...run,
          attemptCount: value.accounting.sequence,
          accountedRaw: value.accounting.accountedRaw,
          stopped: value.stopped,
        };
        checkObservedRun(updated);
        rememberStarted(
          run.id,
          value.attempts
            .filter((attempt) => attempt.preparationStarted)
            .map((attempt) => attempt.id),
        );
        observedRuns.current.set(run.id, updated);
        setPage(value);
        const update = (r: Run) =>
          r.id === run.id
            ? {
                ...r,
                attemptCount: value.accounting.sequence,
                accountedRaw: value.accounting.accountedRaw,
                stopped: value.stopped,
              }
            : r;
        setSelectedRun((previous) => (previous ? update(previous) : previous));
        setIndex((previous) =>
          previous
            ? { ...previous, runs: previous.runs.map(update) }
            : previous,
        );
      }
    });
  }
  function inspectAttempt(attempt: Attempt) {
    if (!page) return;
    const captured = page;
    setSelectedAttempt(attempt);
    setRecovery(null);
    void read(async (signal, current) => {
      const value = await loadAutoSellRunPacketRecovery(
        {
          runId: captured.runId,
          runSha256: captured.runSha256,
          context: captured.context,
          attempt,
        },
        signal,
      );
      if (current()) {
        if (
          value.status === 'not-started' &&
          observedStarts.current.get(captured.runId)?.has(attempt.id)
        )
          throw Error(
            'Saved preparation history moved backwards. Earlier start observations are retained.',
          );
        setRecovery(value);
        if (value.status !== 'not-started') {
          rememberStarted(captured.runId, [attempt.id]);
          const update = (row: Attempt) =>
            row.id === attempt.id ? { ...row, preparationStarted: true } : row;
          setSelectedAttempt((previous) =>
            previous ? update(previous) : previous,
          );
          setPage((previous) =>
            previous
              ? { ...previous, attempts: previous.attempts.map(update) }
              : previous,
          );
        }
      }
    });
  }
  const unavailable = busy || checking || !owner;
  return (
    <div>
      {checking ? (
        <output>Checking sign-in…</output>
      ) : !owner ? (
        <p>
          <Link href="/sign-in">Sign in</Link> to inspect your saved runs.
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button
          type="button"
          variant="outline"
          disabled={unavailable}
          onClick={() => loadRuns()}
        >
          Load saved runs
        </Button>
        {busy ? (
          <Button type="button" variant="outline" onClick={cancel}>
            Stop waiting
          </Button>
        ) : null}
      </div>
      {busy ? <output>Reading saved evidence…</output> : null}
      {notice ? <output>{notice}</output> : null}
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {index && !selectedRun ? (
        <section aria-label="Recorded Auto Sell runs">
          {!index.runs.length ? (
            <p>
              No journal runs were found on this page. This does not erase or
              settle a tab-only run.
            </p>
          ) : (
            <ul className={styles.list}>
              {index.runs.map((run) => (
                <li key={run.id}>
                  <strong>Recorded {date(run.createdAt)}</strong>
                  <p>
                    {run.attemptCount} reserved attempt
                    {run.attemptCount === 1 ? '' : 's'} ·{' '}
                    {run.stopped ? 'Journal stopped' : 'Journal open'}
                  </p>
                  <p className={styles.wrap}>
                    {run.accountedRaw} raw token units remain charged.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={unavailable}
                    onClick={() => inspectRun(run)}
                    aria-label={`Inspect run ${run.id}`}
                  >
                    Inspect run {short(run.id)}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {index.nextCursor ? (
            <Button
              type="button"
              variant="outline"
              disabled={unavailable}
              onClick={() => loadRuns(index.nextCursor)}
            >
              Older saved runs
            </Button>
          ) : null}
        </section>
      ) : null}
      {selectedRun ? (
        <section aria-label="Selected saved run" className={styles.section}>
          <h3 ref={runHeading} tabIndex={-1}>
            Original run {short(selectedRun.id)}
          </h3>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setSelectedRun(null);
              setPage(null);
              setSelectedAttempt(null);
              setRecovery(null);
              setError('');
            }}
          >
            Back to saved runs
          </Button>
          {!page && !busy ? (
            <Button
              type="button"
              variant="outline"
              disabled={unavailable}
              onClick={() => inspectRun(selectedRun)}
            >
              Read this run again
            </Button>
          ) : null}
          {owner && !checking ? (
            <AutoSellRunProgressPanel
              key={JSON.stringify([
                owner,
                projectId,
                selectedRun.id,
                selectedRun.runSha256,
              ])}
              owner={owner}
              projectId={projectId}
              run={selectedRun}
              disabled={unavailable}
              startedAttemptIds={startedFloor.get(selectedRun.id) ?? []}
              minimumHead={
                page && page.runId === selectedRun.id
                  ? {
                      sequence: page.accounting.sequence,
                      sha256: page.accounting.headSha256,
                    }
                  : undefined
              }
              onObserved={(progress) => {
                if (
                  [...(observedStarts.current.get(selectedRun.id) ?? [])].some(
                    (id) =>
                      !progress.evidence.preparationStarts.some(
                        (start) => start.attemptId === id,
                      ),
                  )
                )
                  throw Error(
                    'Saved preparation history moved backwards. Earlier start observations are retained.',
                  );
                const updated = {
                  ...selectedRun,
                  attemptCount: progress.accounting.sequence,
                  accountedRaw: progress.accounting.accountedRaw,
                  stopped: progress.evidence.stop !== null,
                };
                checkObservedRun(updated);
                rememberStarted(
                  updated.id,
                  progress.evidence.preparationStarts.map(
                    (start) => start.attemptId,
                  ),
                );
                observedRuns.current.set(updated.id, updated);
                setSelectedRun(updated);
                setIndex((previous) =>
                  previous
                    ? {
                        ...previous,
                        runs: previous.runs.map((row) =>
                          row.id === updated.id ? updated : row,
                        ),
                      }
                    : previous,
                );
                const started = new Set(
                  progress.evidence.preparationStarts.map(
                    (start) => start.attemptId,
                  ),
                );
                setPage((previous) =>
                  previous && previous.runId === updated.id
                    ? {
                        ...previous,
                        accounting: {
                          sequence: progress.accounting.sequence,
                          headSha256: progress.accounting.headSha256,
                          accountedRaw: progress.accounting.accountedRaw,
                        },
                        stopped: updated.stopped,
                        attempts: previous.attempts.map((attempt) =>
                          started.has(attempt.id)
                            ? { ...attempt, preparationStarted: true }
                            : attempt,
                        ),
                      }
                    : previous,
                );
                setRecovery((previous) =>
                  previous?.status === 'not-started' &&
                  started.has(previous.attemptId)
                    ? null
                    : previous,
                );
                setSelectedAttempt((previous) =>
                  previous && started.has(previous.id)
                    ? { ...previous, preparationStarted: true }
                    : previous,
                );
              }}
            />
          ) : null}
          {page ? (
            <>
              <p>
                {units(page.accounting.accountedRaw, page.context.decimals)}{' '}
                tokens remain charged across {page.accounting.sequence} reserved
                attempts. No allowance has been released.
              </p>
              <p className={styles.wrap}>
                Original token: <code>{page.context.mint}</code> · project
                revision {page.context.projectRevision}
              </p>
              {page.stopped ? (
                <p>
                  Journal stopped. This does not cancel a transaction or
                  establish a final outcome.
                </p>
              ) : null}
              {selectedAttempt ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setSelectedAttempt(null);
                    setRecovery(null);
                    setError('');
                  }}
                >
                  Back to attempts
                </Button>
              ) : null}
              {!selectedAttempt ? (
                !page.attempts.length ? (
                  <p>No attempts were reserved in this run.</p>
                ) : (
                  <ul className={styles.list}>
                    {page.attempts.map((attempt) => (
                      <li key={attempt.id}>
                        <strong>
                          Attempt #{attempt.sequence} · Strategy{' '}
                          {attempt.strategyId}
                        </strong>
                        <p>
                          {units(attempt.inputRaw, page.context.decimals)} input
                          tokens ·{' '}
                          {attempt.preparationStarted
                            ? 'Preparation start recorded'
                            : 'Not started'}
                        </p>
                        <p className={styles.wrap}>
                          Wallet <code>{attempt.wallet}</code> · revision{' '}
                          {attempt.walletRevision}
                        </p>
                        <p>Reserved {date(attempt.reservedAt)}</p>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={unavailable}
                          onClick={() => inspectAttempt(attempt)}
                        >
                          Inspect preparation #{attempt.sequence}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )
              ) : null}
              {!selectedAttempt && page.nextBeforeSequence !== null ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={unavailable}
                  onClick={() =>
                    inspectRun(selectedRun, page.nextBeforeSequence!)
                  }
                >
                  Older attempts
                </Button>
              ) : null}
              <details className={styles.identities}>
                <summary>Original run IDs</summary>
                <dl>
                  <dt>Run</dt>
                  <dd>{selectedRun.id}</dd>
                  <dt>Run hash</dt>
                  <dd>{selectedRun.runSha256}</dd>
                  <dt>Saved configuration</dt>
                  <dd>{selectedRun.profileSaveId}</dd>
                </dl>
              </details>
            </>
          ) : null}
        </section>
      ) : null}
      {selectedAttempt ? (
        <section
          aria-label="Original preparation recovery"
          className={styles.section}
        >
          <h3 ref={preparationHeading} tabIndex={-1}>
            Preparation #{selectedAttempt.sequence}
          </h3>
          {!recovery && !busy ? (
            <Button
              type="button"
              variant="outline"
              disabled={unavailable}
              onClick={() => inspectAttempt(selectedAttempt)}
            >
              Read this preparation again
            </Button>
          ) : null}
          {recovery ? (
            <>
              <strong>{label[recovery.status]}</strong>
              <p>
                The original input remains charged. Inspection does not renew
                expiry, release allowance or approve a replacement.
              </p>
              {recovery.status === 'started-without-result' ? (
                <p className={styles.warning}>
                  The saved result is unconfirmed. Keep the original run and
                  attempt IDs. Do not start a replacement based on a missing
                  response.
                </p>
              ) : null}
              {recovery.status === 'summary-only' ? (
                <p>
                  The exact transaction bytes were not retained for this older
                  summary. They cannot be reconstructed as the original
                  preparation.
                </p>
              ) : null}
              {recovery.status === 'not-started' ? (
                <p>
                  No preparation start is recorded. This screen cannot start or
                  resume it.
                </p>
              ) : null}
              {recovery.summary ? (
                <dl className={styles.facts}>
                  <dt>Original quote time</dt>
                  <dd>
                    <time dateTime={recovery.summary.document.quotedAt}>
                      {date(recovery.summary.document.quotedAt)}
                    </time>
                  </dd>
                  <dt>Original expiry</dt>
                  <dd>
                    <time dateTime={recovery.summary.document.expiresAt}>
                      {date(recovery.summary.document.expiresAt)}
                    </time>
                  </dd>
                  <dt>Quoted output</dt>
                  <dd>
                    {units(recovery.summary.document.quotedOutRaw, 9)} SOL
                  </dd>
                  <dt>Minimum output</dt>
                  <dd>
                    {units(recovery.summary.document.minimumOutRaw, 9)} SOL
                  </dd>
                  <dt>Recorded simulation</dt>
                  <dd>
                    {recovery.summary.document.simulation.succeeded
                      ? 'Succeeded, not a finalized receipt'
                      : 'Failed; no execution clearance'}
                  </dd>
                </dl>
              ) : null}
              {recovery.packet ? (
                <p>
                  Exact unsigned packet retained: {recovery.packet.packetBytes}{' '}
                  bytes. It remains historical evidence, not signing clearance.
                </p>
              ) : null}
            </>
          ) : null}
          <details className={styles.identities}>
            <summary>Original preparation IDs</summary>
            <dl>
              <dt>Attempt</dt>
              <dd>{selectedAttempt.id}</dd>
              <dt>Preparation</dt>
              <dd>{selectedAttempt.preparationId}</dd>
              <dt>Attempt hash</dt>
              <dd>{selectedAttempt.attemptSha256}</dd>
              {recovery?.packet ? (
                <>
                  <dt>Packet hash</dt>
                  <dd>{recovery.packet.packetSha256}</dd>
                </>
              ) : null}
            </dl>
          </details>
        </section>
      ) : null}
    </div>
  );
}
