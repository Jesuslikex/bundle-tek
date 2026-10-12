'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import {
  WARMUP_RECEIPT_SAVED,
  notifyWarmupReceiptSaved,
} from '@/lib/warmup-receipt-events';
import type { SavedWarmup } from '@/lib/wallet-warmup-storage';
import type { SavedWarmupBuyReceipt } from '@/lib/warmup-buy-receipt';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import { warmupBuyLink } from '@/lib/warmup-buy-link';
export function WarmupBuyReceipts({
  plan,
  cycle,
  wallet,
  selected,
  onSelect,
  readOnly = false,
}: {
  plan: SavedWarmup;
  cycle: number;
  wallet: string;
  selected: SavedWarmupBuyReceipt | null;
  onSelect: (value: SavedWarmupBuyReceipt | null) => void;
  readOnly?: boolean;
}) {
  const field = useId(),
    pending = useRef<AbortController | null>(null);
  const [rows, setRows] = useState<SavedWarmupBuyReceipt[]>([]),
    [preparationId, setPreparationId] = useState(''),
    [signature, setSignature] = useState(''),
    [busy, setBusy] = useState(false),
    [showHistorical, setShowHistorical] = useState(false),
    [nextCursor, setNextCursor] = useState<string | null>(null),
    [error, setError] = useState('');
  const read = useCallback(
    async (cursor?: string) => {
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      setBusy(true);
      try {
        const response = await fetch(
          `/api/wallet-workspace/warmup/buy-receipts?id=${encodeURIComponent(plan.id)}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
          {
            cache: 'no-store',
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(10000),
            ]),
          },
        );
        const data = (await response.json()) as {
          planId: string;
          executionAllowed: boolean;
          receipts: SavedWarmupBuyReceipt[];
          nextCursor: string | null;
          error?: string;
        };
        if (
          !response.ok ||
          data.planId !== plan.id ||
          data.executionAllowed !== false ||
          !Array.isArray(data.receipts) ||
          !(data.nextCursor === null || typeof data.nextCursor === 'string') ||
          data.receipts.some(
            (row) =>
              row.planId !== plan.id ||
              row.document.executionAllowed !== false ||
              row.document.signatureVerified !== true,
          )
        )
          throw new Error(data.error || 'Buy receipt history unavailable.');
        if (!controller.signal.aborted) {
          setRows((prior) =>
            cursor
              ? [
                  ...prior.filter(
                    (row) =>
                      !data.receipts.some((incoming) => incoming.id === row.id),
                  ),
                  ...data.receipts,
                ]
              : data.receipts,
          );
          setNextCursor(data.nextCursor);
          setError('');
        }
      } catch (e) {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error ? e.message : 'Buy receipt history unavailable.',
          );
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    },
    [plan.id],
  );
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) void read();
    });
    return () => {
      cancelled = true;
      pending.current?.abort();
    };
  }, [read]);
  useEffect(() => {
    const saved = (event: Event) => {
      if ((event as CustomEvent).detail?.planId !== plan.id) return;
      if ((event as CustomEvent).detail?.side === 'Sell') onSelect(null);
      void read();
    };
    window.addEventListener(WARMUP_RECEIPT_SAVED, saved);
    return () => window.removeEventListener(WARMUP_RECEIPT_SAVED, saved);
  }, [plan.id, read, onSelect]);
  const matches = (row: SavedWarmupBuyReceipt) => {
    if (readOnly) return true;
    try {
      warmupBuyLink(row, {
        planId: plan.id,
        planRevision: plan.revision,
        cycle,
        wallet,
        walletRevision:
          plan.document.walletRevisions.find((w) => w.address === wallet)
            ?.revision ?? 0,
        mint: plan.document.tokens[(cycle - 1) % plan.document.tokens.length],
        allowHistoricalBuy: showHistorical,
      });
      return true;
    } catch {
      return false;
    }
  };
  async function verify() {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        '/api/wallet-workspace/warmup/buy-receipts',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(30000),
          ]),
          body: JSON.stringify({
            preparationId: preparationId.trim(),
            signature: signature.trim(),
          }),
        },
      );
      const data = (await response.json()) as {
        executionAllowed: boolean;
        receipt: SavedWarmupBuyReceipt;
        error?: string;
      };
      if (
        !response.ok ||
        data.executionAllowed !== false ||
        !data.receipt ||
        !matches(data.receipt) ||
        data.receipt.preparationId !== preparationId.trim() ||
        data.receipt.document.signature !== signature.trim() ||
        data.receipt.document.executionAllowed !== false ||
        data.receipt.document.signatureVerified !== true
      )
        throw new Error(
          data.error || 'Receipt does not match the selected cycle and wallet.',
        );
      if (!controller.signal.aborted) {
        setRows((previous) => [
          data.receipt,
          ...previous.filter((row) => row.id !== data.receipt.id),
        ]);
        onSelect(data.receipt);
        notifyWarmupReceiptSaved(plan.id, 'Buy');
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error
            ? e.message
            : 'Buy receipt verification unavailable.',
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section
      aria-label={
        readOnly
          ? 'Recorded warmup buy receipts'
          : 'Warmup matching buy receipts'
      }
    >
      <h5>{readOnly ? 'Recorded buy receipts' : 'Match a completed buy'}</h5>
      <p>
        Verify a signed transaction against its saved buy packet and finalized
        token increase. Recorded sells reduce the remaining units shown here.
        Standard SPL tokens only. External transfers and pending transactions
        are not reconstructed.
      </p>
      {!readOnly && (
        <>
          <label
            className="warmup-checkbox-choice"
            htmlFor={field + '-historical'}
          >
            <input
              id={field + '-historical'}
              type="checkbox"
              disabled={busy}
              checked={showHistorical}
              onChange={(event) => {
                setShowHistorical(event.target.checked);
                onSelect(null);
              }}
            />{' '}
            <span>
              Include finalized buys from earlier plan or wallet revisions, with
              the same plan, cycle, wallet and token.
            </span>
          </label>
          <label htmlFor={field + '-preparation'}>
            Saved buy preparation ID
          </label>
          <Input
            id={field + '-preparation'}
            value={preparationId}
            maxLength={36}
            disabled={busy}
            onChange={(e) => setPreparationId(e.target.value)}
          />
          <label htmlFor={field + '-signature'}>
            Completed buy transaction signature
          </label>
          <Input
            id={field + '-signature'}
            value={signature}
            maxLength={88}
            disabled={busy}
            onChange={(e) => setSignature(e.target.value)}
          />
          <Button
            variant="outline"
            disabled={busy || !preparationId.trim() || !signature.trim()}
            onClick={() => void verify()}
          >
            Verify matching buy receipt
          </Button>
        </>
      )}
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => {
          onSelect(null);
          void read();
        }}
      >
        Reload buy receipts
      </Button>
      {nextCursor && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void read(nextCursor)}
        >
          Load older buy receipts
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
      {busy && <output>Reading buy receipt evidence…</output>}
      {rows.filter(matches).map((row) => (
        <article key={row.id}>
          <WarmupBuyReceiptRecord record={row} />
          {!readOnly && (
            <Button
              variant="outline"
              disabled={
                busy || (row.remainingRaw ?? row.document.acquiredRaw) === '0'
              }
              aria-pressed={selected?.id === row.id}
              onClick={() => onSelect(row)}
            >
              {(row.remainingRaw ?? row.document.acquiredRaw) === '0'
                ? 'Buy lot fully sold'
                : 'Use matched buy amount'}
            </Button>
          )}
        </article>
      ))}
      {!busy && !error && !rows.some(matches) && (
        <p>
          {nextCursor
            ? 'No matching buy receipt in the loaded pages. Load older receipts to continue.'
            : readOnly
              ? 'No buy receipts saved for this plan.'
              : showHistorical
                ? 'No finalized buy lot matches this plan, cycle, wallet and token, including earlier revisions.'
                : 'No matching buy receipt saved for this plan revision, cycle and wallet.'}
        </p>
      )}
      {selected && (
        <>
          <p>
            Sell input is capped at{' '}
            {selected.remainingRaw ?? selected.document.acquiredRaw} remaining
            atomic units. Fresh unfrozen holdings are checked independently.
          </p>
          <Button variant="outline" onClick={() => onSelect(null)}>
            Return to unlinked inventory review
          </Button>
        </>
      )}
    </section>
  );
}
const ignoreSelection = () => {};
export function WarmupBuyReceiptHistory({ plan }: { plan: SavedWarmup }) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Warmup buy receipt history">
      <Button variant="outline" onClick={() => setOpen((value) => !value)}>
        {open ? 'Close buy receipt history' : 'Open buy receipt history'}
      </Button>
      {open && (
        <WarmupBuyReceipts
          plan={plan}
          cycle={1}
          wallet={plan.document.addresses[0]}
          selected={null}
          onSelect={ignoreSelection}
          readOnly
        />
      )}
    </section>
  );
}
export function WarmupBuyReceiptRecord({
  record: row,
}: {
  record: SavedWarmupBuyReceipt;
}) {
  return (
    <>
      <p>
        Cycle {row.cycle} · plan r{row.planRevision} · wallet r
        {row.walletRevision} · received{' '}
        {formatNativeBalance(row.document.acquiredRaw, row.document.decimals)}{' '}
        tokens ({row.document.acquiredRaw} atomic units) · finalized slot{' '}
        {row.document.slot}.
      </p>
      <p>
        Remaining recorded buy units:{' '}
        {row.remainingRaw ?? row.document.acquiredRaw}.
      </p>
      <p className="warmup-address">
        Wallet: {row.document.wallet}. Mint: {row.document.mint}.
      </p>
      <p>
        Saved buy preparation: {row.preparationId}. Receipt: {row.id}.
      </p>
      <p>
        Network fee: {row.document.networkFeeLamports} lamports. Native change:{' '}
        {row.document.nativeChangeRaw} lamports.
      </p>
      <a
        href={`https://explorer.solana.com/tx/${encodeURIComponent(row.document.signature)}`}
        target="_blank"
        rel="noreferrer"
      >
        View matching transaction
      </a>
      <small>
        {row.document.source} · observed {row.document.observedAt}.{' '}
        {row.document.limitations}
      </small>
    </>
  );
}
