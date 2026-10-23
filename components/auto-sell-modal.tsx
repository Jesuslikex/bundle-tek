'use client';
import { AutoSellReviewRecovery } from './auto-sell-review-recovery';
import {
  validatedAutoSellReviewReference,
  type AutoSellReviewReference,
} from '@/lib/auto-sell-review-recovery';

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  autoSellStrategyError,
  autoSellMaximumLabel,
  endCapRaw,
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
import { autoSellSessionCap } from '@/lib/auto-sell-session';
import {
  parseDurationParts,
  splitDurationSeconds,
  type DurationParts,
} from '@/lib/duration-parts';
import type {
  AutoSellConfiguration,
  AutoSellEditReview,
} from '@/lib/auto-sell-edit';
import { autoSellEditChanges } from '@/lib/auto-sell-edit-changes';
import { autoSellMarketObservation } from '@/lib/auto-sell-market-observation';
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
import { AutoSellSessionSummary } from './auto-sell-session-summary';
import { AutoSellOutcomeRead } from './auto-sell-outcome-read';
import { AutoSellSavedOutcomes } from './auto-sell-saved-outcomes';
import {
  autoSellActivityLabel,
  autoSellEndLabel,
} from '@/lib/auto-sell-display';

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
const emptyDuration = (): DurationParts => ({
  hours: '',
  minutes: '',
  seconds: '',
});
function optionalDuration(parts: DurationParts) {
  return Object.values(parts).every((value) => value === '' || value === '0')
    ? { seconds: 0, error: '' }
    : parseDurationParts(parts, 86400);
}

/**
 * Holds a browser-wide lock for one token's Auto Sell so a second tab cannot
 * run the same strategy and sell twice. Resolves with a release function, or
 * null when another tab already holds it.
 */
function acquireRunLock(name: string): Promise<(() => void) | null> {
  const lockFailure = () =>
    new Error(
      'Auto Sell could not obtain cross-tab protection. Check browser access and try again. No vault was unlocked or strategy started.',
    );
  let locks: LockManager | undefined;
  try {
    locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!locks || typeof locks.request !== 'function')
      return Promise.reject(
        new Error(
          'This browser cannot protect Auto Sell across tabs. Use an up-to-date browser on the secure app URL, then try again.',
        ),
      );
  } catch {
    return Promise.reject(lockFailure());
  }
  return new Promise((resolve, reject) => {
    const denied = () => reject(lockFailure());
    try {
      void locks
        .request(name, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(null);
            return undefined;
          }
          return new Promise<void>((release) => resolve(() => release()));
        })
        .catch(denied);
    } catch {
      denied();
    }
  });
}

/**
 * Proxima-style Auto Sell. Run Strategy is the single approval: after it,
 * matching sells are prepared, signed with the unlocked browser vault and
 * submitted without further clicks, while this tab stays open.
 */
type AutoSellProps = {
  project: ImportedTokenProject;
  wallets: WorkspaceWallet[];
  locked: boolean;
};

export function AutoSell(props: AutoSellProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [contextNotice, setContextNotice] = useState('');
  const contextClosed = useCallback(
    (originalTrigger: HTMLButtonElement | null) => {
      const replacement = trigger.current;
      if (
        !replacement ||
        replacement === originalTrigger ||
        !replacement.isConnected
      )
        return false;
      replacement.focus();
      setContextNotice(
        'Workspace context changed. This view closed and new work stopped; an existing operation can still settle. Reopen for saved history or fresh settings.',
      );
      return true;
    },
    [],
  );
  const opened = useCallback(() => setContextNotice(''), []);
  // A review/run belongs to one exact project and wallet roster. Changing that
  // context must stop the old instance, including an unfinished vault unlock.
  const context = JSON.stringify([
    props.project.id,
    props.project.revision,
    props.project.archived,
    props.project.document.token,
    props.locked,
    props.wallets.map((wallet) => [
      wallet.address,
      wallet.chain,
      wallet.revision,
      wallet.archived,
    ]),
  ]);
  return (
    <>
      <AutoSellContext
        key={context}
        {...props}
        triggerRef={trigger}
        onContextClosed={contextClosed}
        onOpened={opened}
      />
      <output
        className={styles.contextNotice}
        aria-label="Auto Sell view change"
        aria-live="polite"
        aria-atomic="true"
      >
        {contextNotice}
      </output>
    </>
  );
}

