'use client';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { layerNativeComparison } from '@/lib/launch-layer-native-coverage';
import type { LaunchLayerEnvelope } from '@/lib/launch-layer-terms';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import styles from './pump-layer-planner.module.css';
import {
  layerSolRefreshGroups,
  refreshLayerSol,
  LayerSolRefreshError,
  LAYER_SOL_GROUP_WAIT_MS,
  type LayerSolProgress,
  layerSolRefreshHttpError,
  readLayerSolJson,
} from '@/lib/launch-layer-balance-refresh';

const names = {
  funder: 'Funder',
  developer: 'Developer',
  front: 'Front buyer',
  back: 'Back buyer',
  temporary: 'Temporary holder',
  holders: 'Final holder',
};
type Plan = {
  id: string;
  projectId: string;
  sha256: string;
  envelope: LaunchLayerEnvelope;
  current: boolean;
};
function Comparison({
  result,
  plan,
}: {
  result: ReturnType<typeof layerNativeComparison>;
  plan: Plan;
}) {
  const id = useId();
  const [role, setRole] = useState('all');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(0);
  const pageStatus = useRef<HTMLOutputElement>(null);
  const roleRows = result.rows.filter(
    (row) => role === 'all' || row.role === role,
  );
  const classify = (difference: string | null) =>
    difference === null
      ? 'unavailable'
      : BigInt(difference) < 0n
        ? 'below'
        : 'covered';
  const rows = roleRows.filter(
    (row) => status === 'all' || classify(row.differenceRaw) === status,
  );
  const count = (state: string) =>
    roleRows.filter((row) => classify(row.differenceRaw) === state).length;
  const pages = Math.max(1, Math.ceil(rows.length / 25)),
    selectedPage = Math.min(page, pages - 1);
  return (
    <>
      <p>
        Saved snapshot checked at{' '}
        <time dateTime={result.evidence.checkedAt}>
          {new Date(result.evidence.checkedAt).toLocaleString()}
        </time>
        . These amounts are historical observations, not current spendability or
        required funding.
      </p>
      <p>
        {plan.envelope.terms.quote.kind === 'native'
          ? 'SOL buys are included in each native ceiling.'
          : `${plan.envelope.terms.quote.symbol} buy ceilings are separate. Quote-token balances and live mint scaling are not checked here.`}
      </p>
      <p>
        Declared native ceiling:{' '}
        <strong>
          {formatNativeBalance(
            plan.envelope.terms.totals.maximumNativeBudgetLamports,
            9,
          )}{' '}
          SOL
        </strong>
        .
      </p>
      {result.observedTotalRaw !== null ? (
        <p>
          Combined saved SOL observation:{' '}
          {formatNativeBalance(result.observedTotalRaw, 9)} SOL, from one saved
          snapshot.
        </p>
      ) : (
        <p>
          Different or missing observations: no combined SOL balance is shown.
        </p>
      )}
      <label htmlFor={id}>Show role</label>
      <select
        id={id}
        value={role}
        onChange={(e) => {
          setRole(e.target.value);
          setPage(0);
        }}
      >
        <option value="all">All roles</option>
        {Object.entries(names)
          .filter(([key]) => result.rows.some((row) => row.role === key))
          .map(([key, name]) => (
            <option key={key} value={key}>
              {name}
            </option>
          ))}
      </select>
      <label htmlFor={id + '-status'}>Show comparison</label>
      <select
        id={id + '-status'}
        value={status}
        onChange={(event) => {
          setStatus(event.target.value);
          setPage(0);
        }}
      >
        <option value="all">All comparisons</option>
        <option value="below">Below declared ceiling</option>
        <option value="unavailable">Missing or invalid observation</option>
        <option value="covered">At or above declared ceiling</option>
      </select>
      <p>
        Selected role: {count('below')} below ceiling, {count('unavailable')}{' '}
        unavailable, {count('covered')} at or above ceiling. These are saved
        comparisons, not funding readiness.
      </p>
      <p>
        Selected role native ceiling:{' '}
        {formatNativeBalance(
          String(
            roleRows.reduce((sum, row) => sum + BigInt(row.ceilingRaw), 0n),
          ),
          9,
        )}{' '}
        SOL. Filters do not calculate required funding or combine different
        balance snapshots.
      </p>
      <output ref={pageStatus} tabIndex={-1}>
        Showing {Math.min(25, Math.max(0, rows.length - selectedPage * 25))} of{' '}
        {rows.length} matching wallets ({result.rows.length} in the full plan),
        page {selectedPage + 1} of {pages}. Totals include the full selected
        role, not only this page.
      </output>
      {(role !== 'all' || status !== 'all') && (
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setRole('all');
            setStatus('all');
            setPage(0);
            pageStatus.current?.focus();
          }}
        >
          Clear observation filters
        </Button>
      )}
      {!rows.length && (
        <p>
          No saved comparisons match these filters. Clear the filters to view
          all role wallets.
        </p>
      )}
      {/* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- A named horizontal scroll region must be focusable for keyboard scrolling. */}
      <section
        className={styles.nativeComparison}
        aria-label="Wallet SOL observation comparison"
        tabIndex={0}
      >
        <table>
          <caption>
            Saved SOL observations against this snapshot’s declared ceilings. No
            transaction is authorized.
          </caption>
          <thead>
            <tr>
              <th>Role / public wallet</th>
              <th>Buy ceiling ({plan.envelope.terms.quote.symbol})</th>
              <th>Fee ceiling (SOL)</th>
              <th>Rent ceiling (SOL)</th>
              <th>Reserve (SOL)</th>
              <th>Native ceiling (SOL)</th>
              <th>Saved SOL</th>
              <th>Comparison at observation</th>
              <th>Observed</th>
            </tr>
          </thead>
          <tbody>
            {rows
              .slice(selectedPage * 25, (selectedPage + 1) * 25)
              .map((row) => (
                <tr key={row.address}>
                  <td>
                    {names[row.role]} {row.index + 1}
                    <code>{row.address}</code>
                  </td>
                  <td>
                    {formatNativeBalance(
                      row.buyQuoteRaw,
                      plan.envelope.terms.quote.decimals,
                    )}
                  </td>
                  <td>{formatNativeBalance(row.feeRaw, 9)}</td>
                  <td>{formatNativeBalance(row.rentRaw, 9)}</td>
                  <td>{formatNativeBalance(row.reserveRaw, 9)}</td>
                  <td>{formatNativeBalance(row.ceilingRaw, 9)}</td>
                  <td>
                    {row.observation
                      ? formatNativeBalance(row.observation.raw, 9)
                      : row.issue === 'missing'
                        ? 'No saved observation'
                        : 'Invalid saved observation'}
                  </td>
                  <td>
                    {row.differenceRaw === null
                      ? 'Unavailable'
                      : BigInt(row.differenceRaw) < 0n
                        ? `Below ceiling by ${formatNativeBalance(String(-BigInt(row.differenceRaw)), 9)} SOL`
                        : BigInt(row.differenceRaw) === 0n
                          ? 'Equal to ceiling'
                          : `Above ceiling by ${formatNativeBalance(row.differenceRaw, 9)} SOL`}
                  </td>
                  <td>
                    {row.observation ? (
                      <>
                        <time dateTime={row.observation.observedAt}>
                          {new Date(
                            row.observation.observedAt,
                          ).toLocaleString()}
                        </time>
                        <small>
                          Slot {row.observation.slot} ·{' '}
                          {row.observation.commitment}
                        </small>
                        <small>{row.observation.source}</small>
                      </>
                    ) : (
                      'Not compared'
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>
      {/* oxlint-enable jsx-a11y/no-noninteractive-tabindex */}
      {pages > 1 && (
        <div className={styles.actions}>
          <Button
            type="button"
            variant="outline"
            disabled={selectedPage === 0}
            onClick={() => {
              setPage(selectedPage - 1);
              pageStatus.current?.focus();
            }}
          >
            Previous comparison wallets
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={selectedPage >= pages - 1}
            onClick={() => {
              setPage(selectedPage + 1);
              pageStatus.current?.focus();
            }}
          >
            Next comparison wallets
          </Button>
        </div>
      )}
    </>
  );
}
export function LaunchLayerNativeCoverage(props: {
  plan: Plan;
  disabled: boolean;
}) {
  const { plan } = props;
  return (
    <NativeCoverageContent
      key={JSON.stringify([
        plan.projectId,
        plan.id,
        plan.sha256,
        plan.envelope.sha256,
        plan.current,
      ])}
      {...props}
    />
  );
}
function NativeCoverageContent({
  plan,
  disabled,
}: {
  plan: Plan;
  disabled: boolean;
}) {
  const [result, setResult] = useState<ReturnType<
      typeof layerNativeComparison
    > | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const generation = useRef(0),
    active = useRef<{
      controller: AbortController;
      timer: ReturnType<typeof setTimeout>;
    } | null>(null);
  const [mode, setMode] = useState<'saved' | 'refresh'>('saved');
  const [progress, setProgress] = useState<LayerSolProgress | null>(null);
  const statusRegion = useRef<HTMLElement>(null),
    savedButton = useRef<HTMLButtonElement>(null),
    refreshButton = useRef<HTMLButtonElement>(null),
    initiator = useRef<HTMLButtonElement | null>(null),
    restoreFocus = useRef(false);
  const groups = useMemo(() => {
    try {
      return layerSolRefreshGroups(plan.envelope);
    } catch {
      return [];
    }
  }, [plan.envelope]);
  const holdFocus = () => {
    if (statusRegion.current?.contains(document.activeElement)) {
      restoreFocus.current = true;
      statusRegion.current.focus();
    }
  };
  useEffect(() => {
    if (!busy && restoreFocus.current) {
      restoreFocus.current = false;
      if (document.activeElement === statusRegion.current)
        initiator.current?.focus();
    }
  }, [busy]);
  useEffect(
    () => () => {
      generation.current++;
      active.current?.controller.abort();
      if (active.current) clearTimeout(active.current.timer);
    },
    [],
  );
  const cancel = () => {
    holdFocus();
    generation.current++;
    active.current?.controller.abort();
    if (active.current) clearTimeout(active.current.timer);
    active.current = null;
    setBusy(false);
    setProgress((value) => (value ? { ...value, phase: 'stopped' } : null));
  };
  const load = async (kind: 'saved' | 'refresh' = 'saved') => {
    if (active.current || disabled || !plan.current) return;
    if (kind === 'refresh' && !groups.length) return;
    const mine = ++generation.current,
      controller = new AbortController();
    const timer = setTimeout(
      () => {
        if (generation.current !== mine) return;
        cancel();
        setError(
          kind === 'saved'
            ? 'Saved observation loading timed out. Reload to try again.'
            : 'Balance refresh timed out. Load saved observations before another refresh; an in-flight read may have been retained.',
        );
      },
      kind === 'saved'
        ? 30000
        : groups.length * 30000 + (groups.length - 1) * LAYER_SOL_GROUP_WAIT_MS,
    );
    active.current = { controller, timer };
    initiator.current =
      kind === 'saved' ? savedButton.current : refreshButton.current;
    statusRegion.current?.focus();
    restoreFocus.current = true;
    setBusy(true);
    setError('');
    setResult(null);
    setMode(kind);
    setProgress(null);
    let failure =
      'Saved observation comparison is unavailable or inconsistent. Reload the saved plan to try again.';
    const current = () =>
      generation.current === mine && !controller.signal.aborted;
    const evidence = async (signal: AbortSignal) => {
      const response = await fetch(
        '/api/launch/layers?projectId=' +
          encodeURIComponent(plan.projectId) +
          '&id=' +
          encodeURIComponent(plan.id) +
          '&balances=1',
        { cache: 'no-store', redirect: 'error', signal },
      );
      if (!response.ok) {
        if (response.status === 409)
          failure =
            'Planning references changed. Reload the saved plan before comparing.';
        throw layerSolRefreshHttpError(response.status);
      }
      const body = (await readLayerSolJson(response, signal)) as {
        evidence?: unknown;
      } | null;
      signal.throwIfAborted();
      return body?.evidence;
    };
    try {
      if (kind === 'saved') {
        const parsed = layerNativeComparison(
          await evidence(controller.signal),
          plan,
          plan.envelope,
        );
        if (current()) setResult(parsed);
      } else {
        await refreshLayerSol({
          plan,
          signal: controller.signal,
          current,
          readEvidence: evidence,
          refreshGroup: async (addresses, signal) => {
            const response = await fetch('/api/wallet-workspace/balances', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ chain: 'Solana', addresses }),
              cache: 'no-store',
              redirect: 'error',
              signal,
            });
            if (!response.ok) throw layerSolRefreshHttpError(response.status);
            const body = (await readLayerSolJson(response, signal)) as {
              snapshot?: unknown;
            } | null;
            signal.throwIfAborted();
            return body?.snapshot;
          },
          onProgress: (value) => {
            if (current()) setProgress(value);
          },
          onComparison: (value) => {
            if (current()) setResult(value);
          },
        });
      }
    } catch (error) {
      if (generation.current === mine) {
        setError(
          kind === 'saved'
            ? failure
            : error instanceof LayerSolRefreshError
              ? error.message
              : 'Balance refresh could not be confirmed. Load saved observations before another refresh; an in-flight read may have been retained.',
        );
        setProgress((value) => (value ? { ...value, phase: 'stopped' } : null));
      }
    } finally {
      controller.abort();
      clearTimeout(timer);
      if (generation.current === mine) {
        holdFocus();
        active.current = null;
        setBusy(false);
      }
    }
  };
  return (
    <section
      className={styles.nativeReview}
      aria-label="Saved SOL and declared ceilings"
    >
      <h4>Saved SOL vs declared ceilings</h4>
      <p>
        Compare the selected snapshot with saved public-address observations.
        You can read and save new SOL observations here. This does not calculate
        required funding, prove spendability or enable staged execution.
      </p>
      <p>
        The funder ceiling covers only its declared fees, rent and reserve.
        Exchange deposits and transfers to other roles are not calculated.
      </p>
      {plan.envelope.terms.quote.kind !== 'native' && (
        <p>
          {plan.envelope.terms.quote.symbol} buy balances are not checked by
          this SOL refresh.
        </p>
      )}
      {groups.length > 1 && (
        <p>
          {groups.flat().length} wallets in {groups.length} groups. Refresh
          waits at least 15 seconds between groups and stops on a rate limit; no
          automatic retry.
        </p>
      )}
      <div className={styles.actions}>
        <Button
          ref={savedButton}
          variant="outline"
          disabled={disabled || busy || !plan.current}
          onClick={() => void load()}
        >
          {result
            ? 'Reload saved SOL observations'
            : 'Load saved SOL observations'}
        </Button>
        <Button
          ref={refreshButton}
          variant="outline"
          disabled={disabled || busy || !plan.current || !groups.length}
          onClick={() => void load('refresh')}
        >
          Refresh SOL observations
        </Button>
      </div>
      {!groups.length && (
        <p>
          This plan cannot start a balance refresh. Reload a plan with at most
          500 unique role wallets.
        </p>
      )}
      {!plan.current && (
        <p>
          Current project and wallet references are required. Historical
          planning terms remain readable above.
        </p>
      )}
      <section
        ref={statusRegion}
        aria-label="SOL observation status"
        tabIndex={-1}
      >
        {busy && (
          <>
            <p>
              <output>
                {mode === 'saved'
                  ? 'Loading saved SOL observations…'
                  : 'Refreshing SOL observations…'}
              </output>
            </p>
            <Button
              variant="outline"
              onClick={() => {
                cancel();
                setError(
                  mode === 'saved'
                    ? 'Saved observation loading cancelled. Reload to try again.'
                    : 'Balance refresh stopped. Load saved observations before another refresh; an in-flight read may still have been retained. No funds were moved.',
                );
              }}
            >
              {mode === 'saved'
                ? 'Cancel observation loading'
                : 'Cancel balance refresh'}
            </Button>
          </>
        )}
        {progress && (
          <div className={styles.nativeProgress}>
            <progress
              value={progress.completed}
              max={progress.total}
              aria-label="Wallet observations confirmed retained"
            />
            <p>
              <output>
                {progress.completed} of {progress.total} wallet observations
                confirmed retained.{' '}
                {progress.phase === 'done'
                  ? 'Refresh complete.'
                  : progress.phase === 'stopped'
                    ? 'Refresh stopped.'
                    : progress.phase === 'waiting'
                      ? 'Waiting at least 15 seconds before the next group.'
                      : progress.phase === 'checking'
                        ? 'Checking saved plan and previous observations.'
                        : progress.phase === 'reading'
                          ? 'Reading SOL balances.'
                          : 'Checking retained observations.'}
              </output>
            </p>
            <p>
              Groups can have different observation times. Closing or stopping
              prevents later groups, but a started read may finish saving.
              Nothing is transferred or signed.
            </p>
          </div>
        )}
        {error && <p role="alert">{error}</p>}
      </section>
      {result && <Comparison result={result} plan={plan} />}
    </section>
  );
}
