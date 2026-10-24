'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import {
  MARKET_CLEANUP_MAX_ROUNDS,
  MARKET_CLEANUP_MAX_WALLETS,
  groupSupplyBps,
  validMarketCleanupConfig,
  type MarketCleanupBalance,
  type MarketCleanupConfig,
} from '@/lib/market-cleanup';
import {
  startMarketCleanup,
  type MarketCleanupSnapshot,
} from '@/lib/market-cleanup-runner';
import { abortableSleep } from '@/lib/auto-sell-execute';
import { createCleanupExecutor } from '@/lib/market-cleanup-execute';
import {
  unlockVault,
  VAULT_STORAGE_KEY,
  type VaultSession,
} from '@/lib/browser-wallet-vault';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import { solanaTokenAtoms } from '@/lib/solana-token-amount';

const short = (a: string) => a.slice(0, 4) + '…' + a.slice(-4);
const sol = (lamports: bigint) =>
  formatNativeBalance(lamports.toString(), 9) + ' SOL';
const pct = (bps: number) => (bps / 100).toFixed(2) + '%';
const rawSupply = (value: string | undefined) =>
  /^\d{1,40}$/.test(value ?? '') ? BigInt(value!) : 0n;
function wipe(session: VaultSession | null) {
  if (!session) return;
  session.payload.wallets.forEach((w) => {
    w.seed = '';
  });
  session.payload.wallets.length = 0;
}
const END_LABEL: Record<NonNullable<MarketCleanupSnapshot['end']>, string> = {
  'sellers-empty': 'Input wallets are empty.',
  'no-buyer': 'No output wallet could afford the next buy.',
  'max-rounds': 'All rounds finished.',
  'buy-cap': 'Reached the SOL cap for buys.',
  stopped: 'Stopped.',
  uncertain: 'Stopped on a trade whose outcome is not known yet.',
  failed: 'Stopped after errors.',
};

async function readBalances(
  project: ImportedTokenProject,
  wallets: string[],
  signal: AbortSignal,
): Promise<MarketCleanupBalance[]> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch('/api/market-cleanup/balances', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        revision: project.revision,
        wallets,
      }),
      signal,
      cache: 'no-store',
    });
    const value = (await response.json().catch(() => ({}))) as {
      error?: string;
      balances?: { wallet: string; tokenRaw: string; lamports: string }[];
    };
    if (response.status === 429 && attempt < 5) {
      await abortableSleep(2000, signal);
      continue;
    }
    if (!response.ok || !Array.isArray(value.balances))
      throw new Error(value.error || 'Cleanup balances unavailable.');
    const rows = value.balances.map((b) => ({
      wallet: b.wallet,
      tokenRaw: BigInt(b.tokenRaw),
      lamports: BigInt(b.lamports),
    }));
    if (rows.map((r) => r.wallet).join() !== wallets.join())
      throw new Error('Cleanup balances differ from the selected wallets.');
    return rows;
  }
}

