'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import styles from '@/components/launch/pump-launch-ui.module.css';
import { OpenLaunchChartButton } from './open-launch-chart-button';
import {
  SNIPER_GUARD_MAX_SECONDS,
  SNIPER_GUARD_WHITELIST_LIMIT,
  sniperGuardDisplay,
  sniperGuardThresholdRaw,
} from '@/lib/sniper-guard';
import {
  VENUE_SNIPER_DEFAULT_SECONDS,
  applyVenueSniperRead,
  armVenueSniper,
  parseVenueSniperState,
  stopVenueSniper,
  venueSniperSettings,
  venueSniperStorageKey,
  type VenueSniperLaunch,
  type VenueSniperRead,
  type VenueSniperResponse,
  type VenueSniperState,
  type VenueSniperVenue,
} from '@/lib/venue-sniper-guard';
import { unlockVault, VAULT_STORAGE_KEY } from '@/lib/browser-wallet-vault';
import {
  isCleanupSell,
  signWalletCleanupBatch,
  validatedWalletCleanup,
  type WalletCleanup,
} from '@/lib/wallet-cleanup';
import { formatNativeBalance } from '@/lib/wallet-balance-format';

export const VENUE_SNIPER_POLL_MS = 3000;
const short = (a: string) => a.slice(0, 4) + '…' + a.slice(-4);
const sol = (lamports: string) => formatNativeBalance(lamports, 9) + ' SOL';

async function api(path: string, body?: object, signal?: AbortSignal) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
    cache: 'no-store',
  });
  const value = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok)
    throw Object.assign(
      new Error(
        typeof value.error === 'string' ? value.error : 'Request failed.',
      ),
      { status: response.status },
    );
  return value;
}

function load(key: string, launch: VenueSniperLaunch) {
  try {
    return parseVenueSniperState(localStorage.getItem(key), launch);
  } catch {
    return null;
  }
}
function save(key: string, state: VenueSniperState | null) {
  try {
    if (state) localStorage.setItem(key, JSON.stringify(state));
    else localStorage.removeItem(key);
  } catch {
    // Storage unavailable: the guard still runs while this tab stays open.
  }
}

/**
 * Shown once a LetsBonk, Surge, StonkFun or Meteora DBC launch is broadcast:
 * links to the live coin and its chart, plus a browser-run Sniper Guard.
 */
