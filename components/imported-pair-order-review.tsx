'use client';
import { useEffect, useRef, useState } from 'react';
import type { PairOrderFirstRequest } from '@/lib/pair-order-first-service';
import type {
  PairOrderFirstReview,
  PairOrderFirstConsent,
} from '@/lib/pair-order-first-review';
import { pairRuntimeDigest } from '@/lib/pair-runtime-trace';
import { readPanelJson } from './read-panel-json';
import {
  unlockVault,
  VAULT_STORAGE_KEY,
  type VaultSession,
} from '@/lib/browser-wallet-vault';
import { signPairOrderPacket } from '@/lib/pair-order-signing';
import type { PairOrderSigningAuthorization } from '@/lib/pair-order-authorization';
import type { publicPairOrderExecution } from '@/lib/pair-order-execution';
import styles from './imported-pair-order-review.module.css';

type Saved = {
  id: string;
  review: PairOrderFirstReview;
  stockSigningEnabled?: boolean;
};
type Execution = ReturnType<typeof publicPairOrderExecution>;
export function ImportedPairOrderReview({
  request,
  locked = false,
}: {
  request: PairOrderFirstRequest | null;
  locked?: boolean;
}) {
  // A different project, side, wallet, revision or allowance gets fresh state synchronously.
  return (
    <PairOrderReviewSession
      key={JSON.stringify([request, locked])}
      request={request}
      locked={locked}
    />
  );
}
function PairOrderReviewSession({
  request,
  locked,
}: {
  request: PairOrderFirstRequest | null;
  locked: boolean;
}) {
  const [saved, setSaved] = useState<Saved | null>(null),
    [approved, setApproved] = useState(false),
    [acknowledged, setAcknowledged] = useState(false),
    [unavailableAcknowledged, setUnavailableAcknowledged] = useState(false),
    [busy, setBusy] = useState(false),
    [attempted, setAttempted] = useState(false),
    [error, setError] = useState(''),
    [clock, setClock] = useState(Date.now),
    [vaultPassword, setVaultPassword] = useState(''),
    [execution, setExecution] = useState<Execution | null>(null),
    [sendApproved, setSendApproved] = useState(false);
  const pending = useRef<AbortController | null>(null),
    active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      pending.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!saved) return;
    const timer = setInterval(() => setClock(Date.now()), 250);
    return () => clearInterval(timer);
  }, [saved]);
  const review = saved?.review,
    expired = !!review && clock >= Date.parse(review.expiresAt);
  async function post(body: unknown) {
    const controller = new AbortController();
    pending.current = controller;
    const response = await fetch('/api/imported-projects/pair-order-reviews', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    });
    const data = (await readPanelJson(
      response,
      'Order review service unavailable. Request a new review.',
    )) as { error?: unknown };
    if (!response.ok || !data)
      throw Error(
        typeof data?.error === 'string'
          ? data.error
          : 'Order review unavailable. Request a new review.',
      );
    controller.signal.throwIfAborted();
    return data;
  }
  async function prepare() {
    if (!request || locked || pending.current) return;
    setBusy(true);
    setError('');
    setSaved(null);
    setApproved(false);
    setAcknowledged(false);
    setUnavailableAcknowledged(false);
    setAttempted(false);
    setExecution(null);
    setSendApproved(false);
    try {
      const data = (await post({
        action: 'prepare',
        request,
      })) as unknown as Saved;
      if (!data.review || typeof data.id !== 'string')
        throw Error('Invalid order review.');
      const { sha256, ...terms } = data.review;
      if (
        (await pairRuntimeDigest(terms)) !== sha256 ||
        !Number.isFinite(Date.parse(data.review.expiresAt)) ||
        Date.now() >= Date.parse(data.review.expiresAt) ||
        data.review.signingAllowed !== false ||
        data.review.executionAllowed !== false ||
        data.review.projectId !== request.id ||
        data.review.projectRevision !== request.revision ||
        data.review.walletRevision !== request.walletRevision ||
        data.review.requestedInputAmount !== request.amount ||
        data.review.feeAndRentLimitRaw !== request.feeAndRentLimitRaw ||
        data.review.wallet !== request.wallet ||
        data.review.side !== request.side ||
        data.review.absoluteMinimumRaw !== request.absoluteMinimumRaw ||
        data.review.marketPair !== (request.marketPair ?? null) ||
        (request.side === 'Buy'
          ? data.review.inputMint
          : data.review.outputMint) !== request.quoteMint
      )
        throw Error(
          'Order review expired or differs from this selection. Request a new review.',
        );
      if (active.current) {
        setSaved(data);
        setClock(Date.now());
      }
    } catch (e) {
      if (active.current)
        setError(e instanceof Error ? e.message : 'Order review unavailable.');
    } finally {
      pending.current = null;
      if (active.current) setBusy(false);
    }
  }
  async function approve() {
    if (
      !saved ||
      locked ||
      pending.current ||
      attempted ||
      !approved ||
      (saved.review.acknowledgementRequired && !acknowledged) ||
      (!saved.review.marketComparison.available && !unavailableAcknowledged) ||
      saved.review.priceImpactPct === null
    )
      return;
    if (Date.now() >= Date.parse(saved.review.expiresAt)) {
      setClock(Date.now());
      setError('Review expired. Request a new review.');
      return;
    }
    const consent: PairOrderFirstConsent = {
      reviewSha256: saved.review.sha256,
      packetSha256: saved.review.packetSha256,
      approvedMinimumOutputRaw: saved.review.minimumOutputRaw,
      approveExactOrder: true,
      acknowledgeIndependentDifference: acknowledged,
      acknowledgeUnavailableIndependentPrice: unavailableAcknowledged,
    };
    const signing = saved.stockSigningEnabled === true,
      passphrase = vaultPassword,
      vault = signing ? localStorage.getItem(VAULT_STORAGE_KEY) : null;
    if (signing && (!vault || !passphrase)) {
      setError('Unlock the browser wallet vault holding this wallet first.');
      return;
    }
    setVaultPassword('');
    setAttempted(true);
    setBusy(true);
    setError('');
    let session: VaultSession | undefined;
    try {
      // Unlock before approval: the server signing window is only five seconds.
      if (signing) session = await unlockVault(vault!, passphrase);
      const current = () => {
        if (!active.current) throw Error('Order review closed.');
        if (signing && localStorage.getItem(VAULT_STORAGE_KEY) !== vault)
          throw Error('Stored vault changed.');
      };
      current();
      const data = (await post({
        action: 'approve',
        id: saved.id,
        consent,
      })) as unknown as PairOrderSigningAuthorization & {
        execution?: Execution;
      };
      if (!signing || !session || !data.execution) {
        if (active.current)
          setError(
            'Authorization received. Stock signing remains unavailable in this release.',
          );
        return;
      }
      const { execution: reserved, ...authorization } = data;
      const signed = await signPairOrderPacket(
        session,
        saved.review,
        authorization as PairOrderSigningAuthorization,
        reserved,
        {
          approved: true,
          authorizationId: authorization.id,
          authorizationSha256: authorization.sha256,
          packetSha256: authorization.packetSha256,
        },
        current,
      );
      session = undefined;
      const registered = (await post({
        action: 'register',
        authorizationId: authorization.id,
        signedPacket: signed.signedPacket,
      })) as unknown as Execution;
      if (registered.signature !== signed.signature)
        throw Error('Registered signature differs. Nothing was sent.');
      if (active.current) setExecution(registered);
    } catch (e) {
      if (active.current)
        setError(
          e instanceof Error
            ? e.message
            : 'Authorization unavailable. Request a new review.',
        );
    } finally {
      session = undefined;
      pending.current = null;
      if (active.current) {
        setBusy(false);
        setApproved(false);
        setAcknowledged(false);
        setUnavailableAcknowledged(false);
      }
    }
  }
  async function send() {
    if (
      !execution ||
      execution.state !== 'signed' ||
      !execution.signature ||
      !sendApproved ||
      pending.current
    )
      return;
    setSendApproved(false);
    setBusy(true);
    setError('');
    try {
      const result = (await post({
        action: 'submit',
        authorizationId: execution.authorizationId,
        consent: {
          authorizationId: execution.authorizationId,
          packetSha256: execution.packetSha256,
          signature: execution.signature,
          sendExactSignedPacketOnce: true,
        },
      })) as unknown as Execution;
      if (active.current) setExecution(result);
    } catch (e) {
      if (active.current)
        setError(e instanceof Error ? e.message : 'Send outcome unknown.');
    } finally {
      pending.current = null;
      if (active.current) setBusy(false);
    }
  }
  async function recover() {
    if (!execution || pending.current) return;
    setBusy(true);
    setError('');
    try {
      const result = (await post({
        action: 'recover',
        authorizationId: execution.authorizationId,
      })) as unknown as Execution;
      if (active.current) setExecution(result);
    } catch (e) {
      if (active.current)
        setError(e instanceof Error ? e.message : 'Receipt unavailable.');
    } finally {
      pending.current = null;
      if (active.current) setBusy(false);
    }
  }
  const reason = locked
    ? 'Finish the current workspace action before requesting a review.'
    : !request
      ? 'Choose a saved pair, wallet and fee allowance.'
      : expired
        ? 'Review expired. Request a new review.'
        : attempted
          ? 'This authorization attempt is complete. Request a new review to continue.'
          : review?.priceImpactPct === null
            ? 'Price impact is unavailable. Request a new review before approval.'
            : !approved
              ? 'Review the order and check its approval.'
              : review?.acknowledgementRequired && !acknowledged
                ? 'Acknowledge the worse comparison above 2%.'
                : review &&
                    !review.marketComparison.available &&
                    !unavailableAcknowledged
                  ? 'Acknowledge that no independent price check is available.'
                  : '';
  return (
    <section className={styles.panel} aria-label="Pair order review">
      <h3>Review this {review?.side.toLowerCase() ?? 'buy or sell'} order</h3>
      <p>
        {saved?.stockSigningEnabled === true
          ? 'Signing happens only in this browser after your explicit approval. Sending is a separate, single attempt.'
          : 'Stock signing is off while runtime qualification is pending. Reviewing an order never sends it.'}
      </p>
      <button
        type="button"
        onClick={() => void prepare()}
        disabled={busy || locked || !request}
      >
        {busy
          ? 'Checking order…'
          : saved
            ? 'Requote and review'
            : 'Prepare order review'}
      </button>
      {review && (
        <>
          <dl className={styles.terms}>
            <dt>Spend</dt>
            <dd>
              {review.display.inputAmount} {review.display.inputSymbol}
            </dd>
            <dt>Expected output</dt>
            <dd>
              {review.display.expectedOutputAmount}{' '}
              {review.display.outputSymbol}
            </dd>
            <dt>Minimum you approve</dt>
            <dd>
              {review.display.minimumOutputAmount} {review.display.outputSymbol}{' '}
              ({review.minimumOutputRaw} atomic units)
            </dd>
            <dt>Slippage bound</dt>
            <dd>0.5%</dd>
            <dt>Fresh reference minimum</dt>
            <dd>
              {review.freshReferenceMinimumRaw} atomic units. Order minimum:{' '}
              {review.minimumOutputRaw} atomic units. Fresh-reference tolerance:{' '}
              {(review.freshReferenceToleranceBps ?? 0) / 100}%.
            </dd>
            <dt>Initial Jupiter preview</dt>
            <dd>
              {review.previewComparison.baselineOutputRaw} output atomic units
              at {review.previewComparison.observedAt}. Minimum difference:{' '}
              {review.previewComparison.differenceRaw} atomic units (
              {(Number(review.previewComparison.differenceBps) / 100).toFixed(
                2,
              )}
              %).
            </dd>
            <dt>Saved market comparison</dt>
            <dd>
              {review.marketComparison.available ? (
                <>
                  Order-implied token price: $
                  {review.marketComparison.orderImpliedBasePriceUsd}. Saved
                  token price: ${review.marketComparison.basePriceUsd}. Server
                  pair-asset price: ${review.marketComparison.quotePriceUsd}.
                  Difference:{' '}
                  {(
                    Number(review.marketComparison.differenceBps) / 100
                  ).toFixed(2)}
                  %. Read at {review.marketComparison.baseObservedAt} and{' '}
                  {review.marketComparison.quoteObservedAt}. Market pairs:{' '}
                  {review.marketComparison.baseMarketPair},{' '}
                  {review.marketComparison.quoteMarketPair}.
                </>
              ) : (
                review.marketComparison.reason
              )}
            </dd>
            <dt>Price impact</dt>
            <dd>
              {review.priceImpactPct === null
                ? 'Unavailable'
                : `${review.priceImpactPct}% (provider estimate)`}
            </dd>
            <dt>Route venues</dt>
            <dd>
              {review.route.map((step, i) => (
                <div key={i}>
                  {step.venue}: {step.bps / 100}% ({step.inputIndex} →{' '}
                  {step.outputIndex})
                </div>
              ))}
            </dd>
            <dt>Network fee</dt>
            <dd>
              {review.networkFeeRaw} lamports, including a priority-fee upper
              bound of {review.priorityFeeUpperBoundRaw} lamports.
            </dd>
            <dt>Account rent</dt>
            <dd>{review.rentRaw} lamports</dd>
            <dt>Platform fee</dt>
            <dd>
              {review.platformFee
                ? `${review.platformFee.bps} basis points, mint ${review.platformFee.mint}`
                : 'None reported'}
            </dd>
            <dt>Review expires</dt>
            <dd>
              <time dateTime={review.expiresAt}>{review.expiresAt}</time>
            </dd>
          </dl>
          <details>
            <summary>Exact order identity</summary>
            <p className={styles.hash}>{review.packetSha256}</p>
            <p>
              Input: {review.inputMint}. Output: {review.outputMint}.
            </p>
          </details>
          <label className={styles.consent}>
            <input
              type="checkbox"
              checked={approved && !expired}
              disabled={busy || expired || attempted}
              onChange={(e) => setApproved(e.target.checked)}
            />
            I approve this exact order and its minimum output of{' '}
            {review.display.minimumOutputAmount} {review.display.outputSymbol}.
          </label>
          {!review.marketComparison.available && (
            <label className={styles.consent}>
              <input
                type="checkbox"
                checked={unavailableAcknowledged && !expired}
                disabled={busy || expired || attempted}
                onChange={(e) => setUnavailableAcknowledged(e.target.checked)}
              />
              No independent price check is available for this order.
            </label>
          )}
          {review.acknowledgementRequired && (
            <label className={styles.consent}>
              <input
                type="checkbox"
                checked={acknowledged && !expired}
                disabled={busy || expired || attempted}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              I acknowledge a worse result above 2% versus the initial Jupiter
              preview or saved market observation. This does not change my
              slippage bound.
            </label>
          )}
          {saved?.stockSigningEnabled === true && !execution && (
            <label className={styles.consent}>
              Wallet vault passphrase (unlocked only in this browser)
              <input
                type="password"
                autoComplete="current-password"
                value={vaultPassword}
                disabled={busy || expired || attempted}
                onChange={(e) => setVaultPassword(e.target.value)}
              />
            </label>
          )}
          <button
            type="button"
            onClick={() => void approve()}
            disabled={
              busy ||
              !!reason ||
              (saved?.stockSigningEnabled === true && !vaultPassword)
            }
          >
            {saved?.stockSigningEnabled === true
              ? 'Approve and sign locally'
              : 'Request signing authorization'}
          </button>
          {saved?.stockSigningEnabled === true && execution && (
            <div aria-label="Stock order execution">
              <p>
                State: <strong>{execution.outcome}</strong>
                {execution.signature && (
                  <>
                    {' '}
                    · Signature{' '}
                    <span className={styles.hash}>{execution.signature}</span>
                  </>
                )}
              </p>
              {execution.state === 'signed' && (
                <>
                  <label className={styles.consent}>
                    <input
                      type="checkbox"
                      checked={sendApproved}
                      disabled={busy}
                      onChange={(e) => setSendApproved(e.target.checked)}
                    />
                    Send this exact signed order once. It is never resent; a
                    lost reply stays unknown until its receipt is recovered.
                  </label>
                  <button
                    type="button"
                    onClick={() => void send()}
                    disabled={busy || !sendApproved}
                  >
                    Send once
                  </button>
                </>
              )}
              {execution.reservationHeld && (
                <button
                  type="button"
                  onClick={() => void recover()}
                  disabled={busy}
                >
                  Check finalized receipt
                </button>
              )}
              {execution.receipt?.kind === 'finalized' && (
                <p>
                  Output {execution.receipt.outputRaw} atomic units; minimum{' '}
                  {execution.receipt.minimumOutputRaw}{' '}
                  {execution.receipt.minimumOutputMet ? 'met' : 'NOT met'}.
                </p>
              )}
            </div>
          )}
        </>
      )}
      {reason && <output>{reason}</output>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
