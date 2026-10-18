'use client';
import { TransactionDeliveryNotice } from '@/components/transaction-delivery-notice';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import {
  VAULT_STORAGE_KEY,
  unlockVault,
  type VaultSession,
} from '@/lib/browser-wallet-vault';
import {
  decimalToRaw,
  VOLUME_LIMITS,
  volumeTerms,
  newVolumeSeed,
  rawToDecimal,
  type VolumePlan,
  type VolumeTerms,
} from '@/lib/volume-bot-plan';
import {
  signVolumeBatch,
  volumeBatchConsent,
  type VolumeBatchReview,
} from '@/lib/volume-bot-batch';
import {
  validateVolumeUsdTarget,
  type VolumeUsdTarget,
} from '@/lib/volume-usd-target';
import { DurationInput } from './duration-input';
import { parseDurationParts, splitDurationSeconds } from '@/lib/duration-parts';
import { readPanelJson } from './read-panel-json';
import { Button } from './ui/button';
import { Input } from './ui/input';
import styles from './volume-bot-panel.module.css';

const endpoint = '/api/imported-projects/volume-bot';
type Trade = {
  index: number;
  side: 'Buy' | 'Sell';
  wallet: string;
  signature: string;
  state: string;
  batchOffsetMs: number;
};
type Batch = {
  id: string;
  batch: number;
  state: string;
  expiresAt: string;
  review: VolumeBatchReview;
  trades: Trade[];
};
export type VolumeSession = {
  id: string;
  projectId: string;
  state: string;
  createdAt: string;
  plan: VolumePlan;
  realized: {
    finalizedTrades: number;
    volumeLamports: string;
    netSolLamports: string;
  };
  batches: Batch[];
};
const sol = (lamports: string | bigint) => {
  const raw = BigInt(lamports);
  const text = rawToDecimal(raw < 0n ? -raw : raw, 9);
  return `${raw < 0n ? '-' : ''}${text} SOL`;
};
const short = (address: string) =>
  `${address.slice(0, 4)}…${address.slice(-4)}`;
const duration = (seconds: number) => {
  const parts = splitDurationSeconds(seconds);
  return [
    Number(parts.hours) > 0 ? `${parts.hours}h` : '',
    Number(parts.minutes) > 0 ? `${parts.minutes}m` : '',
    Number(parts.seconds) > 0 || seconds === 0 ? `${parts.seconds}s` : '',
  ]
    .filter(Boolean)
    .join(' ');
};

async function call(payload?: object, projectId?: string) {
  const response = await fetch(
    payload ? endpoint : `${endpoint}?projectId=${projectId}`,
    payload
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(60_000),
        }
      : { cache: 'no-store', signal: AbortSignal.timeout(30_000) },
  );
  const data = await readPanelJson(
    response,
    'Volume Bot request unavailable. Reload before retrying.',
  );
  if (!response.ok)
    throw new Error(
      (data as { error?: string })?.error || 'Volume Bot request failed.',
    );
  return data;
}

export function VolumeBotPanel({
  project,
  wallets,
  locked,
}: {
  project: ImportedTokenProject;
  wallets: WorkspaceWallet[];
  locked: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (project.document.token.chain !== 'Solana') return null;
  return (
    <section aria-label="Volume Bot" className={styles.panel}>
      <Button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? 'Close' : 'Open'} Volume Bot
      </Button>
      {open && (
        <VolumeBotWorkspace
          key={`${project.id}:${project.revision}`}
          project={project}
          wallets={wallets.filter((w) => w.chain === 'Solana' && !w.archived)}
          locked={locked || project.archived}
        />
      )}
    </section>
  );
}