export function VenueLaunchLive({
  venue,
  id,
}: {
  venue: VenueSniperVenue;
  id: string;
}) {
  const [launch, setLaunch] = useState<VenueSniperLaunch | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    api(
      `/api/venue-sniper-guard?${new URLSearchParams({ venue, id })}`,
      undefined,
      controller.signal,
    )
      .then((value) => setLaunch(value.launch as VenueSniperLaunch))
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Launch unavailable.');
      });
    return () => controller.abort();
  }, [venue, id]);
  if (error)
    return (
      <p role="alert" className="inspection-error">
        {error}
      </p>
    );
  if (!launch) return <p>Loading the live coin…</p>;
  return (
    <section aria-label="Live coin" className={styles.review}>
      <h4>
        {launch.state === 'finalized' ? 'Your coin is live' : 'Launch sent'}
      </h4>
      <p className={styles.wrap}>
        Token <code>{launch.mint}</code>
      </p>
      <p className={styles.wrap}>
        <a
          href={`https://dexscreener.com/solana/${launch.mint}`}
          target="_blank"
          rel="noreferrer noopener"
        >
          Open chart
        </a>
        {' · '}
        <a
          href={`https://solscan.io/token/${launch.mint}`}
          target="_blank"
          rel="noreferrer noopener"
        >
          Token on Solscan
        </a>
        {launch.signature && (
          <>
            {' · '}
            <a
              href={`https://solscan.io/tx/${launch.signature}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              Launch transaction
            </a>
          </>
        )}
      </p>
      {launch.state === 'finalized' && (
        <OpenLaunchChartButton mint={launch.mint} />
      )}
      <VenueSniperGuard launch={launch} />
    </section>
  );
}

function VenueSniperGuard({ launch }: { launch: VenueSniperLaunch }) {
  const field = useId();
  const key = venueSniperStorageKey(launch.venue, launch.id);
  const [state, setState] = useState<VenueSniperState | null>(() =>
    typeof localStorage === 'undefined' ? null : load(key, launch),
  );
  const [threshold, setThreshold] = useState('');
  const [seconds, setSeconds] = useState(String(VENUE_SNIPER_DEFAULT_SECONDS));
  const [whitelist, setWhitelist] = useState('');
  const [response, setResponse] = useState<VenueSniperResponse>('nuke');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const stateRef = useRef(state);
  const update = useCallback(
    (next: VenueSniperState | null) => {
      stateRef.current = next;
      save(key, next);
      setState(next);
    },
    [key],
  );

  const watching = state?.status === 'watching';
  useEffect(() => {
    if (!watching) return;
    let stopped = false,
      inFlight: AbortController | null = null;
    const poll = async () => {
      const current = stateRef.current;
      if (stopped || inFlight || current?.status !== 'watching') return;
      inFlight = new AbortController();
      try {
        const read = (await api(
          '/api/venue-sniper-guard',
          {
            action: 'observe',
            venue: launch.venue,
            id: launch.id,
            cursor: current.cursor,
          },
          inFlight.signal,
        )) as unknown as VenueSniperRead;
        const latest = stateRef.current;
        if (stopped || !latest || latest.armedAt !== current.armedAt) return;
        update(applyVenueSniperRead(latest, read, Date.now()));
        setNote(
          read.pending ? 'Some new transactions are still confirming.' : '',
        );
      } catch (e) {
        if (!stopped && (e as { status?: number }).status !== 429)
          setNote(
            e instanceof Error
              ? `${e.message} Retrying.`
              : 'Read failed. Retrying.',
          );
      } finally {
        inFlight = null;
      }
    };
    void poll();
    const timer = setInterval(() => {
      setNow(Date.now());
      void poll();
    }, VENUE_SNIPER_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
      inFlight?.abort();
    };
  }, [watching, launch.venue, launch.id, update]);

  function arm() {
    setError('');
    try {
      const secs = Number(seconds);
      if (
        !Number.isSafeInteger(secs) ||
        secs < 1 ||
        secs > SNIPER_GUARD_MAX_SECONDS
      )
        throw new Error(`Watch for 1 to ${SNIPER_GUARD_MAX_SECONDS} seconds.`);
      const list = whitelist
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.length > SNIPER_GUARD_WHITELIST_LIMIT)
        throw new Error(
          `A whitelist holds up to ${SNIPER_GUARD_WHITELIST_LIMIT} addresses.`,
        );
      const settings = venueSniperSettings({
        thresholdRaw: sniperGuardThresholdRaw(threshold, launch.quoteDecimals),
        seconds: secs,
        whitelist: list,
      });
      update(armVenueSniper(launch, settings, response, Date.now()));
      setNow(Date.now());
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Sniper Guard settings differ.',
      );
    }
  }

  const symbol = launch.quoteSymbol;
  if (!state)
    return (
      <div aria-label="Sniper Guard">
        <h4>Sniper Guard</h4>
        <p>
          Watches outside buys into this pool. If they add up to more than your
          threshold, it alerts you or prepares a sell of the developer wallet
          for you to review. Your own wallets and the whitelist never count. It
          runs while this tab is open and resumes after a reload.
        </p>
        <label htmlFor={field + '-threshold'}>
          Trigger when outside buys exceed ({symbol})
          <Input
            id={field + '-threshold'}
            inputMode="decimal"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
          />
        </label>
        <label htmlFor={field + '-seconds'}>
          Watch for (seconds)
          <Input
            id={field + '-seconds'}
            inputMode="numeric"
            value={seconds}
            onChange={(e) => setSeconds(e.target.value)}
          />
        </label>
        <label htmlFor={field + '-whitelist'}>
          Whitelist (optional, one address per line)
          <textarea
            id={field + '-whitelist'}
            rows={2}
            value={whitelist}
            onChange={(e) => setWhitelist(e.target.value)}
          />
        </label>
        <fieldset>
          <legend>When triggered</legend>
          <label>
            <input
              type="radio"
              name={field + '-response'}
              checked={response === 'nuke'}
              onChange={() => setResponse('nuke')}
            />{' '}
            Nuke: prepare a sell of the developer wallet for me to approve
          </label>
          <label>
            <input
              type="radio"
              name={field + '-response'}
              checked={response === 'alert'}
              onChange={() => setResponse('alert')}
            />{' '}
            Alert only
          </label>
        </fieldset>
        <Button type="button" disabled={!threshold.trim()} onClick={arm}>
          Start Sniper Guard
        </Button>
        {error && (
          <p role="alert" className="inspection-error">
            {error}
          </p>
        )}
      </div>
    );

  const end =
    state.settings.end.kind === 'timed'
      ? state.armedAt + state.settings.end.seconds * 1000
      : null;
  return (
    <div aria-label="Sniper Guard">
      <h4>Sniper Guard</h4>
      <p aria-live="polite">
        Outside buys{' '}
        {sniperGuardDisplay(state.externalTotalRaw, launch.quoteDecimals)} of{' '}
        {sniperGuardDisplay(state.settings.thresholdRaw, launch.quoteDecimals)}{' '}
        {symbol} ({state.buys.length} counted, {state.excludedCount} from your
        own wallets ignored).
        {state.coverage === 'partial' &&
          ' Some activity arrived faster than it could be read; the total is a lower bound.'}
      </p>
      {state.status === 'watching' && (
        <>
          <p>
            Watching
            {end !== null &&
              `, ${Math.max(0, Math.ceil((end - now) / 1000))}s left`}
            .
          </p>
          {note && <p className="tracker-note">{note}</p>}
          <Button
            type="button"
            variant="outline"
            onClick={() => update(stopVenueSniper(state, Date.now()))}
          >
            Stop Sniper Guard
          </Button>
        </>
      )}
      {state.status === 'ended' && (
        <p>The watch window ended without a trigger.</p>
      )}
      {state.status === 'stopped' && <p>You stopped Sniper Guard.</p>}
      {state.status === 'triggered' && (
        <>
          <p role="alert">
            Sniper Guard triggered: outside buys passed your threshold
            {state.triggeringSignature && (
              <>
                {' '}
                at{' '}
                <a
                  href={`https://solscan.io/tx/${state.triggeringSignature}`}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {short(state.triggeringSignature)}
                </a>
              </>
            )}
            .
          </p>
          {state.response === 'nuke' && <VenueNukeSell launch={launch} />}
        </>
      )}
      {state.status !== 'watching' && (
        <Button type="button" variant="outline" onClick={() => update(null)}>
          Set up a new guard
        </Button>
      )}
    </div>
  );
}

