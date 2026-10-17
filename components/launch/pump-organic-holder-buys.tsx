'use client';
import { useEffect, useId, useRef, useState } from 'react';
import styles from './pump-launch-ui.module.css';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { readPanelJson } from '@/components/read-panel-json';
import {
  VAULT_STORAGE_KEY,
  unlockVault,
  type VaultSession,
} from '@/lib/browser-wallet-vault';
import { clearMintSession } from '@/lib/pump-mint-vault';
import {
  signPumpOrganicBatch,
  type PumpOrganicBatchReview,
} from '@/lib/pump-organic-batch';
import type { planPumpOrganicSequence } from '@/lib/pump-organic-sequence';

type Plan = ReturnType<typeof planPumpOrganicSequence>;
type Batch = {
  id: string;
  batch: number;
  state: string;
  expiresAt: string;
  review: PumpOrganicBatchReview;
  buys: {
    index: number;
    holder: string;
    signature: string;
    state: string;
    batchOffsetMs: number;
  }[];
};
type Sequence = {
  id: string;
  launchReviewId: string;
  mint: string;
  state: string;
  plan: Plan;
  batches: Batch[];
};
const endpoint = '/api/launch/pump/organic';
const TOKEN_DECIMALS = 6n,
  LAMPORTS = 1_000_000_000n;
const short = (key: string) => key.slice(0, 4) + '…' + key.slice(-4);
const sol = (raw: string) => {
  const v = BigInt(raw);
  return `${v / LAMPORTS}.${(v % LAMPORTS).toString().padStart(9, '0').replace(/0+$/, '') || '0'}`;
};
/** Exact decimal string to raw base units; refuses extra precision. */
export function decimalToRaw(value: string, decimals: bigint) {
  const match = /^(\d{1,20})(?:\.(\d+))?$/.exec(value.trim());
  if (!match || (match[2]?.length ?? 0) > Number(decimals))
    throw new Error(`Use at most ${decimals} decimal places.`);
  const raw =
    BigInt(match[1]) * 10n ** decimals +
    BigInt((match[2] ?? '').padEnd(Number(decimals), '0') || '0');
  if (raw <= 0n) throw new Error('Amounts must be above zero.');
  return raw.toString();
}

