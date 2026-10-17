'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { unlockVault, VAULT_STORAGE_KEY } from '@/lib/browser-wallet-vault';
import {
  signCreatorFeeClaim,
  vaultKey,
  CLAIM_WSOL,
  type CreatorFeeClaimReceipt,
  type CreatorFeeClaimReview,
  type CreatorFeeVault,
} from '@/lib/pump-creator-fees';
import type { CreatorFeeScan } from '@/lib/pump-creator-fees-server';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import { quoteCatalog } from '@/lib/quote-catalog';

const ENDPOINT = '/api/wallet-workspace/creator-fees';
const QUOTES = quoteCatalog('Solana', 'PumpFun').assets;
const symbol = (mint: string) =>
  mint === CLAIM_WSOL
    ? 'SOL'
    : (QUOTES.find((q) => q.address === mint)?.symbol ?? mint.slice(0, 6));
const sol = (raw: string) => {
  const negative = raw.startsWith('-');
  return (
    (negative ? '-' : '') +
    formatNativeBalance(negative ? raw.slice(1) : raw, 9) +
    ' SOL'
  );
};
const KIND: Record<CreatorFeeVault['kind'], string> = {
  'pump-sol': 'Bonding curve',
  'pump-token': 'Bonding curve',
  'amm-token': 'PumpSwap',
};
const amount = (v: CreatorFeeVault) =>
  `${formatNativeBalance(v.claimableRaw, v.decimals)} ${
    v.kind === 'amm-token' && v.quoteMint === CLAIM_WSOL
      ? 'WSOL'
      : symbol(v.quoteMint)
  }`;
type Signed = { signature: string; transaction: string };

