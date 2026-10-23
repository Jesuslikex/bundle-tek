'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { readBoundedPanelJson } from '@/lib/read-bounded-panel-json';
import type { MeteoraDbcReview } from '@/lib/meteora-dbc-launch-service';
import type { StonkLaunchReview } from '@/lib/stonkfun-launch-service';
export type VenueReview = MeteoraDbcReview | StonkLaunchReview;
export type VenueLaunchRecovery<R extends VenueReview = VenueReview> = {
  format: 'venue-launch-recovery-v1';
  id: string;
  venue: 'meteora-dbc' | 'stonkfun';
  projectId: string;
  review: R;
  state:
    | 'review'
    | 'approved'
    | 'signed'
    | 'submitting'
    | 'submitted'
    | 'finalized'
    | 'failed'
    | 'cancelled';
  signature: string | null;
  receipt: Record<string, unknown> | null;
  createdAt: string;
};
const states = [
  'review',
  'approved',
  'signed',
  'submitting',
  'submitted',
  'finalized',
  'failed',
  'cancelled',
];
function admit<R extends VenueReview>(
  value: unknown,
  venue: VenueLaunchRecovery['venue'],
  projectId: string,
): VenueLaunchRecovery<R> {
  const r = value as VenueLaunchRecovery<R>;
  if (
    !r ||
    typeof r !== 'object' ||
    Object.keys(r).sort().join(',') !==
      [
        'format',
        'id',
        'venue',
        'projectId',
        'review',
        'state',
        'signature',
        'receipt',
        'createdAt',
      ]
        .sort()
        .join(',')
  )
    throw Error('Saved launch could not be verified. Recover the original ID.');
  if (
    !r ||
    r.format !== 'venue-launch-recovery-v1' ||
    typeof r.id !== 'string' ||
    !r.id ||
    r.id.length > 128 ||
    r.venue !== venue ||
    r.projectId !== projectId ||
    !states.includes(r.state) ||
    !Number.isFinite(Date.parse(r.createdAt)) ||
    (r.signature !== null &&
      (typeof r.signature !== 'string' ||
        !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(r.signature))) ||
    (r.receipt !== null &&
      (!r.receipt ||
        typeof r.receipt !== 'object' ||
        Array.isArray(r.receipt))) ||
    !r.review ||
    r.review.format !==
      (venue === 'meteora-dbc'
        ? 'meteora-dbc-launch-review-v1'
        : 'stonkfun-launch-review-v1') ||
    !/^[a-f0-9]{64}$/.test(r.review.sha256) ||
    !Number.isFinite(Date.parse(r.review.expiresAt)) ||
    r.review.terms?.projectId !== projectId ||
    r.review.input?.mint !== r.review.terms.mint ||
    typeof r.review.transaction !== 'string' ||
    !r.review.summary ||
    (['signed', 'submitting', 'submitted', 'finalized'].includes(r.state) &&
      !r.signature)
  )
    throw Error('Saved launch could not be verified. Recover the original ID.');
  const summary = r.review.summary;
  const raw = (v: unknown) =>
    typeof v === 'string' && /^(0|[1-9]\d{0,31})$/.test(v);
  if (
    !Number.isInteger(summary.quoteDecimals) ||
    summary.quoteDecimals < 0 ||
    summary.quoteDecimals > 18 ||
    !Number.isFinite(summary.devSupplyBps) ||
    summary.devSupplyBps < 0 ||
    summary.devSupplyBps > 10000 ||
    !raw(summary.devBuyRaw) ||
    !raw(summary.tokensOutRaw) ||
    !raw(summary.solCostLamports) ||
    typeof summary.pool !== 'string' ||
    typeof summary.quoteSymbol !== 'string' ||
    typeof r.review.input.name !== 'string' ||
    typeof r.review.input.symbol !== 'string' ||
    r.review.transaction.length > 1644
  )
    throw Error('Saved launch summary could not be verified.');
  if (r.review.format === 'meteora-dbc-launch-review-v1') {
    if (
      !raw(r.review.summary.migrationThresholdRaw) ||
      !raw(r.review.summary.poolCreationFeeLamports) ||
      !Number.isInteger(r.review.summary.baseDecimals) ||
      r.review.summary.baseDecimals < 0 ||
      r.review.summary.baseDecimals > 18
    )
      throw Error('Saved DBC summary could not be verified.');
  } else if (!raw(r.review.summary.raiseRaw))
    throw Error('Saved launch summary could not be verified.');
  return r;
}
/** Only unsigned public review/history is held in React. Signed bytes go once
 * from the browser signer to register; they are never placed in local storage. */
