'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import {
  unlockVault,
  VAULT_STORAGE_KEY,
  type VaultSession,
} from '@/lib/browser-wallet-vault';
import {
  AutoBuyRunner,
  fmt,
  solToLamports,
  validateAutoBuy,
  type AutoBuyRules,
  type AutoBuySnapshot,
  type AutoBuyStrategy,
} from '@/lib/auto-buy-run';
import { createAutoSellFeed } from '@/lib/auto-sell-feed';
import {
  createRotatingTrader,
  TradeUncertainError,
} from '@/lib/imported-trade-execute';
import styles from './auto-buy-panel.module.css';

type Kind = 'Counter' | 'DCA' | 'Limit';
type Draft = {
  id: string;
  kind: Kind;
  rate: string;
  minSol: string;
  minTokens: string;
  replication: string;
  minPerTrade: string;
  interval: string;
  amountMode: 'Fixed' | 'Randomized';
  amount: string;
  maxAmount: string;
  rows: { cap: string; amount: string }[];
  capMin: string;
  capMax: string;
  endSol: string;
  endSeconds: string;
};
let seq = 0;
const newDraft = (kind: Kind): Draft => ({
  id: `s${++seq}`,
  kind,
  rate: '40',
  minSol: '0.1',
  minTokens: '0',
  replication: '20',
  minPerTrade: '',
  interval: '60',
  amountMode: 'Fixed',
  amount: '0.05',
  maxAmount: '0.1',
  rows: [{ cap: '', amount: '' }],
  capMin: '',
  capMax: '',
  endSol: '',
  endSeconds: '',
});
const optNum = (v: string, label: string) => {
  if (!v.trim()) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0)
    throw new Error(`${label} must be a positive number.`);
  return n;
};
const optSol = (v: string) => (v.trim() ? solToLamports(v.trim()) : undefined);
const optSecs = (v: string, label: string) => {
  const n = optNum(v, label);
  if (n !== undefined && !Number.isInteger(n))
    throw new Error(`${label} must be whole seconds.`);
  return n;
};

export function toStrategy(d: Draft): AutoBuyStrategy {
  const common = {
    id: d.id,
    marketCapMinUsd: optNum(d.capMin, 'Market cap minimum'),
    marketCapMaxUsd: optNum(d.capMax, 'Market cap maximum'),
    endLamports: optSol(d.endSol),
    endSeconds: optSecs(d.endSeconds, 'Strategy duration'),
  };
  if (d.kind === 'Counter')
    return {
      ...common,
      kind: 'Counter',
      ratePercent: Number(d.rate),
      minSolLamports: solToLamports(d.minSol || '0'),
      minTokens: Number(d.minTokens || '0'),
      replicationPercent: Number(d.replication),
      minPerTradeLamports: d.minPerTrade.trim()
        ? solToLamports(d.minPerTrade)
        : 0n,
    };
  if (d.kind === 'DCA') {
    const min = solToLamports(d.amount);
    return {
      ...common,
      kind: 'DCA',
      intervalSeconds: Number(d.interval),
      minLamports: min,
      maxLamports:
        d.amountMode === 'Randomized' ? solToLamports(d.maxAmount) : min,
    };
  }
  return {
    ...common,
    kind: 'Limit',
    rows: d.rows.map((r) => ({
      marketCapUsd: Number(r.cap),
      lamports: solToLamports(r.amount),
    })),
  };
}