async function call(body?: Record<string, unknown>, projectId?: string) {
  const response = await fetch(
    body ? endpoint : `${endpoint}?projectId=${encodeURIComponent(projectId!)}`,
    body
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  const data = (await readPanelJson(
    response,
    'Organic holder-buy request failed.',
  )) as Record<string, unknown>;
  if (!response.ok)
    throw new Error(
      typeof data.error === 'string'
        ? data.error
        : 'Organic holder-buy request failed.',
    );
  return data;
}

/**
 * Organic/Stagger holder buys after a finalized launch. Every batch needs its
 * own review, explicit approval, browser-local signing and a separate send
 * approval. Stop cancels every unsent buy.
 */
export function PumpOrganicHolderBuys({ projectId }: { projectId: string }) {
  const id = useId(),
    mounted = useRef(true),
    timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [open, setOpen] = useState(false),
    [launches, setLaunches] = useState<string[]>([]),
    [launchId, setLaunchId] = useState(''),
    [mode, setMode] = useState<'Organic' | 'Stagger'>('Organic'),
    [delayMin, setDelayMin] = useState('3'),
    [delayMax, setDelayMax] = useState('15'),
    [slippage, setSlippage] = useState('5'),
    [rent, setRent] = useState('0.004'),
    [rows, setRows] = useState('');
  const [sequences, setSequences] = useState<Sequence[]>([]),
    [approve, setApprove] = useState(false),
    [sendApproved, setSendApproved] = useState(false),
    [passphrase, setPassphrase] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');

  async function refresh() {
    const data = await call(undefined, projectId);
    if (mounted.current) setSequences((data.sequences as Sequence[]) ?? []);
  }
  useEffect(() => {
    mounted.current = true;
    if (!open) return;
    const pending = timers.current;
    void (async () => {
      try {
        const sources = await Promise.all(
          ['/api/launch/pump', '/api/launch/pump/holders'].map(async (path) => {
            const response = await fetch(
              `${path}?projectId=${encodeURIComponent(projectId)}`,
            );
            if (!response.ok) return [];
            const data = (await response.json()) as {
              launches?: {
                state?: string;
                id?: string;
                review?: { id?: string };
              }[];
            };
            return (data.launches ?? [])
              .filter((l) => l.state === 'finalized')
              .map((l) => l.review?.id ?? l.id ?? '')
              .filter(Boolean);
          }),
        );
        if (!mounted.current) return;
        const ids = sources.flat();
        setLaunches(ids);
        setLaunchId((current) => current || ids[0] || '');
        const listed = await call(undefined, projectId);
        if (mounted.current)
          setSequences((listed.sequences as Sequence[]) ?? []);
      } catch (e) {
        if (mounted.current) setError((e as Error).message);
      }
    })();
    return () => {
      mounted.current = false;
      for (const t of pending) clearTimeout(t);
    };
  }, [projectId, open]);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const active = sequences.find((s) => s.state === 'active');
  const nextBatch = active
    ? active.plan.batches.find(
        (b) =>
          !active.batches.some(
            (saved) => saved.batch === b.batch && saved.state !== 'stopped',
          ),
      )
    : undefined;
  const openBatch = active?.batches.find((b) =>
    ['review', 'signed'].includes(b.state),
  );

  const plan = () =>
    run(async () => {
      const buys = rows
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [address, amount] = line.split(/[\s,]+/);
          return {
            address,
            tokenAmountRaw: decimalToRaw(amount ?? '', TOKEN_DECIMALS),
          };
        });
      const min = Math.round(Number(delayMin) * 1000),
        max = Math.round(
          Number(mode === 'Stagger' ? delayMin : delayMax) * 1000,
        );
      await call({
        action: 'plan',
        terms: {
          launchReviewId: launchId,
          mode,
          buys,
          delayMinMs: min,
          delayMaxMs: max,
          slippageBps: Math.round(Number(slippage) * 100),
          rentAllowanceRaw: decimalToRaw(rent, 9n),
        },
      });
      await refresh();
    });
  const prepare = (sequenceId: string, batch: number) =>
    run(async () => {
      await call({ action: 'prepare-batch', sequenceId, batch });
      setApprove(false);
      await refresh();
    });
  const review = openBatch ?? null;

  const sign = (batch: Batch) =>
    run(async () => {
      if (!approve) throw new Error('Approve this exact batch first.');
      const encrypted = localStorage.getItem(VAULT_STORAGE_KEY);
      if (!encrypted)
        throw new Error('Import the holder wallets into this browser vault.');
      const pass = passphrase;
      setPassphrase('');
      let session: VaultSession | undefined;
      try {
        session = await unlockVault(encrypted, pass);
        const guard = () => {
          if (!mounted.current) throw new Error('Panel closed.');
          if (localStorage.getItem(VAULT_STORAGE_KEY) !== encrypted)
            throw new Error('Stored vault changed while signing.');
        };
        const consent = {
          approved: true as const,
          reviewId: batch.review.id,
          sha256: batch.review.sha256,
          scope: 'organic-holder-buy-batch' as const,
          acknowledgePriceMovesBetweenBuys: true as const,
        };
        const signed = await signPumpOrganicBatch(
          new Map(batch.review.buys.map((b) => [b.holder, session!])),
          batch.review,
          consent,
          guard,
        );
        await call({
          action: 'register',
          batchId: batch.id,
          consent,
          transactions: signed.signed.map((s) => s.transaction),
        });
      } finally {
        if (session) clearMintSession(session);
      }
      await refresh();
    });

  const start = (batch: Batch) => {
    if (!sendApproved) return setError('Approve sending this batch first.');
    setError('');
    const started = Date.now();
    for (const buy of batch.buys.filter((b) => b.state === 'signed')) {
      const wait = Math.max(0, buy.batchOffsetMs - (Date.now() - started));
      timers.current.push(
        setTimeout(() => {
          call({
            action: 'send',
            batchId: batch.id,
            index: buy.index,
            sendApproved: true,
          })
            .then(refresh)
            .catch((e) => mounted.current && setError((e as Error).message));
        }, wait),
      );
    }
    const last = Math.max(...batch.buys.map((b) => b.batchOffsetMs));
    for (const delay of [last + 8_000, last + 30_000, last + 90_000])
      timers.current.push(
        setTimeout(() => {
          call({ action: 'observe', batchId: batch.id })
            .then(refresh)
            .catch(() => {});
        }, delay),
      );
    setSendApproved(false);
  };
  const stop = (sequenceId: string) =>
    run(async () => {
      for (const t of timers.current.splice(0)) clearTimeout(t);
      await call({ action: 'stop', sequenceId });
      await refresh();
    });

  return !open ? (
    <section className={styles.panel}>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        Organic and Stagger holder buys
      </Button>
    </section>
  ) : (
    <section className={styles.panel} aria-labelledby={id + '-title'}>
      <h3 id={id + '-title'}>Organic and Stagger holder buys</h3>
      <p>
        Holder buys go out one at a time after your token is live. Each batch is
        reviewed, simulated, approved and signed in this browser before anything
        is sent. Prices move between buys; each buy has its own cap.
      </p>
      {error && <p role="alert">{error}</p>}
      {!active && (
        <div className={styles.limits}>
          <label>
            Finalized launch
            <select
              value={launchId}
              onChange={(e) => setLaunchId(e.target.value)}
            >
              {!launches.length && (
                <option value="">No finalized launch</option>
              )}
              {launches.map((l) => (
                <option key={l} value={l}>
                  {short(l)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Mode
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as 'Organic' | 'Stagger')}
            >
              <option value="Organic">Organic (random delay)</option>
              <option value="Stagger">Stagger (fixed delay)</option>
            </select>
          </label>
          <label htmlFor={id + '-f1'}>
            {mode === 'Organic' ? 'Minimum delay (s)' : 'Delay (s)'}
            <Input
              id={id + '-f1'}
              value={delayMin}
              onChange={(e) => setDelayMin(e.target.value)}
            />
          </label>
          {mode === 'Organic' && (
            <label htmlFor={id + '-f2'}>
              Maximum delay (s)
              <Input
                id={id + '-f2'}
                value={delayMax}
                onChange={(e) => setDelayMax(e.target.value)}
              />
            </label>
          )}
          <label htmlFor={id + '-f3'}>
            Slippage per buy (%)
            <Input
              id={id + '-f3'}
              value={slippage}
              onChange={(e) => setSlippage(e.target.value)}
            />
          </label>
          <label htmlFor={id + '-rent'}>
            Rent allowance per buy (SOL)
            <Input
              id={id + '-rent'}
              value={rent}
              onChange={(e) => setRent(e.target.value)}
            />
          </label>
          <label htmlFor={id + '-rows'}>
            Holder wallets and token amounts, one per line
            <textarea
              id={id + '-rows'}
              rows={5}
              value={rows}
              placeholder="WalletAddress 1500000 (whole tokens)"
              onChange={(e) => setRows(e.target.value)}
            />
          </label>
          <div className={styles.actions}>
            <Button
              type="button"
              disabled={busy || !launchId || !rows.trim()}
              onClick={plan}
            >
              Plan holder buys
            </Button>
          </div>
        </div>
      )}
      {active && (
        <div className={styles.review}>
          <p>
            {active.plan.mode} · {active.plan.rows.length} buys ·{' '}
            {active.plan.batches.length} batches · up to{' '}
            {sol(active.plan.maximumQuoteCostRaw)} SOL total
          </p>
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Wallet</th>
                  <th>Batch</th>
                  <th>Starts after</th>
                  <th>Max cost (SOL)</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {active.plan.rows.map((row) => {
                  const state =
                    active.batches
                      .flatMap((b) => b.buys)
                      .find((b) => b.index === row.index)?.state ?? 'planned';
                  return (
                    <tr key={row.index}>
                      <td>{row.index + 1}</td>
                      <td>{short(row.address)}</td>
                      <td>{row.batch + 1}</td>
                      <td>{(row.offsetMs / 1000).toFixed(1)}s</td>
                      <td>{sol(row.maximumQuoteCostRaw)}</td>
                      <td>{state}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {review?.state === 'review' && (
            <div className={styles.limits}>
              <label>
                <input
                  type="checkbox"
                  checked={approve}
                  onChange={(e) => setApprove(e.target.checked)}
                />{' '}
                I approve these {review.review.buys.length} buys up to{' '}
                {sol(
                  review.review.buys
                    .reduce((s, b) => s + BigInt(b.maximumQuoteCostRaw), 0n)
                    .toString(),
                )}{' '}
                SOL. Prices can move between buys.
              </label>
              <label htmlFor={id + '-f4'}>
                Wallet vault passphrase
                <Input
                  id={id + '-f4'}
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                />
              </label>
              <Button
                type="button"
                disabled={busy || !approve || !passphrase}
                onClick={() => sign(review)}
              >
                Sign batch {review.batch + 1}
              </Button>
            </div>
          )}
          {review?.state === 'signed' &&
            review.buys.some((b) => b.state === 'signed') && (
              <div className={styles.limits}>
                <label>
                  <input
                    type="checkbox"
                    checked={sendApproved}
                    onChange={(e) => setSendApproved(e.target.checked)}
                  />{' '}
                  Send these signed buys once each, on schedule. Keep this page
                  open; unsent buys expire.
                </label>
                <Button
                  type="button"
                  disabled={!sendApproved}
                  onClick={() => start(review)}
                >
                  Start batch {review.batch + 1}
                </Button>
              </div>
            )}
          <div className={styles.actions}>
            {nextBatch && !openBatch && (
              <Button
                type="button"
                disabled={busy}
                onClick={() => prepare(active.id, nextBatch.batch)}
              >
                Prepare batch {nextBatch.batch + 1}
              </Button>
            )}
            {review?.state === 'signed' && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await call({ action: 'observe', batchId: review.id });
                    await refresh();
                  })
                }
              >
                Check status
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => stop(active.id)}
            >
              Stop
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
