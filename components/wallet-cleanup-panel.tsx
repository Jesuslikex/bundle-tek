'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { unlockVault, VAULT_STORAGE_KEY } from '@/lib/browser-wallet-vault';
import {
  CLEANUP_MAX_WALLETS,
  cleanupTotals,
  isCleanupSell,
  signWalletCleanupBatch,
  validatedWalletCleanup,
  type CleanupSkipReason,
  type WalletCleanup,
} from '@/lib/wallet-cleanup';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import { solanaTokenAtoms } from '@/lib/solana-token-amount';

const SKIP_LABEL: Record<CleanupSkipReason, string> = {
  'holds-tokens': 'holds tokens (sell first)',
  frozen: 'frozen',
  'foreign-close-authority': 'another close authority',
  'withheld-fees': 'withheld transfer fees',
  'unsupported-extension': 'unsupported Token-2022 extension',
  'over-limit': 'over 20 accounts (run again)',
};
const sol = (lamports: bigint | string) =>
  formatNativeBalance(String(lamports), 9) + ' SOL';
const short = (address: string) =>
  address.slice(0, 4) + '…' + address.slice(-4);

type Batch = {
  batchId: string;
  stage: 'sell' | 'close';
  cleanups: WalletCleanup[];
  errors: { wallet: string; mint?: string; error: string }[];
  empty: string[];
  remaining: number;
};