function Field({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <input
        inputMode="decimal"
        value={value}
        placeholder={hint}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export function AutoBuyPanel({
  project,
  wallets,
  locked,
}: {
  project: ImportedTokenProject;
  wallets: WorkspaceWallet[];
  locked: boolean;
}) {
  const token = project.document.token;
  const solana = useMemo(
    () => wallets.filter((w) => w.chain === 'Solana' && !w.archived),
    [wallets],
  );
  const [drafts, setDrafts] = useState<Draft[]>([newDraft('Counter')]);
  const [budget, setBudget] = useState('');
  const [runSeconds, setRunSeconds] = useState('');
  const [startDelay, setStartDelay] = useState('');
  const [slippage, setSlippage] = useState('50');
  const [whitelist, setWhitelist] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [snap, setSnap] = useState<AutoBuySnapshot | null>(null);
  const runner = useRef<AutoBuyRunner | null>(null);
  const vault = useRef<VaultSession | null>(null);
  useEffect(
    () => () => {
      runner.current?.stop('Panel closed.');
      if (vault.current) vault.current.payload.wallets = [];
      vault.current = null;
    },
    [],
  );
  const patch = (id: string, p: Partial<Draft>) =>
    setDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, ...p } : d)));
  const running = snap?.running === true;

  async function start() {
    setError('');
    try {
      const strategies = drafts.map(toStrategy);
      const rules: AutoBuyRules = {
        budgetLamports: budget.trim() ? solToLamports(budget.trim()) : 0n,
        endSeconds: optSecs(runSeconds, 'Run duration'),
        startDelaySeconds: optSecs(startDelay, 'Start delay'),
        whitelist: whitelist.split(/[\s,]+/).filter(Boolean),
      };
      validateAutoBuy(strategies, rules);
      const bps = Number(slippage);
      if (!Number.isInteger(bps) || bps < 1 || bps > 50)
        throw new Error(
          'Slippage must be 1 to 50 bps (Bundle never quotes above 0.5%).',
        );
      const selected = solana.filter((w) => chosen.includes(w.address));
      if (!selected.length)
        throw new Error('Choose at least one wallet to buy with.');
      const encrypted = (() => {
        try {
          return localStorage.getItem(VAULT_STORAGE_KEY);
        } catch {
          return null;
        }
      })();
      if (!encrypted)
        throw new Error('Create or import wallets in the browser vault first.');
      const session = await unlockVault(encrypted, password).catch(() => {
        throw new Error('Wrong vault password.');
      });
      setPassword('');
      const missing = selected.find(
        (w) =>
          !session.payload.wallets.some(
            (v) => v.family === 'solana' && v.address === w.address,
          ),
      );
      if (missing) {
        session.payload.wallets = [];
        throw new Error(
          `Wallet ${missing.address.slice(0, 6)}… is not in this browser vault.`,
        );
      }
      vault.current = session;
      const instance = new AutoBuyRunner({
        strategies,
        rules,
        decimals: token.decimals,
        totalSupplyRaw: BigInt(token.totalSupplyRaw),
        ownWallets: new Set(
          wallets.filter((w) => w.chain === 'Solana').map((w) => w.address),
        ),
        readTrades: createAutoSellFeed(token.address),
        buy: createRotatingTrader(
          {
            projectId: project.id,
            projectRevision: project.revision,
            mint: token.address,
            decimals: token.decimals,
            session: () => vault.current,
            slippageBps: bps,
          },
          selected,
          'Buy',
        ),
        isUncertain: (e) => e instanceof TradeUncertainError,
        onUpdate: (s) => {
          setSnap(s);
          if (!s.running && vault.current) {
            vault.current.payload.wallets = [];
            vault.current = null;
          }
        },
      });
      runner.current = instance;
      instance.start();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to start Auto Buy.');
    }
  }

  if (token.chain !== 'Solana') return null;
  return (
    <details className={styles.panel}>
      <summary>
        AutoBuy
        {running
          ? ` · running · ${fmt(snap!.spentLamports)} / ${budget} SOL`
          : ''}
      </summary>
      <p className={styles.note}>
        Opt-in automatic buying. While this tab is open and the run is on,
        Bundle signs buys from your unlocked browser vault without asking each
        time, and never spends more than the SOL budget below. Stop ends it at
        once.
      </p>
      {drafts.map((d, index) => (
        <fieldset key={d.id} className={styles.strategy} disabled={running}>
          <legend>
            Strategy {index + 1}
            {drafts.length > 1 && (
              <button
                type="button"
                onClick={() =>
                  setDrafts((ds) => ds.filter((x) => x.id !== d.id))
                }
              >
                Remove
              </button>
            )}
          </legend>
          <div className={styles.kinds}>
            {(['Counter', 'DCA', 'Limit'] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={d.kind === k}
                onClick={() => patch(d.id, { kind: k })}
              >
                {k === 'Counter'
                  ? 'Counter Trading'
                  : k === 'DCA'
                    ? 'DCA'
                    : 'Limit Orders'}
              </button>
            ))}
          </div>
          {d.kind === 'Counter' && (
            <div className={styles.grid}>
              <Field
                label="Rate (%)"
                value={d.rate}
                onChange={(rate) => patch(d.id, { rate })}
              />
              <Field
                label="Min. SOL (observed sell)"
                value={d.minSol}
                onChange={(minSol) => patch(d.id, { minSol })}
              />
              <Field
                label="Min. Token (observed sell)"
                value={d.minTokens}
                onChange={(minTokens) => patch(d.id, { minTokens })}
              />
              <Field
                label="Replication factor (%)"
                value={d.replication}
                onChange={(replication) => patch(d.id, { replication })}
              />
              <Field
                label="Minimum per trade (SOL)"
                hint="optional"
                value={d.minPerTrade}
                onChange={(minPerTrade) => patch(d.id, { minPerTrade })}
              />
            </div>
          )}
          {d.kind === 'DCA' && (
            <div className={styles.grid}>
              <div className={styles.kinds}>
                {(['Fixed', 'Randomized'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={d.amountMode === m}
                    onClick={() => patch(d.id, { amountMode: m })}
                  >
                    {m === 'Fixed' ? 'Fixed Amount' : 'Randomized'}
                  </button>
                ))}
              </div>
              <Field
                label={
                  d.amountMode === 'Fixed' ? 'Amount (SOL)' : 'Min Amount (SOL)'
                }
                value={d.amount}
                onChange={(amount) => patch(d.id, { amount })}
              />
              {d.amountMode === 'Randomized' && (
                <Field
                  label="Max Amount (SOL)"
                  value={d.maxAmount}
                  onChange={(maxAmount) => patch(d.id, { maxAmount })}
                />
              )}
              <Field
                label="Interval (seconds, ≤ 86400)"
                value={d.interval}
                onChange={(interval) => patch(d.id, { interval })}
              />
            </div>
          )}
          {d.kind === 'Limit' && (
            <div className={styles.rows}>
              {d.rows.map((r, i) => (
                <div key={i} className={styles.grid}>
                  <Field
                    label={`Market cap (USD) #${i + 1}`}
                    value={r.cap}
                    onChange={(cap) =>
                      patch(d.id, {
                        rows: d.rows.map((x, j) =>
                          j === i ? { ...x, cap } : x,
                        ),
                      })
                    }
                  />
                  <Field
                    label="Amount (SOL)"
                    value={r.amount}
                    onChange={(amount) =>
                      patch(d.id, {
                        rows: d.rows.map((x, j) =>
                          j === i ? { ...x, amount } : x,
                        ),
                      })
                    }
                  />
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  patch(d.id, { rows: [...d.rows, { cap: '', amount: '' }] })
                }
              >
                Add row
              </button>
              <small>Each target must be lower than the previous one.</small>
            </div>
          )}
          <details>
            <summary>Market cap range and end conditions</summary>
            <div className={styles.grid}>
              <Field
                label="Market cap min (USD)"
                hint="optional"
                value={d.capMin}
                onChange={(capMin) => patch(d.id, { capMin })}
              />
              <Field
                label="Market cap max (USD)"
                hint="optional"
                value={d.capMax}
                onChange={(capMax) => patch(d.id, { capMax })}
              />
              <Field
                label="End after spending (SOL)"
                hint="optional"
                value={d.endSol}
                onChange={(endSol) => patch(d.id, { endSol })}
              />
              <Field
                label="End after (seconds)"
                hint="optional"
                value={d.endSeconds}
                onChange={(endSeconds) => patch(d.id, { endSeconds })}
              />
            </div>
          </details>
        </fieldset>
      ))}
      {!running && drafts.length < 8 && (
        <button
          type="button"
          onClick={() => setDrafts((ds) => [...ds, newDraft('DCA')])}
        >
          Add Strategy
        </button>
      )}
      <fieldset className={styles.strategy} disabled={running}>
        <legend>Run limits and Advanced Options</legend>
        <div className={styles.grid}>
          <Field
            label="Total SOL budget (required)"
            value={budget}
            onChange={setBudget}
          />
          <Field
            label="Global end after (seconds)"
            hint="optional"
            value={runSeconds}
            onChange={setRunSeconds}
          />
          <Field
            label="Start delay (seconds)"
            hint="optional"
            value={startDelay}
            onChange={setStartDelay}
          />
          <Field
            label="Slippage (bps, 1-50)"
            value={slippage}
            onChange={setSlippage}
          />
        </div>
        <label className={styles.field}>
          <span>
            Whitelist (addresses ignored by Counter Trading; your wallets are
            always ignored)
          </span>
          <textarea
            value={whitelist}
            onChange={(e) => setWhitelist(e.target.value)}
          />
        </label>
        <div className={styles.wallets}>
          <span>Choose wallets</span>
          {solana.map((w) => (
            <label key={w.address}>
              <input
                type="checkbox"
                checked={chosen.includes(w.address)}
                onChange={(e) =>
                  setChosen((c) =>
                    e.target.checked
                      ? [...c, w.address]
                      : c.filter((a) => a !== w.address),
                  )
                }
              />
              {w.label || `${w.address.slice(0, 4)}…${w.address.slice(-4)}`}
            </label>
          ))}
        </div>
      </fieldset>
      {!running ? (
        <form
          className={styles.actions}
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <input
            type="password"
            aria-label="Vault password"
            placeholder="Vault password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="submit" disabled={locked}>
            Run Strategy
          </button>
        </form>
      ) : (
        <div className={styles.actions}>
          {snap?.paused ? (
            <button type="button" onClick={() => runner.current?.resume()}>
              Resume
            </button>
          ) : (
            <button type="button" onClick={() => runner.current?.pause()}>
              Pause
            </button>
          )}
          <button type="button" onClick={() => runner.current?.stop()}>
            Stop
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {snap && (
        <div className={styles.status}>
          <p>
            Spent {fmt(snap.spentLamports)} SOL
            {snap.marketCapUsd !== null &&
              ` · market cap $${Math.round(snap.marketCapUsd).toLocaleString()}`}
            {snap.buying && ' · buying…'}
            {snap.endedReason && ` · ${snap.endedReason}`}
          </p>
          <ul aria-label="Auto Buy activity">
            {snap.log.slice(0, 20).map((l, i) => (
              <li key={`${l.at}-${i}`} data-kind={l.kind}>
                {new Date(l.at).toLocaleTimeString()} {l.text}
                {l.signature && (
                  <>
                    {' '}
                    <a
                      href={`https://solscan.io/tx/${l.signature}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      tx
                    </a>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </details>
  );
}