/** Proxima-style project Cleanup: market sell→buy rounds between the user's own wallets. */
export function MarketCleanupPanel({
  project,
  wallets,
  locked,
}: {
  project: ImportedTokenProject;
  wallets: WorkspaceWallet[];
  locked: boolean;
}) {
  const field = useId();
  const token = project.document.token;
  const options = useMemo(
    () => wallets.filter((w) => w.chain === 'Solana' && !w.archived),
    [wallets],
  );
  const [sellers, setSellers] = useState<string[]>([]);
  const [buyers, setBuyers] = useState<string[]>([]);
  const [sellMin, setSellMin] = useState('100');
  const [sellMax, setSellMax] = useState('100');
  const [delayKind, setDelayKind] = useState<'fixed' | 'random'>('fixed');
  const [delayMin, setDelayMin] = useState('16');
  const [delayMax, setDelayMax] = useState('30');
  const [rounds, setRounds] = useState('10');
  const [buyCap, setBuyCap] = useState('');
  const [consent, setConsent] = useState(false);
  const [password, setPassword] = useState('');
  const [balances, setBalances] = useState<MarketCleanupBalance[] | null>(null);
  const [snapshot, setSnapshot] = useState<MarketCleanupSnapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const vault = useRef<VaultSession | null>(null);
  const run = useRef<ReturnType<typeof startMarketCleanup> | null>(null);
  useEffect(
    () => () => {
      run.current?.stop();
      wipe(vault.current);
      vault.current = null;
    },
    [],
  );
  const running = snapshot?.running === true;
  const disabled = locked || busy || running;
  const toggle = (
    list: string[],
    set: (next: string[]) => void,
    other: string[],
    setOther: (next: string[]) => void,
    wallet: string,
  ) => {
    setBalances(null);
    if (list.includes(wallet)) set(list.filter((w) => w !== wallet));
    else {
      set([...list, wallet]);
      if (other.includes(wallet)) setOther(other.filter((w) => w !== wallet));
    }
  };

  function config(): MarketCleanupConfig {
    const bps = (text: string) => {
      const value = Number(text);
      if (!Number.isFinite(value)) throw new Error('Enter a sell share in %.');
      return Math.round(value * 100);
    };
    const ms = (text: string) => {
      const value = Number(text);
      if (!Number.isFinite(value))
        throw new Error('Enter the delay in seconds.');
      return Math.round(value * 1000);
    };
    const maxRounds = Number(rounds);
    return validMarketCleanupConfig({
      sellers,
      buyers,
      sellMinBps: bps(sellMin),
      sellMaxBps: bps(sellMax),
      delay:
        delayKind === 'fixed'
          ? { kind: 'fixed', ms: ms(delayMin) }
          : { kind: 'random', minMs: ms(delayMin), maxMs: ms(delayMax) },
      maxRounds,
      maxBuyLamports: buyCap.trim() ? solanaTokenAtoms(buyCap.trim(), 9) : null,
    });
  }

  async function refresh() {
    setBusy(true);
    setError('');
    try {
      const list = [...sellers, ...buyers];
      if (!list.length)
        throw new Error('Select input and output wallets first.');
      setBalances(
        await readBalances(project, list, AbortSignal.timeout(30000)),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Balances unavailable.');
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    setError('');
    setBusy(true);
    try {
      const reviewed = config();
      const encrypted = localStorage.getItem(VAULT_STORAGE_KEY);
      if (!encrypted)
        throw new Error('Import these wallets into your browser vault first.');
      const pass = password;
      setPassword('');
      const session = await unlockVault(encrypted, pass);
      const vaultWallets = new Set(
        session.payload.wallets
          .filter((w) => w.family === 'solana')
          .map((w) => w.address),
      );
      const missing = [...reviewed.sellers, ...reviewed.buyers].find(
        (w) => !vaultWallets.has(w),
      );
      if (missing) {
        wipe(session);
        throw new Error(`Wallet ${short(missing)} is not in your vault.`);
      }
      vault.current = session;
      setConsent(false);
      const revisions = new Map(options.map((w) => [w.address, w.revision]));
      const executor = createCleanupExecutor({
        projectId: project.id,
        projectRevision: project.revision,
        mint: token.address,
        decimals: token.decimals,
        session: () => vault.current,
      });
      run.current = startMarketCleanup({
        config: reviewed,
        readBalances: (list, signal) => readBalances(project, list, signal),
        trade: (wallet, side, amountRaw, signal) =>
          executor.trade(
            { address: wallet, revision: revisions.get(wallet)! },
            side,
            amountRaw,
            signal,
          ),
        awaitFinal: executor.awaitFinal,
        sleep: abortableSleep,
        onUpdate: (next) => {
          setSnapshot(next);
          if (next.balances.length) setBalances(next.balances);
          if (!next.running) {
            wipe(vault.current);
            vault.current = null;
          }
        },
      });
    } catch (e) {
      wipe(vault.current);
      vault.current = null;
      setError(e instanceof Error ? e.message : 'Cleanup could not start.');
    } finally {
      setBusy(false);
    }
  }

  const byWallet = new Map((balances ?? []).map((b) => [b.wallet, b]));
  const supply = rawSupply(token.totalSupplyRaw);
  let configError = '';
  try {
    config();
  } catch (e) {
    configError = e instanceof Error ? e.message : 'Check the settings.';
  }
  const walletList = (
    title: string,
    list: string[],
    set: (next: string[]) => void,
    other: string[],
    setOther: (next: string[]) => void,
  ) => (
    <fieldset disabled={disabled}>
      <legend>
        {title} ({list.length})
      </legend>
      {options.map((w) => {
        const b = byWallet.get(w.address);
        return (
          <label key={w.address}>
            <input
              type="checkbox"
              checked={list.includes(w.address)}
              onChange={() => toggle(list, set, other, setOther, w.address)}
            />{' '}
            {w.label || short(w.address)}
            {b && list.includes(w.address) && (
              <>
                {' '}
                · {formatNativeBalance(
                  b.tokenRaw.toString(),
                  token.decimals,
                )}{' '}
                {token.symbol} · {sol(b.lamports)}
              </>
            )}
          </label>
        );
      })}
      {balances && (
        <p className="tracker-note">
          Total {pct(groupSupplyBps(list, byWallet, supply))} of supply
        </p>
      )}
    </fieldset>
  );

  return (
    <details className="imported-bundle-session-tools">
      <summary>Cleanup: sell→buy rounds</summary>
      <p>
        Sells {token.symbol} from input wallets and buys it back into output
        wallets on the market, one round at a time. Each round one seller sells
        part of its balance, and once that sale finalizes one buyer buys with
        exactly the SOL it returned. Up to {MARKET_CLEANUP_MAX_WALLETS} wallets
        on each side.
      </p>
      {walletList(
        'Input wallets (sellers)',
        sellers,
        setSellers,
        buyers,
        setBuyers,
      )}
      {walletList(
        'Output wallets (buyers)',
        buyers,
        setBuyers,
        sellers,
        setSellers,
      )}
      <Button
        type="button"
        variant="outline"
        disabled={disabled || !sellers.length || !buyers.length}
        onClick={() => void refresh()}
      >
        Read balances
      </Button>
      <fieldset disabled={disabled}>
        <legend>Sell per round (% of the seller balance)</legend>
        <label htmlFor={field + '-smin'}>
          From
          <Input
            id={field + '-smin'}
            inputMode="decimal"
            value={sellMin}
            onChange={(e) => setSellMin(e.target.value)}
          />
        </label>
        <label htmlFor={field + '-smax'}>
          To
          <Input
            id={field + '-smax'}
            inputMode="decimal"
            value={sellMax}
            onChange={(e) => setSellMax(e.target.value)}
          />
        </label>
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>Delay between rounds (0.5s to 300s)</legend>
        <label>
          <input
            type="radio"
            name={field + '-delay'}
            checked={delayKind === 'fixed'}
            onChange={() => setDelayKind('fixed')}
          />{' '}
          Fixed
        </label>
        <label>
          <input
            type="radio"
            name={field + '-delay'}
            checked={delayKind === 'random'}
            onChange={() => setDelayKind('random')}
          />{' '}
          Random
        </label>
        <label htmlFor={field + '-dmin'}>
          {delayKind === 'fixed' ? 'Seconds' : 'Minimum seconds'}
          <Input
            id={field + '-dmin'}
            inputMode="decimal"
            value={delayMin}
            onChange={(e) => setDelayMin(e.target.value)}
          />
        </label>
        {delayKind === 'random' && (
          <label htmlFor={field + '-dmax'}>
            Maximum seconds
            <Input
              id={field + '-dmax'}
              inputMode="decimal"
              value={delayMax}
              onChange={(e) => setDelayMax(e.target.value)}
            />
          </label>
        )}
      </fieldset>
      <label htmlFor={field + '-rounds'}>
        Rounds (up to {MARKET_CLEANUP_MAX_ROUNDS})
        <Input
          id={field + '-rounds'}
          inputMode="numeric"
          value={rounds}
          disabled={disabled}
          onChange={(e) => setRounds(e.target.value)}
        />
      </label>
      <label htmlFor={field + '-cap'}>
        SOL cap for all buys (optional)
        <Input
          id={field + '-cap'}
          inputMode="decimal"
          value={buyCap}
          disabled={disabled}
          onChange={(e) => setBuyCap(e.target.value)}
        />
      </label>
      <p className="tracker-note">
        Each trade waits for the server&apos;s wallet check (about 15 seconds),
        so a round takes at least half a minute plus your delay.
      </p>
      {configError && (sellers.length > 0 || buyers.length > 0) && (
        <p className="tracker-note">{configError}</p>
      )}
      {!running && (
        <>
          <label>
            <input
              type="checkbox"
              checked={consent}
              disabled={disabled || !!configError}
              onChange={(e) => setConsent(e.target.checked)}
            />{' '}
            I approve Cleanup to sign and send each round&apos;s sell and buy
            from these wallets with my unlocked vault while this tab stays open,
            until it stops.
          </label>
          <label htmlFor={field + '-pass'}>
            Wallet vault passphrase
            <Input
              id={field + '-pass'}
              type="password"
              autoComplete="current-password"
              value={password}
              disabled={disabled}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <Button
            type="button"
            disabled={disabled || !consent || !password || !!configError}
            onClick={() => void start()}
          >
            Start Cleanup
          </Button>
        </>
      )}
      {running && (
        <Button
          type="button"
          variant="outline"
          onClick={() => run.current?.stop()}
        >
          Stop Cleanup
        </Button>
      )}
      {snapshot && (
        <div aria-live="polite">
          <p>
            Round {snapshot.round}: sold{' '}
            {formatNativeBalance(snapshot.soldRaw.toString(), token.decimals)}{' '}
            for {sol(snapshot.receivedLamports)}, bought{' '}
            {formatNativeBalance(snapshot.boughtRaw.toString(), token.decimals)}{' '}
            for {sol(snapshot.spentLamports)}.
          </p>
          {snapshot.end && <output>{END_LABEL[snapshot.end]}</output>}
          {snapshot.uncertainSignature && (
            <p role="alert">
              Check{' '}
              <a
                href={`https://solscan.io/tx/${snapshot.uncertainSignature}`}
                target="_blank"
                rel="noreferrer noopener"
              >
                {short(snapshot.uncertainSignature)}
              </a>{' '}
              in preparation history before trading that wallet again. It is
              never resent.
            </p>
          )}
          <ol>
            {snapshot.log
              .slice(-20)
              .reverse()
              .map((entry, i) => (
                <li key={`${entry.at}-${i}`}>
                  Round {entry.round}: {entry.message}
                  {entry.wallet && ` (${short(entry.wallet)})`}
                </li>
              ))}
          </ol>
        </div>
      )}
      {error && (
        <p role="alert" className="inspection-error">
          {error}
        </p>
      )}
    </details>
  );
}
