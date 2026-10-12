'use client';
import { ImportedSessionReview } from './imported-session-review';
import { ImportedReceiptChart } from './imported-receipt-chart';
import { notifyImportedReceiptSaved } from '@/lib/imported-receipt-events';
import {
  validatedTradeSessionCapture,
  type TradeSessionCapture,
} from '@/lib/imported-trade-session';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { warmupReviewDeadline } from '@/lib/warmup-review-wait';
import { notifyWarmupReceiptSaved } from '@/lib/warmup-receipt-events';
import type { ImportedSwapReceipt } from '@/lib/imported-approval-history';
import { unlockVault, VAULT_STORAGE_KEY } from '@/lib/browser-wallet-vault';
import {
  signApprovedWarmupPacket,
  type WarmupSigningReview,
} from '@/lib/warmup-signing';
import type { SolanaSwapPreparation } from '@/lib/warmup-swap-quote';
import {
  validatedImportedAcquisitionSelection,
  type ImportedAcquisitionSelection,
} from '@/lib/imported-acquisition';
import { ConditionalSigningReview } from './conditional-signing-review';
import { validatedConditionalSigning } from '@/lib/conditional-signing';
import type { ConditionalPreparation } from '@/lib/conditional-preparation-server';
import { ImportedAcquisitionReview } from './imported-acquisition-review';
import {
  connectWarmupExternalWallet,
  matchingWarmupExternalAccount,
  onWarmupExternalWalletChange,
  signApprovedExternalWarmupPacket,
  supportsWarmupExternalWallet,
  type WarmupExternalWallet,
} from '@/lib/warmup-external-signer';
export function WarmupApprovedSigning({
  preparationId,
  planId,
  projectId,
  order,
  reviewNotBefore,
  onReviewImportedBuy,
  expectedAcquisition,
  expectedConditional,
  expectedSession,
}: {
  preparationId: string;
  order: SolanaSwapPreparation;
  reviewNotBefore: number;
  onReviewImportedBuy?: (receipt: ImportedSwapReceipt) => void;
  expectedAcquisition?: ImportedAcquisitionSelection;
  expectedConditional?: ConditionalPreparation;
  expectedSession?: TradeSessionCapture;
} & (
  | { planId: string; projectId?: never }
  | { projectId: string; planId?: never }
)) {
  const imported = projectId !== undefined;
  const [importedReceipt, setImportedReceipt] =
    useState<ImportedSwapReceipt | null>(null);
  const signingEndpoint = imported
    ? '/api/imported-projects/signing'
    : '/api/wallet-workspace/warmup/signing';
  const [reviewDeadline, setReviewDeadline] = useState(reviewNotBefore);
  const [reviewWaitSeconds, setReviewWaitSeconds] = useState(() =>
    Math.max(0, Math.ceil((reviewNotBefore - Date.now()) / 1000)),
  );
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      const remaining = Math.max(
        0,
        Math.ceil((reviewDeadline - Date.now()) / 1000),
      );
      setReviewWaitSeconds(remaining);
      if (remaining > 0) timer = setTimeout(update, 250);
    };
    update();
    return () => clearTimeout(timer);
  }, [reviewDeadline]);
  const [review, setReview] = useState<WarmupSigningReview | null>(null),
    [password, setPassword] = useState(''),
    [accepted, setAccepted] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [signed, setSigned] = useState<{
      transaction: string;
      signature: string;
    } | null>(null),
    [state, setState] = useState(''),
    [expired, setExpired] = useState(false),
    [signer, setSigner] = useState<'vault' | 'external'>('vault'),
    [externalWallets, setExternalWallets] = useState<WarmupExternalWallet[]>(
      [],
    ),
    [externalWallet, setExternalWallet] = useState<WarmupExternalWallet | null>(
      null,
    );
  const [, setWalletRevision] = useState(0);
  const epoch = useRef(0),
    pending = useRef<AbortController | null>(null),
    walletPrompt = useRef(false),
    selectedWallet = useRef<WarmupExternalWallet | null>(null),
    isRegistered = useRef<(wallet: WarmupExternalWallet) => boolean>(
      () => false,
    ),
    field = useId();
  useEffect(() => {
    let disposed = false,
      cleanup = () => {};
    void import('@wallet-standard/app')
      .then(({ getWallets }) => {
        if (disposed) return;
        const registry = getWallets(),
          refresh = () => {
            const wallets = registry.get();
            setExternalWallets(wallets.filter(supportsWarmupExternalWallet));
            if (
              selectedWallet.current &&
              !wallets.includes(selectedWallet.current)
            ) {
              epoch.current++;
              pending.current?.abort();
              selectedWallet.current = null;
              setExternalWallet(null);
              setAccepted(false);
              if (!walletPrompt.current) setBusy(false);
            }
          };
        isRegistered.current = (wallet) => registry.get().includes(wallet);
        refresh();
        const registered = registry.on('register', refresh),
          unregistered = registry.on('unregister', refresh);
        cleanup = () => {
          registered();
          unregistered();
        };
      })
      .catch(() => {
        if (!disposed) setError('Browser wallet discovery unavailable.');
      });
    return () => {
      disposed = true;
      cleanup();
    };
  }, []);
  useEffect(() => {
    if (!externalWallet) return;
    return onWarmupExternalWalletChange(externalWallet, () => {
      epoch.current++;
      pending.current?.abort();
      setAccepted(false);
      setPassword('');
      if (!walletPrompt.current) setBusy(false);
      setWalletRevision((value) => value + 1);
    });
  }, [externalWallet]);
  const approvalExpiresAt = Math.min(
    Date.parse(order.expiresAt),
    expectedConditional ? Date.parse(expectedConditional.expiresAt) : Infinity,
  );
  useEffect(() => {
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, approvalExpiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [approvalExpiresAt]);
  useEffect(() => {
    const invalidate = () => {
      epoch.current++;
      pending.current?.abort();
      setPassword('');
      setAccepted(false);
      if (!walletPrompt.current) setBusy(false);
    };
    const hidden = () => {
      // A mobile wallet handoff can hide this page while its explicit sign-only prompt is open.
      if (document.visibilityState === 'hidden' && !walletPrompt.current)
        invalidate();
    };
    window.addEventListener('pagehide', invalidate);
    window.addEventListener('storage', invalidate);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      invalidate();
      window.removeEventListener('pagehide', invalidate);
      window.removeEventListener('storage', invalidate);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, []);
  async function post(body: unknown) {
    const controller = new AbortController();
    pending.current = controller;
    const response = await fetch(signingEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
    });
    const data = (await response.json()) as {
      error?: string;
      review?: WarmupSigningReview;
      signature?: string;
      state?: string;
      reviewWaitMs?: number;
    };
    if (response.status === 429 && data.reviewWaitMs !== undefined)
      setReviewDeadline(warmupReviewDeadline(data.reviewWaitMs));
    if (!response.ok) throw new Error(data.error || 'Approval unavailable.');
    return data;
  }
  async function prepare() {
    if (busy || expired || Date.now() < reviewDeadline) return;
    const generation = epoch.current;
    setBusy(true);
    setError('');
    setReview(null);
    setAccepted(false);
    try {
      const data = await post({
        action: 'review',
        preparationId,
        transaction: order.preparation.transaction,
      });
      const value = data.review as WarmupSigningReview;
      if (
        !value ||
        JSON.stringify(value.session) !== JSON.stringify(expectedSession) ||
        value.preparationId !== preparationId ||
        value.wallet !== order.preparation.wallet ||
        value.sha256 !== order.preparation.sha256 ||
        value.transaction !== order.preparation.transaction ||
        value.inputRaw !== order.inAmount ||
        value.minimumOutputRaw !== order.minimumOutAmount ||
        value.network !== 'mainnet' ||
        !Number.isFinite(Date.parse(value.expiresAt)) ||
        Date.parse(value.expiresAt) <= Date.now() ||
        Date.parse(value.expiresAt) !==
          Math.min(
            Date.parse(order.expiresAt),
            expectedConditional
              ? Date.parse(expectedConditional.expiresAt)
              : Infinity,
          ) ||
        JSON.stringify(value.conditional) !==
          JSON.stringify(expectedConditional) ||
        value.inputMint !== order.inputMint ||
        value.outputMint !== order.outputMint ||
        value.settlement?.version !== 1 ||
        JSON.stringify(value.acquisition) !==
          JSON.stringify(expectedAcquisition)
      )
        throw new Error('Approval differs from the displayed preparation.');
      if (value.session)
        validatedTradeSessionCapture(value.session, value.inputRaw);
      if (value.conditional)
        validatedConditionalSigning(
          value.conditional,
          value.inputRaw,
          Date.now(),
        );
      if (value.acquisition)
        validatedImportedAcquisitionSelection(value.acquisition, {
          projectId,
          wallet: value.wallet,
          mint: value.inputMint,
          unitsRaw: value.inputRaw,
        });
      if (generation !== epoch.current) return;
      setReview(value);
      setState('awaiting_signature');
    } catch (err) {
      if (generation === epoch.current)
        setError(err instanceof Error ? err.message : 'Review failed.');
    } finally {
      if (generation === epoch.current) setBusy(false);
    }
  }
  async function approve() {
    if (!review || !accepted || busy) return;
    const generation = epoch.current,
      passphrase = password;
    setPassword('');
    setBusy(true);
    setError('');
    let session: Awaited<ReturnType<typeof unlockVault>> | null = null;
    let encrypted: string | null = null;
    const assertCurrent = () => {
      if (
        generation !== epoch.current ||
        (signer === 'vault' &&
          localStorage.getItem(VAULT_STORAGE_KEY) !== encrypted) ||
        (signer === 'external' &&
          (!externalWallet || !isRegistered.current(externalWallet)))
      )
        throw new Error('Approval or signer changed.');
    };
    try {
      let packet;
      if (signer === 'external') {
        if (!externalWallet)
          throw new Error('Choose and connect a browser wallet first.');
        walletPrompt.current = true;
        try {
          packet = await signApprovedExternalWarmupPacket(
            externalWallet,
            review,
            assertCurrent,
          );
        } finally {
          walletPrompt.current = false;
        }
      } else {
        encrypted = localStorage.getItem(VAULT_STORAGE_KEY);
        if (!encrypted)
          throw new Error(
            'Create or import this wallet in the encrypted browser vault first.',
          );
        session = await unlockVault(encrypted, passphrase);
        assertCurrent();
        packet = await signApprovedWarmupPacket(session, review, assertCurrent);
      }
      // Preserve the signed packet locally in this mounted review even if registration fails. Never broadcast without registration.
      setSigned(packet);
      assertCurrent();
      const data = await post({
        action: 'register',
        id: review.id,
        transaction: packet.transaction,
      });
      assertCurrent();
      if (data.signature !== packet.signature)
        throw new Error('Registered signature mismatch.');
      setState(data.state ?? 'recovery_required');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signing failed.');
    } finally {
      if (session) session.payload.wallets = [];
      setBusy(false);
    }
  }
  async function connectExternal() {
    if (!externalWallet || busy) return;
    setBusy(true);
    setError('');
    setAccepted(false);
    walletPrompt.current = true;
    try {
      await connectWarmupExternalWallet(
        externalWallet,
        order.preparation.wallet,
      );
      setWalletRevision((value) => value + 1);
    } catch {
      setError(
        'Connect the exact wallet shown in this preparation using a Solana mainnet wallet with transaction signing.',
      );
    } finally {
      walletPrompt.current = false;
      setBusy(false);
    }
  }
  const externalReady =
    !!externalWallet &&
    supportsWarmupExternalWallet(externalWallet) &&
    !!matchingWarmupExternalAccount(externalWallet, order.preparation.wallet) &&
    externalWallets.includes(externalWallet);
  async function registerOrSubmit(submit: boolean) {
    if (!review || !signed) return;
    const generation = epoch.current;
    setBusy(true);
    setError('');
    try {
      const data = await post({
        action: submit ? 'submit' : 'register',
        id: review.id,
        transaction: signed.transaction,
      });
      if (generation !== epoch.current) return;
      if (data.signature !== signed.signature)
        throw new Error('Signature differs.');
      setState(data.state ?? 'recovery_required');
    } catch (err) {
      if (generation !== epoch.current) return;
      setError(
        err instanceof Error ? err.message : 'Signature recovery required.',
      );
      if (submit) setState('recovery_required');
    } finally {
      if (generation === epoch.current) setBusy(false);
    }
  }
  async function verifyReceipt() {
    if (!signed || !review || busy) return;
    const generation = epoch.current,
      controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        imported
          ? signingEndpoint
          : `/api/wallet-workspace/warmup/${order.side === 'Buy' ? 'buy' : 'sell'}-receipts`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            imported
              ? { action: 'recover', id: review.id }
              : { preparationId, signature: signed.signature },
          ),
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(30000),
          ]),
        },
      );
      const data = (await response.json()) as {
        error?: string;
        state?: string;
        signature?: string;
        receipt?: ImportedSwapReceipt & { planId?: string };
      };
      if (
        imported &&
        response.ok &&
        data.state === 'failed' &&
        data.signature === signed.signature
      ) {
        if (generation !== epoch.current || controller.signal.aborted) return;
        setState('failed');
        return;
      }
      const receipt = data.receipt;
      if (
        !response.ok ||
        (imported
          ? receipt?.projectId !== projectId
          : receipt?.planId !== planId) ||
        receipt?.preparationId !== preparationId ||
        receipt.document?.signature !== signed.signature ||
        receipt.document?.wallet !== review.wallet ||
        receipt.document?.signatureVerified !== true ||
        receipt.document?.commitment !== 'finalized'
      )
        throw new Error(
          data.error ||
            'Finalized matching receipt unavailable. Retry after confirmation.',
        );
      if (generation !== epoch.current || controller.signal.aborted) return;
      if (imported) {
        if (
          data.state !== 'finalized' ||
          data.signature !== signed.signature ||
          receipt.document.side !== order.side ||
          receipt.document.network !== 'mainnet' ||
          receipt.document.preparationSha256 !== review.sha256 ||
          receipt.document.mint !==
            (order.side === 'Buy' ? order.outputMint : order.inputMint)
        )
          throw new Error('Imported receipt differs from this approved swap.');
        setImportedReceipt(receipt);
        notifyImportedReceiptSaved(receipt);
      }
      setState('finalized');
      if (!imported && planId) notifyWarmupReceiptSaved(planId, order.side);
    } catch (err) {
      if (generation === epoch.current && !controller.signal.aborted)
        setError(
          err instanceof Error
            ? err.message
            : 'Receipt verification unavailable.',
        );
    } finally {
      if (generation === epoch.current) setBusy(false);
    }
  }
  async function cancel() {
    if (!review) return;
    const generation = epoch.current;
    setBusy(true);
    setError('');
    try {
      await post({ action: 'cancel', id: review.id });
      if (generation !== epoch.current) return;
      setReview(null);
      setState('cancelled');
    } catch (err) {
      if (generation === epoch.current)
        setError(err instanceof Error ? err.message : 'Cancellation failed.');
    } finally {
      if (generation === epoch.current) setBusy(false);
    }
  }
  return (
    <section
      className="warmup-address min-w-0 max-w-full space-y-3"
      aria-label={
        imported
          ? 'User approved imported swap signing'
          : 'User approved warmup signing'
      }
    >
      <h5>Approve this transaction</h5>
      {expectedConditional && expired && state !== 'finalized' && (
        <output className="block">
          Condition capture expired. Cancel an unsigned approval before
          preparing a fresh level transaction, or recover a registered
          signature.
        </output>
      )}
      {review?.session && <ImportedSessionReview session={review.session} />}
      {review?.conditional && (
        <ConditionalSigningReview conditional={review.conditional} />
      )}
      {review?.acquisition && (
        <ImportedAcquisitionReview acquisition={review.acquisition} />
      )}
      {imported && (
        <p>
          Approvals are saved to this project. Open swap approval recovery to
          resume after closing this panel or reloading.
        </p>
      )}
      <p>
        Each mainnet transaction requires your review, a browser vault or
        connected wallet signature and a separate submit action. Supported
        Jupiter Metis routes can create your standard token accounts, wrap SOL
        for a buy and return unwrapped SOL after a sell. Lookup tables are
        checked again before submission.
      </p>
      {!signed && (
        <div className="space-y-2">
          <label htmlFor={field + '-signer'}>Sign with</label>
          <select
            id={field + '-signer'}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={signer}
            disabled={busy}
            onChange={(event) => {
              setSigner(event.target.value as 'vault' | 'external');
              setPassword('');
              setAccepted(false);
            }}
          >
            <option value="vault">Encrypted browser vault</option>
            <option value="external">Connected Solana wallet</option>
          </select>
          {signer === 'external' && (
            <>
              <label htmlFor={field + '-wallet'}>Browser wallet</label>
              <select
                id={field + '-wallet'}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={
                  externalWallet ? externalWallets.indexOf(externalWallet) : ''
                }
                disabled={busy}
                onChange={(event) => {
                  selectedWallet.current =
                    event.target.value === ''
                      ? null
                      : (externalWallets[Number(event.target.value)] ?? null);
                  setExternalWallet(selectedWallet.current);
                  setAccepted(false);
                }}
              >
                <option value="">Choose a wallet</option>
                {externalWallets.map((wallet, index) => (
                  <option key={wallet.name + index} value={index}>
                    {wallet.name}
                  </option>
                ))}
              </select>
              {externalWallets.length === 0 && (
                <p>
                  No compatible Wallet Standard wallet detected. Open or install
                  a wallet that supports Solana mainnet and versioned
                  transaction signing.
                </p>
              )}
              <Button
                className="h-auto min-h-9 max-w-full whitespace-normal"
                variant="outline"
                disabled={busy || !externalWallet}
                onClick={() => void connectExternal()}
              >
                Connect the reviewed wallet
              </Button>
              <p>
                {externalReady
                  ? `Connected to the exact reviewed address: ${order.preparation.wallet}.`
                  : `Required address: ${order.preparation.wallet}.`}
              </p>
              <p>
                Approve the exact transaction in your wallet. Bundle checks its
                returned signature and keeps submission as a separate action.
              </p>
            </>
          )}
        </div>
      )}
      {!review && (
        <Button
          className="h-auto min-h-9 max-w-full whitespace-normal"
          variant="outline"
          disabled={
            busy ||
            expired ||
            reviewWaitSeconds > 0 ||
            (!!(expectedConditional || expectedSession) &&
              state === 'cancelled')
          }
          onClick={() => void prepare()}
        >
          {(expectedConditional || expectedSession) && state === 'cancelled'
            ? 'Cancelled. Prepare a fresh transaction.'
            : reviewWaitSeconds > 0
              ? `Review available in ${reviewWaitSeconds}s`
              : 'Check eligibility for user approval'}
        </Button>
      )}
      {review && (
        <>
          <p>
            Solana mainnet. Spend {review.inputRaw} atomic units of{' '}
            {review.inputMint}. Receive at least {review.minimumOutputRaw}{' '}
            atomic units of {review.outputMint}. Network fee{' '}
            {review.maximumFeeLamports} lamports.
          </p>
          {review.settlement && (
            <p>
              Wrap {review.settlement.wrappedFromNativeRaw} lamports from your
              SOL balance. Maximum new-account rent:{' '}
              {review.settlement.maximumRentLamports} lamports. Maximum upfront
              SOL debit including fees, rent and wrapping:{' '}
              {review.settlement.maximumNativeDebitLamports} lamports.
              {review.settlement.closesWrappedAccount
                ? ' Wrapped SOL account closes after the swap and returns its rent to this wallet.'
                : ' Wrapped SOL remains in your token account.'}
              {review.settlement.preexistingWrappedRefundRaw !== '0' &&
                ` Existing wrapped SOL returned: ${review.settlement.preexistingWrappedRefundRaw} lamports, separate from swap output.`}
              {` ${review.settlement.lookupTables.length} lookup tables pinned for submission.`}
            </p>
          )}
          {review.platformFee && review.platformFee.bps > 0 && (
            <p className="text-xs text-muted-foreground">
              Quoted platform fee: {review.platformFee.bps} basis points (
              {review.platformFee.bps / 100}%) in {review.platformFee.mint}. The
              approved input and minimum output include this fee.
            </p>
          )}
          {review.buyReceipt?.historicalBuy && (
            <p>
              Historical buy lot {review.buyReceipt.receiptId}: source plan
              revision {review.buyReceipt.historicalBuy.planRevision}, source
              wallet revision {review.buyReceipt.historicalBuy.walletRevision}.
              Original buy signature {review.buyReceipt.signature}. Sell input
              is limited by its remaining recorded units and fresh holdings.
            </p>
          )}
          <p className="warmup-address">
            Wallet: {review.wallet}. Exact packet: {review.sha256}. Approval{' '}
            {review.id}. Expires {review.expiresAt}.
          </p>
          <p>
            Jupiter executes the route through its deployed programs. Simulation
            is an observation and cannot guarantee execution or profit.
            Approving grants a signature only for this exact packet.
          </p>
          {!signed && state === 'awaiting_signature' && (
            <>
              <label
                className="warmup-checkbox-choice flex items-start gap-2"
                htmlFor={field + '-accept'}
              >
                <input
                  id={field + '-accept'}
                  type="checkbox"
                  checked={accepted}
                  disabled={busy}
                  onChange={(event) => setAccepted(event.target.checked)}
                />{' '}
                <span>
                  I reviewed the network, wallet, token amounts, fee, rent, SOL
                  debit
                  {review.acquisition
                    ? ', selected acquisition accounting'
                    : ''}
                  {review.conditional
                    ? ', saved conditional level and market-cap threshold'
                    : ''}{' '}
                  {review.session ? ', saved session entry' : ''} and
                  transaction risk.
                </span>
              </label>
              {signer === 'vault' && (
                <>
                  <label htmlFor={field + '-password'}>
                    Browser vault passphrase for this transaction
                  </label>
                  <Input
                    id={field + '-password'}
                    type="password"
                    autoComplete="off"
                    value={password}
                    disabled={busy}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </>
              )}
              <Button
                className="h-auto min-h-9 max-w-full whitespace-normal"
                disabled={
                  busy ||
                  expired ||
                  !accepted ||
                  (signer === 'vault' ? !password : !externalReady)
                }
                onClick={() => void approve()}
              >
                Approve and sign this exact transaction
              </Button>
              <Button
                className="h-auto min-h-9 max-w-full whitespace-normal"
                variant="outline"
                disabled={busy}
                onClick={() => void cancel()}
              >
                Cancel unsigned approval
              </Button>
            </>
          )}
          {signed && (
            <>
              <p className="warmup-address">
                Signed transaction: {signed.signature}. Saved preparation:{' '}
                {preparationId}. State: {state}.
              </p>
              {state === 'awaiting_signature' && (
                <Button
                  className="h-auto min-h-9 max-w-full whitespace-normal"
                  disabled={busy}
                  onClick={() => void registerOrSubmit(false)}
                >
                  Retry signature registration
                </Button>
              )}
              {state === 'signed' && (
                <Button
                  className="h-auto min-h-9 max-w-full whitespace-normal"
                  disabled={busy || expired}
                  onClick={() => void registerOrSubmit(true)}
                >
                  Submit this signed transaction to mainnet
                </Button>
              )}
              {['signed', 'submitted', 'recovery_required'].includes(state) && (
                <Button
                  className="h-auto min-h-9 max-w-full whitespace-normal"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void verifyReceipt()}
                >
                  Verify finalized {order.side.toLowerCase()} receipt
                </Button>
              )}
              {state === 'finalized' ? (
                <output>
                  {imported
                    ? 'Finalized swap receipt recorded. Refresh this wallet balance before preparing your next transaction.'
                    : order.side === 'Buy'
                      ? 'Buy recorded. Choose this lot below to prepare a sell using its acquired units.'
                      : 'Sell recorded. Remaining buy units and receipt history updated.'}
                </output>
              ) : state === 'failed' ? (
                <output>
                  Transaction finalized with an execution failure. The wallet
                  reservation is released.
                </output>
              ) : (
                <p>
                  Verify the finalized receipt to finish this transaction and
                  {imported
                    ? ' record its token units.'
                    : ' update your buy lot.'}{' '}
                  A pending or unknown outcome keeps this wallet reserved.
                </p>
              )}
              {state === 'finalized' && importedReceipt && (
                <ImportedReceiptChart receipt={importedReceipt} autoOpen />
              )}
              {state === 'finalized' &&
                importedReceipt?.document.side === 'Buy' &&
                onReviewImportedBuy && (
                  <Button
                    className="h-auto min-h-9 max-w-full whitespace-normal"
                    variant="outline"
                    disabled={busy}
                    onClick={() => onReviewImportedBuy(importedReceipt)}
                  >
                    Review sell of acquired tokens
                  </Button>
                )}
            </>
          )}
        </>
      )}
      {busy && <output>Checking this transaction…</output>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
