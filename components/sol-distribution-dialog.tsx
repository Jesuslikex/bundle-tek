'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { unlockVault, VAULT_STORAGE_KEY } from '@/lib/browser-wallet-vault';
import {
  distributionMessage,
  formatSol,
  parseSol,
  planAmounts,
  signDistributionBatch,
  toBase64,
  type DistributionBatch,
  type DistributionMode,
} from '@/lib/sol-distribution';
import type { PreparedDistribution } from '@/lib/sol-distribution-server';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import type { WalletBalance } from '@/lib/wallet-balance-format';

type Planned = { address: string; lamports: bigint };
type Result = { batch: number; signature?: string; status: string };

const toLamports = (value: string) => BigInt(value);
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

async function post(body: Record<string, unknown>) {
  const response = await fetch('/api/wallet-workspace/distribute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const value = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok)
    throw new Error(
      typeof value.error === 'string' ? value.error : 'Request failed.',
    );
  return value;
}

/**
 * Checks the server's prepared packets are exactly what the user asked for,
 * rebuilt locally byte for byte, before anything can be signed.
 */
export function checkPrepared(
  prepared: PreparedDistribution,
  mode: DistributionMode,
  funder: string,
  asked: Planned[] | string[],
) {
  if (prepared.mode !== mode || prepared.funder !== funder)
    throw new Error('Prepared transfers differ from your request.');
  const seen = new Map<string, string>();
  for (const batch of prepared.batches) {
    if (
      batch.mode !== mode ||
      batch.funder !== funder ||
      batch.blockhash !== prepared.blockhash ||
      toBase64(distributionMessage(batch)) !== batch.message
    )
      throw new Error('Prepared transaction differs from its transfers.');
    for (const t of batch.transfers) {
      if (seen.has(t.address))
        throw new Error('Prepared transfers repeat a wallet.');
      seen.set(t.address, t.lamports);
    }
  }
  if (mode === 'fund') {
    const wanted = asked as Planned[];
    if (
      seen.size !== wanted.length ||
      wanted.some((p) => seen.get(p.address) !== p.lamports.toString())
    )
      throw new Error('Prepared amounts differ from your review.');
  } else {
    const wanted = new Set(asked as string[]);
    if ([...seen.keys()].some((a) => !wanted.has(a)))
      throw new Error('Prepared sources differ from your selection.');
  }
  return [...seen.values()].reduce((s, v) => s + BigInt(v), 0n);
}

export function SolDistributionDialog({
  mode,
  funder,
  open,
  onOpenChange,
}: {
  mode: DistributionMode;
  funder: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const id = useId();
  const [wallets, setWallets] = useState<WorkspaceWallet[]>([]);
  const [balances, setBalances] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [amountMode, setAmountMode] = useState<'fixed' | 'range'>('fixed');
  const [fixed, setFixed] = useState('0.01');
  const [min, setMin] = useState('0.01');
  const [max, setMax] = useState('0.02');
  const [planned, setPlanned] = useState<Planned[] | null>(null);
  const [prepared, setPrepared] = useState<PreparedDistribution | null>(null);
  const [password, setPassword] = useState('');
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const epoch = useRef(0);
  const fund = mode === 'fund';

  useEffect(() => {
    if (!open) return;
    // Mounted fresh per open (see LaunchWorkspacePanels), so state starts clean.
    const controller = new AbortController();
    fetch('/api/wallet-workspace', {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = (await response.json().catch(() => null)) as {
          wallets?: WorkspaceWallet[];
          balances?: WalletBalance[];
        } | null;
        if (!response.ok || !Array.isArray(data?.wallets))
          throw new Error('Wallets unavailable. Sign in and try again.');
        const list = data.wallets.filter(
          (w) => w.chain === 'Solana' && !w.archived && w.address !== funder,
        );
        setWallets(list);
        setSelected(list.map((w) => w.address));
        setBalances(
          new Map(
            (data.balances ?? [])
              .filter((b) => b.chain === 'Solana')
              .map((b) => [b.address, b.amount]),
          ),
        );
      })
      .catch((err) => {
        if (!controller.signal.aborted)
          setError(err instanceof Error ? err.message : 'Wallets unavailable.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, funder]);

  function resetReview() {
    epoch.current++;
    setPlanned(null);
    setPrepared(null);
    setApproved(false);
    setResults([]);
  }

  async function review() {
    const current = ++epoch.current;
    setBusy(true);
    setError('');
    setPrepared(null);
    setApproved(false);
    setResults([]);
    try {
      const chosen = wallets
        .map((w) => w.address)
        .filter((a) => selected.includes(a));
      if (!chosen.length) throw new Error('Select at least one wallet.');
      let plan: Planned[] | null = null;
      if (fund) {
        const amounts = planAmounts(
          chosen.length,
          amountMode === 'fixed'
            ? { fixed: parseSol(fixed) }
            : { min: parseSol(min), max: parseSol(max) },
        );
        plan = chosen.map((address, i) => ({ address, lamports: amounts[i] }));
      }
      const value = await post({
        action: 'prepare',
        mode,
        funder,
        ...(plan
          ? {
              transfers: plan.map((p) => ({
                address: p.address,
                lamports: p.lamports.toString(),
              })),
            }
          : { wallets: chosen }),
      });
      const next = value.prepared as PreparedDistribution;
      checkPrepared(next, mode, funder, plan ?? chosen);
      if (current !== epoch.current) return;
      setPlanned(plan);
      setPrepared(next);
    } catch (err) {
      if (current === epoch.current)
        setError(err instanceof Error ? err.message : 'Review failed.');
    } finally {
      if (current === epoch.current) setBusy(false);
    }
  }

  async function approveAndSend() {
    if (!prepared || !approved) return;
    const current = ++epoch.current;
    setBusy(true);
    setError('');
    try {
      checkPrepared(prepared, mode, funder, planned ?? selected);
      const session = await unlockVault(
        localStorage.getItem(VAULT_STORAGE_KEY) || '',
        password,
      );
      setPassword('');
      let signed: { batch: DistributionBatch; transaction: string }[];
      try {
        // Sign everything first: a missing key refuses the whole set.
        signed = prepared.batches.map((b) => {
          const batch: DistributionBatch = {
            mode: b.mode,
            funder: b.funder,
            blockhash: b.blockhash,
            transfers: b.transfers,
          };
          return {
            batch,
            transaction: signDistributionBatch(session, batch).transaction,
          };
        });
      } finally {
        session.payload.wallets.forEach((w) => {
          w.seed = '';
        });
        session.payload.wallets.length = 0;
      }
      if (current !== epoch.current) return;
      const out: Result[] = [];
      for (let i = 0; i < signed.length; i++) {
        try {
          const value = await post({ action: 'submit', ...signed[i] });
          out.push({
            batch: i + 1,
            signature: String(value.signature),
            status: 'sent',
          });
        } catch (err) {
          out.push({
            batch: i + 1,
            status: err instanceof Error ? err.message : 'Send failed.',
          });
        }
        if (current === epoch.current) setResults([...out]);
      }
      setPrepared(null);
      setApproved(false);
      const sent = out.filter((r) => r.signature);
      for (let round = 0; round < 20 && sent.length; round++) {
        await new Promise((r) => setTimeout(r, 2000));
        if (current !== epoch.current) return;
        const value = await post({
          action: 'status',
          signatures: sent.map((r) => r.signature),
        }).catch(() => null);
        const statuses = value?.statuses as string[] | undefined;
        if (!statuses) continue;
        sent.forEach((r, i) => (r.status = statuses[i]));
        setResults([...out]);
        if (statuses.every((s) => s !== 'pending')) break;
      }
    } catch (err) {
      if (current === epoch.current)
        setError(err instanceof Error ? err.message : 'Sending failed.');
    } finally {
      if (current === epoch.current) {
        setBusy(false);
        setPassword('');
      }
    }
  }

  const total = prepared ? toLamports(prepared.totalLamports) : 0n;
  const fee = prepared ? toLamports(prepared.feeLamports) : 0n;
  const funderAfter = prepared
    ? toLamports(prepared.funderLamports) + (fund ? -total - fee : total - fee)
    : 0n;
  const disabled = busy || loading;

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (busy) return;
        if (!value) epoch.current++;
        onOpenChange(value);
      }}
    >
      <DialogContent
        className="sol-distribution-dialog"
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>
            {fund ? 'Fund all wallets' : 'Return all to funder'}
          </DialogTitle>
          <DialogDescription>
            {fund
              ? 'Send SOL from your funder to the selected wallets in batched transactions, with one approval.'
              : 'Send the full SOL balance of each selected wallet back to your funder, with one approval. The funder pays the network fees.'}
          </DialogDescription>
        </DialogHeader>
        <p className="sol-distribution-funder">
          Funder <code>{funder}</code>
        </p>
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        {loading ? (
          <p>Loading wallets…</p>
        ) : !wallets.length ? (
          <p>No other saved Solana wallets.</p>
        ) : (
          <>
            {fund && (
              <fieldset className="sol-distribution-amount" disabled={disabled}>
                <legend>Amount per wallet</legend>
                <div role="radiogroup" className="sol-distribution-modes">
                  {(['fixed', 'range'] as const).map((value) => (
                    <label key={value}>
                      <input
                        type="radio"
                        name={`${id}-amount`}
                        checked={amountMode === value}
                        onChange={() => {
                          setAmountMode(value);
                          resetReview();
                        }}
                      />
                      {value === 'fixed' ? 'Fixed' : 'Range'}
                    </label>
                  ))}
                </div>
                {amountMode === 'fixed' ? (
                  <label htmlFor={`${id}-fixed`}>
                    SOL per wallet
                    <Input
                      id={`${id}-fixed`}
                      inputMode="decimal"
                      value={fixed}
                      onChange={(e) => {
                        setFixed(e.target.value);
                        resetReview();
                      }}
                    />
                  </label>
                ) : (
                  <div className="sol-distribution-range">
                    <label htmlFor={`${id}-min`}>
                      Min SOL
                      <Input
                        id={`${id}-min`}
                        inputMode="decimal"
                        value={min}
                        onChange={(e) => {
                          setMin(e.target.value);
                          resetReview();
                        }}
                      />
                    </label>
                    <label htmlFor={`${id}-max`}>
                      Max SOL
                      <Input
                        id={`${id}-max`}
                        inputMode="decimal"
                        value={max}
                        onChange={(e) => {
                          setMax(e.target.value);
                          resetReview();
                        }}
                      />
                    </label>
                  </div>
                )}
              </fieldset>
            )}
            <div className="sol-distribution-list">
              <label className="sol-distribution-all">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={selected.length === wallets.length}
                  onChange={(e) => {
                    setSelected(
                      e.target.checked ? wallets.map((w) => w.address) : [],
                    );
                    resetReview();
                  }}
                />
                Select all ({selected.length}/{wallets.length})
              </label>
              {wallets.map((w) => (
                <label key={w.address}>
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={selected.includes(w.address)}
                    onChange={(e) => {
                      setSelected((prev) =>
                        e.target.checked
                          ? [...prev, w.address]
                          : prev.filter((a) => a !== w.address),
                      );
                      resetReview();
                    }}
                  />
                  <span>{w.label || short(w.address)}</span>
                  <code title={w.address}>{short(w.address)}</code>
                  <span className="sol-distribution-balance">
                    {balances.has(w.address)
                      ? `${balances.get(w.address)} SOL`
                      : ''}
                  </span>
                </label>
              ))}
            </div>
            <Button
              variant="outline"
              disabled={disabled || !selected.length}
              onClick={() => void review()}
            >
              {busy && !prepared ? 'Reviewing…' : 'Review transfers'}
            </Button>
          </>
        )}
        {prepared && (
          <form
            className="sol-distribution-review"
            onSubmit={(e) => {
              e.preventDefault();
              void approveAndSend();
            }}
          >
            <h3>Review</h3>
            <dl>
              <dt>{fund ? 'Total sent' : 'Total returned'}</dt>
              <dd>{formatSol(total)} SOL</dd>
              <dt>Wallets</dt>
              <dd>
                {prepared.batches.reduce((s, b) => s + b.transfers.length, 0)}
                {prepared.skipped.length
                  ? ` (${prepared.skipped.length} empty skipped)`
                  : ''}
              </dd>
              <dt>Transactions</dt>
              <dd>{prepared.batches.length}</dd>
              <dt>Network fees</dt>
              <dd>{formatSol(fee)} SOL</dd>
              <dt>Funder after</dt>
              <dd>{formatSol(funderAfter < 0n ? 0n : funderAfter)} SOL</dd>
            </dl>
            <ul className="sol-distribution-plan">
              {prepared.batches.flatMap((b) =>
                b.transfers.map((t) => (
                  <li key={t.address}>
                    <code title={t.address}>{short(t.address)}</code>
                    <span>
                      {fund ? '+' : '−'}
                      {formatSol(toLamports(t.lamports))} SOL
                    </span>
                  </li>
                )),
              )}
            </ul>
            <p>
              Solana mainnet. Signed in this browser with your vault; keys are
              never sent to the server. Approve within about a minute or review
              again.
            </p>
            <label htmlFor={`${id}-password`}>Wallet password</label>
            <Input
              id={`${id}-password`}
              type="password"
              autoComplete="current-password"
              value={password}
              disabled={busy}
              onChange={(e) => setPassword(e.target.value)}
            />
            <label className="browser-vault-ack">
              <input
                type="checkbox"
                checked={approved}
                disabled={busy}
                onChange={(e) => setApproved(e.target.checked)}
              />
              I approve {prepared.batches.length} transaction
              {prepared.batches.length === 1 ? '' : 's'} moving{' '}
              {formatSol(total)} SOL.
            </label>
            <Button type="submit" disabled={busy || !approved || !password}>
              {busy ? 'Sending…' : 'Approve and send'}
            </Button>
          </form>
        )}
        {results.length > 0 && (
          <ul className="sol-distribution-results" aria-label="Results">
            {results.map((r) => (
              <li key={r.batch}>
                Transaction {r.batch}:{' '}
                {r.signature ? (
                  <a
                    href={`https://solscan.io/tx/${r.signature}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {r.status}
                  </a>
                ) : (
                  r.status
                )}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
