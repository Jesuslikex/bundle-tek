'use client';
import { readPanelJson } from './read-panel-json';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import { decodeCounterPlan, type CounterPlan } from '@/lib/counter-trade-store';
import { initialCounterLedger, type CounterRules } from '@/lib/counter-trade';
import { solanaTokenAtoms } from '@/lib/solana-token-amount';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import { walletAddress } from '@/lib/wallet-workspace';
import type { PoolTrades } from '@/lib/pool-trades';
import type { PoolTradeSelection } from '@/lib/pool-trade-context';
import { Button } from './ui/button';
import { Input } from './ui/input';
import styles from './counter-trade-panel.module.css';

const endpoint = '/api/imported-projects/counter-trades';
async function responseData(
  url: string,
  signal: AbortSignal,
  payload?: object,
) {
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  const response = await fetch(
    url,
    payload
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: boundedSignal,
        }
      : { signal: boundedSignal, cache: 'no-store' },
  );
  const data = await readPanelJson(
    response,
    'Counter request unavailable. Reload saved history before retrying.',
  );
  if (!response.ok)
    throw new Error(
      (data as { error?: string })?.error || 'Counter request unavailable.',
    );
  return data;
}
export function CounterTradePanel({
  project,
  locked,
}: {
  project: ImportedTokenProject;
  locked: boolean;
}) {
  if (project.document.token.chain !== 'Solana') return null;
  return (
    <CounterWorkspace
      key={JSON.stringify([
        project.id,
        project.revision,
        project.archived,
        project.document,
        locked,
      ])}
      project={project}
      locked={locked}
    />
  );
}
function CounterWorkspace({
  project,
  locked,
}: {
  project: ImportedTokenProject;
  locked: boolean;
}) {
  const prefix = useId();
  const [plans, setPlans] = useState<CounterPlan[]>([]),
    [selected, setSelected] = useState('');
  const [side, setSide] = useState<'Buy' | 'Sell'>('Sell');
  const [replication, setReplication] = useState('100'),
    [minimum, setMinimum] = useState('1');
  const [mode, setMode] = useState<'rate' | 'minimum-token' | 'minimum-sol'>(
    'rate',
  );
  const [trigger, setTrigger] = useState('100'),
    [excluded, setExcluded] = useState('');
  const [tape, setTape] = useState<
      { label: string; selection: PoolTradeSelection }[]
    >([]),
    [trade, setTrade] = useState('');
  const [busy, setBusy] = useState(true),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const pending = useRef<AbortController | null>(null);
  const retry = useRef<{ key: string; id: string } | null>(null);
  const active = plans.find((p) => p.id === selected);
  const current =
    active?.ledger.scope.revision === project.revision &&
    active.ledger.scope.mint === project.document.token.address;
  const token = project.document.token;
  const blocked = locked || project.archived;
  const acceptRoster = useCallback(
    (value: unknown) => {
      const data = value as {
        projectId?: unknown;
        plans?: unknown[];
        executionAllowed?: unknown;
      };
      if (
        !data ||
        data.projectId !== project.id ||
        data.executionAllowed !== false ||
        !Array.isArray(data.plans) ||
        data.plans.length > 20
      )
        throw new Error('Counter roster context differs.');
      const saved = data.plans.map(decodeCounterPlan);
      if (
        saved.some((p) => p.projectId !== project.id) ||
        new Set(saved.map((p) => p.id)).size !== saved.length
      )
        throw new Error('Counter roster identity differs.');
      setPlans(saved);
      setSelected((old) =>
        saved.some((p) => p.id === old) ? old : (saved[0]?.id ?? ''),
      );
    },
    [project.id],
  );
  useEffect(() => {
    const c = new AbortController();
    pending.current = c;
    void responseData(
      `${endpoint}?${new URLSearchParams({ projectId: project.id })}`,
      c.signal,
    )
      .then((data) => {
        if (!c.signal.aborted) acceptRoster(data);
      })
      .catch((e) => {
        if (!c.signal.aborted)
          setError(
            e instanceof Error ? e.message : 'Counter history unavailable.',
          );
      })
      .finally(() => {
        if (!c.signal.aborted) {
          pending.current = null;
          setBusy(false);
        }
      });
    return () => pending.current?.abort();
  }, [project.id, acceptRoster]);
  async function run(
    url: string,
    payload: object | undefined,
    accept: (data: unknown) => void,
  ) {
    if (pending.current) return;
    const c = new AbortController();
    pending.current = c;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const data = await responseData(url, c.signal, payload);
      if (!c.signal.aborted) accept(data);
    } catch (e) {
      if (!c.signal.aborted)
        setError(
          e instanceof Error ? e.message : 'Counter request unavailable.',
        );
    } finally {
      if (!c.signal.aborted && pending.current === c) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  function acceptPlan(value: unknown, expectedId: string) {
    const data = value as {
      plan?: unknown;
      executionAllowed?: unknown;
      replayed?: unknown;
    };
    if (!data || data.executionAllowed !== false)
      throw new Error('Counter response differs.');
    const plan = decodeCounterPlan(data.plan);
    if (plan.projectId !== project.id || plan.id !== expectedId)
      throw new Error('Counter project differs.');
    setPlans((old) => [plan, ...old.filter((p) => p.id !== plan.id)]);
    setSelected(plan.id);
    setNotice(
      data.replayed
        ? 'Recovered the original recorded decision.'
        : 'Counter history saved. No transaction signed or sent.',
    );
  }
  function create() {
    if (blocked || pending.current) return;
    try {
      const rules: CounterRules = {
        format: 'counter-evaluator-v1',
        responseSide: side,
        replicationPercent: replication,
        minimumResponseTokenRaw: solanaTokenAtoms(
          minimum,
          token.decimals,
        ).toString(),
        trigger:
          mode === 'rate'
            ? { kind: 'rate', percent: trigger }
            : {
                kind: mode,
                minimumRaw: solanaTokenAtoms(
                  trigger,
                  mode === 'minimum-sol' ? 9 : token.decimals,
                ).toString(),
              },
        ignoredWallets: [
          ...new Set(
            excluded
              .split(/[\s,]+/)
              .filter(Boolean)
              .map((w) => walletAddress(w, 'Solana')),
          ),
        ],
      };
      if (rules.ignoredWallets.length > 100)
        throw new Error('Choose at most 100 excluded wallets.');
      initialCounterLedger(rules, {
        projectId: project.id,
        revision: project.revision,
        mint: token.address,
        decimals: token.decimals,
      });
      const key = JSON.stringify(rules);
      if (retry.current?.key !== key)
        retry.current = { key, id: crypto.randomUUID() };
      const expectedId = retry.current.id;
      void run(
        endpoint,
        {
          action: 'create',
          id: retry.current.id,
          projectId: project.id,
          projectRevision: project.revision,
          rules,
        },
        (data) => {
          acceptPlan(data, expectedId);
          retry.current = null;
        },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid Counter rules.');
    }
  }
  function control(state: CounterPlan['state']) {
    if (
      !active ||
      active.state === 'ended' ||
      (state === 'active' && (blocked || !current))
    )
      return;
    void run(
      endpoint,
      {
        action: 'control',
        id: active.id,
        projectId: project.id,
        revision: active.revision,
        state,
      },
      (data) => acceptPlan(data, active.id),
    );
  }
  function loadTape() {
    void run(
      `/api/imported-projects/trades?${new URLSearchParams({ id: project.id, revision: String(project.revision) })}`,
      undefined,
      (value) => {
        const data = value as {
          id?: unknown;
          revision?: unknown;
          executionAllowed?: unknown;
          observations?: PoolTrades[];
        };
        if (
          !data ||
          data.id !== project.id ||
          data.revision !== project.revision ||
          data.executionAllowed !== false ||
          !Array.isArray(data.observations) ||
          data.observations.length > 10
        )
          throw new Error('Saved trade tape context differs.');
        const choices = data.observations.flatMap((observation) => {
          if (
            observation.chain !== 'Solana' ||
            observation.address !== token.address ||
            observation.projectRevision !== project.revision ||
            observation.executionAllowed !== false ||
            !Array.isArray(observation.trades) ||
            observation.trades.length > 100 ||
            !Number.isFinite(Date.parse(observation.observedAt))
          )
            throw new Error('Saved trade tape context differs.');
          walletAddress(observation.pool, 'Solana');
          return observation.trades
            .filter((t) => ['Buy', 'Sell'].includes(t.side))
            .map((t) => ({
              label: `${t.side} · ${t.sender} · ${t.transaction}`,
              selection: {
                id: project.id,
                revision: project.revision,
                pool: observation.pool,
                tradeId: t.id,
                tapeObservedAt: observation.observedAt,
              },
            }));
        });
        setTape(choices);
        setTrade('');
        setNotice(
          `${choices.length} saved trade references loaded. The server verifies each selected trade.`,
        );
      },
    );
  }
  function evaluate() {
    const choice = tape[Number(trade)];
    if (
      !active ||
      active.state !== 'active' ||
      blocked ||
      !current ||
      trade === '' ||
      !choice
    )
      return;
    void run(
      endpoint,
      {
        action: 'evaluate',
        id: active.id,
        projectId: project.id,
        revision: active.revision,
        selection: choice.selection,
      },
      (data) => acceptPlan(data, active.id),
    );
  }
  const field = (
    label: string,
    name: string,
    value: string,
    set: (v: string) => void,
  ) => (
    <label htmlFor={`${prefix}-${name}`}>
      {label}
      <Input
        id={`${prefix}-${name}`}
        value={value}
        disabled={busy}
        onChange={(e) => set(e.target.value)}
      />
    </label>
  );
  return (
    <section aria-label="Counter Trading" className={styles.panel}>
      <h3>Counter Trading</h3>
      <p>
        Create a response to opposite-side trades. Evaluation records token
        targets; transaction review is not connected yet.
      </p>
      <fieldset disabled={busy || blocked}>
        <legend>New Counter rules</legend>
        <label htmlFor={`${prefix}-side`}>Response side</label>
        <select
          id={`${prefix}-side`}
          value={side}
          onChange={(e) => setSide(e.target.value as 'Buy' | 'Sell')}
        >
          <option value="Sell">Auto Sell after a buy</option>
          <option value="Buy">Auto Buy after a sell</option>
        </select>
        {field(
          'Replication factor (%)',
          'replication',
          replication,
          setReplication,
        )}
        <label htmlFor={`${prefix}-trigger`}>Trigger mode</label>
        <select
          id={`${prefix}-trigger`}
          value={mode}
          onChange={(e) => {
            setMode(e.target.value as typeof mode);
            setTrigger(e.target.value === 'rate' ? '100' : '1');
          }}
        >
          <option value="rate">Rate</option>
          <option value="minimum-token">Minimum token trade</option>
          <option value="minimum-sol">Minimum SOL trade</option>
        </select>
        {field(
          mode === 'rate'
            ? 'Response probability (%)'
            : mode === 'minimum-sol'
              ? 'Minimum observed SOL amount'
              : `Minimum observed ${token.symbol} amount`,
          'threshold',
          trigger,
          setTrigger,
        )}
        {field(
          `Minimum response (${token.symbol} tokens)`,
          'minimum',
          minimum,
          setMinimum,
        )}
        <label htmlFor={`${prefix}-excluded`}>Excluded wallets</label>
        <textarea
          id={`${prefix}-excluded`}
          value={excluded}
          onChange={(e) => setExcluded(e.target.value)}
          placeholder="Public addresses, separated by commas or spaces"
        />
        <p>
          Previously verified wallets and the selected trading wallet are
          excluded automatically. Watch-only holders remain eligible.
        </p>
        <Button type="button" onClick={create}>
          Save Counter rules
        </Button>
      </fieldset>
      <Button
        type="button"
        disabled={busy}
        onClick={() =>
          void run(
            `${endpoint}?${new URLSearchParams({ projectId: project.id })}`,
            undefined,
            acceptRoster,
          )
        }
      >
        Reload Counter history
      </Button>
      <label htmlFor={`${prefix}-plan`}>Saved Counter plan</label>
      <select
        id={`${prefix}-plan`}
        value={selected}
        disabled={busy}
        onChange={(e) => {
          setSelected(e.target.value);
          setTrade('');
          setNotice('');
        }}
      >
        <option value="">Choose a plan</option>
        {plans.map((p) => (
          <option key={p.id} value={p.id}>
            {p.rules.responseSide} · {p.state} · {p.id}
          </option>
        ))}
      </select>
      {active && (
        <>
          <p>
            State: {active.state}. Response: {active.rules.responseSide},{' '}
            {active.rules.replicationPercent}% replication. Queued:{' '}
            {formatNativeBalance(
              active.ledger.queuedTokenRaw,
              active.ledger.scope.decimals,
            )}{' '}
            tokens.
          </p>
          <p>
            Saved exclusions: {active.rules.ignoredWallets.length}. Trigger:{' '}
            {active.rules.trigger.kind === 'rate'
              ? `${active.rules.trigger.percent}% probability`
              : `${formatNativeBalance(active.rules.trigger.minimumRaw, active.rules.trigger.kind === 'minimum-sol' ? 9 : active.ledger.scope.decimals)} ${active.rules.trigger.kind === 'minimum-sol' ? 'SOL' : 'tokens'} minimum observed trade`}
            . Minimum response:{' '}
            {formatNativeBalance(
              active.rules.minimumResponseTokenRaw,
              active.ledger.scope.decimals,
            )}{' '}
            tokens.
          </p>
          {!current && (
            <p>
              Project context changed. Retained history is readable; create new
              reviewed rules to evaluate this project.
            </p>
          )}
          <Button
            type="button"
            disabled={busy || active.state !== 'active'}
            onClick={() => control('paused')}
          >
            Pause Counter
          </Button>
          <Button
            type="button"
            disabled={busy || blocked || !current || active.state !== 'paused'}
            onClick={() => control('active')}
          >
            Resume Counter
          </Button>
          <Button
            type="button"
            disabled={busy || active.state === 'ended'}
            onClick={() => control('ended')}
          >
            End Counter
          </Button>
          <p>
            Ending is permanent. Active permits manual evaluation only. Trades
            must occur after the creation of this plan and pass server freshness
            checks.
          </p>
          <Button
            type="button"
            disabled={busy || blocked || !current || active.state !== 'active'}
            onClick={loadTape}
          >
            Load saved trades
          </Button>
          <label htmlFor={`${prefix}-trade`}>Trade to evaluate</label>
          <select
            id={`${prefix}-trade`}
            value={trade}
            disabled={busy || blocked}
            onChange={(e) => setTrade(e.target.value)}
          >
            <option value="">Choose a saved trade</option>
            {tape.map((t, i) => (
              <option key={JSON.stringify(t.selection)} value={String(i)}>
                {t.label}
              </option>
            ))}
          </select>
          <Button
            type="button"
            disabled={
              busy ||
              blocked ||
              !current ||
              active.state !== 'active' ||
              trade === ''
            }
            onClick={evaluate}
          >
            Evaluate selected trade
          </Button>
          <ol aria-label="Recorded Counter decisions">
            {active.ledger.decisions.slice(-20).map((d) => (
              <li key={d.identity}>
                {d.outcome}. Contribution:{' '}
                {formatNativeBalance(
                  d.contributionTokenRaw,
                  active.ledger.scope.decimals,
                )}{' '}
                tokens
                {d.proposalTokenRaw !== null
                  ? `. Proposed target: ${formatNativeBalance(d.proposalTokenRaw, active.ledger.scope.decimals)} tokens`
                  : ''}
                .
              </li>
            ))}
          </ol>
          <p>
            {active.ledger.decisions.length} decisions saved; showing the latest
            20.
          </p>
        </>
      )}
      <div aria-live="polite">
        {busy && <p>Loading Counter data…</p>}
        {notice && <p>{notice}</p>}
        {error && <p role="alert">{error}</p>}
      </div>
    </section>
  );
}