async function request(body: object, signal?: AbortSignal) {
  const response = await fetch('/api/wallet-workspace/cleanup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const value = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok)
    throw new Error(
      typeof value.error === 'string' ? value.error : 'Cleanup unavailable.',
    );
  return value;
}

/** Close empty token accounts and sweep SOL from selected wallets to one destination. */
export function WalletCleanupPanel({
  wallets,
  selected,
}: {
  wallets: WorkspaceWallet[];
  selected: WorkspaceWallet[];
}) {
  const field = useId();
  const [open, setOpen] = useState(false),
    [destination, setDestination] = useState(''),
    [keep, setKeep] = useState('0'),
    [sellFirst, setSellFirst] = useState(true),
    [batch, setBatch] = useState<Batch | null>(null),
    [accepted, setAccepted] = useState(false),
    [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const epoch = useRef(0);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const sources = selected.filter((w) => w.chain === 'Solana' && !w.archived);
  const destinations = wallets.filter(
    (w) =>
      w.chain === 'Solana' &&
      !w.archived &&
      !sources.some((s) => s.address === w.address),
  );
  const rows = batch?.cleanups ?? [];
  const pending = rows.filter((r) => r.state === 'awaiting_signature');
  const totals = cleanupTotals(rows.map((r) => r.document));
  const reset = () => {
    epoch.current++;
    setBatch(null);
    setAccepted(false);
    setNotice('');
    setError('');
  };
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

  async function prepare(stage: 'sell' | 'close') {
    reset();
    setBusy(true);
    try {
      const keepLamports = /^0*(\.0*)?$/.test(keep.trim())
        ? '0'
        : solanaTokenAtoms(keep.trim(), 9).toString();
      const value = (await request({
        action: 'prepare',
        stage,
        destination,
        keepLamports,
        wallets: sources.map((w) => ({
          address: w.address,
          revision: w.revision,
        })),
      })) as Batch;
      for (const row of value.cleanups) await validatedWalletCleanup(row);
      if (
        value.cleanups.some(
          (r) =>
            r.document.destination !== destination ||
            r.batchId !== value.batchId,
        )
      )
        throw new Error('Cleanup review differs from the request.');
      if (
        stage === 'sell' &&
        !value.cleanups.length &&
        !value.errors.length &&
        !value.remaining
      ) {
        // Nothing to sell: go straight to closing accounts and sweeping SOL.
        setBusy(false);
        return await prepare('close');
      }
      if (mounted.current) setBatch(value);
    } catch (err) {
      if (mounted.current)
        setError(err instanceof Error ? err.message : 'Cleanup unavailable.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function approve() {
    if (!batch || !pending.length || !accepted) return;
    const current = epoch.current;
    const assertCurrent = () => {
      if (current !== epoch.current || !mounted.current)
        throw new Error('Cleanup review changed. Nothing further was signed.');
    };
    setBusy(true);
    setError('');
    let begun = false,
      signedAny = false;
    try {
      const reviews = pending.map((r) => r.document);
      const started = (await request({
        action: 'begin_signing',
        batchId: batch.batchId,
      })) as { cleanups: WalletCleanup[] };
      begun = true;
      setBatch({ ...batch, cleanups: started.cleanups });
      const session = await unlockVault(
        localStorage.getItem(VAULT_STORAGE_KEY) || '',
        password,
      );
      setPassword('');
      let signed: Awaited<ReturnType<typeof signWalletCleanupBatch>>;
      try {
        assertCurrent();
        signed = await signWalletCleanupBatch(session, reviews, assertCurrent);
        signedAny = true;
      } finally {
        session.payload.wallets.forEach((w) => {
          w.seed = '';
        });
        session.payload.wallets.length = 0;
      }
      let submitted = 0;
      const failures: string[] = [];
      for (const s of signed) {
        try {
          const registered = (await request({
            action: 'register',
            id: s.id,
            transaction: s.transaction,
          })) as { cleanup: WalletCleanup };
          merge(registered.cleanup);
          const sent = (await request({
            action: 'submit',
            id: s.id,
            transaction: s.transaction,
          })) as { cleanup: WalletCleanup };
          merge(sent.cleanup);
          submitted++;
        } catch (err) {
          failures.push(err instanceof Error ? err.message : String(err));
        }
      }
      setNotice(
        `${submitted} of ${signed.length} cleanup transactions submitted once each. Check outcomes after they finalize.` +
          (failures.length ? ' ' + failures.join(' ') : ''),
      );
    } catch (err) {
      if (begun && !signedAny)
        for (const row of pending)
          await request({
            action: 'reject_signing',
            id: row.id,
            noSignatureVerified: true,
          })
            .then((value) =>
              merge((value as { cleanup: WalletCleanup }).cleanup),
            )
            .catch(() => undefined);
      if (mounted.current)
        setError(
          err instanceof Error ? err.message : 'Cleanup signing failed.',
        );
    } finally {
      if (mounted.current) {
        setBusy(false);
        setAccepted(false);
        setPassword('');
      }
    }
  }

  async function recover() {
    setBusy(true);
    setError('');
    try {
      for (const row of rows.filter((r) =>
        ['signed', 'submitted'].includes(r.state),
      )) {
        try {
          const value = (await request({ action: 'recover', id: row.id })) as {
            cleanup: WalletCleanup;
          };
          merge(await validatedWalletCleanup(value.cleanup));
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Outcome unavailable.');
        }
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function cancel() {
    if (!batch) return;
    setBusy(true);
    try {
      const value = (await request({
        action: 'cancel',
        batchId: batch.batchId,
      })) as { cleanups: WalletCleanup[] };
      epoch.current++;
      setBatch({ ...batch, cleanups: value.cleanups });
      setAccepted(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cancel unavailable.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="native-withdrawal-panel" aria-label="Wallet cleanup">
      <div className="wallet-roster-actions">
        <h3>Clean up wallets</h3>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            reset();
            setOpen(!open);
          }}
        >
          {open ? 'Hide cleanup' : 'Open cleanup'}
        </Button>
      </div>
      {open && (
        <>
          <p>
            Solana mainnet. For each selected wallet, one transaction closes
            every empty token account (and unwraps wrapped SOL), sends the
            reclaimed rent and all remaining SOL to the destination, minus the
            network fee. With selling on, a first batch sells each leftover
            token balance to SOL; once those finalize, the close and sweep batch
            picks up the emptied accounts. Nothing is signed or sent until you
            approve each reviewed batch.
          </p>
          <p className="tracker-note">
            {sources.length
              ? `${sources.length} selected wallet${sources.length === 1 ? '' : 's'}.`
              : 'Select the wallets to clean up in the roster.'}{' '}
            Up to {CLEANUP_MAX_WALLETS} per batch.
          </p>
          <label htmlFor={field + 'destination'}>Destination wallet</label>
          <select
            id={field + 'destination'}
            value={destination}
            disabled={busy || Boolean(batch)}
            onChange={(e) => setDestination(e.target.value)}
          >
            <option value="">Select a saved Solana wallet</option>
            {destinations.map((w) => (
              <option key={w.address} value={w.address}>
                {w.label || w.address}
              </option>
            ))}
          </select>
          <label htmlFor={field + 'keep'}>Keep in each wallet (SOL)</label>
          <Input
            id={field + 'keep'}
            value={keep}
            inputMode="decimal"
            disabled={busy || Boolean(batch)}
            onChange={(e) => setKeep(e.target.value)}
          />
          <p className="tracker-note">
            0 empties each wallet completely. Any kept amount must be at least
            0.00089088 SOL (the rent minimum).
          </p>
          <label>
            <input
              type="checkbox"
              checked={sellFirst}
              disabled={busy || Boolean(batch)}
              onChange={(e) => setSellFirst(e.target.checked)}
            />{' '}
            Sell leftover tokens to SOL first (Jupiter, 0.5% max slippage, up to
            3 tokens per wallet)
          </label>
          {!batch && (
            <Button
              disabled={
                busy ||
                !destination ||
                !sources.length ||
                sources.length > CLEANUP_MAX_WALLETS
              }
              onClick={() => void prepare(sellFirst ? 'sell' : 'close')}
            >
              Scan and review cleanup
            </Button>
          )}
          {batch && (
            <div className="native-withdrawal-form">
              {batch.stage === 'sell' ? (
                <table>
                  <thead>
                    <tr>
                      <th>Wallet</th>
                      <th>Sell</th>
                      <th>Expected SOL</th>
                      <th>Minimum SOL</th>
                      <th>Price impact</th>
                      <th>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) =>
                      isCleanupSell(r.document) ? (
                        <tr key={r.id}>
                          <td title={r.wallet}>{short(r.wallet)}</td>
                          <td title={r.document.mint}>
                            {formatNativeBalance(
                              r.document.amountRaw,
                              r.document.decimals,
                            )}{' '}
                            of {short(r.document.mint)}
                          </td>
                          <td>{sol(r.document.expectedOutLamports)}</td>
                          <td>{sol(r.document.minimumOutLamports)}</td>
                          <td>
                            {r.document.priceImpactPct === null
                              ? 'unknown'
                              : `${r.document.priceImpactPct}%`}
                          </td>
                          <td>
                            {r.state.replace('_', ' ')}
                            {r.failure ? `: ${r.failure.error}` : ''}
                          </td>
                        </tr>
                      ) : null,
                    )}
                  </tbody>
                </table>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Wallet</th>
                      <th>Close</th>
                      <th>Rent back</th>
                      <th>SOL swept</th>
                      <th>Skipped</th>
                      <th>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) =>
                      isCleanupSell(r.document) ? null : (
                        <tr key={r.id}>
                          <td title={r.wallet}>{short(r.wallet)}</td>
                          <td>{r.document.close.length}</td>
                          <td>{sol(r.document.reclaimLamports)}</td>
                          <td>{sol(r.document.sweepLamports)}</td>
                          <td>
                            {r.document.skipped.length
                              ? r.document.skipped
                                  .map(
                                    (s) =>
                                      `${short(s.mint)}: ${SKIP_LABEL[s.reason]}`,
                                  )
                                  .join('; ') +
                                (r.document.skippedCount >
                                r.document.skipped.length
                                  ? ` (+${r.document.skippedCount - r.document.skipped.length} more)`
                                  : '')
                              : '—'}
                          </td>
                          <td>
                            {r.state.replace('_', ' ')}
                            {r.failure ? `: ${r.failure.error}` : ''}
                          </td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              )}
              {batch.stage === 'sell' ? (
                <output>
                  {totals.sells} sell{totals.sells === 1 ? '' : 's'} for at
                  least {sol(totals.minimumSellOut)} in total, before fees (up
                  to {sol(totals.fee)}). SOL stays in each wallet until the
                  close and sweep step.
                  {batch.remaining > 0 &&
                    ` ${batch.remaining} more holding${batch.remaining === 1 ? '' : 's'} left for a later round.`}
                </output>
              ) : (
                <output>
                  Destination {short(destination)} receives{' '}
                  {sol(totals.received)} ({sol(totals.reclaim)} rent from{' '}
                  {totals.closed} accounts and {sol(totals.sweep)} SOL). Network
                  fees {sol(totals.fee)}, paid by each wallet.
                </output>
              )}
              {batch.empty.length > 0 && (
                <p className="tracker-note">
                  Nothing to clean: {batch.empty.map(short).join(', ')}.
                </p>
              )}
              {batch.errors.map((e) => (
                <p key={e.wallet + (e.mint ?? '')} role="alert">
                  {short(e.wallet)}
                  {e.mint ? ` (${short(e.mint)})` : ''}: {e.error}
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
                    I reviewed these {pending.length} transactions. Sign each
                    with my browser vault and send each once to Solana mainnet.
                  </label>
                  <label htmlFor={field + 'password'}>Vault passphrase</label>
                  <Input
                    id={field + 'password'}
                    type="password"
                    value={password}
                    disabled={busy}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <div className="wallet-roster-actions">
                    <Button
                      disabled={busy || !accepted || !password}
                      onClick={() => void approve()}
                    >
                      Approve and send {pending.length} transaction
                      {pending.length === 1 ? '' : 's'}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void cancel()}
                    >
                      Cancel batch
                    </Button>
                  </div>
                </>
              )}
              <div className="wallet-roster-actions">
                {rows.some((r) =>
                  ['signed', 'submitted'].includes(r.state),
                ) && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void recover()}
                  >
                    Check outcomes
                  </Button>
                )}
                {batch.stage === 'sell' &&
                  !pending.length &&
                  rows.every((r) =>
                    ['finalized', 'failed', 'cancelled'].includes(r.state),
                  ) && (
                    <Button
                      disabled={busy}
                      onClick={() => void prepare('close')}
                    >
                      Continue: close accounts and sweep SOL
                    </Button>
                  )}
                {!pending.length && (
                  <Button variant="outline" disabled={busy} onClick={reset}>
                    New cleanup
                  </Button>
                )}
              </div>
            </div>
          )}
          {notice && <output>{notice}</output>}
          {error && <p role="alert">{error}</p>}
        </>
      )}
    </section>
  );
}
