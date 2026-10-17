'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { NativeWithdrawalPanel } from './native-withdrawal-panel';
import { unlockVault, VAULT_STORAGE_KEY } from '@/lib/browser-wallet-vault';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import {
  formatSendPercent,
  parseSendRows,
  planTokenSend,
  type SendLeg,
  type SendPlan,
} from '@/lib/token-send-plan';
import {
  generateLockMetadataKey,
  signSupplyAction,
  validatedSupplyAction,
  type SupplyActionKind,
  type TokenSupplyAction,
} from '@/lib/token-supply-action';
import type { TokenSendSnapshot } from '@/lib/token-send-snapshot-server';

type Tool = 'send' | 'burn' | 'lock';
const sumRaw = (values: string[]) =>
  values.reduce((t, v) => t + BigInt(v), 0n).toString();
const shareOfSupply = (raw: string, supply: string) =>
  formatSendPercent((BigInt(raw) * 1_000_000n) / BigInt(supply));
const percentLabel = (ppm: string) => formatSendPercent(BigInt(ppm));
const DAY = 86400;

/** Proxima-style token tools: Send (split by % of supply), Burn and Lock (Streamflow). Every transaction is reviewed, signed in this browser and submitted separately. */
export function TokenToolsPanel({
  wallets,
  initialMint = '',
}: {
  wallets: WorkspaceWallet[];
  initialMint?: string;
}) {
  const choices = wallets.filter((w) => w.chain === 'Solana' && !w.archived);
  const [open, setOpen] = useState(false),
    [tool, setTool] = useState<Tool>('send'),
    [mint, setMint] = useState(initialMint);
  return (
    <section className="native-withdrawal-panel" aria-label="Token tools">
      <div className="wallet-roster-actions">
        <h3>Token tools</h3>
        <Button variant="outline" onClick={() => setOpen(!open)}>
          {open ? 'Hide token tools' : 'Open token tools'}
        </Button>
      </div>
      {open && (
        <>
          <p>
            Send, burn or lock a share of a token&apos;s total supply. Each
            transaction is prepared and simulated on mainnet, signed with your
            key in this browser, and submitted only after a separate approval.
          </p>
          <div className="wallet-roster-actions" role="tablist">
            {(['send', 'burn', 'lock'] as const).map((t) => (
              <Button
                key={t}
                role="tab"
                aria-selected={tool === t}
                variant={tool === t ? 'default' : 'outline'}
                onClick={() => setTool(t)}
              >
                {t === 'send' ? 'Send' : t === 'burn' ? 'Burn' : 'Lock'}
              </Button>
            ))}
          </div>
          <label htmlFor="token-tools-mint">Token mint</label>
          <Input
            id="token-tools-mint"
            value={mint}
            onChange={(e) => setMint(e.target.value.trim())}
            placeholder="Token mint address"
          />
          {tool === 'send' ? (
            <SendTool key={mint} wallets={choices} all={wallets} mint={mint} />
          ) : (
            <SupplyTool key={tool} kind={tool} wallets={choices} mint={mint} />
          )}
        </>
      )}
    </section>
  );
}