export function useVenueLaunchRecovery<R extends VenueReview>(
  venue: VenueLaunchRecovery['venue'],
  projectId: string,
) {
  const endpoint = `/api/${venue}/launch`,
    key = `bundle-venue-launch-recovery:${venue}:${projectId}`;
  const alive = useRef(true),
    active = useRef<AbortController | null>(null);
  const [recordReadAt, setRecordReadAt] = useState(() => Date.now());
  const [record, setRecord] = useState<VenueLaunchRecovery<R> | null>(null),
    [history, setHistory] = useState<VenueLaunchRecovery<R>[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [uncertain, setUncertain] = useState(false),
    [originalId, setOriginalId] = useState('');
  function current() {
    if (!alive.current)
      throw Error('Launch view changed. Recover the original saved launch.');
  }
  function marker(id: string, stage: string) {
    current();
    const existing = JSON.parse(localStorage.getItem(key) || 'null');
    if (existing?.id && existing.id !== id)
      throw Error('Another original launch ID still needs recovery.');
    const text = JSON.stringify({ id, stage });
    localStorage.setItem(key, text);
    if (localStorage.getItem(key) !== text)
      throw Error(
        'The recovery ID could not be retained. No new request was made.',
      );
    setOriginalId(id);
  }
  function clearMarker(id: string, explicitSelection = false) {
    try {
      const m = JSON.parse(localStorage.getItem(key) || 'null');
      if (
        m?.id === id ||
        (explicitSelection && m?.id === '' && m?.stage === 'prepare')
      )
        localStorage.removeItem(key);
    } catch {
      /* Preserve a reminder if storage cannot be read. */
    }
  }
  function accept(row: VenueLaunchRecovery<R>, explicitSelection = false) {
    current();
    setRecord(row);
    setRecordReadAt(Date.now());
    setHistory((old) => [row, ...old.filter((r) => r.id !== row.id)]);
    setOriginalId(row.id);
    setUncertain(false);
    clearMarker(row.id, explicitSelection);
    return row;
  }
  async function request(url: string, body?: unknown) {
    current();
    active.current?.abort();
    const c = new AbortController();
    active.current = c;
    try {
      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(30000)]);
      const response = await fetch(url, {
        ...(body === undefined
          ? {}
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }),
        cache: 'no-store',
        signal,
      });
      current();
      if (response.status === 401) {
        void response.body?.cancel().catch(() => {});
        throw Error('Sign in to recover your saved launches.');
      }
      let value: unknown;
      try {
        value = await readBoundedPanelJson(response, signal);
      } catch {
        throw Error(
          'Launch response unavailable. Recover the original ID before another action.',
        );
      }
      current();
      if (c.signal.aborted)
        throw Error('Launch request interrupted. Recover the original ID.');
      if (!response.ok)
        throw Error(
          response.status === 401
            ? 'Sign in to recover your saved launches.'
            : typeof (value as { error?: unknown })?.error === 'string'
              ? String((value as { error: string }).error).slice(0, 400)
              : 'Launch request unavailable. Recover the original ID.',
        );
      return value;
    } finally {
      if (active.current === c) active.current = null;
    }
  }
  async function load() {
    setLoading(true);
    setError('');
    try {
      const value = (await request(
        `${endpoint}?projectId=${encodeURIComponent(projectId)}`,
      )) as { launches?: unknown[] };
      if (!Array.isArray(value.launches) || value.launches.length > 100)
        throw Error('Saved launch history could not be verified.');
      const rows = value.launches.map((r) => admit<R>(r, venue, projectId));
      current();
      setHistory(rows);
      let saved: { id?: unknown; stage?: unknown } | null = null;
      try {
        saved = JSON.parse(localStorage.getItem(key) || 'null');
      } catch {
        setUncertain(true);
        throw Error(
          'The saved recovery reminder could not be read. Keep the original launch ID.',
        );
      }
      if (saved) {
        setOriginalId(typeof saved.id === 'string' ? saved.id : '');
        setUncertain(true);
      } else setUncertain(false);
    } catch (e) {
      if (alive.current) {
        setError(
          e instanceof Error ? e.message : 'Saved launches unavailable.',
        );
        setUncertain(true);
      }
    } finally {
      if (alive.current) setLoading(false);
    }
  }
  const initialLoad = useRef(load);
  useEffect(() => {
    let mounted = true;
    alive.current = true;
    queueMicrotask(() => {
      if (mounted) void initialLoad.current();
    });
    return () => {
      mounted = false;
      alive.current = false;
      active.current?.abort();
    };
  }, []);
  async function prepare(terms: unknown) {
    if (
      loading ||
      uncertain ||
      history.some((r) =>
        ['review', 'approved', 'signed', 'submitting', 'submitted'].includes(
          r.state,
        ),
      )
    )
      throw Error(
        'Recover or finish the existing saved launch before preparing another.',
      );
    marker('', 'prepare');
    setUncertain(true);
    try {
      const value = (await request(endpoint, {
        action: 'prepare',
        terms,
      })) as R & { recoveryId: string };
      if (typeof value.recoveryId !== 'string' || !value.recoveryId)
        throw Error(
          'The saved review ID is unavailable. Reload saved launches.',
        );
      marker(value.recoveryId, 'review');
      const row = admit<R>(
        await request(`${endpoint}?id=${encodeURIComponent(value.recoveryId)}`),
        venue,
        projectId,
      );
      if (row.id !== value.recoveryId || row.review.sha256 !== value.sha256)
        throw Error('Saved review differs from the original preparation.');
      return accept(row).review;
    } catch (e) {
      current();
      setUncertain(true);
      throw e;
    }
  }
  async function write(
    action: 'approve' | 'register' | 'submit' | 'cancel',
    body: Record<string, unknown> = {},
  ) {
    if (!record || uncertain)
      throw Error('Recover the original saved launch before this action.');
    const captured = record;
    marker(captured.id, action);
    setUncertain(true);
    try {
      const value = await request(endpoint, {
        action,
        id: captured.id,
        ...body,
      });
      const row = admit<R>(value, venue, projectId);
      if (
        row.id !== captured.id ||
        row.review.sha256 !== captured.review.sha256
      )
        throw Error('Saved launch changed. Recover the original ID.');
      return accept(row);
    } catch (e) {
      current();
      setUncertain(true);
      throw e;
    }
  }
  async function recover(id = originalId) {
    if (!id)
      throw Error('Reload saved launches and choose the original review.');
    setError('');
    const value = await request(endpoint, { action: 'recover', id });
    const row = admit<R>(value, venue, projectId);
    if (row.id !== id) throw Error('Recovery returned another launch.');
    return accept(row);
  }
  async function select(id: string) {
    if (uncertain && originalId && id !== originalId)
      throw Error('Recover the original unresolved launch ID first.');
    const reminder = JSON.parse(localStorage.getItem(key) || 'null');
    if (reminder?.id === '' && reminder?.stage === 'prepare') {
      // A lost prepare may have saved a row after the displayed history loaded.
      // Never resolve that uncertainty using a stale terminal selection.
      const fresh = (await request(
        `${endpoint}?projectId=${encodeURIComponent(projectId)}`,
      )) as { launches?: unknown[] };
      if (!Array.isArray(fresh.launches) || fresh.launches.length > 100)
        throw Error('Saved launch history could not be verified.');
      const rows = fresh.launches.map((r) => admit<R>(r, venue, projectId));
      setHistory(rows);
      if (
        !rows.some((r) => r.id === id) ||
        rows.some(
          (r) =>
            r.id !== id &&
            [
              'review',
              'approved',
              'signed',
              'submitting',
              'submitted',
            ].includes(r.state),
        )
      )
        throw Error(
          'Select the original active launch from the refreshed history.',
        );
    }
    const value = await request(`${endpoint}?id=${encodeURIComponent(id)}`);
    const row = admit<R>(value, venue, projectId);
    if (row.id !== id) throw Error('History returned another launch.');
    return accept(row, true);
  }
  return {
    record,
    recordReadAt,
    history,
    loading,
    error,
    uncertain,
    originalId,
    prepare,
    write,
    recover,
    select,
    load,
    current,
    blocked:
      loading ||
      uncertain ||
      history.some((r) =>
        ['review', 'approved', 'signed', 'submitting', 'submitted'].includes(
          r.state,
        ),
      ),
  };
}
export function VenueLaunchRecoveryHistory({
  recovery,
  busy,
  onTask,
}: {
  recovery: Pick<
    ReturnType<typeof useVenueLaunchRecovery>,
    | 'record'
    | 'history'
    | 'loading'
    | 'error'
    | 'uncertain'
    | 'originalId'
    | 'load'
    | 'select'
    | 'recover'
    | 'write'
  >;
  busy: boolean;
  onTask: (task: () => Promise<void>) => void;
}) {
  return (
    <section
      aria-label="Saved launch recovery"
      className="min-w-0 space-y-3 break-words"
    >
      <h4>Saved launches</h4>
      <p>
        Recent saved reviews and receipts. Opening history never signs,
        broadcasts or renews a review. Cancelling an unapproved review closes
        this saved draft only; it does not cancel an on-chain transaction.
      </p>
      <Button
        type="button"
        className="h-auto min-h-11 max-w-full whitespace-normal break-all text-left"
        variant="outline"
        disabled={busy || recovery.loading}
        onClick={() =>
          onTask(async () => {
            await recovery.load();
          })
        }
      >
        Reload saved launches
      </Button>
      {recovery.loading && <output>Loading saved launches…</output>}
      {recovery.error && <p role="alert">{recovery.error}</p>}
      {recovery.uncertain && (
        <p role="alert">
          A launch action may have been saved. Recover the original ID before
          signing or preparing another review.{' '}
          {recovery.originalId ||
            'Reload the project history to find the original review.'}
        </p>
      )}
      {recovery.originalId && (
        <Button
          type="button"
          className="h-auto min-h-11 max-w-full whitespace-normal break-all text-left"
          variant="outline"
          disabled={busy || recovery.loading}
          onClick={() =>
            onTask(async () => {
              await recovery.recover();
            })
          }
        >
          Recover original launch
        </Button>
      )}
      <ul>
        {recovery.history.map((r) => (
          <li key={r.id}>
            <Button
              type="button"
              className="h-auto min-h-11 max-w-full whitespace-normal break-all text-left"
              variant="outline"
              disabled={busy || recovery.loading}
              onClick={() =>
                onTask(async () => {
                  await recovery.select(r.id);
                })
              }
            >
              {r.state} · {r.review.input.name} · {r.id}
            </Button>
          </li>
        ))}
      </ul>
      {recovery.record && (
        <>
          <output>Saved launch status: {recovery.record.state}</output>
          {['approved', 'signed', 'submitting', 'submitted'].includes(
            recovery.record.state,
          ) && (
            <p>
              Missing or unavailable finalized evidence keeps this launch
              unresolved. Recovery never broadcasts again or releases it without
              verified finality or safe expiry. If cancellation leaves this
              status unchanged, it is awaiting safe expiry evidence; check
              recovery later.
            </p>
          )}
          {recovery.record.signature && (
            <a
              href={`https://solscan.io/tx/${recovery.record.signature}`}
              target="_blank"
              rel="noreferrer"
            >
              View transaction
            </a>
          )}
          {!recovery.uncertain &&
            ['review', 'approved'].includes(recovery.record.state) && (
              <Button
                type="button"
                className="h-auto min-h-11 max-w-full whitespace-normal break-all text-left"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  onTask(async () => {
                    await recovery.write('cancel');
                  })
                }
              >
                Cancel unsigned launch
              </Button>
            )}
        </>
      )}
    </section>
  );
}