type Batch = {
  batchId: string;
  cleanups: WalletCleanup[];
  errors: { wallet: string; mint?: string; error: string }[];
};

/** One reviewed Jupiter sell of the developer's whole balance of this coin. */
function VenueNukeSell({ launch }: { launch: VenueSniperLaunch }) {
  const field = useId();
  const [batch, setBatch] = useState<Batch | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const rows = batch?.cleanups ?? [];
  const pending = rows.filter((r) => r.state === 'awaiting_signature');
  const merge = (updated: WalletCleanup) =>
    setBatch((b) =>
      b
        ? {
            ...b,
            cleanups: b.cleanups.map((r) =>
              r.id === updated.id ? updated : r,
            ),
          }
        : b,
    );
  const cleanup = (body: object) => api('/api/wallet-workspace/cleanup', body);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : 'Nuke sell failed.');
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  if (launch.developerRevision === null)
    return (
      <p>
        The developer wallet is no longer saved in your workspace, so Bundle
        cannot prepare its sell here.
      </p>
    );
  if (!launch.cleanupDestination)
    return (
      <p>
        Save a second Solana wallet in your workspace to use Nuke; Cleanup needs
        it for the later sweep step. The sale itself keeps its SOL in the
        developer wallet.
      </p>
    );

  const prepare = () =>
    run(async () => {
      setBatch(null);
      setAccepted(false);
      setNotice('');
      const value = (await cleanup({
        action: 'prepare',
        stage: 'sell',
        destination: launch.cleanupDestination,
        keepLamports: '0',
        mint: launch.mint,
        wallets: [
          { address: launch.developer, revision: launch.developerRevision },
        ],
      })) as unknown as Batch;
      for (const row of value.cleanups) await validatedWalletCleanup(row);
      if (
        value.cleanups.some(
          (r) =>
            r.wallet !== launch.developer ||
            !isCleanupSell(r.document) ||
            r.document.mint !== launch.mint,
        )
      )
        throw new Error('Nuke review differs from this coin.');
      if (!value.cleanups.length && !value.errors.length)
        throw new Error('The developer wallet holds none of this coin.');
      if (alive.current) setBatch(value);
    });

  const approve = () =>
    run(async () => {
      if (!batch || !pending.length) return;
      const reviews = pending.map((r) => r.document);
      const started = (await cleanup({
        action: 'begin_signing',
        batchId: batch.batchId,
      })) as unknown as { cleanups: WalletCleanup[] };
      setBatch({ ...batch, cleanups: started.cleanups });
      const pass = password;
      setPassword('');
      let signed: Awaited<ReturnType<typeof signWalletCleanupBatch>>;
      try {
        const session = await unlockVault(
          localStorage.getItem(VAULT_STORAGE_KEY) || '',
          pass,
        );
        try {
          signed = await signWalletCleanupBatch(session, reviews, () => {
            if (!alive.current) throw new Error('Nuke view closed.');
          });
        } finally {
          session.payload.wallets.forEach((w) => {
            w.seed = '';
          });
          session.payload.wallets.length = 0;
        }
      } catch (e) {
        for (const row of pending)
          await cleanup({
            action: 'reject_signing',
            id: row.id,
            noSignatureVerified: true,
          })
            .then((v) => merge((v as { cleanup: WalletCleanup }).cleanup))
            .catch(() => undefined);
        throw e;
      }
      for (const s of signed) {
        const registered = (await cleanup({
          action: 'register',
          id: s.id,
          transaction: s.transaction,
        })) as { cleanup: WalletCleanup };
        merge(registered.cleanup);
        const sent = (await cleanup({
          action: 'submit',
          id: s.id,
          transaction: s.transaction,
        })) as { cleanup: WalletCleanup };
        merge(sent.cleanup);
      }
      if (alive.current)
        setNotice(
          'Developer sell sent once. Check its outcome once it finalizes.',
        );
    });

  const recover = () =>
    run(async () => {
      for (const row of rows.filter((r) =>
        ['signed', 'submitted'].includes(r.state),
      )) {
        const value = (await cleanup({ action: 'recover', id: row.id })) as {
          cleanup: WalletCleanup;
        };
        merge(await validatedWalletCleanup(value.cleanup));
      }
    });

  return (
    <div aria-label="Nuke developer sell" className={styles.review}>
      <p>
        Nuke sells the developer wallet&apos;s whole balance of this coin to SOL
        through Jupiter (0.5% maximum slippage). Nothing is signed until you
        approve the reviewed transaction.
      </p>
      {!batch && (
        <Button type="button" disabled={busy} onClick={() => void prepare()}>
          {busy ? 'Preparing sell…' : 'Prepare developer sell'}
        </Button>
      )}
      {rows.map((r) =>
        isCleanupSell(r.document) ? (
          <table key={r.id} className={styles.table}>
            <tbody>
              <tr>
                <th scope="row">Wallet</th>
                <td title={r.wallet}>{short(r.wallet)}</td>
              </tr>
              <tr>
                <th scope="row">Sell</th>
                <td>
                  {formatNativeBalance(
                    r.document.amountRaw,
                    r.document.decimals,
                  )}
                </td>
              </tr>
              <tr>
                <th scope="row">Expected</th>
                <td>{sol(r.document.expectedOutLamports)}</td>
              </tr>
              <tr>
                <th scope="row">Minimum</th>
                <td>{sol(r.document.minimumOutLamports)}</td>
              </tr>
              <tr>
                <th scope="row">State</th>
                <td>
                  {r.state.replace('_', ' ')}
                  {r.failure ? `: ${r.failure.error}` : ''}
                </td>
              </tr>
            </tbody>
          </table>
        ) : null,
      )}
      {batch?.errors.map((e) => (
        <p key={e.wallet + (e.mint ?? '')} role="alert">
          {e.error}
        </p>
      ))}
      {pending.length > 0 && (
        <>
          <label>
            <input
              type="checkbox"
              checked={accepted}
              disabled={busy}
              onChange={(e) => setAccepted(e.target.checked)}
            />{' '}
            I approve this exact developer sell and sending it once.
          </label>
          <label htmlFor={field + '-pass'}>
            Wallet vault passphrase
            <Input
              id={field + '-pass'}
              type="password"
              autoComplete="current-password"
              value={password}
              disabled={busy}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <Button
            type="button"
            disabled={busy || !accepted || !password}
            onClick={() => void approve()}
          >
            Approve, sign and send once
          </Button>
        </>
      )}
      {rows.some((r) => ['signed', 'submitted'].includes(r.state)) && (
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => void recover()}
        >
          Check outcome
        </Button>
      )}
      {batch &&
        rows.every((r) =>
          ['finalized', 'failed', 'cancelled'].includes(r.state),
        ) && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void prepare()}
          >
            Prepare again
          </Button>
        )}
      {notice && <output>{notice}</output>}
      {error && (
        <p role="alert" className="inspection-error">
          {error}
        </p>
      )}
    </div>
  );
}