function VolumeBotWorkspace({
  project,
  wallets,
  locked,
}: {
  project: ImportedTokenProject;
  wallets: WorkspaceWallet[];
  locked: boolean;
}) {
  const id = useId();
  const [target, setTarget] = useState('1'),
    [durationParts, setDurationParts] = useState(() =>
      splitDurationSeconds(1800),
    ),
    [delayMin, setDelayMin] = useState('5'),
    [delayMax, setDelayMax] = useState('20'),
    [sizing, setSizing] = useState<'auto' | 'fixed' | 'range'>('auto'),
    [fixed, setFixed] = useState('0.05'),
    [rangeMin, setRangeMin] = useState('0.02'),
    [rangeMax, setRangeMax] = useState('0.08'),
    [waveIntensity, setWaveIntensity] = useState(0),
    [selected, setSelected] = useState<string[]>([]);
  const [targetUnit, setTargetUnit] = useState<'SOL' | 'USD'>('SOL');
  const [usdQuote, setUsdQuote] = useState<VolumeUsdTarget | null>(null);
  const [acceptConversion, setAcceptConversion] = useState(false);
  const draftVersion = useRef(0);
  const [estimate, setEstimate] = useState<{
    plan: VolumePlan;
    terms: VolumeTerms;
    seed: string;
    usdQuoteId?: string;
  } | null>(null);
  const [sessions, setSessions] = useState<VolumeSession[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [passphrase, setPassphrase] = useState(''),
    [unlocked, setUnlocked] = useState(false),
    [runningView, setRunningView] = useState(false),
    [approve, setApprove] = useState(false),
    [now, setNow] = useState(() => Date.now());
  const running = useRef(false),
    preparing = useRef(false),
    advance = useRef<(list: VolumeSession[]) => void>(() => {});
  const vault = useRef<VaultSession | null>(null),
    timers = useRef<ReturnType<typeof setTimeout>[]>([]),
    mounted = useRef(true);
  const active = sessions.find((s) => s.state === 'active');

  const lock = useCallback(() => {
    if (vault.current)
      for (const wallet of vault.current.payload.wallets) wallet.seed = '';
    vault.current = null;
    setUnlocked(false);
  }, []);
  const refresh = useCallback(async () => {
    const data = (await call(undefined, project.id)) as {
      sessions: VolumeSession[];
    };
    if (mounted.current) {
      setSessions(data.sessions);
      setTimeout(() => mounted.current && advance.current(data.sessions), 0);
    }
    return data.sessions;
  }, [project.id]);
  useEffect(() => {
    mounted.current = true;
    refresh().catch((e) => setError((e as Error).message));
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const pending = timers.current;
    return () => {
      mounted.current = false;
      clearInterval(tick);
      for (const t of pending.splice(0)) clearTimeout(t);
      lock();
    };
  }, [refresh, lock]);

  const run = useCallback(async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);

  const parsedDuration = parseDurationParts(
    durationParts,
    VOLUME_LIMITS.maxDurationSeconds,
  );
  const validDuration =
    parsedDuration.seconds !== null &&
    parsedDuration.seconds >= VOLUME_LIMITS.minDurationSeconds;
  const terms = (): VolumeTerms => {
    const lamports = (text: string, label: string) => {
      const raw = decimalToRaw(text, 9);
      if (raw === undefined || raw <= 0n)
        throw new Error(`Enter ${label} in SOL.`);
      return raw.toString();
    };
    const seconds = (text: string, label: string) => {
      const raw = decimalToRaw(text, 3);
      if (
        raw === undefined ||
        raw < BigInt(VOLUME_LIMITS.minDelayMs) ||
        raw > BigInt(VOLUME_LIMITS.maxDelayMs)
      )
        throw new Error(
          `Enter ${label} from 1 to 600 seconds with at most three decimal places.`,
        );
      return Number(raw);
    };
    if (!validDuration || parsedDuration.seconds === null)
      throw new Error(
        parsedDuration.error ||
          'Choose a session duration from 1 minute to 24 hours.',
      );
    if (!selected.length) throw new Error('Choose at least one wallet.');
    return volumeTerms({
      targetVolumeLamports:
        targetUnit === 'USD'
          ? currentUsdQuote().targetVolumeLamports
          : lamports(target, 'a target volume'),
      durationSeconds: parsedDuration.seconds,
      delayMinMs: seconds(delayMin, 'a minimum delay'),
      delayMaxMs: seconds(delayMax, 'a maximum delay'),
      amount:
        sizing === 'auto'
          ? { kind: 'auto' }
          : sizing === 'fixed'
            ? { kind: 'fixed', lamports: lamports(fixed, 'a trade amount') }
            : {
                kind: 'range',
                minLamports: lamports(rangeMin, 'a minimum amount'),
                maxLamports: lamports(rangeMax, 'a maximum amount'),
              },
      wave: waveIntensity === 0 ? 'tight' : 'big-waves',
      ...(waveIntensity === 0 ? {} : { waveIntensityTenths: waveIntensity }),
      wallets: selected,
    });
  };
  const changed = () => {
    draftVersion.current++;
    setEstimate(null);
  };
  const clearConversion = () => {
    changed();
    setUsdQuote(null);
    setAcceptConversion(false);
  };
  const currentUsdQuote = () => {
    if (
      !usdQuote ||
      usdQuote.targetUsd !== target ||
      usdQuote.projectId !== project.id ||
      usdQuote.projectRevision !== project.revision ||
      Date.parse(usdQuote.expiresAt) <= Date.now()
    )
      throw new Error('Capture a fresh USD conversion before estimating.');
    return usdQuote;
  };
  const captureUsd = () =>
    run(async () => {
      const version = draftVersion.current;
      setEstimate(null);
      setUsdQuote(null);
      setAcceptConversion(false);
      const data = (await call({
        action: 'quote-usd-target',
        projectId: project.id,
        projectRevision: project.revision,
        targetUsd: target,
      })) as { quote: unknown; executionAllowed: boolean };
      if (!mounted.current || version !== draftVersion.current) return;
      const quote = validateVolumeUsdTarget(data.quote);
      if (
        data.executionAllowed !== false ||
        quote.projectId !== project.id ||
        quote.projectRevision !== project.revision ||
        quote.targetUsd !== target ||
        Date.parse(quote.observedAt) > Date.now() ||
        Date.parse(quote.expiresAt) <= Date.now()
      )
        throw new Error('USD conversion changed or expired. Capture it again.');
      setUsdQuote(quote);
    });

  const doEstimate = () =>
    run(async () => {
      const version = draftVersion.current;
      const t = terms(),
        seed = newVolumeSeed();
      const quote = targetUnit === 'USD' ? currentUsdQuote() : null;
      const data = (await call({
        action: 'estimate',
        projectId: project.id,
        projectRevision: project.revision,
        terms: t,
        seed,
        ...(quote ? { usdQuoteId: quote.id } : {}),
      })) as { plan: VolumePlan };
      if (!mounted.current || version !== draftVersion.current) return;
      if (
        data.plan.seed !== seed ||
        JSON.stringify(data.plan.terms) !== JSON.stringify(t) ||
        JSON.stringify(data.plan.usdTarget) !==
          JSON.stringify(quote ?? undefined) ||
        data.plan.signingAllowed !== false ||
        data.plan.executionAllowed !== false
      )
        throw new Error(
          'Estimate differs from the current draft. Estimate again.',
        );
      if (quote && Date.parse(quote.expiresAt) <= Date.now())
        throw new Error('USD conversion expired. Capture it again.');
      setAcceptConversion(false);
      setEstimate({
        plan: data.plan,
        terms: t,
        seed,
        ...(quote ? { usdQuoteId: quote.id } : {}),
      });
    });
  const start = () =>
    run(async () => {
      if (!estimate) throw new Error('Estimate first.');
      if (
        estimate.usdQuoteId &&
        (!acceptConversion || currentUsdQuote().id !== estimate.usdQuoteId)
      )
        throw new Error(
          'Review and acknowledge the fixed SOL conversion first.',
        );
      await call({
        action: 'create',
        projectId: project.id,
        projectRevision: project.revision,
        terms: estimate.terms,
        seed: estimate.seed,
        ...(estimate.usdQuoteId ? { usdQuoteId: estimate.usdQuoteId } : {}),
      });
      setEstimate(null);
      await refresh();
    });
  const unlock = () =>
    run(async () => {
      const encrypted = localStorage.getItem(VAULT_STORAGE_KEY);
      if (!encrypted)
        throw new Error('Import these wallets into this browser vault first.');
      const pass = passphrase;
      setPassphrase('');
      const session = await unlockVault(encrypted, pass);
      const missing = (active?.plan.wallets ?? []).filter(
        (w) =>
          !session.payload.wallets.some(
            (v) => v.family === 'solana' && v.address === w,
          ),
      );
      if (missing.length) {
        for (const wallet of session.payload.wallets) wallet.seed = '';
        throw new Error(
          `This vault is missing ${missing.length} session wallet(s).`,
        );
      }
      vault.current = session;
      setUnlocked(true);
    });
  const prepareNext = useCallback(
    (session: VolumeSession) =>
      run(async () => {
        await call({ action: 'prepare-batch', sessionId: session.id });
        setApprove(false);
        await refresh();
      }),
    [run, refresh],
  );
  const observe = useCallback(
    async (batchId: string) => {
      try {
        await call({ action: 'observe', batchId });
        await refresh();
      } catch {
        // A later observation retries; nothing is resent.
      }
    },
    [refresh],
  );
  const approveAndSend = (session: VolumeSession, batch: Batch) =>
    run(async () => {
      if (!approve) throw new Error('Tick the approval for this exact batch.');
      if (!vault.current) throw new Error('Unlock the session wallets first.');
      const consent = volumeBatchConsent(batch.review);
      const signed = await signVolumeBatch(
        vault.current,
        batch.review,
        consent,
        () => {
          if (!mounted.current) throw new Error('Panel closed.');
        },
      );
      await call({
        action: 'register',
        batchId: batch.id,
        consent,
        transactions: signed.signed.map((s) => s.transaction),
      });
      setApprove(false);
      const started = Date.now();
      for (const trade of batch.review.trades)
        timers.current.push(
          setTimeout(
            () => {
              call({ action: 'send', batchId: batch.id, index: trade.index })
                .then(refresh)
                .catch(
                  (e) => mounted.current && setError((e as Error).message),
                );
            },
            Math.max(0, trade.batchOffsetMs - (Date.now() - started)),
          ),
        );
      const last = Math.max(...batch.review.trades.map((t) => t.batchOffsetMs));
      for (const delay of [8_000, 20_000, 40_000, 90_000])
        timers.current.push(setTimeout(() => observe(batch.id), last + delay));
      await refresh();
      void session;
    });
  const cancel = (session: VolumeSession) =>
    run(async () => {
      for (const t of timers.current.splice(0)) clearTimeout(t);
      running.current = false;
      setRunningView(false);
      await call({ action: 'cancel', sessionId: session.id });
      lock();
      await refresh();
    });

  // While running, prepare the next batch as soon as the previous one settles.
  const lastBatch = active?.batches.at(-1);
  useEffect(() => {
    advance.current = (list) => {
      const current = list.find((s) => s.state === 'active');
      if (!current) {
        running.current = false;
        setRunningView(false);
        if (vault.current) lock();
        return;
      }
      const last = current.batches.at(-1);
      if (
        running.current &&
        !preparing.current &&
        current.batches.length < current.plan.batches &&
        (!last || last.state === 'closed')
      ) {
        preparing.current = true;
        void prepareNext(current).finally(() => {
          preparing.current = false;
        });
      }
    };
  });
  const startRunning = () => {
    running.current = true;
    setRunningView(true);
    advance.current(sessions);
  };

  const openBatch =
    lastBatch && ['review', 'signed'].includes(lastBatch.state)
      ? lastBatch
      : undefined;
  const plan = estimate?.plan;
  return (
    <div className={styles.workspace}>
      <p className={styles.note}>
        Buys and sells this token from your wallets toward a volume target, like
        Proxima&apos;s Volume Bot. Trades are grouped into batches that fit one
        ~60 second blockhash window. You approve each batch once, this browser
        signs it, and each trade is sent at its time. It only runs while this
        panel is open. Each sell sells exactly what its own buy received.
      </p>
      <TransactionDeliveryNotice transport="rpc" />
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {!active && (
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            void doEstimate();
          }}
          onChange={changed}
        >
          <label htmlFor={`${id}-unit`}>Target currency</label>
          <select
            id={`${id}-unit`}
            value={targetUnit}
            onChange={(e) => {
              clearConversion();
              setTargetUnit(e.target.value as 'SOL' | 'USD');
              setTarget(e.target.value === 'USD' ? '100' : '1');
            }}
          >
            <option value="SOL">SOL</option>
            <option value="USD">USD at captured SOL price</option>
          </select>
          <label htmlFor={`${id}-target`}>Target volume ({targetUnit})</label>
          <Input
            id={`${id}-target`}
            inputMode="decimal"
            value={target}
            onChange={(e) => {
              clearConversion();
              setTarget(e.target.value);
            }}
          />
          {targetUnit === 'USD' && (
            <>
              <Button
                type="button"
                onClick={captureUsd}
                disabled={busy || locked}
              >
                Capture USD conversion
              </Button>
              {usdQuote && (
                <p className={styles.note}>
                  ${usdQuote.targetUsd} converts to{' '}
                  {sol(usdQuote.targetVolumeLamports)} at $
                  {usdQuote.solPriceUsd}/SOL. Source: {usdQuote.source}.
                  Captured {usdQuote.observedAt}.{' '}
                  {Date.parse(usdQuote.expiresAt) <= now
                    ? 'Conversion expired. Capture it again.'
                    : `Expires ${usdQuote.expiresAt}.`}{' '}
                  This fixes a SOL turnover target. It does not guarantee USD
                  turnover or profit.
                </p>
              )}
            </>
          )}
          <DurationInput
            label="Session duration"
            value={durationParts}
            onChange={setDurationParts}
            maximumSeconds={VOLUME_LIMITS.maxDurationSeconds}
            disabled={busy || locked}
          />
          <p className={styles.note}>
            From 1 minute to 24 hours as a planned schedule limit. The schedule
            can finish sooner at its volume target or {VOLUME_LIMITS.maxRounds}
            -round limit. Approval and settlement waits can make wall time
            longer.
          </p>
          {parsedDuration.seconds !== null && !validDuration && (
            <p role="alert" className={styles.error}>
              Choose a session duration from 1 minute to 24 hours.
            </p>
          )}
          <label htmlFor={`${id}-dmin`}>Delay between trades (seconds)</label>
          <div className={styles.pair}>
            <Input
              id={`${id}-dmin`}
              aria-label="Minimum delay"
              inputMode="decimal"
              value={delayMin}
              onChange={(e) => setDelayMin(e.target.value)}
            />
            <Input
              aria-label="Maximum delay"
              inputMode="decimal"
              value={delayMax}
              onChange={(e) => setDelayMax(e.target.value)}
            />
          </div>
          <p className={styles.note}>
            From 1 to 600 seconds, with up to three decimal places for exact
            millisecond delays.
          </p>
          <label htmlFor={`${id}-sizing`}>Trade amounts</label>
          <select
            id={`${id}-sizing`}
            value={sizing}
            onChange={(e) => setSizing(e.target.value as typeof sizing)}
          >
            <option value="auto">Auto (from duration)</option>
            <option value="fixed">Fixed</option>
            <option value="range">Random range</option>
          </select>
          {sizing === 'fixed' && (
            <Input
              aria-label="Fixed amount in SOL"
              inputMode="decimal"
              value={fixed}
              onChange={(e) => setFixed(e.target.value)}
            />
          )}
          {sizing === 'range' && (
            <div className={styles.pair}>
              <Input
                aria-label="Minimum amount in SOL"
                inputMode="decimal"
                value={rangeMin}
                onChange={(e) => setRangeMin(e.target.value)}
              />
              <Input
                aria-label="Maximum amount in SOL"
                inputMode="decimal"
                value={rangeMax}
                onChange={(e) => setRangeMax(e.target.value)}
              />
            </div>
          )}
          <label htmlFor={`${id}-wave`}>
            Wave intensity: {(waveIntensity / 10).toFixed(1)}
          </label>
          <input
            id={`${id}-wave`}
            aria-label="Wave intensity"
            type="range"
            min="0"
            max="1"
            step="0.1"
            value={waveIntensity / 10}
            className={styles.wave}
            aria-valuetext={(waveIntensity / 10).toFixed(1)}
            disabled={busy || locked}
            onChange={(event) => {
              const raw = decimalToRaw(event.target.value, 1);
              if (raw !== undefined && raw >= 0n && raw <= 10n)
                setWaveIntensity(Number(raw));
            }}
          />
          <div className={styles.waveLabels}>
            <span>Tight</span>
            <span>Big waves</span>
          </div>
          <p className={styles.note}>
            Higher intensity makes longer buy and sell streaks, limited to
            eligible wallets and at most six buys in a row. Each wallet sells
            only after its own buy settles, with a separate reviewed batch.
          </p>
          <fieldset className={styles.wallets}>
            <legend>Wallets</legend>
            {wallets.length ? (
              wallets.map((w) => (
                <label key={w.address}>
                  <input
                    type="checkbox"
                    checked={selected.includes(w.address)}
                    onChange={(e) =>
                      setSelected((old) =>
                        e.target.checked
                          ? [...old, w.address].slice(0, 25)
                          : old.filter((a) => a !== w.address),
                      )
                    }
                  />{' '}
                  {w.label || short(w.address)}
                </label>
              ))
            ) : (
              <p>No active Solana wallets.</p>
            )}
          </fieldset>
          <Button
            type="submit"
            disabled={
              busy ||
              locked ||
              !validDuration ||
              (targetUnit === 'USD' &&
                (!usdQuote || Date.parse(usdQuote.expiresAt) <= now))
            }
          >
            Estimate
          </Button>
        </form>
      )}
      {!active && plan && (
        <section aria-label="Volume Bot estimate" className={styles.card}>
          <dl>
            <dt>Volume</dt>
            <dd>{sol(plan.estimate.volumeLamports)}</dd>
            <dt>Round trips</dt>
            <dd>
              {plan.estimate.rounds} ({plan.estimate.trades} trades)
            </dd>
            <dt>Wave pattern</dt>
            <dd>
              {plan.terms.waveIntensityTenths === undefined
                ? plan.terms.wave === 'tight'
                  ? 'Tight'
                  : 'Legacy big waves'
                : `${(plan.terms.waveIntensityTenths / 10).toFixed(1)} intensity`}
            </dd>
            <dt>Approvals</dt>
            <dd>{plan.estimate.approvals} batches</dd>
            <dt>Schedule limit</dt>
            <dd>{duration(plan.terms.durationSeconds)}</dd>
            <dt>Scheduled time</dt>
            <dd>{duration(plan.estimate.scheduledSeconds)}</dd>
            <dt>Needed per wallet</dt>
            <dd>{sol(plan.estimate.requiredPerWalletLamports)}</dd>
            <dt>Network fees</dt>
            <dd>~{sol(plan.estimate.networkFeesLamports)}</dd>
            <dt>Swap cost</dt>
            <dd>~{sol(plan.estimate.swapCostLamports)}</dd>
          </dl>
          {plan.excludedWallets.length > 0 && (
            <p>
              Excluded for low balance:{' '}
              {plan.excludedWallets.map(short).join(', ')}
            </p>
          )}
          <p className={styles.note}>{plan.estimate.assumptions}</p>
          {plan.usdTarget && (
            <label>
              <input
                type="checkbox"
                checked={acceptConversion}
                onChange={(e) => setAcceptConversion(e.target.checked)}
              />{' '}
              I understand that ${plan.usdTarget.targetUsd} uses a fixed{' '}
              {sol(plan.usdTarget.targetVolumeLamports)} target at the captured
              price, not guaranteed USD turnover.
            </label>
          )}
          <Button
            type="button"
            disabled={
              busy ||
              locked ||
              !!(
                plan.usdTarget &&
                (!acceptConversion ||
                  Date.parse(plan.usdTarget.expiresAt) <= now)
              )
            }
            onClick={start}
          >
            Save session and reserve wallets
          </Button>
        </section>
      )}
      {active && (
        <section
          aria-label="Running Volume Bot session"
          className={styles.card}
        >
          <p>
            Batch {active.batches.filter((b) => b.state === 'closed').length} of{' '}
            {active.plan.batches} settled. Realized volume{' '}
            {sol(active.realized.volumeLamports)}, net{' '}
            {sol(active.realized.netSolLamports)} across{' '}
            {active.realized.finalizedTrades} trades.
          </p>
          {active.plan.usdTarget && (
            <p className={styles.note}>
              Requested ${active.plan.usdTarget.targetUsd}; fixed target{' '}
              {sol(active.plan.usdTarget.targetVolumeLamports)} at $
              {active.plan.usdTarget.solPriceUsd}/SOL, captured{' '}
              {active.plan.usdTarget.observedAt} from{' '}
              {active.plan.usdTarget.source}. Actual turnover is reported in
              SOL.
            </p>
          )}
          {!unlocked ? (
            <div className={styles.pair}>
              <Input
                type="password"
                aria-label="Wallet vault passphrase"
                placeholder="Vault passphrase"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
              />
              <Button
                type="button"
                disabled={busy || !passphrase}
                onClick={unlock}
              >
                Unlock wallets
              </Button>
            </div>
          ) : (
            <p className={styles.note}>
              Wallets unlocked in this tab only. They lock when you close the
              panel, cancel or the session ends.{' '}
              <button type="button" onClick={lock}>
                Lock now
              </button>
            </p>
          )}
          <div className={styles.pair}>
            <Button
              type="button"
              disabled={busy || !unlocked || runningView}
              onClick={startRunning}
            >
              Run
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy && !runningView}
              onClick={() => cancel(active)}
            >
              Cancel session
            </Button>
          </div>
          {openBatch && (
            <BatchReview
              batch={openBatch}
              now={now}
              approve={approve}
              setApprove={setApprove}
              disabled={busy || !unlocked}
              onApprove={() => approveAndSend(active, openBatch)}
            />
          )}
        </section>
      )}
      {sessions.some((s) => s.state !== 'active') && (
        <details>
          <summary>Previous sessions</summary>
          <ul>
            {sessions
              .filter((s) => s.state !== 'active')
              .map((s) => (
                <li key={s.id}>
                  {new Date(s.createdAt).toLocaleString()}: {s.state},{' '}
                  {sol(s.realized.volumeLamports)} volume over{' '}
                  {s.realized.finalizedTrades} trades, net{' '}
                  {sol(s.realized.netSolLamports)}
                </li>
              ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function BatchReview({
  batch,
  now,
  approve,
  setApprove,
  disabled,
  onApprove,
}: {
  batch: Batch;
  now: number;
  approve: boolean;
  setApprove: (value: boolean) => void;
  disabled: boolean;
  onApprove: () => void;
}) {
  const left = Math.max(
    0,
    Math.round((Date.parse(batch.expiresAt) - now) / 1000),
  );
  const decimals = batch.review.decimals;
  return (
    <div aria-label={`Batch ${batch.batch + 1}`}>
      <h5>
        Batch {batch.batch + 1}{' '}
        {batch.state === 'review'
          ? `(expires in ${left}s)`
          : `(${batch.state})`}
      </h5>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>At</th>
            <th>Side</th>
            <th>Wallet</th>
            <th>In</th>
            <th>Min out</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          {batch.review.trades.map((t) => {
            const state =
              batch.trades.find((x) => x.index === t.index)?.state ?? 'review';
            return (
              <tr key={t.index}>
                <td>+{(t.batchOffsetMs / 1000).toFixed(1)}s</td>
                <td>{t.side}</td>
                <td>{short(t.wallet)}</td>
                <td>
                  {t.side === 'Buy'
                    ? sol(t.inAmountRaw)
                    : rawToDecimal(BigInt(t.inAmountRaw), decimals)}
                </td>
                <td>
                  {t.side === 'Buy'
                    ? rawToDecimal(BigInt(t.minimumOutRaw), decimals)
                    : sol(t.minimumOutRaw)}
                </td>
                <td>{state}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {batch.review.skipped.length > 0 && (
        <p className={styles.note}>
          {batch.review.skipped.length} sell(s) skipped because their buy did
          not land.
        </p>
      )}
      {batch.state === 'review' && (
        <>
          <label>
            <input
              type="checkbox"
              checked={approve}
              onChange={(e) => setApprove(e.target.checked)}
            />{' '}
            I approve these {batch.review.trades.length} trades. Prices can move
            between trades; each trade is protected by its minimum output.
          </label>
          <Button
            type="button"
            disabled={disabled || !approve || left === 0}
            onClick={onApprove}
          >
            Sign and send batch
          </Button>
        </>
      )}
    </div>
  );
}
