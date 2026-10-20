'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  autoSellStrategyError,
  durationSeconds,
  formatDuration,
  marketCapFromPrice,
  marketCapInRange,
  marketCapLabel,
  newAutoSellStrategy,
  newLimitOrder,
  rawToDecimal,
  withAutoSellMode,
  type AutoSellLimitOrder,
  type AutoSellMode,
  type AutoSellStrategy,
} from '@/lib/auto-sell';
import { AutoSellRunner, type AutoSellSnapshot } from '@/lib/auto-sell-runner';
import { createAutoSellExecutor } from '@/lib/auto-sell-execute';
import { createAutoSellFeed } from '@/lib/auto-sell-feed';
import {
  unlockVault,
  VAULT_STORAGE_KEY,
  type VaultSession,
} from '@/lib/browser-wallet-vault';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import styles from './auto-sell-modal.module.css';

type Section = 'range' | 'end' | 'whitelist' | null;

const MODES: { mode: AutoSellMode; label: string; hint: string }[] = [
  {
    mode: 'counter',
    label: '↺ Counter Trading',
    hint: 'Counter Trade will sell tokens every time someone buys the token.',
  },
  {
    mode: 'dca',
    label: '◷ DCA',
    hint: 'DCA spreads your sells over time by selling at a fixed interval rather than all at once.',
  },
  {
    mode: 'limit',
    label: '⇡ Limit Orders',
    hint: 'Limit Orders sell each amount once when the market cap reaches its target. Each target must be higher than the one above.',
  },
];

const cleanNumber = (value: string) => value.replace(/[,\s$]/g, '');

/**
 * Holds a browser-wide lock for one token's Auto Sell so a second tab cannot
 * run the same strategy and sell twice. Resolves with a release function, or
 * null when another tab already holds it.
 */
function acquireRunLock(name: string): Promise<(() => void) | null> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return Promise.resolve(() => {});
  return new Promise((resolve, reject) => {
    locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(null);
          return undefined;
        }
        return new Promise<void>((release) => resolve(() => release()));
      })
      .catch(reject);
  });
}

/**
 * Proxima-style Auto Sell. Run Strategy is the single approval: after it,
 * matching sells are prepared, signed with the unlocked browser vault and
 * submitted without further clicks, while this tab stays open.
 */