function SendTool({
  wallets,
  all,
  mint,
}: {
  wallets: WorkspaceWallet[];
  all: WorkspaceWallet[];
  mint: string;
}) {
  const id = useId();
  const [sources, setSources] = useState<string[]>([]),
    [snapshot, setSnapshot] = useState<TokenSendSnapshot | null>(null),
    [mode, setMode] = useState<'simple' | 'advanced'>('simple'),
    [recipient, setRecipient] = useState(''),
    [percent, setPercent] = useState(''),
    [bulk, setBulk] = useState(''),
    [plan, setPlan] = useState<SendPlan | null>(null),
    [leg, setLeg] = useState<SendLeg | null>(null),
    [done, setDone] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const label = (a: string) =>
    all.find((w) => w.address === a)?.label ||
    a.slice(0, 4) + '…' + a.slice(-4);
  const reset = () => {
    setPlan(null);
    setLeg(null);
    setDone([]);
  };
  async function load() {
    setBusy(true);
    setError('');
    reset();
    try {
      const response = await fetch('/api/wallet-workspace/token-send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mint, wallets: sources }),
      });
      const value = (await response.json()) as {
        snapshot?: TokenSendSnapshot;
        error?: string;
      };
      if (!response.ok || !value.snapshot)
        throw new Error(value.error || 'Token balances unavailable.');
      if (
        value.snapshot.mint !== mint ||
        value.snapshot.balances.some((b, i) => b.address !== sources[i])
      )
        throw new Error('Balances do not match the selected wallets.');
      setSnapshot(value.snapshot);
    } catch (e) {
      setSnapshot(null);
      setError(e instanceof Error ? e.message : 'Token balances unavailable.');
    } finally {
      setBusy(false);
    }
  }
  function review() {
    setError('');
    reset();
    try {
      if (!snapshot) throw new Error('Load balances first.');
      const rows = parseSendRows(
        mode === 'simple' ? `${recipient.trim()},${percent.trim()}` : bulk,
      );
      setPlan(
        planTokenSend({
          supplyRaw: BigInt(snapshot.supplyRaw),
          decimals: snapshot.decimals,
          sources: snapshot.balances.map((b) => ({
            address: b.address,
            raw: BigInt(b.raw),
          })),
          rows,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Send plan unavailable.');
    }
  }
  const legKey = (l: SendLeg) => `${l.sender}>${l.recipient}`;
  return (
    <div className="native-withdrawal-form">
      <fieldset>
        <legend>From (source wallets)</legend>
        {wallets.length === 0 && <p>Add a Solana wallet first.</p>}
        {wallets.map((w) => (
          <label key={w.address} className="wallet-checkbox">
            <input
              type="checkbox"
              checked={sources.includes(w.address)}
              disabled={
                busy || (!sources.includes(w.address) && sources.length >= 25)
              }
              onChange={(e) => {
                setSnapshot(null);
                reset();
                setSources((prior) =>
                  e.target.checked
                    ? [...prior, w.address]
                    : prior.filter((a) => a !== w.address),
                );
              }}
            />{' '}
            {w.label || w.address} · {w.role}
          </label>
        ))}
      </fieldset>
      <Button
        variant="outline"
        disabled={busy || !mint || sources.length === 0}
        onClick={() => void load()}
      >
        Load supply and balances
      </Button>
      {snapshot && (
        <p className="tracker-note">
          Total supply{' '}
          {formatNativeBalance(snapshot.supplyRaw, snapshot.decimals)} ·
          selected wallets hold{' '}
          {formatNativeBalance(
            sumRaw(snapshot.balances.map((b) => b.raw)),
            snapshot.decimals,
          )}{' '}
          · finalized slot {snapshot.slot}
        </p>
      )}
      <label htmlFor={id + 'mode'}>Recipients</label>
      <select
        id={id + 'mode'}
        value={mode}
        onChange={(e) => {
          reset();
          setMode(e.target.value as 'simple' | 'advanced');
        }}
      >
        <option value="simple">Simple: one recipient</option>
        <option value="advanced">Advanced: bulk add</option>
      </select>
      {mode === 'simple' ? (
        <>
          <label htmlFor={id + 'to'}>Recipient</label>
          <Input
            id={id + 'to'}
            value={recipient}
            onChange={(e) => {
              reset();
              setRecipient(e.target.value);
            }}
            placeholder="Solana recipient address"
          />
          <label htmlFor={id + 'pct'}>Amount (% of total supply)</label>
          <Input
            id={id + 'pct'}
            value={percent}
            inputMode="decimal"
            onChange={(e) => {
              reset();
              setPercent(e.target.value);
            }}
            placeholder="1.5"
          />
        </>
      ) : (
        <>
          <label htmlFor={id + 'bulk'}>
            One per line: recipient,% or sender,recipient,% (comma, colon or
            tab)
          </label>
          <textarea
            id={id + 'bulk'}
            rows={6}
            value={bulk}
            onChange={(e) => {
              reset();
              setBulk(e.target.value);
            }}
          />
        </>
      )}
      <Button disabled={busy || !snapshot} onClick={review}>
        Review distribution
      </Button>
      {error && (
        <p role="alert" className="tracker-error">
          {error}
        </p>
      )}
      {plan && snapshot && (
        <article className="imported-trade-record">
          <h4>
            {plan.legs.length} transfer{plan.legs.length === 1 ? '' : 's'} ·{' '}
            {formatNativeBalance(plan.totalRaw, plan.decimals)} tokens
          </h4>
          <details>
            <summary>Wallet breakdown</summary>
            <ul>
              {plan.usage
                .filter((u) => u.usedRaw !== '0')
                .map((u) => (
                  <li key={u.address}>
                    {label(u.address)} sends{' '}
                    {formatNativeBalance(u.usedRaw, plan.decimals)} (
                    {shareOfSupply(u.usedRaw, plan.supplyRaw)} of supply), keeps{' '}
                    {formatNativeBalance(u.remainingRaw, plan.decimals)}
                  </li>
                ))}
            </ul>
          </details>
          <p className="tracker-note">
            Each transfer below is its own withdrawal: review it, sign it and
            submit it. Transfers from the same wallet go one at a time.
          </p>
          <ol>
            {plan.legs.map((l) => (
              <li key={legKey(l)}>
                {label(l.sender)} → {l.recipient}: {l.amount}{' '}
                {done.includes(legKey(l)) ? (
                  <span>· marked done</span>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => setLeg(l)}
                      aria-pressed={leg ? legKey(leg) === legKey(l) : false}
                    >
                      Review transfer
                    </Button>{' '}
                    <Button
                      variant="ghost"
                      onClick={() => setDone((d) => [...d, legKey(l)])}
                    >
                      Mark done
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ol>
          {leg && (
            <NativeWithdrawalPanel
              key={legKey(leg)}
              wallets={all}
              initialOpen
              initialWallet={leg.sender}
              initialToken={{ mint, decimals: plan.decimals }}
              initialRecipient={leg.recipient}
              initialAmount={leg.amount}
            />
          )}
        </article>
      )}
    </div>
  );
}

// Signed packets carry only public signatures, so the tab keeps a copy for
// registration/submission recovery after a reload.
const retained = {
  save(id: string, transaction: string) {
    try {
      sessionStorage.setItem('bundle.supply-signed.' + id, transaction);
    } catch {
      /* storage unavailable: registration still proceeds */
    }
  },
  load(id: string) {
    try {
      return sessionStorage.getItem('bundle.supply-signed.' + id);
    } catch {
      return null;
    }
  },
  clear(id: string) {
    try {
      sessionStorage.removeItem('bundle.supply-signed.' + id);
    } catch {
      /* ignore */
    }
  },
};

async function quietly<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}
/** Unlocks the vault only for this signature and wipes the decrypted seeds afterwards. */
async function vaultSign(
  password: string,
  review: TokenSupplyAction['document'],
  lockSecret?: Uint8Array,
) {
  const session = await unlockVault(
    localStorage.getItem(VAULT_STORAGE_KEY) || '',
    password,
  );
  try {
    return await signSupplyAction(session, review, () => {}, lockSecret);
  } finally {
    session.payload.wallets.forEach((w) => {
      w.seed = '';
    });
    session.payload.wallets.length = 0;
  }
}

function SupplyTool({
  kind,
  wallets,
  mint,
}: {
  kind: SupplyActionKind;
  wallets: WorkspaceWallet[];
  mint: string;
}) {
  const id = useId();
  const [wallet, setWallet] = useState(wallets[0]?.address ?? ''),
    [percent, setPercent] = useState(''),
    [duration, setDuration] = useState('30'),
    [unit, setUnit] = useState<'days' | 'months' | 'years'>('days'),
    [acknowledged, setAcknowledged] = useState(false),
    [action, setAction] = useState<TokenSupplyAction | null>(null),
    [history, setHistory] = useState<TokenSupplyAction[]>([]),
    [approveSign, setApproveSign] = useState(false),
    [approveSubmit, setApproveSubmit] = useState(false),
    [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [now, setNow] = useState(() => Date.now());
  // The Streamflow metadata key lives only in this tab's memory.
  const lockKey = useRef<{ address: string; secretKey: Uint8Array } | null>(
    null,
  );
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(timer);
      lockKey.current?.secretKey.fill(0);
    };
  }, []);
  const source = wallets.find((w) => w.address === wallet);
  const review = action?.document;
  const expired = !!review && Date.parse(review.expiresAt) <= now;
  const seconds =
    Number(duration) *
    (unit === 'days' ? DAY : unit === 'months' ? 30 * DAY : 365 * DAY);
  async function request(body: object) {
    const response = await fetch('/api/wallet-workspace/supply-actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(35000),
    });
    const value = (await response.json()) as {
      action?: TokenSupplyAction;
      error?: string;
    };
    if (!response.ok || !value.action)
      throw new Error(value.error || 'Burn or lock action unavailable.');
    const row = await validatedSupplyAction(value.action);
    if (row.wallet !== wallet) throw new Error('Wallet differs from review.');
    return row;
  }
  function show(row: TokenSupplyAction) {
    setHistory((prior) => [row, ...prior.filter((r) => r.id !== row.id)]);
    setAction(
      ['awaiting_signature', 'signing', 'signed', 'submitted'].includes(
        row.state,
      )
        ? row
        : null,
    );
    setApproveSign(false);
    setApproveSubmit(false);
  }
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action unavailable.');
    } finally {
      setBusy(false);
    }
  }
  const prepare = () =>
    run(async () => {
      if (kind === 'lock') {
        lockKey.current?.secretKey.fill(0);
        lockKey.current = generateLockMetadataKey();
      }
      const row = await request({
        action: 'prepare',
        kind,
        wallet,
        walletRevision: source?.revision,
        mint,
        percent,
        ...(kind === 'lock'
          ? { durationSeconds: seconds, lockMetadata: lockKey.current!.address }
          : {}),
        acknowledgeIrreversible: acknowledged,
      });
      show(row);
      setNotice(
        'Exact unsigned transaction simulated and saved. Review it, then approve signing.',
      );
    });
  const loadHistory = () =>
    run(async () => {
      const response = await fetch(
        '/api/wallet-workspace/supply-actions?wallet=' +
          encodeURIComponent(wallet),
        { cache: 'no-store' },
      );
      const value = (await response.json()) as {
        actions?: TokenSupplyAction[];
        active?: TokenSupplyAction | null;
        error?: string;
      };
      if (!response.ok || !value.actions)
        throw new Error(value.error || 'History unavailable.');
      const rows = await Promise.all(value.actions.map(validatedSupplyAction));
      setHistory(rows);
      setAction(
        value.active ? await validatedSupplyAction(value.active) : null,
      );
    });
  const sign = () =>
    run(async () => {
      if (!action || !approveSign || expired) return;
      const begun = await request({ action: 'begin_signing', id: action.id });
      show(begun);
      const key = lockKey.current;
      const signed = await vaultSign(
        password,
        action.document,
        key?.address === action.document.lock?.metadata
          ? key?.secretKey
          : undefined,
      ).catch(async (e: unknown) => {
        // No signature exists, so release the signing reservation.
        const released = await quietly(() =>
          request({
            action: 'reject_signing',
            id: action.id,
            noSignatureVerified: true,
          }),
        );
        if (released) show(released);
        throw e;
      });
      setPassword('');
      retained.save(action.id, signed.transaction);
      const registered = await request({
        action: 'register',
        id: action.id,
        transaction: signed.transaction,
      });
      if (registered.signature !== signed.signature)
        throw new Error('Signature registration did not match.');
      show(registered);
      setNotice(
        'Signed in this browser. Nothing has been sent. Approve the separate submission.',
      );
    });
  const submit = () =>
    run(async () => {
      if (!action || action.state !== 'signed' || !approveSubmit || expired)
        return;
      let transaction = retained.load(action.id);
      if (!transaction && action.signature && !action.document.lock) {
        // A burn has one signer, so the registered signature rebuilds it.
        const { default: bs58 } = await import('bs58');
        const bytes = Uint8Array.from(atob(action.document.transaction), (c) =>
          c.charCodeAt(0),
        );
        bytes.set(bs58.decode(action.signature), 1);
        transaction = btoa(String.fromCharCode(...bytes));
      }
      if (!transaction)
        throw new Error(
          'This tab no longer holds the signed lock. It was never sent; prepare a new lock.',
        );
      const row = await request({
        action: 'submit',
        id: action.id,
        transaction,
      });
      retained.clear(action.id);
      show(row);
      setNotice('Submitted once. Check the finalized outcome; do not resend.');
    });
  const recover = () =>
    run(async () => {
      if (!action) return;
      const row = await request({ action: 'recover', id: action.id });
      show(row);
      setNotice(
        row.state === 'finalized'
          ? kind === 'burn'
            ? 'Burn finalized. Supply reduced.'
            : 'Lock finalized on Streamflow.'
          : row.state === 'failed'
            ? 'The transaction failed on chain. No tokens moved.'
            : 'Outcome not final yet.',
      );
    });
  const registerRetained = () =>
    run(async () => {
      const transaction = action && retained.load(action.id);
      if (!action || !transaction)
        throw new Error('No signed packet is retained in this tab.');
      show(await request({ action: 'register', id: action.id, transaction }));
      setNotice(
        'Retained signature registered. Approve the separate submission.',
      );
    });
  const cancel = () =>
    run(async () => {
      if (!action) return;
      show(await request({ action: 'cancel', id: action.id }));
      setNotice('Unsigned review cancelled.');
    });
  const share = review ? percentLabel(review.percentPpm) : '';
  return (
    <div className="native-withdrawal-form">
      <p>
        {kind === 'burn'
          ? 'Burn permanently destroys tokens from one wallet and reduces total supply. It cannot be undone.'
          : 'Lock moves tokens into a Streamflow token lock that unlocks in full back to the same wallet at the end. It cannot be cancelled, transferred or shortened. Keep about 0.2 SOL in the wallet for Streamflow fees and rent.'}
      </p>
      <label htmlFor={id + 'wallet'}>Wallet</label>
      <select
        id={id + 'wallet'}
        value={wallet}
        disabled={busy || !!action}
        onChange={(e) => {
          setWallet(e.target.value);
          setHistory([]);
          setAction(null);
        }}
      >
        <option value="">Select a Solana wallet</option>
        {wallets.map((w) => (
          <option key={w.address} value={w.address}>
            {w.label || w.address} · {w.role}
          </option>
        ))}
      </select>
      <Button
        variant="outline"
        disabled={busy || !wallet}
        onClick={() => void loadHistory()}
      >
        Reload {kind} history
      </Button>
      {!action && (
        <>
          <label htmlFor={id + 'pct'}>Amount (% of total supply)</label>
          <Input
            id={id + 'pct'}
            value={percent}
            inputMode="decimal"
            onChange={(e) => setPercent(e.target.value)}
            placeholder="1"
          />
          {kind === 'lock' && (
            <div className="wallet-roster-actions">
              <label htmlFor={id + 'duration'}>Lock duration</label>
              <Input
                id={id + 'duration'}
                value={duration}
                inputMode="numeric"
                onChange={(e) => setDuration(e.target.value)}
              />
              <select
                aria-label="Duration unit"
                value={unit}
                onChange={(e) =>
                  setUnit(e.target.value as 'days' | 'months' | 'years')
                }
              >
                <option value="days">days</option>
                <option value="months">months (30 days)</option>
                <option value="years">years (365 days)</option>
              </select>
              {Number.isFinite(seconds) && seconds > 0 && (
                <span className="tracker-note">
                  Unlocks about{' '}
                  {new Date(now + seconds * 1000).toLocaleString()}
                </span>
              )}
            </div>
          )}
          <label className="wallet-checkbox">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />{' '}
            I understand this {kind} cannot be undone.
          </label>
          <Button
            disabled={busy || !source || !mint || !percent || !acknowledged}
            onClick={() => void prepare()}
          >
            Prepare {kind === 'burn' ? 'burn' : 'lock'}
          </Button>
        </>
      )}
      {error && (
        <p role="alert" className="tracker-error">
          {error}
        </p>
      )}
      {notice && <p className="tracker-note">{notice}</p>}
      {action && review && (
        <article className="imported-trade-record">
          <h4>
            {kind === 'burn' ? 'Burn' : 'Lock'} review · {action.state}
          </h4>
          <p>
            {review.amount} tokens ({share} of supply{' '}
            {formatNativeBalance(review.supplyRaw, review.decimals)}) from{' '}
            {review.wallet}
          </p>
          <p>
            Token debit in simulation:{' '}
            {formatNativeBalance(review.tokenDebitRaw, review.decimals)}
            {review.tokenDebitRaw !== review.amountRaw &&
              ' (includes the Streamflow token fee)'}{' '}
            · SOL cost up to{' '}
            {formatNativeBalance(
              sumRaw([review.solDebitLamports, review.feeLamports]),
              9,
            )}{' '}
            SOL
          </p>
          {review.lock && (
            <p>
              Unlocks {new Date(review.lock.unlockAt * 1000).toLocaleString()} ·
              Streamflow contract {review.lock.metadata}
            </p>
          )}
          <p className="tracker-note">
            {expired
              ? 'This review expired. Cancel it and prepare again.'
              : `Review expires in ${Math.max(0, Math.ceil((Date.parse(review.expiresAt) - now) / 1000))}s.`}
          </p>
          {action.state === 'awaiting_signature' && (
            <>
              <label className="wallet-checkbox">
                <input
                  type="checkbox"
                  checked={approveSign}
                  disabled={expired}
                  onChange={(e) => setApproveSign(e.target.checked)}
                />{' '}
                I approve signing this exact transaction.
              </label>
              <label htmlFor={id + 'pw'}>Vault password</label>
              <Input
                id={id + 'pw'}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <div className="wallet-roster-actions">
                <Button
                  disabled={busy || !approveSign || !password || expired}
                  onClick={() => void sign()}
                >
                  Sign in this browser
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void cancel()}
                >
                  Cancel review
                </Button>
              </div>
            </>
          )}
          {action.state === 'signing' && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void registerRetained()}
            >
              Register retained signature
            </Button>
          )}
          {action.state === 'signed' && (
            <>
              <label className="wallet-checkbox">
                <input
                  type="checkbox"
                  checked={approveSubmit}
                  disabled={expired}
                  onChange={(e) => setApproveSubmit(e.target.checked)}
                />{' '}
                Submit this signed {kind} to Solana mainnet now.
              </label>
              <Button
                disabled={busy || !approveSubmit || expired}
                onClick={() => void submit()}
              >
                Submit once
              </Button>
            </>
          )}
          {['signed', 'submitted'].includes(action.state) && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void recover()}
            >
              Check finalized outcome
            </Button>
          )}
        </article>
      )}
      {history.length > 0 && (
        <details>
          <summary>Recent burns and locks for this wallet</summary>
          <ul>
            {history.map((h) => (
              <li key={h.id}>
                {h.kind} {h.document.amount} · {h.state}
                {h.signature && ` · ${h.signature.slice(0, 12)}…`}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
