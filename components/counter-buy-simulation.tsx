'use client';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CounterPlan } from '@/lib/counter-trade-store';
import type { CounterPreviewRequest } from '@/lib/counter-owned-preview';
import {
  counterPreviewView,
  counterPreviewWallets,
  type CounterPreviewView,
  type CounterPreviewWallet,
} from '@/lib/counter-preview-view';
import { warmupAtoms } from '@/lib/wallet-warmup';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import { readPanelJson } from './read-panel-json';
import { Button } from './ui/button';
import { Input } from './ui/input';
import styles from './counter-buy-simulation.module.css';

export function CounterBuySimulation({
  plan,
  decisionIdentity,
  maximumSolAmount,
  locked,
}: {
  plan: CounterPlan;
  decisionIdentity: string;
  maximumSolAmount: string;
  locked: boolean;
}) {
  const id = useId(),
    pending = useRef<AbortController | null>(null);
  const [wallets, setWallets] = useState<CounterPreviewWallet[] | null>(null),
    [selected, setSelected] = useState(''),
    [fee, setFee] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<{ key: string; message: string } | null>(null),
    [preview, setPreview] = useState<{
      key: string;
      value: CounterPreviewView;
    } | null>(null),
    [now, setNow] = useState(() => Date.now());
  const key = JSON.stringify([
      plan.id,
      plan.revision,
      plan.state,
      plan.ledger,
      locked,
      decisionIdentity,
      maximumSolAmount,
      selected,
      fee,
    ]),
    liveKey = useRef(key);
  const [renderedKey, setRenderedKey] = useState(key);
  if (renderedKey !== key) {
    setRenderedKey(key);
    setBusy(false);
    setPreview(null);
    setError(null);
  }
  const wallet = wallets?.find((w) => w.address === selected),
    proposal = plan.ledger.decisions.find(
      (d) => d.identity === decisionIdentity && d.outcome === 'proposal',
    );
  let limits: { input: string; fee: string } | null = null;
  try {
    const input = warmupAtoms(maximumSolAmount, 9),
      fees = warmupAtoms(fee, 9);
    if (
      input > 0n &&
      fees > 0n &&
      input <= (1n << 64n) - 1n &&
      fees <= (1n << 64n) - 1n
    )
      limits = { input: input.toString(), fee: fees.toString() };
  } catch {
    /* Plain decimal limits are required before a request. */
  }
  const reason = locked
    ? 'Counter controls are busy or unavailable.'
    : plan.state !== 'active'
      ? 'Activate a current Counter plan first.'
      : !proposal
        ? 'Choose a saved Buy proposal above.'
        : !wallets
          ? 'Load verified wallets to continue.'
          : wallets.length === 0
            ? 'No verified Solana wallets are available. Verify a wallet in the wallet workspace first.'
            : !wallet
              ? 'Choose a verified wallet.'
              : !limits
                ? 'Enter positive SOL input and fee/rent limits.'
                : '';
  const current = preview?.key === key ? preview.value : null,
    expired = current !== null && Date.parse(current.expiresAt) <= now;
  useLayoutEffect(() => {
    liveKey.current = key;
    pending.current?.abort();
    pending.current = null;
  }, [key]);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (!current || expired) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [current, expired]);
  async function run(kind: 'wallets' | 'preview') {
    if (
      pending.current ||
      locked ||
      plan.state !== 'active' ||
      (kind === 'preview' && reason)
    )
      return;
    const captured = key,
      c = new AbortController();
    pending.current = c;
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const request: CounterPreviewRequest | null =
        kind === 'preview' && wallet && limits
          ? {
              projectId: plan.projectId,
              projectRevision: plan.ledger.scope.revision,
              planId: plan.id,
              planRevision: plan.revision,
              decisionIdentity,
              wallet: wallet.address,
              walletRevision: wallet.revision,
              maximumSolInputRaw: limits.input,
              maximumFeeAndRentRaw: limits.fee,
            }
          : null;
      const response = await fetch(
        kind === 'wallets'
          ? '/api/wallet-workspace'
          : '/api/imported-projects/counter-previews',
        request
          ? {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(request),
              signal: AbortSignal.any([c.signal, AbortSignal.timeout(45000)]),
            }
          : {
              cache: 'no-store',
              signal: AbortSignal.any([c.signal, AbortSignal.timeout(15000)]),
            },
      );
      const data = await readPanelJson(
        response,
        'Counter preview unavailable. Reload saved history before retrying.',
      );
      if (!response.ok)
        throw Error(
          (data as { error?: string })?.error || 'Counter preview unavailable.',
        );
      if (
        c.signal.aborted ||
        pending.current !== c ||
        liveKey.current !== captured
      )
        return;
      if (kind === 'wallets') {
        setWallets(counterPreviewWallets(data, plan));
        setSelected('');
      } else if (request) {
        setPreview({
          key: captured,
          value: counterPreviewView(data, plan, request),
        });
        setNow(Date.now());
      }
    } catch (e) {
      if (!c.signal.aborted && liveKey.current === captured)
        setError({
          key: captured,
          message:
            e instanceof Error ? e.message : 'Counter preview unavailable.',
        });
    } finally {
      if (pending.current === c) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <section className={styles.panel} aria-label="Counter settlement preview">
      <h4>Preview wallet settlement</h4>
      <p>
        Simulate this retained Buy target with a verified wallet. This does not
        revalidate the original trade signal or approve a transaction.
      </p>
      <Button
        type="button"
        disabled={busy || locked || plan.state !== 'active'}
        onClick={() => void run('wallets')}
      >
        {wallets ? 'Refresh verified wallets' : 'Load verified wallets'}
      </Button>
      <div className={styles.fields}>
        <div>
          <label htmlFor={`${id}-wallet`}>Preview wallet</label>
          <select
            id={`${id}-wallet`}
            value={selected}
            disabled={busy || locked || !wallets?.length}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">Choose a verified wallet</option>
            {wallets?.map((w) => (
              <option key={w.address} value={w.address}>
                {w.label || `${w.address.slice(0, 6)}…${w.address.slice(-4)}`}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-fee`}>
            Maximum network fees and rent (SOL)
          </label>
          <Input
            id={`${id}-fee`}
            inputMode="decimal"
            maxLength={30}
            value={fee}
            disabled={busy || locked}
            onChange={(e) => setFee(e.target.value)}
            placeholder="Enter a separate cost limit"
          />
        </div>
      </div>
      <p id={`${id}-reason`}>
        {reason || 'Simulation only. Your wallet remains locked.'}
      </p>
      <div className={styles.actions}>
        <Button
          type="button"
          disabled={busy || !!reason}
          aria-describedby={`${id}-reason`}
          onClick={() => void run('preview')}
        >
          Preview settlement
        </Button>
        {busy && (
          <Button
            type="button"
            onClick={() => {
              pending.current?.abort();
              pending.current = null;
              setBusy(false);
            }}
          >
            Cancel preview
          </Button>
        )}
      </div>
      <div aria-live="polite">
        {busy && <output>Reading the selected preview…</output>}
        {error?.key === key && <p role="alert">{error.message}</p>}
        {current &&
          (expired ? (
            <p>Settlement preview expired. Request a fresh preview.</p>
          ) : (
            <>
              <dl className={styles.summary}>
                <div>
                  <dt>Exact Buy target</dt>
                  <dd>
                    {formatNativeBalance(
                      current.outputTargetRaw,
                      current.tokenDecimals,
                    )}{' '}
                    tokens
                  </dd>
                </div>
                <div>
                  <dt>Simulated swap input</dt>
                  <dd>
                    {formatNativeBalance(current.actualSimulatedInputRaw, 9)}{' '}
                    SOL
                  </dd>
                </div>
                <div>
                  <dt>Quote input ceiling</dt>
                  <dd>
                    {formatNativeBalance(current.maximumQuoteInputRaw, 9)} SOL
                  </dd>
                </div>
                <div>
                  <dt>Network fee</dt>
                  <dd>
                    {formatNativeBalance(current.networkFeeLamports, 9)} SOL
                  </dd>
                </div>
                <div>
                  <dt>Your swap-input limit</dt>
                  <dd>
                    {formatNativeBalance(current.maximumSolInputRaw, 9)} SOL
                  </dd>
                </div>
                <div>
                  <dt>Your fee and rent limit</dt>
                  <dd>
                    {formatNativeBalance(current.maximumFeeAndRentRaw, 9)} SOL
                  </dd>
                </div>
              </dl>
              <p>
                Expires {new Date(current.expiresAt).toLocaleTimeString()}.
                Preview only. Source eligibility, program admission and a
                separate execution review are still required. Signing is
                unavailable here.
              </p>
            </>
          ))}
      </div>
    </section>
  );
}
