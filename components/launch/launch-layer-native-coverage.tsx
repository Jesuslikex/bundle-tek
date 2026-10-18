'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { readPanelJson } from '@/components/read-panel-json';
import { layerNativeComparison } from '@/lib/launch-layer-native-coverage';
import type { LaunchLayerEnvelope } from '@/lib/launch-layer-terms';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import styles from './pump-layer-planner.module.css';

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
  const rows = result.rows.filter((row) => role === 'all' || row.role === role);
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
      <select id={id} value={role} onChange={(e) => setRole(e.target.value)}>
        <option value="all">All roles</option>
        {Object.entries(names)
          .filter(([key]) => result.rows.some((row) => row.role === key))
          .map(([key, name]) => (
            <option key={key} value={key}>
              {name}
            </option>
          ))}
      </select>
      <p>
        Showing {rows.length} of {result.rows.length} role wallets.
      </p>
      <div className={styles.nativeComparison}>
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
            {rows.map((row) => (
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
                        {new Date(row.observation.observedAt).toLocaleString()}
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
      </div>
    </>
  );
}
export function LaunchLayerNativeCoverage({
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
  useEffect(
    () => () => {
      generation.current++;
      active.current?.controller.abort();
      if (active.current) clearTimeout(active.current.timer);
    },
    [],
  );
  const cancel = () => {
    generation.current++;
    active.current?.controller.abort();
    if (active.current) clearTimeout(active.current.timer);
    active.current = null;
    setBusy(false);
  };
  const load = async () => {
    if (active.current || disabled || !plan.current) return;
    const mine = ++generation.current,
      controller = new AbortController();
    const timer = setTimeout(() => {
      if (generation.current !== mine) return;
      cancel();
      setError('Saved observation loading timed out. Reload to try again.');
    }, 30000);
    active.current = { controller, timer };
    setBusy(true);
    setError('');
    setResult(null);
    let failure =
      'Saved observation comparison is unavailable or inconsistent. Reload the saved plan to try again.';
    try {
      const response = await fetch(
        '/api/launch/layers?projectId=' +
          encodeURIComponent(plan.projectId) +
          '&id=' +
          encodeURIComponent(plan.id) +
          '&balances=1',
        { cache: 'no-store', signal: controller.signal },
      );
      const body = (await readPanelJson(
        response,
        'Saved observation comparison is unavailable. Reload the saved plan to try again.',
      )) as { evidence?: unknown; error?: unknown } | null;
      if (!response.ok) {
        if (response.status === 409)
          failure =
            'Planning references changed. Reload the saved plan before comparing.';
        throw Error(
          response.status === 409
            ? 'Planning references changed. Reload the saved plan before comparing.'
            : 'Saved observation comparison is unavailable. Reload the saved plan to try again.',
        );
      }
      const parsed = layerNativeComparison(body?.evidence, plan, plan.envelope);
      if (generation.current === mine && !controller.signal.aborted)
        setResult(parsed);
    } catch {
      if (generation.current === mine) setError(failure);
    } finally {
      clearTimeout(timer);
      if (generation.current === mine) {
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
        This does not calculate required funding or enable staged execution. For
        new observations, refresh native balances in My wallets, then reload
        here.
      </p>
      <p>
        The funder ceiling covers only its declared fees, rent and reserve.
        Exchange deposits and transfers to other roles are not calculated.
      </p>
      <Button
        variant="outline"
        disabled={disabled || busy || !plan.current}
        onClick={() => void load()}
      >
        {result
          ? 'Reload saved SOL observations'
          : 'Load saved SOL observations'}
      </Button>
      {!plan.current && (
        <p>
          Current project and wallet references are required. Historical
          planning terms remain readable above.
        </p>
      )}
      {busy && (
        <>
          <p>
            <output>Loading saved SOL observations…</output>
          </p>
          <Button
            variant="outline"
            onClick={() => {
              cancel();
              setError(
                'Saved observation loading cancelled. Reload to try again.',
              );
            }}
          >
            Cancel observation loading
          </Button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {result && <Comparison result={result} plan={plan} />}
    </section>
  );
}