export function AutoSell({
  project,
  wallets,
  locked,
}: {
  project: ImportedTokenProject;
  wallets: WorkspaceWallet[];
  locked: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [strategies, setStrategies] = useState<AutoSellStrategy[]>(() => [
    newAutoSellStrategy(0),
  ]);
  const [snapshot, setSnapshot] = useState<AutoSellSnapshot | null>(null);
  const runner = useRef<AutoSellRunner | null>(null);
  const vault = useRef<VaultSession | null>(null);
  const releaseLock = useRef<(() => void) | null>(null);
  const token = project.document.token;
  const solanaWallets = useMemo(
    () => wallets.filter((w) => w.chain === 'Solana' && !w.archived),
    [wallets],
  );
  const [sellWallets, setSellWallets] = useState<string[]>([]);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [previewCap, setPreviewCap] = useState<number | null>(null);
  const running = !!snapshot?.running;
  const ids = useId();

  function stop(reason = 'Stopped by you.') {
    runner.current?.stop(reason);
    if (vault.current) vault.current.payload.wallets = [];
    vault.current = null;
    if (runner.current) setSnapshot(runner.current.snapshot());
    if (!runner.current?.snapshot().selling) {
      releaseLock.current?.();
      releaseLock.current = null;
    }
  }

  useEffect(() => {
    const halt = (reason: string) => {
      runner.current?.stop(reason);
      if (vault.current) vault.current.payload.wallets = [];
      vault.current = null;
      releaseLock.current?.();
      releaseLock.current = null;
    };
    const onHide = () => halt('Tab closed.');
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      halt('Auto Sell closed.');
    };
  }, []);

  // Live market cap for the In-Range pill before Run.
  useEffect(() => {
    if (!open || running || token.chain !== 'Solana') return;
    const controller = new AbortController();
    const read = createAutoSellFeed(token.address);
    const load = () =>
      read(controller.signal)
        .then((trades) => {
          const price = trades.find((t) => Number(t.priceUsd) > 0)?.priceUsd;
          if (price)
            setPreviewCap(
              marketCapFromPrice(price, token.totalSupplyRaw, token.decimals),
            );
        })
        .catch(() => {});
    void load();
    const timer = setInterval(load, 15000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [
    open,
    running,
    token.address,
    token.chain,
    token.decimals,
    token.totalSupplyRaw,
  ]);

  const errors = strategies.map(autoSellStrategyError);
  const marketCap = running ? (snapshot?.marketCapUsd ?? null) : previewCap;

  function update(id: string, patch: Partial<AutoSellStrategy>) {
    setStrategies((list) =>
      list.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    );
  }

  async function run() {
    if (busy || running || snapshot?.selling || errors.some(Boolean)) return;
    setError('');
    if (token.chain !== 'Solana')
      return setError('Auto Sell supports Solana tokens.');
    if (!sellWallets.length)
      return setError(
        'Choose at least one wallet to sell from in Advanced Options.',
      );
    const encrypted = localStorage.getItem(VAULT_STORAGE_KEY);
    if (!encrypted)
      return setError(
        'Create or import your wallets in the browser vault first.',
      );
    setBusy(true);
    let release: (() => void) | null = null;
    try {
      release = await acquireRunLock(
        `bundle-auto-sell:${project.id}:${token.address}`,
      );
      if (!release)
        throw new Error(
          'Auto Sell is already running for this token in another tab.',
        );
      const session = await unlockVault(encrypted, password);
      setPassword('');
      const missing = sellWallets.filter(
        (a) =>
          !session.payload.wallets.some(
            (w) => w.family === 'solana' && w.address === a,
          ),
      );
      if (missing.length) {
        session.payload.wallets = [];
        throw new Error(
          `Wallet ${missing[0].slice(0, 6)}… is not in this browser vault.`,
        );
      }
      vault.current = session;
      const selected = solanaWallets.filter((w) =>
        sellWallets.includes(w.address),
      );
      const instance: AutoSellRunner = new AutoSellRunner({
        strategies,
        decimals: token.decimals,
        totalSupplyRaw: BigInt(token.totalSupplyRaw),
        // Archived wallets are still the user's own: never counter them.
        ownWallets: new Set(
          wallets.filter((w) => w.chain === 'Solana').map((w) => w.address),
        ),
        readTrades: createAutoSellFeed(token.address),
        sell: createAutoSellExecutor({
          projectId: project.id,
          projectRevision: project.revision,
          mint: token.address,
          decimals: token.decimals,
          wallets: selected.map((w) => ({
            address: w.address,
            revision: w.revision,
          })),
          session: () => vault.current,
        }),
        onUpdate: (next) => {
          // A previous run finishing its last sell must not touch this one.
          if (runner.current !== instance) return;
          setSnapshot(next);
          if (!next.running && !next.selling) {
            if (vault.current) vault.current.payload.wallets = [];
            vault.current = null;
            releaseLock.current?.();
            releaseLock.current = null;
          }
        },
      });
      runner.current = instance;
      releaseLock.current = release;
      release = null;
      instance.start();
    } catch (e) {
      release?.();
      setError(e instanceof Error ? e.message : 'Could not unlock the vault.');
    } finally {
      setBusy(false);
    }
  }

  const supply = toRaw(token.totalSupplyRaw);
  const pct = (raw: bigint) =>
    supply > 0n
      ? `${(Number((raw * 1_000_000n) / supply) / 10_000).toFixed(4)}%`
      : '';

  return (
    <>
      <Button
        variant="outline"
        disabled={locked && !running}
        onClick={() => setOpen(true)}
      >
        {running ? 'Auto Sell · running' : 'Auto Sell'}
      </Button>
      {open && (
        <div className={styles.overlay}>
          <dialog
            open
            aria-modal="true"
            aria-labelledby="auto-sell-title"
            className={styles.modal}
          >
            <header className={styles.header}>
              <h2 id="auto-sell-title">Auto Sell</h2>
              <button
                type="button"
                aria-label="Close"
                className={styles.x}
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </header>
            <div className={styles.body}>
              {strategies.map((s, i) => (
                <StrategyCard
                  key={s.id}
                  strategy={s}
                  error={errors[i]}
                  disabled={running || busy}
                  inRange={marketCapInRange(s, marketCap)}
                  state={snapshot?.states[s.id]}
                  pct={pct}
                  decimals={token.decimals}
                  canDelete={strategies.length > 1}
                  onChange={(patch) => update(s.id, patch)}
                  onDelete={() =>
                    setStrategies((list) => list.filter((x) => x.id !== s.id))
                  }
                />
              ))}
              {!running && (
                <button
                  type="button"
                  className={styles.add}
                  disabled={busy || strategies.length >= 5}
                  onClick={() =>
                    setStrategies((list) => [
                      ...list,
                      newAutoSellStrategy(list.length),
                    ])
                  }
                >
                  + Add Strategy
                </button>
              )}
              <details
                className={styles.advanced}
                open={!sellWallets.length || undefined}
              >
                <summary>Advanced Options</summary>
                <fieldset disabled={running || busy}>
                  <legend>Sell from wallets</legend>
                  {solanaWallets.length === 0 && (
                    <p>No Solana wallets in this workspace.</p>
                  )}
                  {solanaWallets.map((w) => (
                    <label key={w.address} className={styles.check}>
                      <input
                        type="checkbox"
                        checked={sellWallets.includes(w.address)}
                        onChange={(e) =>
                          setSellWallets((list) =>
                            e.target.checked
                              ? [...list, w.address]
                              : list.filter((a) => a !== w.address),
                          )
                        }
                      />
                      <span>{w.label || 'Wallet'}</span>
                      <code>
                        {w.address.slice(0, 6)}…{w.address.slice(-4)}
                      </code>
                    </label>
                  ))}
                  <p className={styles.hint}>
                    Your own workspace wallets never trigger a counter sell.
                    Each sell comes from one wallet, rotating through the ones
                    you pick.
                  </p>
                </fieldset>
              </details>
              {!running && (
                <div className={styles.field}>
                  <label htmlFor={`${ids}-password`}>Vault password</label>
                  <Input
                    id={`${ids}-password`}
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    disabled={busy}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <small className={styles.hint}>
                    Run Strategy unlocks your browser vault for this tab and
                    approves every sell these strategies make (counter, DCA and
                    limit order sells), until they end or you press Stop. Keep
                    this tab open. Each sell still goes through the
                    server&apos;s balance, simulation and 15-second read checks,
                    so sells land about every 30 seconds at most.
                  </small>
                </div>
              )}
              {error && (
                <p role="alert" className={styles.alert}>
                  {error}
                </p>
              )}
              {snapshot && snapshot.log.length > 0 && (
                <section aria-label="Auto Sell activity" className={styles.log}>
                  <h3>Activity</h3>
                  <ol>
                    {[...snapshot.log]
                      .reverse()
                      .slice(0, 20)
                      .map((entry, n) => (
                        <li key={`${entry.at}-${n}`} data-kind={entry.kind}>
                          <time>{new Date(entry.at).toLocaleTimeString()}</time>{' '}
                          {entry.text}
                          {entry.signature && (
                            <a
                              href={`https://solscan.io/tx/${entry.signature}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {' '}
                              tx
                            </a>
                          )}
                        </li>
                      ))}
                  </ol>
                </section>
              )}
            </div>
            <footer className={styles.footer}>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Close
              </Button>
              {running ? (
                <Button variant="destructive" onClick={() => stop()}>
                  Stop
                </Button>
              ) : (
                <Button
                  disabled={
                    busy ||
                    locked ||
                    !!snapshot?.selling ||
                    errors.some(Boolean) ||
                    !password
                  }
                  onClick={() => void run()}
                >
                  {busy
                    ? 'Unlocking…'
                    : `Run ${strategies.length} Strateg${strategies.length === 1 ? 'y' : 'ies'}`}
                </Button>
              )}
            </footer>
          </dialog>
        </div>
      )}
    </>
  );
}

function StrategyCard({
  strategy: s,
  error,
  disabled,
  inRange,
  state,
  pct,
  decimals,
  canDelete,
  onChange,
  onDelete,
}: {
  strategy: AutoSellStrategy;
  error: string | null;
  disabled: boolean;
  inRange: boolean;
  state?: AutoSellSnapshot['states'][string];
  pct: (raw: bigint) => string;
  decimals: number;
  canDelete: boolean;
  onChange: (patch: Partial<AutoSellStrategy>) => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const id = useId();
  const [section, setSection] = useState<Section>(null);
  const [hours, setHours] = useState('');
  const [minutes, setMinutes] = useState('');
  const [seconds, setSeconds] = useState('');
  const [whitelistText, setWhitelistText] = useState(s.whitelist.join('\n'));
  const [dcaInterval, setDcaIntervalParts] = useState({ h: '', m: '', s: '' });
  const setDuration = (h: string, m: string, sec: string) => {
    setHours(h);
    setMinutes(m);
    setSeconds(sec);
    onChange({ endDurationSeconds: durationSeconds(h, m, sec) });
  };
  const setDcaInterval = (next: typeof dcaInterval) => {
    setDcaIntervalParts(next);
    onChange({ dcaIntervalSeconds: durationSeconds(next.h, next.m, next.s) });
  };
  const unit = s.amountUnit === 'supply' ? '% Supply' : 'Tokens';
  const updateRow = (rowId: string, patch: Partial<AutoSellLimitOrder>) =>
    onChange({
      limitOrders: s.limitOrders.map((row) =>
        row.id === rowId ? { ...row, ...patch } : row,
      ),
    });
  const modeInfo = MODES.find((m) => m.mode === s.mode)!;
  const stats = !state
    ? ''
    : s.mode === 'dca'
      ? `${state.responses} DCA sell${state.responses === 1 ? '' : 's'}`
      : s.mode === 'limit'
        ? `${state.filledLimitIds.length}/${s.limitOrders.length} limit orders hit`
        : `${state.responses} buys countered`;
  const t = s.trigger;
  const triggerValue = t.kind === 'rate' ? t.percent : t.amount;
  const endLabel =
    [
      s.endMaxSupplyPercent ? `${s.endMaxSupplyPercent}%` : '',
      s.endDurationSeconds > 0 ? formatDuration(s.endDurationSeconds) : '',
    ]
      .filter(Boolean)
      .join(' · ') || '—';
  return (
    <article className={styles.card} aria-label={`${s.name} strategy`}>
      <div className={styles.cardHead}>
        <div>
          <strong>
            {s.name}
            {error && (
              <span
                className={styles.dot}
                aria-label="Needs attention"
                title={error}
              />
            )}
          </strong>
          <span className={styles.range}>
            {marketCapLabel(s)}
            <span className={inRange ? styles.inRange : styles.outRange}>
              {inRange ? 'In-Range' : 'Out-of-Range'}
            </span>
            {state && state.status !== 'running' && (
              <span className={styles.outRange}>
                {state.endedReason ?? state.status}
              </span>
            )}
          </span>
        </div>
        <div className={styles.cardActions}>
          {canDelete && !disabled && (
            <button
              type="button"
              aria-label="Delete strategy"
              onClick={onDelete}
            >
              🗑
            </button>
          )}
          <button
            type="button"
            aria-label={expanded ? 'Collapse' : 'Expand'}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? '⌃' : '⌄'}
          </button>
        </div>
      </div>
      {state && (
        <p className={styles.stats}>
          Sold {rawToDecimal(state.soldRaw, decimals)} ({pct(state.soldRaw)}{' '}
          supply) · queued{' '}
          {rawToDecimal(state.bufferedRaw + state.inFlightRaw, decimals)} ·{' '}
          {stats}
        </p>
      )}
      {expanded && (
        <fieldset disabled={disabled} className={styles.cardBody}>
          <legend className={styles.label}>Mode</legend>
          <div className={styles.tiles3} aria-label="Mode">
            {MODES.map((m) => (
              <button
                key={m.mode}
                type="button"
                aria-pressed={s.mode === m.mode}
                className={s.mode === m.mode ? styles.tileActive : styles.tile}
                onClick={() => {
                  if (s.mode === m.mode) return;
                  if (section === 'whitelist') setSection(null);
                  onChange(withAutoSellMode(s, m.mode));
                }}
              >
                {m.label}
              </button>
            ))}
          </div>
          <p className={styles.hint}>{modeInfo.hint}</p>
          {s.mode === 'counter' && (
            <>
              <div className={styles.field}>
                <label htmlFor={`${id}-rep`}>
                  Replication Factor<em>*</em>
                </label>
                <div className={styles.suffixed}>
                  <Input
                    id={`${id}-rep`}
                    inputMode="decimal"
                    placeholder="50"
                    value={s.replicationPercent}
                    onChange={(e) =>
                      onChange({ replicationPercent: e.target.value.trim() })
                    }
                  />
                  <span>%</span>
                </div>
              </div>
              <div className={styles.field}>
                <span>
                  Trigger Condition<em>*</em>
                </span>
                <div className={styles.row}>
                  <select
                    aria-label="Trigger type"
                    value={t.kind}
                    onChange={(e) => {
                      const kind = e.target
                        .value as AutoSellStrategy['trigger']['kind'];
                      onChange({
                        trigger:
                          kind === 'rate'
                            ? { kind, percent: '100' }
                            : { kind, amount: '' },
                      });
                    }}
                  >
                    <option value="rate">Rate (%)</option>
                    <option value="min-sol">Min. SOL</option>
                    <option value="min-token">Min. Token</option>
                  </select>
                  <Input
                    aria-label="Trigger value"
                    inputMode="decimal"
                    value={triggerValue}
                    onChange={(e) => {
                      const v = e.target.value.trim();
                      onChange({
                        trigger:
                          t.kind === 'rate'
                            ? { kind: 'rate', percent: v }
                            : { kind: t.kind, amount: v },
                      });
                    }}
                  />
                </div>
              </div>
              <div className={styles.field}>
                <label htmlFor={`${id}-min`}>
                  Min. % Supply per Sell <small>(optional)</small>
                </label>
                <div className={styles.suffixed}>
                  <Input
                    id={`${id}-min`}
                    inputMode="decimal"
                    placeholder="0.1"
                    value={s.minSupplyPercentPerSell}
                    onChange={(e) =>
                      onChange({
                        minSupplyPercentPerSell: e.target.value.trim(),
                      })
                    }
                  />
                  <span>% Supply</span>
                </div>
              </div>
            </>
          )}
          {s.mode !== 'counter' && (
            <div className={styles.field}>
              <span>Amount unit</span>
              <div className={styles.tiles2} aria-label="Amount unit">
                {(['supply', 'tokens'] as const).map((u) => (
                  <button
                    key={u}
                    type="button"
                    aria-pressed={s.amountUnit === u}
                    className={
                      s.amountUnit === u ? styles.tileActive : styles.tile
                    }
                    onClick={() => onChange({ amountUnit: u })}
                  >
                    {u === 'supply' ? '% Supply' : 'Token amount'}
                  </button>
                ))}
              </div>
            </div>
          )}
          {s.mode === 'dca' && (
            <>
              <div className={styles.tiles2} aria-label="Amount type">
                {[false, true].map((random) => (
                  <button
                    key={String(random)}
                    type="button"
                    aria-pressed={s.dcaRandomized === random}
                    className={
                      s.dcaRandomized === random
                        ? styles.tileActive
                        : styles.tile
                    }
                    onClick={() => onChange({ dcaRandomized: random })}
                  >
                    {random ? 'Randomized' : 'Fixed Amount'}
                  </button>
                ))}
              </div>
              {s.dcaRandomized ? (
                <div className={styles.row}>
                  <div className={styles.field}>
                    <label htmlFor={`${id}-dcamin`}>
                      Min Amount<em>*</em>
                    </label>
                    <div className={styles.suffixed}>
                      <Input
                        id={`${id}-dcamin`}
                        inputMode="decimal"
                        value={s.dcaMinAmount}
                        onChange={(e) =>
                          onChange({
                            dcaMinAmount: cleanNumber(e.target.value),
                          })
                        }
                      />
                      <span>{unit}</span>
                    </div>
                  </div>
                  <div className={styles.field}>
                    <label htmlFor={`${id}-dcamax`}>
                      Max Amount<em>*</em>
                    </label>
                    <div className={styles.suffixed}>
                      <Input
                        id={`${id}-dcamax`}
                        inputMode="decimal"
                        value={s.dcaMaxAmount}
                        onChange={(e) =>
                          onChange({
                            dcaMaxAmount: cleanNumber(e.target.value),
                          })
                        }
                      />
                      <span>{unit}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className={styles.field}>
                  <label htmlFor={`${id}-dcaamt`}>
                    Amount<em>*</em>
                  </label>
                  <div className={styles.suffixed}>
                    <Input
                      id={`${id}-dcaamt`}
                      inputMode="decimal"
                      placeholder={s.amountUnit === 'supply' ? '0.1' : '1000'}
                      value={s.dcaAmount}
                      onChange={(e) =>
                        onChange({ dcaAmount: cleanNumber(e.target.value) })
                      }
                    />
                    <span>{unit}</span>
                  </div>
                </div>
              )}
              <div className={styles.field}>
                <span>
                  Interval<em>*</em> <small>(up to 24 hours)</small>
                </span>
                <div className={styles.duration}>
                  <Input
                    aria-label="Interval hours"
                    inputMode="numeric"
                    placeholder="HOURS"
                    value={dcaInterval.h}
                    onChange={(e) =>
                      setDcaInterval({ ...dcaInterval, h: e.target.value })
                    }
                  />
                  <span>:</span>
                  <Input
                    aria-label="Interval minutes"
                    inputMode="numeric"
                    placeholder="MIN"
                    value={dcaInterval.m}
                    onChange={(e) =>
                      setDcaInterval({ ...dcaInterval, m: e.target.value })
                    }
                  />
                  <span>:</span>
                  <Input
                    aria-label="Interval seconds"
                    inputMode="numeric"
                    placeholder="SEC"
                    value={dcaInterval.s}
                    onChange={(e) =>
                      setDcaInterval({ ...dcaInterval, s: e.target.value })
                    }
                  />
                </div>
                <small className={styles.hint}>
                  The first sell goes out when you press Run. Sells take about
                  30 seconds each, so short intervals run back to back.
                </small>
              </div>
            </>
          )}
          {s.mode === 'limit' && (
            <div className={styles.field}>
              <span>
                Orders<em>*</em>
              </span>
              <ol className={styles.orders}>
                {s.limitOrders.map((row, i) => {
                  const hit = state?.filledLimitIds.includes(row.id);
                  return (
                    <li key={row.id} data-hit={hit || undefined}>
                      <div className={styles.suffixed}>
                        <Input
                          aria-label={`Order ${i + 1} amount`}
                          inputMode="decimal"
                          placeholder="Amount"
                          value={row.amount}
                          onChange={(e) =>
                            updateRow(row.id, {
                              amount: cleanNumber(e.target.value),
                            })
                          }
                        />
                        <span>{unit}</span>
                      </div>
                      <div className={styles.suffixed}>
                        <span>$</span>
                        <Input
                          aria-label={`Order ${i + 1} market cap`}
                          inputMode="decimal"
                          placeholder="Market Cap (USD)"
                          value={row.marketCapUsd}
                          onChange={(e) =>
                            updateRow(row.id, {
                              marketCapUsd: cleanNumber(e.target.value),
                            })
                          }
                        />
                      </div>
                      {hit ? (
                        <span className={styles.inRange}>Hit</span>
                      ) : (
                        s.limitOrders.length > 1 && (
                          <button
                            type="button"
                            aria-label={`Remove order ${i + 1}`}
                            onClick={() =>
                              onChange({
                                limitOrders: s.limitOrders.filter(
                                  (x) => x.id !== row.id,
                                ),
                              })
                            }
                          >
                            ×
                          </button>
                        )
                      )}
                    </li>
                  );
                })}
              </ol>
              {s.limitOrders.length < 10 && (
                <button
                  type="button"
                  className={styles.add}
                  onClick={() =>
                    onChange({
                      limitOrders: [...s.limitOrders, newLimitOrder()],
                    })
                  }
                >
                  + Add Order
                </button>
              )}
            </div>
          )}
          <div className={s.mode === 'counter' ? styles.tiles3 : styles.tiles2}>
            <button
              type="button"
              aria-expanded={section === 'range'}
              className={section === 'range' ? styles.tileActive : styles.tile}
              onClick={() => setSection(section === 'range' ? null : 'range')}
            >
              Market Cap Range
              <small>
                {marketCapLabel(s).replace(/\$/g, '').replace(' → ', '->')}
              </small>
            </button>
            <button
              type="button"
              aria-expanded={section === 'end'}
              className={section === 'end' ? styles.tileActive : styles.tile}
              onClick={() => setSection(section === 'end' ? null : 'end')}
            >
              End Conditions
              <small>{endLabel}</small>
            </button>
            {s.mode === 'counter' && (
              <button
                type="button"
                aria-expanded={section === 'whitelist'}
                className={
                  section === 'whitelist' ? styles.tileActive : styles.tile
                }
                onClick={() =>
                  setSection(section === 'whitelist' ? null : 'whitelist')
                }
              >
                Whitelist
                <small>
                  {s.whitelist.length} Wallet
                  {s.whitelist.length === 1 ? '' : 's'}
                </small>
              </button>
            )}
          </div>
          {section === 'range' && (
            <div className={styles.panel}>
              <p>
                <strong>Market Cap Range</strong> <small>(optional)</small>
                <br />
                <span className={styles.hint}>
                  Sell only while the token&apos;s market cap is between these
                  values. Outside the range, buys are skipped and queued sells
                  wait; DCA pauses without stacking missed sells.
                </span>
              </p>
              <div className={styles.row}>
                <div className={styles.field}>
                  <label htmlFor={`${id}-mcmin`}>Start market cap</label>
                  <div className={styles.suffixed}>
                    <span>$</span>
                    <Input
                      id={`${id}-mcmin`}
                      inputMode="decimal"
                      placeholder="0"
                      value={s.marketCapMinUsd}
                      onChange={(e) =>
                        onChange({
                          marketCapMinUsd: e.target.value.replace(
                            /[,\s$]/g,
                            '',
                          ),
                        })
                      }
                    />
                  </div>
                </div>
                <div className={styles.field}>
                  <label htmlFor={`${id}-mcmax`}>End market cap</label>
                  <div className={styles.suffixed}>
                    <span>$</span>
                    <Input
                      id={`${id}-mcmax`}
                      inputMode="decimal"
                      placeholder="∞"
                      value={s.marketCapMaxUsd}
                      onChange={(e) =>
                        onChange({
                          marketCapMaxUsd: e.target.value.replace(
                            /[,\s$]/g,
                            '',
                          ),
                        })
                      }
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
          {section === 'end' && (
            <div className={styles.panel}>
              <p>
                <strong>End Conditions</strong> <small>(optional)</small>
                <br />
                <span className={styles.hint}>
                  You can choose to stop this strategy only after a certain
                  amount of tokens has been sold, after a certain amount of time
                  has passed, or both. Other strategies will continue running.
                </span>
              </p>
              <div className={styles.row}>
                <div className={styles.field}>
                  <label htmlFor={`${id}-max`}>
                    Max Amount <small>(optional)</small>
                  </label>
                  <div className={styles.suffixed}>
                    <Input
                      id={`${id}-max`}
                      inputMode="decimal"
                      placeholder="1"
                      value={s.endMaxSupplyPercent}
                      onChange={(e) =>
                        onChange({ endMaxSupplyPercent: e.target.value.trim() })
                      }
                    />
                    <span>% Supply</span>
                  </div>
                </div>
                <div className={styles.field}>
                  <span>
                    Duration <small>(optional)</small>
                  </span>
                  <div className={styles.duration}>
                    <Input
                      aria-label="Hours"
                      inputMode="numeric"
                      placeholder="HOURS"
                      value={hours}
                      onChange={(e) =>
                        setDuration(e.target.value, minutes, seconds)
                      }
                    />
                    <span>:</span>
                    <Input
                      aria-label="Minutes"
                      inputMode="numeric"
                      placeholder="MIN"
                      value={minutes}
                      onChange={(e) =>
                        setDuration(hours, e.target.value, seconds)
                      }
                    />
                    <span>:</span>
                    <Input
                      aria-label="Seconds"
                      inputMode="numeric"
                      placeholder="SEC"
                      value={seconds}
                      onChange={(e) =>
                        setDuration(hours, minutes, e.target.value)
                      }
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
          {section === 'whitelist' && s.mode === 'counter' && (
            <div className={styles.panel}>
              <p>
                <strong>Whitelist</strong>
                <br />
                <span className={styles.hint}>
                  Buys from these wallets are never counter-sold. Your own
                  workspace wallets are always excluded.
                </span>
              </p>
              <textarea
                aria-label="Whitelisted wallets"
                rows={3}
                placeholder="One address per line"
                value={whitelistText}
                onChange={(e) => {
                  setWhitelistText(e.target.value);
                  onChange({
                    whitelist: e.target.value.split(/[\s,]+/).filter(Boolean),
                  });
                }}
              />
            </div>
          )}
          {error && (
            <p className={styles.alert} role="alert">
              {error}
            </p>
          )}
        </fieldset>
      )}
    </article>
  );
}

function toRaw(value: string) {
  return BigInt(value);
}
