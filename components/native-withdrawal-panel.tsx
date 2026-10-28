'use client';
import { WithdrawalFailureEvidence } from './withdrawal-failure-evidence';
import type { SavedFunding } from '@/lib/funding-plan';
import {
  fundingLegs,
  requireSelectedFundingReview,
} from '@/lib/mainnet-funding';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { unlockVault, VAULT_STORAGE_KEY } from '@/lib/browser-wallet-vault';
import {
  signNativeWithdrawal,
  validatedNativeWithdrawal,
  type NativeWithdrawal,
} from '@/lib/native-withdrawal';
import {
  supportsNativeWithdrawalWallet,
  connectNativeWithdrawalWallet,
  onNativeWithdrawalWalletChange,
  signExternalNativeWithdrawal,
  type NativeWithdrawalExternalWallet,
} from '@/lib/native-withdrawal-external-signer';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import { WalletSigningRejected } from '@/lib/wallet-signing-rejection';
import {
  retainNativeWithdrawalSignature,
  restoreNativeWithdrawalSignature,
  clearNativeWithdrawalSignature,
} from '@/lib/native-withdrawal-signature-cache';
// Exact SOL text for a lamport amount, as the prepare request expects.
const lamportsText = (raw: string) => {
  const padded = raw.padStart(10, '0');
  const fraction = padded.slice(-9).replace(/0+$/, '');
  return padded.slice(0, -9) + (fraction ? '.' + fraction : '');
};
export function NativeWithdrawalPanel({
  wallets,
  initialWallet = '',
  initialToken,
  initialOpen = false,
  initialRecipient = '',
  initialAmount = '',
  funding,
}: {
  wallets: WorkspaceWallet[];
  initialWallet?: string;
  initialToken?: { mint: string; decimals: number };
  initialOpen?: boolean;
  /** Prefill from a planned send leg; the user still prepares, signs and submits it. */
  initialRecipient?: string;
  initialAmount?: string;
  funding?: { plan: SavedFunding; item: number; leg?: number };
}) {
  const choices = wallets.filter((w) => w.chain === 'Solana');
  let fundingLeg: ReturnType<typeof fundingLegs>[number] | undefined;
  try {
    fundingLeg = funding
      ? fundingLegs(funding.plan.document, funding.item)[(funding.leg ?? 1) - 1]
      : undefined;
  } catch {
    /* Unsupported drafts withhold the prefilled transfer. */
  }
  const initialTokenMint = initialToken?.mint;
  const panel = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (initialTokenMint || initialOpen) panel.current?.focus();
  }, [initialTokenMint, initialOpen]);
  const [open, setOpen] = useState(Boolean(initialToken) || initialOpen),
    [asset, setAsset] = useState(initialToken ? 'SPL' : 'SOL'),
    [mint, setMint] = useState(initialToken?.mint || ''),
    [decimals, setDecimals] = useState(String(initialToken?.decimals ?? 6)),
    [cachedSigned, setCachedSigned] = useState<{
      id: string;
      signature: string;
      transaction: string;
    } | null>(null),
    [wallet, setWallet] = useState(
      initialWallet || choices.find((w) => !w.archived)?.address || '',
    ),
    [recipient, setRecipient] = useState(
      fundingLeg?.recipient || initialRecipient || '',
    ),
    [amount, setAmount] = useState(
      funding?.leg && fundingLeg
        ? lamportsText(fundingLeg.amountRaw)
        : funding?.plan.document.items[funding.item - 1]?.amount ||
            initialAmount ||
            '',
    ),
    [rows, setRows] = useState<NativeWithdrawal[]>([]),
    [historyLoaded, setHistoryLoaded] = useState(false),
    [active, setActive] = useState<NativeWithdrawal | null>(null),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [accepted, setAccepted] = useState(false),
    [password, setPassword] = useState(''),
    [signer, setSigner] = useState('vault'),
    [extensions, setExtensions] = useState<NativeWithdrawalExternalWallet[]>(
      [],
    ),
    [external, setExternal] = useState<NativeWithdrawalExternalWallet | null>(
      null,
    ),
    [now, setNow] = useState(() => Date.now());
  const epoch = useRef(0),
    mounted = useRef(true),
    pending = useRef<AbortController | null>(null),
    prompt = useRef(false),
    field = useId();
  const source = choices.find((w) => w.address === wallet),
    review = active?.document,
    expired = !!review && Date.parse(review.expiresAt) <= now;
  const fundingDue =
    !funding ||
    Date.parse(
      funding.plan.document.items[funding.item - 1]?.scheduledAt || '',
    ) <= now;
  const abortPending = useCallback(() => pending.current?.abort(), []);
  const dispose = useCallback(() => {
    mounted.current = false;
    epoch.current++;
    abortPending();
  }, [abortPending]);
  useEffect(() => {
    mounted.current = true;
    return dispose;
  }, [dispose]);
  function changeWallet(value: string) {
    epoch.current++;
    pending.current?.abort();
    setAccepted(false);
    setPassword('');
    setActive(null);
    setRows([]);
    setHistoryLoaded(false);
    setCursor(null);
    setBusy(false);
    setError('');
    setNotice('');
    setCachedSigned(null);
    setWallet(value);
  }
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);
  useEffect(() => {
    const reset = () => {
      epoch.current++;
      setAccepted(false);
      setPassword('');
      pending.current?.abort();
      if (!prompt.current) setBusy(false);
    };
    const storage = (event: StorageEvent) => {
      if (event.key === VAULT_STORAGE_KEY || event.key === null) reset();
    };
    document.addEventListener('visibilitychange', reset);
    window.addEventListener('storage', storage);
    return () => {
      document.removeEventListener('visibilitychange', reset);
      window.removeEventListener('storage', storage);
    };
  }, []);
  useEffect(() => {
    let disposed = false,
      stop = () => {};
    void import('@wallet-standard/app').then(({ getWallets }) => {
      if (disposed) return;
      const registry = getWallets(),
        refresh = () => {
          if (disposed) return;
          epoch.current++;
          setAccepted(false);
          pending.current?.abort();
          if (!prompt.current) setBusy(false);
          setExtensions(registry.get().filter(supportsNativeWithdrawalWallet));
          setExternal((prior) =>
            prior && registry.get().includes(prior) ? prior : null,
          );
        };
      refresh();
      const a = registry.on('register', refresh),
        b = registry.on('unregister', refresh);
      stop = () => {
        a();
        b();
      };
    });
    return () => {
      disposed = true;
      stop();
    };
  }, []);
  useEffect(() => {
    if (!external) return;
    return onNativeWithdrawalWalletChange(external, () => {
      epoch.current++;
      pending.current?.abort();
      if (!prompt.current) setBusy(false);
      setAccepted(false);
      setNotice('Wallet account changed. Recover any retained signature.');
    });
  }, [external]);
  async function request(body: object, signal: AbortSignal) {
    const response = await fetch('/api/wallet-workspace/withdrawals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const value = (await response.json()) as {
      withdrawal?: NativeWithdrawal;
      error?: string;
    };
    if (!response.ok || !value.withdrawal)
      throw new Error(value.error || 'Withdrawal action unavailable.');
    const validated = await validatedNativeWithdrawal(value.withdrawal);
    if (funding)
      await requireSelectedFundingReview(
        validated.document,
        funding.plan,
        funding.item,
        funding.leg,
      );
    return validated;
  }
  function update(row: NativeWithdrawal) {
    if (!mounted.current) return;
    setRows((prior) => [row, ...prior.filter((old) => old.id !== row.id)]);
    setActive(
      ['awaiting_signature', 'signing', 'signed', 'submitted'].includes(
        row.state,
      )
        ? row
        : null,
    );
    setAccepted(false);
    setPassword('');
  }
  async function history(older = false) {
    if (busy || !wallet) return;
    const controller = new AbortController();
    pending.current?.abort();
    pending.current = controller;
    const current = epoch.current;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        `/api/wallet-workspace/withdrawals?wallet=${encodeURIComponent(wallet)}${funding ? '&' + new URLSearchParams({ planId: funding.plan.id, revision: String(funding.plan.revision), item: String(funding.item), ...(funding.leg ? { leg: String(funding.leg) } : {}) }) : ''}${older && cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
        {
          cache: 'no-store',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(15000),
          ]),
        },
      );
      const value = (await response.json()) as {
        withdrawals: NativeWithdrawal[];
        active: NativeWithdrawal | null;
        nextCursor: string | null;
        error?: string;
      };
      if (
        !response.ok ||
        !Array.isArray(value.withdrawals) ||
        value.withdrawals.length > 50
      )
        throw new Error(value.error || 'Withdrawal history unavailable.');
      const parsed = await Promise.all(
        value.withdrawals.map(validatedNativeWithdrawal),
      );
      if (
        parsed.some((r) => r.wallet !== wallet) ||
        new Set(parsed.map((r) => r.id)).size !== parsed.length
      )
        throw new Error('Withdrawal wallet history differs.');
      const latest = value.active
        ? await validatedNativeWithdrawal(value.active)
        : null;
      if (latest && latest.wallet !== wallet) throw new Error();
      if (funding) {
        await Promise.all(
          parsed.map((row) =>
            requireSelectedFundingReview(
              row.document,
              funding.plan,
              funding.item,
              funding.leg,
            ),
          ),
        );
        if (latest)
          await requireSelectedFundingReview(
            latest.document,
            funding.plan,
            funding.item,
            funding.leg,
          );
      }
      const cached =
        latest?.state === 'signing'
          ? await restoreNativeWithdrawalSignature(
              latest.document,
              sessionStorage,
            )
          : null;
      if (current !== epoch.current || controller.signal.aborted) return;
      setRows((prior) =>
        older
          ? [
              ...prior,
              ...parsed.filter(
                (row) => !prior.some((old) => old.id === row.id),
              ),
            ]
          : parsed,
      );
      setActive(latest);
      setHistoryLoaded(true);
      setCachedSigned(latest && cached ? { id: latest.id, ...cached } : null);
      setCursor(value.nextCursor);
      setAccepted(false);
    } catch (err) {
      if (current === epoch.current && !controller.signal.aborted)
        setError(
          err instanceof Error
            ? err.message
            : 'Withdrawal history unavailable.',
        );
    } finally {
      if (current === epoch.current && !controller.signal.aborted)
        setBusy(false);
    }
  }
  async function act(
    action:
      | 'prepare'
      | 'cancel'
      | 'reject_signing'
      | 'register_cached'
      | 'recover'
      | 'submit',
    row = active,
  ) {
    if (busy || prompt.current || (action !== 'prepare' && !row)) return;
    const current = epoch.current,
      controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (
        action === 'submit' &&
        (!accepted || row?.state !== 'signed' || expired)
      )
        throw new Error('Approve the exact separate submission first.');
      let transaction: string | undefined;
      if (action === 'register_cached' && row) {
        const cached =
          cachedSigned?.id === row.id
            ? cachedSigned
            : await restoreNativeWithdrawalSignature(
                row.document,
                sessionStorage,
              );
        if (!cached)
          throw new Error(
            'No exact returned withdrawal signature is retained.',
          );
        transaction = cached.transaction;
      }
      if (action === 'submit' && row?.signature) {
        const bytes = Uint8Array.from(atob(row.document.transaction), (c) =>
          c.charCodeAt(0),
        );
        const { default: bs58 } = await import('bs58');
        bytes.set(bs58.decode(row.signature), 1);
        transaction = btoa(String.fromCharCode(...bytes));
      }
      const value = await request(
        action === 'prepare'
          ? {
              action,
              wallet,
              walletRevision: source?.revision,
              recipient,
              amount,
              ...(funding
                ? {
                    funding: {
                      planId: funding.plan.id,
                      revision: funding.plan.revision,
                      item: funding.item,
                      ...(funding.leg ? { leg: funding.leg } : {}),
                    },
                  }
                : {}),
              ...(asset === 'SPL' ? { mint, decimals: Number(decimals) } : {}),
            }
          : {
              action: action === 'register_cached' ? 'register' : action,
              id: row!.id,
              ...(transaction ? { transaction } : {}),
              ...(action === 'reject_signing'
                ? { noSignatureVerified: accepted }
                : {}),
            },
        AbortSignal.any([controller.signal, AbortSignal.timeout(35000)]),
      );
      if (current !== epoch.current || controller.signal.aborted) return;
      update(value);
      if (value.signature) {
        clearNativeWithdrawalSignature(value.document, sessionStorage);
        setCachedSigned(null);
      }
      setNotice(
        value.state === 'signed'
          ? 'Returned signature registered. Review and approve its separate submission.'
          : value.state === 'submitted'
            ? 'Submission attempted once. Check finalized outcome; do not resend.'
            : value.state === 'finalized'
              ? 'Exact withdrawal finalized and recorded.'
              : value.state === 'failed'
                ? 'Finalized transaction failure verified.'
                : value.state === 'cancelled'
                  ? 'Unsigned withdrawal cancelled.'
                  : 'Exact unsigned mainnet withdrawal retained. Review its amount, recipient and maximum debit.',
      );
    } catch (err) {
      if (current === epoch.current && !controller.signal.aborted) {
        setError(
          err instanceof Error ? err.message : 'Withdrawal action unavailable.',
        );
        if (action === 'submit')
          setNotice(
            'Submission may have an uncertain outcome. Reload its retained state and recover the signature.',
          );
      }
    } finally {
      if (current === epoch.current && !controller.signal.aborted)
        setBusy(false);
    }
  }
  async function sign() {
    if (!active || !accepted || expired || busy || prompt.current) return;
    const row = active,
      current = epoch.current;
    prompt.current = true;
    setBusy(true);
    setError('');
    let signingBegun = false,
      signerStarted = false;
    const assertCurrent = () => {
      if (
        !mounted.current ||
        current !== epoch.current ||
        Date.parse(row.document.expiresAt) <= Date.now()
      )
        throw new Error('Withdrawal review changed. Reload retained recovery.');
    };
    const retain = async (
      signed: {
        signature: string;
        transaction: string;
      },
      requireTabStorage: boolean,
    ) => {
      if (mounted.current) setCachedSigned({ id: row.id, ...signed });
      try {
        await retainNativeWithdrawalSignature(
          row.document,
          signed,
          sessionStorage,
        );
      } catch {
        if (requireTabStorage)
          throw new Error(
            'Tab storage failed after signing. Keep this panel open and use the retained signature for recovery; closing it may lose the signature.',
          );
        if (mounted.current)
          setNotice(
            'Tab storage failed after signing. Keep this panel open until registration is confirmed; closing it may lose the retained signature.',
          );
      }
    };
    const register = async (signed: {
      signature: string;
      transaction: string;
    }) => {
      assertCurrent();
      const retained = await request(
        { action: 'register', id: row.id, transaction: signed.transaction },
        AbortSignal.timeout(15000),
      );
      if (
        retained.signature !== signed.signature ||
        retained.state !== 'signed'
      )
        throw new Error(
          'Signature registration did not match. Reload retained recovery.',
        );
      if (current === epoch.current) update(retained);
      clearNativeWithdrawalSignature(row.document, sessionStorage);
      if (mounted.current) setCachedSigned(null);
    };
    try {
      if (signer === 'external') {
        // Probe before reserving a signing attempt. Storage can still fail
        // later, so the panel also keeps the returned packet in memory.
        const probe = `pulseforge.withdrawal-storage-probe:${crypto.randomUUID()}`;
        const sample = 'x'.repeat(512);
        try {
          sessionStorage.setItem(probe, sample);
          if (sessionStorage.getItem(probe) !== sample) throw new Error();
          sessionStorage.removeItem(probe);
        } catch {
          try {
            sessionStorage.removeItem(probe);
          } catch {
            // No signature or reservation exists yet.
          }
          throw new Error(
            'Tab storage is unavailable. Enable it before signing so the returned signature can be recovered.',
          );
        }
      }
      const begun = await request(
        { action: 'begin_signing', id: row.id },
        AbortSignal.timeout(15000),
      );
      if (begun.state !== 'signing')
        throw new Error(
          'Signing reservation unavailable. Reload withdrawal history.',
        );
      signingBegun = true;
      if (current === epoch.current) update(begun);
      assertCurrent();
      if (signer === 'external') {
        if (!external) throw new Error('Select and connect the exact wallet.');
        const signed = await signExternalNativeWithdrawal(
          external,
          row.document,
          assertCurrent,
          (value) => retain(value, true),
        );
        assertCurrent();
        await register(signed);
      } else {
        const session = await unlockVault(
          localStorage.getItem(VAULT_STORAGE_KEY) || '',
          password,
        );
        setPassword('');
        try {
          assertCurrent();
          const signed = await signNativeWithdrawal(
            session,
            row.document,
            assertCurrent,
            {
              onSignerStart: () => {
                signerStarted = true;
              },
              retainSigned: (value) => retain(value, false),
            },
          );
          await register(signed);
        } finally {
          session.payload.wallets.forEach((w) => {
            w.seed = '';
          });
          session.payload.wallets.length = 0;
        }
      }
      assertCurrent();
      setNotice(
        'Signature retained. Nothing has been submitted. Review and approve the separate submission.',
      );
    } catch (err) {
      if (
        signingBegun &&
        (err instanceof WalletSigningRejected ||
          (signer === 'vault' && !signerStarted))
      ) {
        try {
          const cancelled = await request(
            { action: 'reject_signing', id: row.id, noSignatureVerified: true },
            AbortSignal.timeout(15000),
          );
          if (current === epoch.current) update(cancelled);
        } catch {
          /* Retain the signing reservation if rejection could not be saved. */
        }
      }
      if (mounted.current)
        setError(
          err instanceof Error
            ? err.message
            : 'Withdrawal signing unavailable. Reload recovery.',
        );
    } finally {
      prompt.current = false;
      if (mounted.current) {
        setBusy(false);
        setPassword('');
        setAccepted(false);
      }
    }
  }
  return (
    <section
      ref={panel}
      tabIndex={-1}
      className="native-withdrawal-panel"
      aria-label={
        funding
          ? 'Mainnet saved recipient transfer'
          : 'Mainnet Solana withdrawals'
      }
    >
      <div className="wallet-roster-actions">
        <h3>{funding ? 'Fund saved recipient' : 'Withdraw Solana assets'}</h3>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            epoch.current++;
            setAccepted(false);
            setPassword('');
            setOpen(!open);
          }}
        >
          {open ? 'Hide withdrawals' : 'Open withdrawals'}
        </Button>
      </div>
      {open && (
        <>
          {funding && (
            <p>
              Saved funding draft {funding.plan.document.name}, revision{' '}
              {funding.plan.revision}, recipient {funding.item}
              {funding.leg ? `, proxy leg ${funding.leg}` : ''}. The source,
              recipient and amount are locked to this saved item. Each transfer
              requires its own signature and separate submission. Reload history
              to recover this recipient.
            </p>
          )}
          {funding && !fundingDue && (
            <output>
              This saved recipient is not due yet. Scheduled time:{' '}
              {funding.plan.document.items[funding.item - 1]?.scheduledAt}.
            </output>
          )}
          <p>
            Solana mainnet. Each transfer requires an exact asset, recipient and
            amount, your wallet signature, and a separate submission. A rent
            reserve stays in the source wallet. Solana tokens use your
            associated token account. Ordinary Token-2022 and transfer-fee mints
            are supported. Transfer hooks, other extensions and wrapped SOL
            token transfers are unavailable here.
          </p>
          <label htmlFor={field + 'wallet'}>
            {funding ? 'Funding source' : 'Withdrawal wallet'}
          </label>
          <select
            id={field + 'wallet'}
            value={wallet}
            disabled={busy || Boolean(funding)}
            onChange={(e) => changeWallet(e.target.value)}
          >
            <option value="">Select a Solana wallet</option>
            {choices.map((w) => (
              <option key={w.address} value={w.address}>
                {w.label || w.address} · {w.archived ? 'Archived' : 'Active'}
              </option>
            ))}
          </select>
          <div className="wallet-roster-actions">
            <Button
              variant="outline"
              disabled={busy || !wallet}
              onClick={() => void history()}
            >
              {funding
                ? 'Reload recipient transfer history'
                : 'Reload withdrawal history'}
            </Button>
          </div>
          {!active && (
            <div className="native-withdrawal-form">
              <label htmlFor={field + 'asset'}>
                {funding ? 'Funding asset' : 'Withdrawal asset'}
              </label>
              <select
                id={field + 'asset'}
                value={asset}
                disabled={busy || Boolean(funding)}
                onChange={(e) => {
                  setAsset(e.target.value);
                  setAmount('');
                  setAccepted(false);
                }}
              >
                <option value="SOL">Native SOL</option>
                <option value="SPL">Solana token (SPL / Token-2022)</option>
              </select>
              {asset === 'SPL' && (
                <>
                  <label htmlFor={field + 'mint'}>Token mint</label>
                  <Input
                    id={field + 'mint'}
                    value={mint}
                    disabled={busy || Boolean(funding)}
                    onChange={(e) => setMint(e.target.value)}
                    placeholder="Exact standard SPL mint address"
                  />
                  <label htmlFor={field + 'decimals'}>Token decimals</label>
                  <Input
                    id={field + 'decimals'}
                    type="number"
                    min={0}
                    max={255}
                    value={decimals}
                    disabled={busy || Boolean(funding)}
                    onChange={(e) => setDecimals(e.target.value)}
                  />
                  <p className="tracker-note">
                    The server independently verifies mint precision and
                    transferable associated-account balance. A new recipient
                    token account adds a reviewed SOL rent cost.
                  </p>
                </>
              )}
              <label htmlFor={field + 'recipient'}>Destination wallet</label>
              <Input
                id={field + 'recipient'}
                value={recipient}
                disabled={busy || Boolean(funding)}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="Solana recipient address"
              />
              <label htmlFor={field + 'amount'}>
                {asset === 'SPL' ? 'Token amount' : 'Amount (SOL)'}
              </label>
              <Input
                id={field + 'amount'}
                value={amount}
                disabled={busy || Boolean(funding)}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.01"
                inputMode="decimal"
              />
              <Button
                disabled={
                  busy ||
                  !fundingDue ||
                  !source ||
                  source.archived ||
                  !recipient ||
                  !amount ||
                  (asset === 'SPL' &&
                    (!mint ||
                      !/^\d{1,3}$/.test(decimals) ||
                      Number(decimals) > 255))
                }
                onClick={() => void act('prepare')}
              >
                {funding
                  ? 'Prepare mainnet funding transfer'
                  : 'Prepare mainnet withdrawal'}
              </Button>
            </div>
          )}
          {error && (
            <p role="alert" className="tracker-error">
              {error}
            </p>
          )}
          {notice && <p className="tracker-note">{notice}</p>}
          {active && review && (
            <article className="imported-trade-record">
              <h4>Retained withdrawal · {active.state}</h4>
              {review.funding && (
                <p className="warmup-address">
                  Funding draft {review.funding.planId}, revision{' '}
                  {review.funding.revision}, recipient {review.funding.item}.
                  Due {review.funding.scheduledAt}. Saved terms fingerprint:{' '}
                  {review.funding.termsSha256}.
                </p>
              )}
              {active.state === 'failed' && (
                <WithdrawalFailureEvidence receipt={active.failureReceipt} />
              )}
              <p>
                {review.amount} {review.token ? 'SPL tokens' : 'SOL'} to{' '}
                {review.recipient}
              </p>
              {review.token && (
                <p>
                  {review.token.program ===
                  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
                    ? 'Token-2022'
                    : 'SPL Token'}{' '}
                  · mint {review.token.mint} · {review.token.decimals} decimals
                  · source account {review.token.sourceAccount} · recipient
                  account {review.token.destinationAccount} · account rent limit{' '}
                  {formatNativeBalance(review.token.accountRentLamports, 9)} SOL
                </p>
              )}
              {review.token?.transferFee && (
                <p>
                  Token transfer fee{' '}
                  {formatNativeBalance(
                    review.token.transferFee.feeRaw,
                    review.token.decimals,
                  )}{' '}
                  tokens · recipient receives{' '}
                  {formatNativeBalance(
                    review.token.transferFee.netAmountRaw,
                    review.token.decimals,
                  )}{' '}
                  tokens · {review.token.transferFee.basisPoints / 100}% rate,
                  capped at{' '}
                  {formatNativeBalance(
                    review.token.transferFee.maximumFeeRaw,
                    review.token.decimals,
                  )}{' '}
                  tokens · epoch {review.token.transferFee.epoch}. This fee is
                  withheld in the recipient token account.
                </p>
              )}
              <p>
                From {review.wallet} · wallet revision {review.walletRevision}
              </p>
              <p>
                Maximum SOL debit{' '}
                {formatNativeBalance(review.maximumDebitRaw, 9)} SOL · fee limit{' '}
                {formatNativeBalance(review.feeLamports, 9)} SOL · retained
                reserve {formatNativeBalance(review.reserveLamports, 9)} SOL
              </p>
              <p>
                Review expires {new Date(review.expiresAt).toLocaleString()}{' '}
                {expired ? '· expired' : ''}
              </p>
              <details>
                <summary>Exact withdrawal packet</summary>
                <p>
                  Approval {review.id} · packet {review.sha256} · slot{' '}
                  {review.slot} · source {review.source}
                </p>
              </details>
              {active.state === 'awaiting_signature' && (
                <>
                  <p>
                    A returned signature is kept in this tab for recovery until
                    registration. Keep the tab open during signing; browser
                    storage can become unavailable or be cleared. Closing the
                    tab can lose an unregistered signature.
                  </p>
                  <label htmlFor={field + 'signer'}>Sign with</label>
                  <select
                    id={field + 'signer'}
                    value={signer}
                    disabled={busy}
                    onChange={(e) => {
                      setSigner(e.target.value);
                      setAccepted(false);
                      setPassword('');
                    }}
                  >
                    <option value="vault">Encrypted browser vault</option>
                    <option value="external">Connected wallet</option>
                  </select>
                  {signer === 'vault' ? (
                    <>
                      <label htmlFor={field + 'password'}>
                        Vault passphrase
                      </label>
                      <Input
                        id={field + 'password'}
                        type="password"
                        autoComplete="off"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                      />
                    </>
                  ) : (
                    <>
                      <label htmlFor={field + 'extension'}>
                        Wallet extension
                      </label>
                      <select
                        id={field + 'extension'}
                        value={external?.name || ''}
                        disabled={busy}
                        onChange={(e) => {
                          setExternal(
                            extensions.find((w) => w.name === e.target.value) ||
                              null,
                          );
                          setAccepted(false);
                        }}
                      >
                        <option value="">Select wallet</option>
                        {extensions.map((w) => (
                          <option key={w.name} value={w.name}>
                            {w.name}
                          </option>
                        ))}
                      </select>
                      <Button
                        variant="outline"
                        disabled={busy || !external}
                        onClick={() => {
                          if (!external) return;
                          setBusy(true);
                          void connectNativeWithdrawalWallet(
                            external,
                            review.wallet,
                          )
                            .catch((err) =>
                              setError(
                                err instanceof Error
                                  ? err.message
                                  : 'Wallet connection failed.',
                              ),
                            )
                            .finally(() => setBusy(false));
                        }}
                      >
                        Connect exact withdrawal wallet
                      </Button>
                    </>
                  )}
                  <label>
                    <input
                      type="checkbox"
                      checked={accepted}
                      disabled={busy || expired}
                      onChange={(e) => setAccepted(e.target.checked)}
                    />
                    I approve this exact mainnet asset, recipient, amount and
                    maximum SOL debit.
                  </label>
                  <Button
                    disabled={
                      busy ||
                      expired ||
                      !accepted ||
                      (signer === 'vault' ? !password : !external)
                    }
                    onClick={() => void sign()}
                  >
                    Approve and sign withdrawal
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void act('cancel')}
                  >
                    Cancel unsigned withdrawal
                  </Button>
                </>
              )}
              {active.signature && (
                <p>Registered signature {active.signature}</p>
              )}
              {active.state === 'signing' && (
                <>
                  <p>
                    Signing started, but no signature is registered. Check the
                    wallet outcome before releasing this reservation.
                  </p>
                  {cachedSigned?.id === active.id ? (
                    <>
                      <p>
                        An exact returned signature is retained in this tab.
                        Register it for recovery without signing or sending
                        again.
                      </p>
                      <p>
                        The packet below is a signed transaction. Anyone with it
                        may submit it while it remains valid. Keep it private.
                        {expired &&
                          ' This review has expired and cannot be registered.'}
                      </p>
                      <label htmlFor={field + 'retained-packet'}>
                        Signed withdrawal packet for private recovery
                      </label>
                      <textarea
                        id={field + 'retained-packet'}
                        readOnly
                        spellCheck={false}
                        rows={3}
                        value={cachedSigned.transaction}
                        className="w-full break-all rounded-md border p-2 font-mono text-xs"
                      />
                      <Button
                        variant="outline"
                        disabled={busy || expired}
                        onClick={() => void act('register_cached')}
                      >
                        Register retained withdrawal signature
                      </Button>
                    </>
                  ) : (
                    <>
                      <label>
                        <input
                          type="checkbox"
                          checked={accepted}
                          disabled={busy}
                          onChange={(e) => setAccepted(e.target.checked)}
                        />
                        I verified that no transaction was signed or sent by the
                        wallet.
                      </label>
                      <Button
                        variant="outline"
                        disabled={busy || !accepted}
                        onClick={() => void act('reject_signing')}
                      >
                        Release verified unsigned signing reservation
                      </Button>
                    </>
                  )}
                </>
              )}
              {active.state === 'signed' && (
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={accepted}
                      disabled={busy || expired}
                      onChange={(e) => setAccepted(e.target.checked)}
                    />
                    I approve submitting this exact registered mainnet
                    withdrawal once.
                  </label>
                  <Button
                    disabled={
                      busy ||
                      expired ||
                      !accepted ||
                      !source ||
                      source.archived ||
                      source.revision !== active.walletRevision
                    }
                    onClick={() => void act('submit')}
                  >
                    Submit signed withdrawal once
                  </Button>
                </>
              )}
              {active.signature && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void act('recover')}
                >
                  Check finalized withdrawal outcome
                </Button>
              )}
            </article>
          )}
          {historyLoaded && rows.length === 0 && !active && (
            <p className="tracker-note" aria-live="polite">
              No saved Solana withdrawals for this wallet. Signing and
              submission are recorded separately from finalized transfers.
            </p>
          )}
          {rows
            .filter((row) => row.id !== active?.id)
            .map((row) => (
              <article className="imported-trade-record" key={row.id}>
                <strong>
                  {row.document.amount}{' '}
                  {row.document.token ? 'SPL tokens' : 'SOL'} · {row.state}
                </strong>
                <p>
                  To {row.document.recipient} · wallet revision{' '}
                  {row.walletRevision}
                </p>
                {row.document.token && (
                  <p>
                    Mint {row.document.token.mint} ·{' '}
                    {row.document.token.decimals} decimals
                  </p>
                )}
                <p>{new Date(row.createdAt).toLocaleString()}</p>
                {row.signature && (
                  <a
                    href={`https://explorer.solana.com/tx/${encodeURIComponent(row.signature)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View transaction
                  </a>
                )}
                {row.state === 'failed' && (
                  <WithdrawalFailureEvidence receipt={row.failureReceipt} />
                )}
                {row.state === 'failed' && !row.failureReceipt && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setActive(row);
                    }}
                  >
                    Review original failure evidence
                  </Button>
                )}
                {row.receipt && (
                  <p>
                    Finalized at slot {row.receipt.slot} · network fee{' '}
                    {formatNativeBalance(row.receipt.networkFeeLamports, 9)} SOL
                    {row.receipt.token && (
                      <>
                        {' '}
                        · recipient account rent{' '}
                        {formatNativeBalance(
                          row.receipt.token.accountRentLamports,
                          9,
                        )}{' '}
                        SOL
                        {row.receipt.token.transferFeeRaw !== undefined && (
                          <>
                            {' '}
                            · token fee{' '}
                            {formatNativeBalance(
                              row.receipt.token.transferFeeRaw,
                              row.receipt.token.decimals,
                            )}{' '}
                            tokens · recipient received{' '}
                            {formatNativeBalance(
                              row.receipt.token.destinationChangeRaw,
                              row.receipt.token.decimals,
                            )}{' '}
                            tokens
                          </>
                        )}
                      </>
                    )}
                  </p>
                )}
              </article>
            ))}
          {cursor && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void history(true)}
            >
              Load older withdrawals
            </Button>
          )}
        </>
      )}
    </section>
  );
}
