'use client';
import { useEffect, useRef, useState } from 'react';
import { useConditionalMonitorStatus } from './use-conditional-monitor-status';
import { Button } from './ui/button';
import {
  decodeConditionalMonitorPage,
  type ConditionalMonitorPage,
  type MonitorNotice,
} from '@/lib/conditional-monitor';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
const errorLabels: Record<string, string> = {
  'rate-limited': 'Waiting for the market read window',
  'provider-unavailable': 'Market provider unavailable',
  'pool-unavailable': 'A selected pool lacks usable market-cap data',
  'storage-unavailable': 'Monitoring storage needs attention',
  'context-changed': 'Project or order context changed',
  'no-current-orders': 'No unreserved current levels to monitor',
};
function MatchNotice({
  notice: n,
  disabled,
  onReview,
}: {
  notice: MonitorNotice;
  disabled: boolean;
  onReview: (orderId: string, revision: number, level: number) => void;
}) {
  const [open, setOpen] = useState(false),
    [page, setPage] = useState(0);
  const offset = Math.min(page, Math.ceil(n.matches.length / 5) - 1) * 5;
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        Market match observed {n.observedAt} · {n.matches.length} orders
      </summary>
      {open && (
        <>
          <p>
            Project revision {n.projectRevision}, monitoring revision{' '}
            {n.monitorRevision}; sample freshness ended {n.expiresAt}.{' '}
            {n.unavailableOrders} order pools were unavailable.
          </p>
          <p>
            Showing orders {offset + 1} to{' '}
            {Math.min(offset + 5, n.matches.length)} of {n.matches.length}.
          </p>
          {n.matches.slice(offset, offset + 5).map((m) => (
            <div key={m.orderId}>
              <p>
                {m.side} order {m.orderId}, market cap ${m.observedMarketCapUsd}
                .
              </p>
              {m.levels.map((l) => (
                <Button
                  key={l.level}
                  variant="outline"
                  disabled={disabled}
                  onClick={() => onReview(m.orderId, m.revision, l.level)}
                >
                  Review matched level {l.level}
                </Button>
              ))}
            </div>
          ))}
          <Button
            variant="outline"
            disabled={offset === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            Previous notice orders
          </Button>
          <Button
            variant="outline"
            disabled={offset + 5 >= n.matches.length}
            onClick={() => setPage((p) => p + 1)}
          >
            More notice orders
          </Button>
        </>
      )}
    </details>
  );
}
type ConditionalMonitorProps = {
  project: ImportedTokenProject;
  onReview: (orderId: string, revision: number, level: number) => void;
  reviewDisabled?: boolean;
};
export function ConditionalMonitor(props: ConditionalMonitorProps) {
  return (
    <ConditionalMonitorPanel
      key={`${props.project.id}:${props.project.revision}:${props.project.archived}`}
      {...props}
    />
  );
}
function ConditionalMonitorPanel({
  project,
  onReview,
  reviewDisabled = false,
}: ConditionalMonitorProps) {
  const [page, setPage] = useState<ConditionalMonitorPage | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [sampleNow, setSampleNow] = useState(() => Date.now());
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, []);
  const live = useConditionalMonitorStatus(
    project.id,
    project.revision,
    project.archived,
    busy,
    (snapshot) => {
      setPage(snapshot);
      setSampleNow(Date.now());
    },
  );
  useEffect(() => {
    if (!page) return;
    const timer = setInterval(() => setSampleNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, [page]);
  async function request(enabled?: boolean) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(
        '/api/imported-projects/conditional-monitor' +
          (enabled === undefined
            ? '?' + new URLSearchParams({ projectId: project.id })
            : ''),
        {
          method: enabled === undefined ? 'GET' : 'POST',
          cache: 'no-store',
          signal: controller.signal,
          ...(enabled === undefined
            ? {}
            : {
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  projectId: project.id,
                  projectRevision: project.revision,
                  monitorRevision: page?.monitor?.revision ?? 0,
                  enabled,
                }),
              }),
        },
      );
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(
          (body as { error?: string })?.error || 'Monitoring unavailable.',
        );
      const decoded = decodeConditionalMonitorPage(body, project.id);
      if (!controller.signal.aborted) {
        setPage(decoded);
        setSampleNow(Date.now());
      }
    } catch (e) {
      if (pending.current === controller)
        setError(
          controller.signal.aborted
            ? 'Monitoring request timed out. Reload before retrying.'
            : e instanceof Error
              ? e.message
              : 'Monitoring unavailable.',
        );
    } finally {
      clearTimeout(timeout);
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  const workerRecent =
    page?.workerLastSeenAt !== null &&
    page?.workerLastSeenAt !== undefined &&
    page.workerLastSeenAt <= sampleNow &&
    sampleNow - page.workerLastSeenAt < 180000;
  return (
    <section
      aria-label="Background conditional monitoring"
      className="space-y-2 rounded-md border p-3"
    >
      <h5>Background conditional monitoring</h5>
      <p>
        Save monitoring for this project&apos;s current Limit and Grid drafts. A
        running server worker checks selected pools and retains new
        matching-level notices, even while this page is closed. Every trade
        still requires a fresh review, signature and separate submission.
      </p>
      <Button variant="outline" disabled={busy} onClick={() => void request()}>
        Reload background monitoring
      </Button>
      <Button
        variant="outline"
        disabled={busy}
        onClick={() =>
          live.state.status === 'off' ? live.start() : live.stop()
        }
      >
        {live.state.status === 'off'
          ? 'Follow monitoring notices'
          : 'Stop following monitoring notices'}
      </Button>
      {live.state.status !== 'off' && (
        <output className="block">
          Notice updates: {live.state.status}. {live.state.reads} successful
          reads. {live.state.reason}
          {live.state.retryInMs !== null &&
            ` Retry in ${live.state.retryInMs / 1000} seconds.`}
        </output>
      )}
      <p>
        Following refreshes retained notices while this tab is visible and
        online. It does not enable the background worker or approve a trade.
      </p>
      {live.error && <p role="alert">{live.error}</p>}
      {page && (
        <>
          <p>
            Saved setting:{' '}
            {page.monitor?.enabled ? 'Monitoring requested' : 'Paused'}.{' '}
            {workerRecent
              ? 'A worker heartbeat was recently recorded.'
              : 'No recent worker heartbeat. Background checks are not confirmed running.'}
          </p>
          <Button
            disabled={busy || (!page.monitor?.enabled && project.archived)}
            onClick={() => void request(!page.monitor?.enabled)}
          >
            {page.monitor?.enabled
              ? 'Pause background monitoring'
              : 'Request background monitoring'}
          </Button>
          {page.monitor?.lastCheckedAt !== null &&
            page.monitor?.lastCheckedAt !== undefined && (
              <p>
                Last successful sample:{' '}
                {new Date(page.monitor.lastCheckedAt).toISOString()}.
              </p>
            )}
          {page.monitor?.error && (
            <output className="block">
              Last check:{' '}
              {errorLabels[page.monitor.error] ?? 'Monitoring unavailable'}.
              Transient errors retain notices and retry; changed projects
              require a new monitoring request.
            </output>
          )}
          <p aria-live="polite" aria-atomic="true">
            Latest {page.notices.length} retained match notices. They are
            sampled conditions, not reserved inventory or executed trades. An
            older notice does not prove the condition still holds.
            {page.notices[0] &&
              ` Latest match observed ${page.notices[0].observedAt}.`}
          </p>
          {page.notices.map((n) => (
            <MatchNotice
              key={n.id}
              notice={n}
              disabled={
                busy ||
                reviewDisabled ||
                project.archived ||
                n.projectRevision !== project.revision
              }
              onReview={onReview}
            />
          ))}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
