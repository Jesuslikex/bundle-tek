'use client';
import { useEffect, useRef, useState } from 'react';
import { Clock3 } from 'lucide-react';
import { readBoundedPanelJson } from '@/lib/read-bounded-panel-json';
import {
  decodeWalletFundingTimes,
  walletFundingProximity,
  fundingGapLabel,
  type WalletFundingSelection,
  type WalletFundingTimes,
} from '@/lib/wallet-funding-time';
import styles from './wallet-funding-proximity.module.css';
export function useWalletFundingProximity(selection: WalletFundingSelection) {
  const key = JSON.stringify(selection);
  const active = useRef<{ key: string; controller: AbortController } | null>(
    null,
  );
  const [view, setView] = useState<{
    key: string;
    busy: boolean;
    result: WalletFundingTimes | null;
    error: string;
  }>({ key, busy: false, result: null, error: '' });
  // Reset this component's state before painting a changed selection. Returning
  // to an earlier key must not revive that selection's old saved-record check.
  if (view.key !== key) setView({ key, busy: false, result: null, error: '' });
  useEffect(
    () => () => {
      if (active.current?.key === key) {
        active.current.controller.abort();
        active.current = null;
      }
    },
    [key],
  );
  async function read() {
    if (
      !selection.length ||
      selection.length > 100 ||
      active.current?.key === key
    )
      return;
    active.current?.controller.abort();
    const controller = new AbortController();
    active.current = { key, controller };
    setView({ key, busy: true, result: null, error: '' });
    try {
      const captured: WalletFundingSelection = JSON.parse(key);
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(15000),
      ]);
      const response = await fetch('/api/wallet-workspace/funding-times', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wallets: captured }),
        cache: 'no-store',
        signal,
      });
      const body = await readBoundedPanelJson(response, signal);
      signal.throwIfAborted();
      if (!response.ok) throw Error();
      const result = decodeWalletFundingTimes(body, captured);
      if (active.current?.controller === controller)
        setView({ key, busy: false, result, error: '' });
    } catch {
      if (active.current?.controller === controller)
        setView({
          key,
          busy: false,
          result: null,
          error:
            'Recorded funding times could not be checked. Keep the selection and retry this read.',
        });
    } finally {
      if (active.current?.controller === controller) active.current = null;
    }
  }
  function cancel() {
    if (active.current?.key !== key) return;
    active.current.controller.abort();
    active.current = null;
    setView({
      key,
      busy: false,
      result: null,
      error: 'Funding-time check cancelled. No funding was started.',
    });
  }
  const current =
    view.key === key ? view : { busy: false, result: null, error: '' };
  return {
    ...current,
    read,
    cancel,
    pairs: current.result ? walletFundingProximity(current.result) : [],
  };
}
type Check = ReturnType<typeof useWalletFundingProximity>;
export function WalletFundingProximityPanel({
  check,
  count,
}: {
  check: Check;
  count: number;
}) {
  return (
    <section
      className={styles.panel}
      aria-label="Selected wallet funding times"
    >
      <div className={styles.toolbar}>
        <button
          type="button"
          onClick={() => void check.read()}
          disabled={check.busy || count < 1 || count > 100}
        >
          Check recorded funding times
        </button>
        {check.busy && (
          <button type="button" onClick={check.cancel}>
            Cancel funding-time check
          </button>
        )}
        <output>
          {check.busy
            ? 'Reading saved receipts…'
            : check.result
              ? `${check.result.wallets.filter((w) => w.funding).length} of ${check.result.wallets.length} recorded times · ${check.pairs.length} ${check.pairs.length === 1 ? 'pair' : 'pairs'} under 30 minutes · ${check.result.wallets.filter((w) => !w.funding).length} unknown`
              : 'No funding-time check for this selection'}
        </output>
      </div>
      {count > 100 && (
        <p>Select up to 100 wallets for one funding-time check.</p>
      )}
      <small>
        Compares the most recently saved finalized native SOL transfer to each
        selected wallet. Uses its block timestamp, not wallet creation time.
        Earlier and external funding may be missing; this is not first-funding
        history or proof of wallet ownership.
      </small>
      {check.result && (
        <small>
          Saved-record check:{' '}
          {new Date(check.result.capturedAt).toLocaleString()}. Click a
          wallet&apos;s clock for its recorded gap. Timing similarity alone does
          not prove shared control.
        </small>
      )}
      {check.error && <p role="alert">{check.error}</p>}
    </section>
  );
}
export function WalletFundingProximityBadge({
  check,
  address,
}: {
  check: Check;
  address: string;
}) {
  const row = check.result?.wallets.find((w) => w.address === address);
  if (!row) return null;
  const nearest = check.pairs.find((p) => p.a === address || p.b === address);
  if (!row.funding)
    return (
      <span
        className={styles.unknown}
        title={
          row.reason === 'no-retained-receipt'
            ? 'No retained successful native SOL receipt was found.'
            : 'The retained receipt could not supply a valid funding time.'
        }
      >
        <Clock3 aria-hidden="true" size={13} />
        Funding time unknown
      </span>
    );
  const peer = nearest ? (nearest.a === address ? nearest.b : nearest.a) : null;
  return (
    <details className={nearest ? styles.warning : styles.recorded}>
      <summary>
        <Clock3 aria-hidden="true" size={13} />
        {nearest
          ? fundingGapLabel(nearest.seconds) + ' apart'
          : 'Recorded funding'}
      </summary>
      <p>
        {nearest
          ? `Recorded funding events are ${fundingGapLabel(nearest.seconds)} apart from ${peer}. Below the 30-minute comparison threshold.`
          : 'No pair under 30 minutes was found in these retained events. This is not proof that the wallets are unlinked.'}
      </p>
      <small>
        Funding block time:{' '}
        {new Date(row.funding.blockTime * 1000).toLocaleString()} · finalized
        slot {row.funding.slot}. Other funding may be missing.
      </small>
    </details>
  );
}