function AutoSellContext({
  project,
  wallets,
  locked,
  triggerRef,
  onContextClosed,
  onOpened,
}: AutoSellProps & {
  triggerRef: RefObject<HTMLButtonElement | null>;
  onContextClosed: (originalTrigger: HTMLButtonElement | null) => boolean;
  onOpened: () => void;
}) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const advanced = useRef<HTMLDetailsElement>(null);
  const walletOptions = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    if (!open) return;
    const element = dialog.current;
    const previous = document.activeElement;
    const originalTrigger = triggerRef.current;
    if (element && !element.open) {
      if (typeof element.showModal === 'function') element.showModal();
      else element.setAttribute('open', '');
    }
    return () => {
      element?.close?.();
      if (
        !onContextClosed(originalTrigger) &&
        previous instanceof HTMLElement &&
        previous.isConnected
      )
        previous.focus();
    };
  }, [open, triggerRef, onContextClosed]);
  const [strategies, setStrategies] = useState<AutoSellStrategy[]>(() => [
    newAutoSellStrategy(0),
  ]);
  const [snapshot, setSnapshot] = useState<AutoSellSnapshot | null>(null);
  const runner = useRef<AutoSellRunner | null>(null);
  const vault = useRef<VaultSession | null>(null);
  const releaseLock = useRef<(() => void) | null>(null);
  const runEpoch = useRef(0);
  const mounted = useRef(false);
  const token = project.document.token;
  const solanaWallets = useMemo(
    () => wallets.filter((w) => w.chain === 'Solana' && !w.archived),
    [wallets],
  );
  const [sellWallets, setSellWallets] = useState<string[]>([]);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reviewReminders, setReviewReminders] = useState<
    { reference: AutoSellReviewReference; conflict: boolean }[]
  >([]);
  const cancellationGuards = useRef(new Set<string>());
  const [cancellationCount, setCancellationCount] = useState(0);
  function trackCancellation(key: string, blocked: boolean) {
    if (blocked) cancellationGuards.current.add(key);
    else cancellationGuards.current.delete(key);
    setCancellationCount(cancellationGuards.current.size);
  }
  const [previewCap, setPreviewCap] = useState<number | null>(null);
  const [sessionDelay, setSessionDelay] =
    useState<DurationParts>(emptyDuration);
  const [sessionDuration, setSessionDuration] =
    useState<DurationParts>(emptyDuration);
  const [sessionMaximum, setSessionMaximum] = useState('');
  const [sessionMaximumUnit, setSessionMaximumUnit] = useState<
    'supply' | 'tokens'
  >('supply');
  const delay = optionalDuration(sessionDelay);
  const duration = optionalDuration(sessionDuration);
  const sessionRules = {
    startDelaySeconds: delay.seconds ?? 0,
    endDurationSeconds: duration.seconds ?? 0,
    endMaxSupplyPercent: sessionMaximumUnit === 'supply' ? sessionMaximum : '',
    ...(sessionMaximumUnit === 'tokens'
      ? { endMaxTokenAmount: sessionMaximum }
      : {}),
  };
  let sessionError = delay.error || duration.error;
  if (!sessionError) {
    try {
      autoSellSessionCap(
        sessionRules,
        toRaw(token.totalSupplyRaw),
        token.decimals,
      );
    } catch (cause) {
      sessionError =
        cause instanceof Error ? cause.message : 'Invalid session settings.';
    }
  }
  const running = !!snapshot?.running;
  const paused = running && !!snapshot?.paused;
  const [editing, setEditing] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [editReview, setEditReview] = useState<AutoSellEditReview | null>(null);
  const [reviewedDraft, setReviewedDraft] = useState('');
  const [approvedEdit, setApprovedEdit] = useState('');
  const originalConfiguration = useRef<AutoSellConfiguration | null>(null);
  const draftKey = JSON.stringify({ strategies, session: sessionRules });
  const currentReview =
    editing && paused && !snapshot?.settling && reviewedDraft === draftKey
      ? editReview
      : null;
  const ids = useId();

  function loadConfiguration(configuration: AutoSellConfiguration) {
    setStrategies(structuredClone(configuration.strategies));
    setSessionDelay(
      splitDurationSeconds(configuration.session.startDelaySeconds),
    );
    setSessionDuration(
      splitDurationSeconds(configuration.session.endDurationSeconds),
    );
    setSessionMaximumUnit(
      configuration.session.endMaxTokenAmount !== undefined
        ? 'tokens'
        : 'supply',
    );
    setSessionMaximum(
      configuration.session.endMaxTokenAmount ??
        configuration.session.endMaxSupplyPercent,
    );
    setGeneration((value) => value + 1);
  }

  function cancelChanges() {
    runner.current?.cancelEdit();
    if (originalConfiguration.current)
      loadConfiguration(originalConfiguration.current);
    originalConfiguration.current = null;
    setEditing(false);
    setEditReview(null);
    setApprovedEdit('');
    setReviewedDraft('');
    setError('');
  }

  function beginEdit() {
    if (!paused || snapshot?.settling || !runner.current) return;
    runner.current.cancelEdit();
    originalConfiguration.current = runner.current.configuration();
    loadConfiguration(originalConfiguration.current);
    setEditReview(null);
    setApprovedEdit('');
    setEditing(true);
    setError('');
  }

  function reviewChanges() {
    setEditReview(null);
    setApprovedEdit('');
    setError('');
    try {
      if (sessionError || errors.some(Boolean))
        throw new Error(sessionError || errors.find(Boolean)!);
      if (!runner.current) return;
      const review = runner.current.reviewEdit({
        strategies,
        session: sessionRules,
      });
      if (!autoSellEditChanges(review.before, review.after).length)
        throw new Error('No active settings have changed.');
      setEditReview(review);
      setReviewedDraft(draftKey);
    } catch (cause) {
      runner.current?.cancelEdit();
      setError(
        cause instanceof Error ? cause.message : 'Could not review changes.',
      );
    }
  }

  function applyChanges() {
    if (
      !currentReview ||
      approvedEdit !== currentReview.reviewKey ||
      !runner.current
    )
      return;
    try {
      runner.current.applyEdit(currentReview.reviewKey, true);
      originalConfiguration.current = null;
      loadConfiguration(runner.current.configuration());
      setEditing(false);
      setEditReview(null);
      setApprovedEdit('');
      setError('');
    } catch (cause) {
      setEditReview(null);
      setApprovedEdit('');
      setError(
        cause instanceof Error ? cause.message : 'Review the changes again.',
      );
    }
  }

  function stop(reason = 'Stopped by you.') {
    if (originalConfiguration.current) cancelChanges();
    runEpoch.current += 1;
    setBusy(false);
    setPassword('');
    runner.current?.stop(reason);
    if (vault.current) vault.current.payload.wallets = [];
    vault.current = null;
    if (runner.current) setSnapshot(runner.current.snapshot());
    if (!runner.current?.snapshot().selling) {
      releaseLock.current?.();
      releaseLock.current = null;
    }
  }

  function closeDialog() {
    if (originalConfiguration.current) cancelChanges();
    if (busy) stop('Vault unlock cancelled.');
    setOpen(false);
  }

  function togglePause() {
    if (editing) return;
    setError('');
    if (!runner.current) return;
    if (paused) {
      if (!runner.current.resume())
        setError(
          runner.current.isRunning()
            ? 'Wait for the pending operation to settle before resuming.'
            : 'This session has ended. Review the settings before starting a new run.',
        );
    } else runner.current.pause();
  }

  useEffect(() => {
    mounted.current = true;
    const halt = (reason: string) => {
      runEpoch.current += 1;
      runner.current?.stop(reason);
      if (vault.current) vault.current.payload.wallets = [];
      vault.current = null;
      // Stopping prevents new work, but a signed/send request can still finish.
      // Its own terminal update retains and releases this lock after unmount.
      if (!runner.current?.snapshot().selling) {
        releaseLock.current?.();
        releaseLock.current = null;
      }
    };
    const onHide = () => {
      halt('Tab closed.');
      setBusy(false);
      setPassword('');
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      mounted.current = false;
      window.removeEventListener('pagehide', onHide);
      halt('Auto Sell closed.');
    };
  }, []);

  // Live market cap for the In-Range pill before Run.
  useEffect(() => {
    if (!open || running || locked || token.chain !== 'Solana') return;
    const controller = new AbortController();
    const read = createAutoSellFeed(token.address);
    const load = () =>
      read(controller.signal)
        .then((trades) => {
          if (controller.signal.aborted) return;
          const price = autoSellMarketObservation(trades, Date.now())?.priceUsd;
          if (price)
            setPreviewCap(
              marketCapFromPrice(price, token.totalSupplyRaw, token.decimals),
            );
          else setPreviewCap(null);
        })
        .catch(() => {
          if (!controller.signal.aborted) setPreviewCap(null);
        });
    void load();
    const timer = setInterval(load, 15000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [
    open,
    running,
    locked,
    token.address,
    token.chain,
    token.decimals,
    token.totalSupplyRaw,
  ]);

  const errors = strategies.map((strategy) => {
    const error = autoSellStrategyError(strategy);
    if (error) return error;
    try {
      endCapRaw(strategy, toRaw(token.totalSupplyRaw), token.decimals);
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : 'Invalid maximum amount.';
    }
  });
  const firstStrategyError = errors.findIndex(Boolean);
  const startBlockReason =
    cancellationCount > 0
      ? 'Check the original saved approval status before starting a new Auto Sell run.'
      : locked
        ? 'Wait for the current workspace operation to finish.'
        : project.archived
          ? 'This project is archived. Restore it before starting Auto Sell.'
          : token.chain !== 'Solana'
            ? 'Auto Sell supports Solana tokens.'
            : snapshot?.selling
              ? 'Wait for the pending sell to finish before starting another session.'
              : firstStrategyError >= 0
                ? `${strategies[firstStrategyError].name}: ${errors[firstStrategyError]}`
                : sessionError
                  ? `Session settings: ${sessionError}`
                  : !solanaWallets.length
                    ? 'Add a Solana wallet in My wallets before starting Auto Sell.'
                    : !sellWallets.length
                      ? 'Choose at least one sell wallet in Advanced Options.'
                      : !password
                        ? 'Enter your vault password before starting these strategies.'
                        : '';
  const marketCap = running ? (snapshot?.marketCapUsd ?? null) : previewCap;

  function update(id: string, patch: Partial<AutoSellStrategy>) {
    if (editing) {
      runner.current?.cancelEdit();
      setEditReview(null);
      setApprovedEdit('');
    }
    setStrategies((list) =>
      list.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    );
  }

  async function run() {
    if (
      locked ||
      project.archived ||
      cancellationGuards.current.size > 0 ||
      busy ||
      running ||
      snapshot?.selling ||
      errors.some(Boolean) ||
      sessionError
    )
      return;
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
    const epoch = ++runEpoch.current;
    const current = () => mounted.current && runEpoch.current === epoch;
    let release: (() => void) | null = null;
    let unlocked: VaultSession | null = null;
    try {
      release = await acquireRunLock(
        `bundle-auto-sell:${project.id}:${token.address}`,
      );
      if (!current()) return;
      if (!release)
        throw new Error(
          'An Auto Sell run for this token is active or still settling. Wait for its outcome before starting another session.',
        );
      const session = await unlockVault(encrypted, password);
      unlocked = session;
      if (!current()) return;
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
      // This release belongs to this exact run, not a later mounted instance.
      // Keep it reachable by the runner's final update even after UI teardown.
      const acquiredRelease = release;
      let released = false;
      const releaseThisRun = () => {
        if (released) return;
        released = true;
        acquiredRelease();
        if (releaseLock.current === releaseThisRun) releaseLock.current = null;
      };
      const instance: AutoSellRunner = new AutoSellRunner({
        strategies,
        session: sessionRules,
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
          if (!next.running && !next.selling) releaseThisRun();
          // A previous run finishing its last sell must not touch this one.
          if (!mounted.current || runner.current !== instance) return;
          setSnapshot(next);
          if (next.reviewRecovery) {
            try {
              const reference = validatedAutoSellReviewReference(
                next.reviewRecovery,
              );
              setReviewReminders((previous) => {
                const index = previous.findIndex(
                  (entry) =>
                    entry.reference.preparationId === reference.preparationId,
                );
                if (index >= 0)
                  return next.reviewRecoveryConflict &&
                    !previous[index].conflict
                    ? previous.map((entry, i) =>
                        i === index ? { ...entry, conflict: true } : entry,
                      )
                    : previous;
                return [
                  ...previous,
                  { reference, conflict: next.reviewRecoveryConflict === true },
                ].slice(-100);
              });
            } catch {
              /* Invalid metadata never becomes a lookup context. */
            }
          }
          if (!next.running && !next.selling) {
            if (originalConfiguration.current) {
              loadConfiguration(instance.configuration());
              originalConfiguration.current = null;
              setEditing(false);
              setEditReview(null);
              setApprovedEdit('');
              setError('The session ended. Unapplied edits were discarded.');
            }
            if (vault.current) vault.current.payload.wallets = [];
            vault.current = null;
            releaseLock.current?.();
            releaseLock.current = null;
          }
        },
      });
      runner.current = instance;
      releaseLock.current = releaseThisRun;
      release = null;
      instance.start();
    } catch (e) {
      if (unlocked) unlocked.payload.wallets = [];
      if (vault.current === unlocked) vault.current = null;
      if (current())
        setError(
          e instanceof Error ? e.message : 'Could not unlock the vault.',
        );
    } finally {
      release?.();
      if (!current() && unlocked) unlocked.payload.wallets = [];
      if (current()) setBusy(false);
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
        ref={triggerRef}
        variant="outline"
        onClick={() => {
          onOpened();
          setOpen(true);
        }}
      >
        {paused
          ? 'Auto Sell · paused'
          : running
            ? 'Auto Sell · running'
            : 'Auto Sell'}
      </Button>
      {open && (
        <dialog
          ref={dialog}
          aria-modal="true"
          aria-labelledby={`${ids}-title`}
          className={styles.modal}
          onCancel={(event) => {
            event.preventDefault();
            closeDialog();
          }}
        >
          <header className={styles.header}>
            <h2 id={`${ids}-title`}>Auto Sell</h2>
            <button
              type="button"
              aria-label="Close"
              className={styles.x}
              onClick={closeDialog}
            >
              ×
            </button>
          </header>
          <div
            className={styles.body}
            onChangeCapture={(event) => {
              if (
                editing &&
                !(
                  event.target instanceof HTMLElement &&
                  event.target.closest('[data-edit-approval]')
                )
              ) {
                runner.current?.cancelEdit();
                setEditReview(null);
                setApprovedEdit('');
              }
            }}
          >
            {snapshot && (
              <AutoSellSessionSummary
                snapshot={snapshot}
                decimals={token.decimals}
              />
            )}
            {strategies.map((s, i) => (
              <StrategyCard
                key={`${s.id}:${generation}`}
                strategy={s}
                error={errors[i]}
                disabled={(running && !editing) || busy}
                inRange={marketCapInRange(s, marketCap)}
                state={snapshot?.states[s.id]}
                pct={pct}
                decimals={token.decimals}
                canDelete={strategies.length > 1}
                onChange={(patch) => update(s.id, patch)}
                onDelete={() => {
                  runner.current?.cancelEdit();
                  setEditReview(null);
                  setApprovedEdit('');
                  setStrategies((list) => list.filter((x) => x.id !== s.id));
                }}
              />
            ))}
            {(!running || editing) && (
              <button
                type="button"
                className={styles.add}
                disabled={busy || strategies.length >= 5}
                onClick={() => {
                  runner.current?.cancelEdit();
                  setEditReview(null);
                  setApprovedEdit('');
                  setStrategies((list) => [
                    ...list,
                    newAutoSellStrategy(list.length),
                  ]);
                }}
              >
                + Add Strategy
              </button>
            )}
            <details
              ref={advanced}
              className={styles.advanced}
              open={!sellWallets.length || undefined}
            >
              <summary>Advanced Options</summary>
              <fieldset disabled={(running && !editing) || busy}>
                <legend>Session settings</legend>
                <SessionTime
                  label="Start delay"
                  disabled={editing}
                  value={sessionDelay}
                  onChange={setSessionDelay}
                />
                <p className={styles.hint}>
                  No sells are queued during this delay. Counter Trading begins
                  with a fresh history baseline afterwards.
                </p>
                <label htmlFor={`${ids}-session-max`}>
                  Session maximum (
                  {sessionMaximumUnit === 'supply' ? '% supply' : 'tokens'})
                </label>
                <fieldset
                  className={styles.tiles2}
                  aria-label="Session maximum unit"
                >
                  {(['supply', 'tokens'] as const).map((unit) => (
                    <button
                      key={unit}
                      type="button"
                      aria-pressed={sessionMaximumUnit === unit}
                      className={
                        sessionMaximumUnit === unit
                          ? styles.tileActive
                          : styles.tile
                      }
                      onClick={() => {
                        if (unit !== sessionMaximumUnit) {
                          if (editing) {
                            runner.current?.cancelEdit();
                            setEditReview(null);
                            setApprovedEdit('');
                          }
                          setSessionMaximumUnit(unit);
                          setSessionMaximum('');
                        }
                      }}
                    >
                      {unit === 'supply' ? '% Supply' : 'Token amount'}
                    </button>
                  ))}
                </fieldset>
                <Input
                  id={`${ids}-session-max`}
                  inputMode="decimal"
                  placeholder="No shared limit"
                  value={sessionMaximum}
                  onChange={(event) =>
                    setSessionMaximum(event.target.value.trim())
                  }
                />
                <p className={styles.hint}>
                  Changing the maximum unit clears its amount. No conversion is
                  assumed.
                </p>
                <SessionTime
                  label="Session duration"
                  value={sessionDuration}
                  onChange={setSessionDuration}
                />
                <p className={styles.hint}>
                  These limits stop all strategies when either is reached.
                  Duration begins after the start delay. Amount includes
                  uncertain submissions so they cannot be sold again. Blank
                  limits are optional; maximum duration and delay are 24 hours
                  each.
                </p>
                <p className={styles.hint}>
                  Slippage uses the existing reviewed quote and protected
                  minimum. Custom session slippage is not connected.
                </p>
                {sessionError && <p role="alert">{sessionError}</p>}
              </fieldset>
              <fieldset
                ref={walletOptions}
                tabIndex={-1}
                disabled={running || busy}
              >
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
                  Your own workspace wallets never trigger a counter sell. Each
                  sell comes from one wallet, rotating through the ones you
                  pick.
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
                  this tab open. Each sell still goes through the server&apos;s
                  balance, simulation and 15-second read checks, so sells land
                  about every 30 seconds at most.
                </small>
              </div>
            )}
            {error && (
              <p role="alert" className={styles.alert}>
                {error}
              </p>
            )}
            {editing && (
              <section
                className={styles.review}
                aria-label="Review Auto Sell changes"
              >
                <h3>Edit paused session</h3>
                <p>
                  Accounted amounts, processed targets and elapsed time are
                  retained. Wallet selection and the original start delay stay
                  fixed. Applying changes does not resume selling.
                </p>
                {currentReview ? (
                  <>
                    <dl>
                      {autoSellEditChanges(
                        currentReview.before,
                        currentReview.after,
                      ).map((change) => (
                        <div key={change.label}>
                          <dt>{change.label}</dt>
                          <dd>
                            <span>Before: {change.before}</span>
                            <span>After: {change.after}</span>
                          </dd>
                        </div>
                      ))}
                    </dl>
                    <p>
                      Accounted tokens:{' '}
                      {rawToDecimal(
                        toRaw(currentReview.accountedRaw),
                        token.decimals,
                      )}{' '}
                      tokens. Queued:{' '}
                      {rawToDecimal(
                        toRaw(currentReview.queuedRaw),
                        token.decimals,
                      )}{' '}
                      tokens. Cancelled unsent queue:{' '}
                      {rawToDecimal(
                        toRaw(currentReview.cancelledQueuedRaw),
                        token.decimals,
                      )}{' '}
                      tokens.
                    </p>
                    {currentReview.reactivatedStrategies.length > 0 && (
                      <p>
                        Strategies enabled again under the new limits:{' '}
                        {currentReview.reactivatedStrategies.join(', ')}.
                        Processed targets stay processed.
                      </p>
                    )}
                    {currentReview.endingStrategies.length > 0 && (
                      <>
                        <p>Strategies that will end:</p>
                        <ul aria-label="Strategies that will end">
                          {currentReview.endingStrategies.map((strategy) => (
                            <li key={strategy.id}>
                              {strategy.name}: {strategy.reason}.
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    {currentReview.endsSession && (
                      <output>
                        Applying these changes will end this session.
                      </output>
                    )}
                    <label className={styles.check} data-edit-approval>
                      <input
                        type="checkbox"
                        checked={approvedEdit === currentReview.reviewKey}
                        onChange={(event) =>
                          setApprovedEdit(
                            event.target.checked ? currentReview.reviewKey : '',
                          )
                        }
                      />
                      I approve these exact Auto Sell changes.
                    </label>
                  </>
                ) : (
                  <p>
                    Change settings above, then review the differences. Every
                    new review needs a fresh approval.
                  </p>
                )}
              </section>
            )}
            {running && (
              <output
                aria-label="Auto Sell session status"
                className={styles.hint}
              >
                {paused
                  ? snapshot?.settling
                    ? 'Paused. Waiting for the pending operation to settle. A submitted transaction can still finalize.'
                    : 'Paused. Resume continues queued amounts within the same approved limits. Paused market activity is discarded and DCA does not catch up missed intervals.'
                  : 'Running while this tab is open.'}{' '}
                Session time limits continue while paused. Stop or close the tab
                to lock the browser vault.
              </output>
            )}
            {!!snapshot?.outcomes?.length && (
              <details className={`${styles.log} ${styles.reminders}`}>
                <summary>
                  Transaction reminders ({snapshot.outcomes.length})
                </summary>
                <p>
                  {snapshot.outcomeOverflow
                    ? 'Latest 100 reminders'
                    : 'Transaction reminders'}{' '}
                  from this run, kept separately from activity entries.
                  Submitted reports and unknown outcomes are not receipt proof.
                  Remounting or a new run clears this local list; use saved
                  approvals below.
                </p>
                <ol>
                  {[...snapshot.outcomes].reverse().map((entry) => (
                    <li key={entry.outcome.intentId}>
                      <strong>
                        {entry.kind === 'error'
                          ? 'Outcome unknown'
                          : 'Submission reported'}
                      </strong>
                      <AutoSellOutcomeRead
                        reference={entry.outcome}
                        projectId={project.id}
                        mint={token.address}
                      />
                    </li>
                  ))}
                </ol>
              </details>
            )}
            {!!reviewReminders.length && (
              <section aria-label="Interrupted review reminders">
                <p>
                  The latest 100 original review references are kept across runs
                  in this view. Older references can be replaced at this limit.
                  This local list resets when the view remounts; use saved
                  approvals after that. New runs stay blocked during
                  cancellation recovery.
                </p>
                {reviewReminders.map((entry) => (
                  <AutoSellReviewRecovery
                    key={entry.reference.preparationId}
                    reference={entry.reference}
                    conflict={entry.conflict}
                    projectId={project.id}
                    mint={token.address}
                    allowCancellation={
                      !running &&
                      !snapshot?.settling &&
                      !busy &&
                      cancellationCount === 0
                    }
                    onCancellationBlocked={(blocked) =>
                      trackCancellation(
                        `review:${entry.reference.preparationId}`,
                        blocked,
                      )
                    }
                  />
                ))}
              </section>
            )}
            <AutoSellSavedOutcomes
              allowCancellation={
                !running &&
                !snapshot?.settling &&
                !busy &&
                cancellationCount === 0
              }
              onCancellationBlocked={(id, blocked) =>
                trackCancellation(`history:${id}`, blocked)
              }
              projectId={project.id}
              mint={token.address}
            />
            {snapshot && snapshot.log.length > 0 && (
              <section aria-label="Auto Sell activity" className={styles.log}>
                <h3>Activity</h3>
                <p>
                  Latest {Math.min(20, snapshot.log.length)} activity entries.
                  Older approvals remain in preparation history.
                </p>
                <ol>
                  {[...snapshot.log]
                    .reverse()
                    .slice(0, 20)
                    .map((entry, n) => (
                      <li
                        key={
                          entry.outcome
                            ? `${entry.outcome.intentId}:${entry.kind}`
                            : `${entry.at}-${n}`
                        }
                        data-kind={entry.kind}
                      >
                        <time>{new Date(entry.at).toLocaleTimeString()}</time>{' '}
                        {autoSellActivityLabel(entry)}
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
                        {entry.outcome && !snapshot.outcomes && (
                          <AutoSellOutcomeRead
                            reference={entry.outcome}
                            projectId={project.id}
                            mint={token.address}
                          />
                        )}
                      </li>
                    ))}
                </ol>
              </section>
            )}
          </div>
          <footer className={styles.footer}>
            {!running && !busy && (
              <div className={styles.readiness} id={`${ids}-start-hint`}>
                <strong>
                  {sellWallets.length} sell{' '}
                  {sellWallets.length === 1 ? 'wallet' : 'wallets'} selected ·{' '}
                  {strategies.length}{' '}
                  {strategies.length === 1 ? 'strategy' : 'strategies'}
                </strong>
                <p>
                  {[error, startBlockReason].filter(Boolean).join(' ') ||
                    'Local settings are complete. Starting still requires the existing vault and server checks.'}
                </p>
                {solanaWallets.length > 0 && !sellWallets.length && (
                  <button
                    type="button"
                    onClick={() => {
                      if (advanced.current) advanced.current.open = true;
                      walletOptions.current
                        ?.querySelector<HTMLInputElement>(
                          'input[type="checkbox"]',
                        )
                        ?.focus();
                    }}
                  >
                    Choose sell wallets
                  </button>
                )}
              </div>
            )}
            <Button variant="outline" onClick={closeDialog}>
              Close
            </Button>
            {paused && !editing && (
              <Button
                variant="outline"
                disabled={!!snapshot?.settling}
                onClick={beginEdit}
              >
                Edit
              </Button>
            )}
            {editing && (
              <>
                <Button variant="outline" onClick={cancelChanges}>
                  Cancel edits
                </Button>
                {currentReview ? (
                  <Button
                    disabled={approvedEdit !== currentReview.reviewKey}
                    onClick={applyChanges}
                  >
                    Apply approved changes
                  </Button>
                ) : (
                  <Button
                    disabled={
                      !paused ||
                      !!snapshot?.settling ||
                      !!sessionError ||
                      errors.some(Boolean)
                    }
                    onClick={reviewChanges}
                  >
                    Review changes
                  </Button>
                )}
              </>
            )}
            {running && !editing && (
              <Button
                variant="outline"
                disabled={paused && !!snapshot?.settling}
                onClick={togglePause}
              >
                {paused ? 'Resume' : 'Pause'}
              </Button>
            )}
            {running || busy ? (
              <Button variant="destructive" onClick={() => stop()}>
                {busy ? 'Cancel unlock' : 'Stop'}
              </Button>
            ) : (
              <Button
                aria-describedby={`${ids}-start-hint`}
                disabled={
                  busy ||
                  locked ||
                  !!snapshot?.selling ||
                  errors.some(Boolean) ||
                  !!sessionError ||
                  !password ||
                  Boolean(startBlockReason)
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
      )}
    </>
  );
}

function SessionTime({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: DurationParts;
  onChange: (parts: DurationParts) => void;
  disabled?: boolean;
}) {
  return (
    <div className={styles.field}>
      <span>
        {label} <small>(optional)</small>
      </span>
      <div className={styles.duration}>
        {(['hours', 'minutes', 'seconds'] as const).map((unit) => (
          <Input
            key={unit}
            disabled={disabled}
            aria-label={`${label} ${unit}`}
            inputMode="numeric"
            placeholder={
              unit === 'hours' ? 'HOURS' : unit === 'minutes' ? 'MIN' : 'SEC'
            }
            value={value[unit]}
            onChange={(event) =>
              onChange({ ...value, [unit]: event.target.value })
            }
          />
        ))}
      </div>
    </div>
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
  const initialDuration = s.endDurationSeconds
    ? splitDurationSeconds(s.endDurationSeconds)
    : emptyDuration();
  const [hours, setHours] = useState(initialDuration.hours);
  const [minutes, setMinutes] = useState(initialDuration.minutes);
  const [seconds, setSeconds] = useState(initialDuration.seconds);
  const [whitelistText, setWhitelistText] = useState(s.whitelist.join('\n'));
  const [dcaInterval, setDcaIntervalParts] = useState(() => {
    const parts = s.dcaIntervalSeconds
      ? splitDurationSeconds(s.dcaIntervalSeconds)
      : emptyDuration();
    return { h: parts.hours, m: parts.minutes, s: parts.seconds };
  });
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
      ? `${state.responses} DCA interval${state.responses === 1 ? '' : 's'} processed`
      : s.mode === 'limit'
        ? `${state.filledLimitIds.length}/${s.limitOrders.length} limit targets processed`
        : `${state.responses} buy trigger${state.responses === 1 ? '' : 's'} accepted`;
  const t = s.trigger;
  const triggerValue = t.kind === 'rate' ? t.percent : t.amount;
  const endLabel =
    [
      s.endMaxSupplyPercent || s.endMaxTokenAmount
        ? autoSellMaximumLabel(s)
        : '',
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
                {autoSellEndLabel(state.endedReason, state.status)}
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
          Accounted {rawToDecimal(state.soldRaw, decimals)} (
          {pct(state.soldRaw)} supply) · queued{' '}
          {rawToDecimal(state.bufferedRaw, decimals)} · in progress{' '}
          {rawToDecimal(state.inFlightRaw, decimals)} · {stats}
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
                        <span className={styles.inRange}>Processed</span>
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
                  amount of tokens has been accounted for, after a certain
                  amount of time has passed, or both. Other strategies will
                  continue running.
                </span>
              </p>
              <div className={styles.row}>
                <div className={styles.field}>
                  <label htmlFor={`${id}-max`}>
                    Max Amount <small>(optional)</small>
                  </label>
                  <fieldset
                    className={styles.tiles2}
                    aria-label="Strategy maximum unit"
                  >
                    {(['supply', 'tokens'] as const).map((unit) => {
                      const selected =
                        (s.endMaxTokenAmount !== undefined
                          ? 'tokens'
                          : 'supply') === unit;
                      return (
                        <button
                          key={unit}
                          type="button"
                          aria-pressed={selected}
                          className={selected ? styles.tileActive : styles.tile}
                          onClick={() => {
                            if (!selected)
                              onChange({
                                endMaxSupplyPercent: '',
                                endMaxTokenAmount:
                                  unit === 'tokens' ? '' : undefined,
                              });
                          }}
                        >
                          {unit === 'supply' ? '% Supply' : 'Token amount'}
                        </button>
                      );
                    })}
                  </fieldset>
                  <div className={styles.suffixed}>
                    <Input
                      id={`${id}-max`}
                      inputMode="decimal"
                      placeholder="1"
                      value={s.endMaxTokenAmount ?? s.endMaxSupplyPercent}
                      onChange={(e) =>
                        onChange(
                          s.endMaxTokenAmount !== undefined
                            ? { endMaxTokenAmount: e.target.value.trim() }
                            : { endMaxSupplyPercent: e.target.value.trim() },
                        )
                      }
                    />
                    <span>
                      {s.endMaxTokenAmount !== undefined
                        ? 'Tokens'
                        : '% Supply'}
                    </span>
                  </div>
                  <p className={styles.hint}>
                    Changing the maximum unit clears its amount. No conversion
                    is assumed.
                  </p>
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
