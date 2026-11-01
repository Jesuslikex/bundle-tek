'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { WalletFolder, WorkspaceWallet } from '@/lib/wallet-workspace';
import {
  unlockVault,
  VAULT_STORAGE_KEY,
  type VaultSession,
} from '@/lib/browser-wallet-vault';
import {
  executeAcrossWallets,
  executeImportedTrade,
  percentOfBalance,
  readGroupTokenBalances,
  type MultiWalletOutcome,
  type TradeSide,
} from '@/lib/imported-trade-execute';
import { warmupAtoms } from '@/lib/wallet-warmup';
import { rawToDecimal } from '@/lib/auto-sell';
import { hotkeyAction, validQuickAmount } from '@/lib/user-settings';
import { useUserSettings } from './use-user-settings';
import styles from './instant-trade-panel.module.css';

const POSITION_KEY = 'bundle-instant-trade-position-v1';
const LOOK_KEY = 'bundle-instant-trade-look-v1';
type Look = { opacity: number; blur: number };
function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...(JSON.parse(raw) as T) } : fallback;
  } catch {
    return fallback;
  }
}
function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* blocked storage: position resets next visit */
  }
}
const clampPosition = (x: number, y: number) => ({
  x: Math.max(0, Math.min(x, window.innerWidth - 320)),
  y: Math.max(0, Math.min(y, window.innerHeight - 80)),
});
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export function InstantTradePanel({
  project,
  wallets,
  folders = [],
  locked,
}: {
  project: ImportedTokenProject;
  wallets: WorkspaceWallet[];
  folders?: WalletFolder[];
  locked: boolean;
}) {
  const settings = useUserSettings();
  const token = project.document.token;
  const solana = useMemo(
    () => wallets.filter((w) => w.chain === 'Solana' && !w.archived),
    [wallets],
  );
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<TradeSide>('Buy');
  const [amount, setAmount] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<'Stagger' | 'Parallel'>('Stagger');
  const [delayMs, setDelayMs] = useState('0');
  const [password, setPassword] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [outcomes, setOutcomes] = useState<MultiWalletOutcome[]>([]);
  const [balances, setBalances] = useState<Record<string, bigint>>({});
  const [balanceError, setBalanceError] = useState('');
  const [pos, setPos] = useState({ x: 24, y: 96 });
  const [look, setLook] = useState<Look>({ opacity: 1, blur: 0 });
  const vault = useRef<VaultSession | null>(null);
  const run = useRef<AbortController | null>(null);
  const spaceHeld = useRef(false);

  useEffect(() => {
    if (!open) return;
    const onResize = () => setPos((p) => clampPosition(p.x, p.y));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open]);
  function openPanel() {
    const p = readJson(POSITION_KEY, { x: 24, y: 96 });
    setPos(clampPosition(p.x, p.y));
    setLook(readJson(LOOK_KEY, { opacity: 1, blur: 0 }));
    setOpen(true);
  }
  useEffect(
    () => () => {
      run.current?.abort();
      if (vault.current) vault.current.payload.wallets = [];
      vault.current = null;
    },
    [],
  );
  const scope = useMemo(
    () => solana.filter((w) => selected.includes(w.address)),
    [solana, selected],
  );
  const ctx = useMemo(
    () => ({
      projectId: project.id,
      projectRevision: project.revision,
      mint: token.address,
      decimals: token.decimals,
      session: () => vault.current,
    }),
    [project.id, project.revision, token.address, token.decimals],
  );

  // One gated group read for up to 25 wallets; failures propagate to Sell.
  const refreshBalances = useCallback(async () => {
    setBalanceError('');
    try {
      const next = await readGroupTokenBalances(
        ctx,
        scope,
        new AbortController().signal,
      );
      setBalances(next);
      return next;
    } catch (e) {
      setBalanceError(
        e instanceof Error ? e.message : 'Holdings refresh unavailable.',
      );
      throw e;
    }
  }, [ctx, scope]);

  async function unlock() {
    setError('');
    const encrypted = (() => {
      try {
        return localStorage.getItem(VAULT_STORAGE_KEY);
      } catch {
        return null;
      }
    })();
    if (!encrypted)
      return setError('Create or import wallets in the browser vault first.');
    try {
      const session = await unlockVault(encrypted, password);
      setPassword('');
      vault.current = session;
      setUnlocked(true);
    } catch {
      setError('Wrong vault password.');
    }
  }
  function lock() {
    run.current?.abort();
    if (vault.current) vault.current.payload.wallets = [];
    vault.current = null;
    setUnlocked(false);
  }

  const submit = useCallback(
    async (tradeSide: TradeSide, tradeAmount: string) => {
      if (busy || locked) return;
      setError('');
      if (!vault.current) return setError('Unlock the vault first.');
      if (!scope.length) return setError('Choose at least one wallet.');
      if (!validQuickAmount(tradeAmount))
        return setError('Enter a positive amount with up to 4 decimals.');
      if (tradeSide === 'Sell' && Number(tradeAmount) > 100)
        return setError('Sell percent cannot exceed 100.');
      const missing = scope.find(
        (w) =>
          !vault.current!.payload.wallets.some(
            (v) => v.family === 'solana' && v.address === w.address,
          ),
      );
      if (missing)
        return setError(
          `Wallet ${short(missing.address)} is not in this browser vault.`,
        );
      if (
        settings?.tradePanel.confirmDevTrades &&
        scope.some((w) => w.role === 'Deployer') &&
        !window.confirm(
          `This ${tradeSide.toLowerCase()} includes a developer/deployer wallet. Continue?`,
        )
      )
        return;
      const delay = Number(delayMs);
      if (!Number.isSafeInteger(delay) || delay < 0 || delay > 600000)
        return setError('Buy delay must be 0 to 600000 ms.');
      const controller = new AbortController();
      run.current = controller;
      setBusy(true);
      setOutcomes([]);
      try {
        let sizes: Record<string, bigint> = {};
        if (tradeSide === 'Buy') {
          const lamports = warmupAtoms(tradeAmount, 9);
          sizes = Object.fromEntries(scope.map((w) => [w.address, lamports]));
        } else {
          const fresh = await refreshBalances();
          for (const w of scope) {
            const bal = fresh[w.address];
            if (bal !== undefined)
              sizes[w.address] = percentOfBalance(bal, tradeAmount);
          }
        }
        const targets = scope.filter((w) => (sizes[w.address] ?? 0n) > 0n);
        if (!targets.length)
          throw new Error('No selected wallet has a balance to trade.');
        await executeAcrossWallets(
          targets,
          mode,
          delay,
          (w, signal) =>
            executeImportedTrade(ctx, w, tradeSide, sizes[w.address], signal),
          controller.signal,
          undefined,
          (o) => setOutcomes((list) => [...list, o]),
        );
        void refreshBalances().catch(() => {});
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Trade failed.');
      } finally {
        setBusy(false);
        run.current = null;
      }
    },
    [busy, locked, scope, settings, delayMs, mode, ctx, refreshBalances],
  );

  const quick = (index: number, tradeSide: TradeSide) => {
    if (!settings) return;
    const list =
      tradeSide === 'Buy'
        ? settings.walletTrades.buyAmounts
        : settings.walletTrades.sellPercents;
    const value = list[index];
    if (!value) return;
    setSide(tradeSide);
    if (settings.tradePanel.instantTrade) void submit(tradeSide, value);
    else setAmount(value);
  };

  useEffect(() => {
    if (!open || !settings?.hotkeys.enabled) return;
    const typing = (t: EventTarget | null) =>
      t instanceof HTMLElement &&
      (t.tagName === 'INPUT' ||
        t.tagName === 'TEXTAREA' ||
        t.isContentEditable);
    const down = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      if (e.code === 'Space') {
        spaceHeld.current = true;
        e.preventDefault();
        return;
      }
      const action = hotkeyAction(settings, e.key, spaceHeld.current);
      if (!action) return;
      e.preventDefault();
      const list =
        action.side === 'Buy'
          ? settings.walletTrades.buyAmounts
          : settings.walletTrades.sellPercents;
      setSide(action.side);
      // A hotkey is an explicit trade instruction, like Proxima's.
      void submit(action.side, list[action.index]);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceHeld.current = false;
    };
    const blur = () => (spaceHeld.current = false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [open, settings, submit]);

  function startDrag(e: React.PointerEvent) {
    const start = { x: e.clientX - pos.x, y: e.clientY - pos.y };
    const move = (m: PointerEvent) =>
      setPos(clampPosition(m.clientX - start.x, m.clientY - start.y));
    const up = (u: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      saveJson(
        POSITION_KEY,
        clampPosition(u.clientX - start.x, u.clientY - start.y),
      );
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  if (token.chain !== 'Solana') return null;
  if (!open)
    return (
      <button type="button" className={styles.launcher} onClick={openPanel}>
        Instant Trade
      </button>
    );
  const quickList =
    side === 'Buy'
      ? (settings?.walletTrades.buyAmounts ?? [])
      : (settings?.walletTrades.sellPercents ?? []);
  const keysList =
    side === 'Buy' ? settings?.hotkeys.buyKeys : settings?.hotkeys.sellKeys;
  const totalTokens = scope.reduce(
    (t, w) => t + (balances[w.address] ?? 0n),
    0n,
  );
  return (
    <section
      className={styles.panel}
      aria-label="Instant Trade"
      style={{
        left: pos.x,
        top: pos.y,
        opacity: look.opacity,
        backdropFilter: look.blur ? `blur(${look.blur}px)` : undefined,
      }}
    >
      <header className={styles.header}>
        <button
          type="button"
          className={styles.grip}
          aria-label="Drag Instant Trade"
          onPointerDown={startDrag}
        >
          ⠿
        </button>
        <strong>Instant Trade · {token.symbol}</strong>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close Instant Trade"
        >
          ✕
        </button>
      </header>

      <fieldset className={styles.scope} aria-label="Wallets">
        <div className={styles.folderBar}>
          <button
            type="button"
            onClick={() => setSelected(solana.map((w) => w.address))}
          >
            All
          </button>
          <button type="button" onClick={() => setSelected([])}>
            None
          </button>
          {folders.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() =>
                setSelected(
                  solana
                    .filter(
                      (w) => w.folderId === f.id || w.folderIds?.includes(f.id),
                    )
                    .map((w) => w.address),
                )
              }
            >
              {f.name}
            </button>
          ))}
        </div>
        <ul className={styles.wallets}>
          {solana.map((w) => {
            const b = balances[w.address];
            return (
              <li key={w.address}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.includes(w.address)}
                    onChange={(e) =>
                      setSelected((s) =>
                        e.target.checked
                          ? [...s, w.address]
                          : s.filter((a) => a !== w.address),
                      )
                    }
                  />
                  {w.label || short(w.address)}
                  {w.role === 'Deployer' && <em> dev</em>}
                </label>
                <small>
                  {b !== undefined
                    ? `${rawToDecimal(b, token.decimals)} ${token.symbol}`
                    : '—'}
                </small>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          disabled={!scope.length}
          onClick={() => void refreshBalances().catch(() => {})}
        >
          Refresh balances
        </button>
        {balanceError && <small role="alert">{balanceError}</small>}
        {scope.length > 0 && (
          <small>
            Selected: {scope.length} ·{' '}
            {rawToDecimal(totalTokens, token.decimals)} {token.symbol}
          </small>
        )}
      </fieldset>

      <div className={styles.sides}>
        {(['Buy', 'Sell'] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={side === s}
            data-side={s}
            onClick={() => setSide(s)}
          >
            {s}
          </button>
        ))}
      </div>
      <div className={styles.quick}>
        {quickList.map((v, i) => (
          <button
            key={`${side}${v}${i}`}
            type="button"
            disabled={busy || locked}
            onClick={() => quick(i, side)}
          >
            {side === 'Buy' ? `${v} SOL` : `${v}%`}
            {settings?.hotkeys.enabled && keysList?.[i] && (
              <kbd>{keysList[i].toUpperCase()}</kbd>
            )}
          </button>
        ))}
      </div>
      <label className={styles.field}>
        {side === 'Buy'
          ? 'Amount (SOL per wallet)'
          : 'Amount (% of each wallet)'}
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      <div className={styles.row}>
        <fieldset className={styles.modes} aria-label="Execution">
          {(['Stagger', 'Parallel'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
            >
              {m}
            </button>
          ))}
        </fieldset>
        {mode === 'Stagger' && (
          <label className={styles.field}>
            Buy Delay (ms)
            <input
              inputMode="numeric"
              value={delayMs}
              onChange={(e) => setDelayMs(e.target.value)}
            />
          </label>
        )}
      </div>

      {!unlocked ? (
        <form
          className={styles.row}
          onSubmit={(e) => {
            e.preventDefault();
            void unlock();
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
          <button type="submit">Unlock</button>
        </form>
      ) : (
        <div className={styles.row}>
          <button
            type="button"
            className={styles.submit}
            data-side={side}
            disabled={busy || locked}
            onClick={() => void submit(side, amount)}
          >
            {busy
              ? 'Trading…'
              : `${side} with ${scope.length} wallet${scope.length === 1 ? '' : 's'}`}
          </button>
          {busy && (
            <button type="button" onClick={() => run.current?.abort()}>
              Stop
            </button>
          )}
          <button type="button" onClick={lock}>
            Lock
          </button>
        </div>
      )}
      <p className={styles.note}>
        {settings?.tradePanel.instantTrade
          ? 'Instant Trade is on: quick amounts submit immediately.'
          : 'Quick amounts fill the amount; press the side button to trade.'}{' '}
        Each wallet signs its own transaction from this browser; nothing is
        atomic across wallets and delays don&apos;t fix the price.
      </p>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {outcomes.length > 0 && (
        <ul className={styles.outcomes} aria-label="Trade outcomes">
          {outcomes.map((o) => (
            <li key={o.wallet} data-ok={o.ok}>
              {short(o.wallet)}:{' '}
              {o.ok ? (
                <a
                  href={`https://solscan.io/tx/${o.result.signature}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  sent
                </a>
              ) : (
                `${o.uncertain ? 'signed, outcome unknown: ' : ''}${o.error}`
              )}
            </li>
          ))}
        </ul>
      )}
      <details className={styles.look}>
        <summary>Appearance</summary>
        <label>
          Opacity
          <input
            type="range"
            min={0.4}
            max={1}
            step={0.05}
            value={look.opacity}
            onChange={(e) => {
              const next = { ...look, opacity: Number(e.target.value) };
              setLook(next);
              saveJson(LOOK_KEY, next);
            }}
          />
        </label>
        <label>
          Blur
          <input
            type="range"
            min={0}
            max={16}
            step={1}
            value={look.blur}
            onChange={(e) => {
              const next = { ...look, blur: Number(e.target.value) };
              setLook(next);
              saveJson(LOOK_KEY, next);
            }}
          />
        </label>
      </details>
    </section>
  );
}