/** Pump.fun creator fee claims: scan, review, sign in the browser, then a separate send. */
export function CreatorFeeClaimPanel({
  wallets,
}: {
  wallets: WorkspaceWallet[];
}) {
  const choices = wallets.filter((w) => w.chain === 'Solana' && !w.archived);
  const [open, setOpen] = useState(false),
    [wallet, setWallet] = useState(choices[0]?.address ?? ''),
    [extraQuote, setExtraQuote] = useState(''),
    [scan, setScan] = useState<CreatorFeeScan | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [review, setReview] = useState<CreatorFeeClaimReview | null>(null),
    [accepted, setAccepted] = useState(false),
    [password, setPassword] = useState(''),
    [signed, setSigned] = useState<Signed | null>(null),
    [sent, setSent] = useState<string | null>(null),
    [receipt, setReceipt] = useState<CreatorFeeClaimReceipt | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [now, setNow] = useState(() => Date.now());
  const epoch = useRef(0),
    field = useId();
  const source = choices.find((w) => w.address === wallet);
  const expired = !!review && Date.parse(review.expiresAt) <= now;
  useEffect(() => {
    if (!review || sent) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [review, sent]);
  function reset(keepScan = false) {
    epoch.current++;
    if (!keepScan) {
      setScan(null);
      setSelected([]);
    }
    setReview(null);
    setAccepted(false);
    setPassword('');
    setSigned(null);
    setSent(null);
    setReceipt(null);
    setError('');
    setNotice('');
  }
  async function post(body: Record<string, unknown>) {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...body,
        ...(extraQuote ? { quoteMint: extraQuote } : {}),
      }),
    });
    const data = (await response.json().catch(() => ({}))) as {
      error?: string;
      scan: CreatorFeeScan;
      review: CreatorFeeClaimReview;
      receipt: CreatorFeeClaimReceipt;
    };
    if (!response.ok)
      throw new Error(data.error || 'Creator fee request failed.');
    return data;
  }
  async function run(task: (current: number) => Promise<void>) {
    const current = epoch.current;
    setBusy(true);
    setError('');
    try {
      await task(current);
    } catch (err) {
      if (current === epoch.current)
        setError(err instanceof Error ? err.message : 'Creator fee failure.');
    } finally {
      setBusy(false);
    }
  }
  const check = () => {
    reset();
    return run(async (current) => {
      const data = await post({ action: 'scan', wallet });
      if (current !== epoch.current) return;
      setScan(data.scan);
      setSelected(data.scan.vaults.slice(0, 6).map(vaultKey));
      if (!data.scan.vaults.length)
        setNotice('No creator fees to claim for this wallet right now.');
    });
  };
  const prepare = () =>
    run(async (current) => {
      const data = await post({
        action: 'prepare',
        wallet,
        walletRevision: source?.revision,
        select: selected,
      });
      if (current !== epoch.current) return;
      setReview(data.review);
      setNow(Date.now());
      setNotice('Review ready. Nothing is signed or sent yet.');
    });
  const sign = () =>
    run(async (current) => {
      if (!review || !accepted)
        throw new Error('Approve the exact claim first.');
      const assertCurrent = () => {
        if (current !== epoch.current)
          throw new Error('Claim changed. Review it again.');
      };
      const session = await unlockVault(
        localStorage.getItem(VAULT_STORAGE_KEY) || '',
        password,
      );
      setPassword('');
      try {
        const result = await signCreatorFeeClaim(
          session,
          review,
          assertCurrent,
        );
        assertCurrent();
        setSigned(result);
        setNotice('Signed in this browser. Nothing has been sent yet.');
      } finally {
        session.payload.wallets.forEach((w) => {
          w.seed = '';
        });
        session.payload.wallets.length = 0;
        setAccepted(false);
      }
    });
  const submit = () =>
    run(async (current) => {
      if (!review || !signed || sent) return;
      // Recorded before the request so an unknown outcome is never resent from here.
      setSent(signed.signature);
      try {
        await post({
          action: 'submit',
          review,
          transaction: signed.transaction,
        });
        if (current === epoch.current)
          setNotice('Sent once. Check the finalized outcome below.');
      } catch (err) {
        if (err instanceof Error && !/outcome is unknown/.test(err.message))
          setSent(null);
        throw err;
      }
    });
  const recover = () =>
    run(async (current) => {
      if (!review || !sent) return;
      const data = await post({ action: 'recover', review, signature: sent });
      if (current !== epoch.current) return;
      setReceipt(data.receipt);
      setNotice('');
    });
  const toggle = (key: string) => {
    reset(true);
    setSelected((s) =>
      s.includes(key) ? s.filter((k) => k !== key) : [...s, key],
    );
  };
  return (
    <section
      className="native-withdrawal-panel creator-fee-panel"
      aria-label="Pump.fun creator fees"
    >
      <div className="wallet-roster-actions">
        <h3>Claim creator fees</h3>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            reset();
            setOpen(!open);
          }}
        >
          {open ? 'Hide creator fees' : 'Open creator fees'}
        </Button>
      </div>
      {open && (
        <>
          <p>
            Pump.fun pays creator fees into a vault per creator wallet, covering
            every coin that wallet launched, on the bonding curve and on
            PumpSwap after migration. You review the exact claim, sign it in
            this browser, then send it separately. Coins with Pump fee sharing
            pay shareholders directly and are not claimed here.
          </p>
          <label htmlFor={field + 'wallet'}>Creator wallet</label>
          <select
            id={field + 'wallet'}
            value={wallet}
            disabled={busy}
            onChange={(e) => {
              reset();
              setWallet(e.target.value);
            }}
          >
            <option value="">Select a Solana wallet</option>
            {choices.map((w) => (
              <option key={w.address} value={w.address}>
                {w.label || w.address}
              </option>
            ))}
          </select>
          <label htmlFor={field + 'quote'}>
            Other quote asset (optional, SOL, USDC and featured stocks are
            always checked)
          </label>
          <select
            id={field + 'quote'}
            value={extraQuote}
            disabled={busy}
            onChange={(e) => {
              reset();
              setExtraQuote(e.target.value);
            }}
          >
            <option value="">None</option>
            {QUOTES.filter((q) => q.address !== CLAIM_WSOL).map((q) => (
              <option key={q.address} value={q.address}>
                {q.symbol}
              </option>
            ))}
          </select>
          <div className="wallet-roster-actions">
            <Button disabled={busy || !wallet} onClick={() => void check()}>
              Check creator fees
            </Button>
          </div>
          {scan && scan.vaults.length > 0 && !review && (
            <fieldset disabled={busy}>
              <legend>Claimable now (choose up to six)</legend>
              {scan.vaults.map((v) => (
                <label key={vaultKey(v)}>
                  <input
                    type="checkbox"
                    checked={selected.includes(vaultKey(v))}
                    onChange={() => toggle(vaultKey(v))}
                  />{' '}
                  {amount(v)} · {KIND[v.kind]}
                </label>
              ))}
              <Button
                disabled={!selected.length || selected.length > 6}
                onClick={() => void prepare()}
              >
                Review claim
              </Button>
            </fieldset>
          )}
          {review && (
            <div aria-label="Creator fee claim review">
              <ul>
                {review.vaults.map((v) => (
                  <li key={vaultKey(v)}>
                    {amount(v)} from {KIND[v.kind]}
                  </li>
                ))}
                <li>Network fee: {sol(review.feeLamports)}</li>
                {review.accountRentLamports !== '0' && (
                  <li>
                    New token account rent kept in your account:{' '}
                    {sol(review.accountRentLamports)}
                  </li>
                )}
                {review.unwrapNative && (
                  <li>PumpSwap WSOL arrives as native SOL.</li>
                )}
                <li>
                  Simulated SOL change:{' '}
                  {sol(review.simulation.walletChangeLamports)}
                </li>
                {review.simulation.tokens
                  .filter((t) => t.changeRaw !== '0')
                  .map((t) => {
                    const v = review.vaults.find(
                      (x) => x.destination === t.account,
                    )!;
                    return (
                      <li key={t.account}>
                        Simulated {symbol(t.mint)} change: +
                        {formatNativeBalance(t.changeRaw, v.decimals)}
                      </li>
                    );
                  })}
              </ul>
              {!signed && (
                <>
                  <output>
                    {expired
                      ? 'This review expired. Check creator fees again.'
                      : `Review expires in ${Math.max(0, Math.ceil((Date.parse(review.expiresAt) - now) / 1000))}s.`}
                  </output>
                  <label>
                    <input
                      type="checkbox"
                      checked={accepted}
                      disabled={busy || expired}
                      onChange={(e) => setAccepted(e.target.checked)}
                    />{' '}
                    I approve signing this exact claim from{' '}
                    {source?.label || wallet}.
                  </label>
                  <label htmlFor={field + 'password'}>Vault password</label>
                  <Input
                    id={field + 'password'}
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    disabled={busy || expired}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <Button
                    disabled={busy || expired || !accepted || !password}
                    onClick={() => void sign()}
                  >
                    Sign in browser
                  </Button>
                </>
              )}
              {signed && !sent && (
                <Button
                  disabled={busy || expired}
                  onClick={() => void submit()}
                >
                  Send claim
                </Button>
              )}
              {sent && (
                <>
                  <p>
                    Signature: <code>{sent}</code>
                  </p>
                  {!receipt && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void recover()}
                    >
                      Check finalized outcome
                    </Button>
                  )}
                </>
              )}
              {receipt && (
                <output aria-label="Creator fee receipt">
                  {receipt.failed
                    ? `Claim failed on chain. Network fee paid: ${sol(receipt.networkFeeLamports)}.`
                    : `Claimed. SOL change ${sol(receipt.walletChangeLamports)}${receipt.tokens
                        .filter((t) => t.changeRaw !== '0')
                        .map((t) => {
                          const v = review.vaults.find(
                            (x) => x.destination === t.account,
                          )!;
                          return `, ${symbol(t.mint)} +${formatNativeBalance(t.changeRaw, v.decimals)}`;
                        })
                        .join('')}.`}
                </output>
              )}
            </div>
          )}
          {notice && <output>{notice}</output>}
          {error && <p role="alert">{error}</p>}
        </>
      )}
    </section>
  );
}
