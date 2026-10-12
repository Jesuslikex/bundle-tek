'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import {
  WARMUP_RECEIPT_SAVED,
  notifyWarmupReceiptSaved,
} from '@/lib/warmup-receipt-events';
import type { SavedWarmupSellReceipt } from '@/lib/warmup-sell-receipt';
export function WarmupSellReceipts({ planId }: { planId: string }) {
  const [open, setOpen] = useState(false),
    [rows, setRows] = useState<SavedWarmupSellReceipt[]>([]),
    [preparationId, setPreparationId] = useState(''),
    [signature, setSignature] = useState(''),
    [busy, setBusy] = useState(false),
    [nextCursor, setNextCursor] = useState<string | null>(null),
    [error, setError] = useState('');
  const id = useId(),
    pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const read = useCallback(
    async (verify = false, cursor?: string) => {
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      setBusy(true);
      setError('');
      try {
        const response = await fetch(
          verify
            ? '/api/wallet-workspace/warmup/sell-receipts'
            : `/api/wallet-workspace/warmup/sell-receipts?id=${encodeURIComponent(planId)}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
          {
            method: verify ? 'POST' : 'GET',
            headers: verify ? { 'content-type': 'application/json' } : {},
            body: verify
              ? JSON.stringify({ preparationId, signature })
              : undefined,
            cache: 'no-store',
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(30000),
            ]),
          },
        );
        const data = (await response.json()) as {
          error?: string;
          receipt?: SavedWarmupSellReceipt;
          receipts?: SavedWarmupSellReceipt[];
          planId?: string;
          nextCursor?: string | null;
        };
        if (!response.ok)
          throw new Error(data.error || 'Sell receipts unavailable.');
        if (verify && !data.receipt) throw new Error('Receipt unavailable.');
        if (
          !verify &&
          (data.planId !== planId ||
            !(data.nextCursor === null || typeof data.nextCursor === 'string'))
        )
          throw new Error('Receipt history context mismatch.');
        const incoming = verify ? [data.receipt!] : data.receipts;
        if (
          !Array.isArray(incoming) ||
          incoming.some(
            (row) =>
              row.planId !== planId || row.document?.signatureVerified !== true,
          )
        )
          throw new Error('Receipt context mismatch.');
        if (!controller.signal.aborted) {
          setRows((prior) =>
            verify
              ? [
                  ...incoming,
                  ...prior.filter(
                    (row) => !incoming.some((value) => value.id === row.id),
                  ),
                ]
              : cursor
                ? [
                    ...prior.filter(
                      (row) => !incoming.some((value) => value.id === row.id),
                    ),
                    ...incoming,
                  ]
                : incoming,
          );
          if (!verify) setNextCursor(data.nextCursor!);
          if (verify) notifyWarmupReceiptSaved(planId, 'Sell');
        }
      } catch (err) {
        if (!controller.signal.aborted)
          setError(err instanceof Error ? err.message : 'Receipt read failed.');
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    },
    [planId, preparationId, signature],
  );
  useEffect(() => {
    const saved = (event: Event) => {
      if (open && (event as CustomEvent).detail?.planId === planId) void read();
    };
    window.addEventListener(WARMUP_RECEIPT_SAVED, saved);
    return () => window.removeEventListener(WARMUP_RECEIPT_SAVED, saved);
  }, [planId, open, read]);
  return (
    <section aria-label="Warmup sell receipts">
      <Button
        variant="outline"
        onClick={() => {
          setOpen((value) => !value);
          if (!open) void read();
        }}
      >
        {' '}
        {open ? 'Close sell receipt history' : 'Open sell receipt history'}
      </Button>
      {open && (
        <>
          <p>
            Record a completed sell linked to a saved buy. Each verified receipt
            consumes the matching buy units once.
          </p>
          <label htmlFor={id + '-prep'}>Saved linked sell preparation ID</label>
          <Input
            id={id + '-prep'}
            value={preparationId}
            maxLength={36}
            disabled={busy}
            onChange={(e) => setPreparationId(e.target.value)}
          />
          <label htmlFor={id + '-sig'}>
            Completed sell transaction signature
          </label>
          <Input
            id={id + '-sig'}
            value={signature}
            maxLength={88}
            disabled={busy}
            onChange={(e) => setSignature(e.target.value)}
          />
          <Button
            variant="outline"
            disabled={busy || !preparationId || !signature}
            onClick={() => void read(true)}
          >
            Verify matching sell receipt
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void read()}>
            Refresh sell receipts
          </Button>
          {nextCursor && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void read(false, nextCursor)}
            >
              Load older sell receipts
            </Button>
          )}
          {busy && <output>Reading finalized sell receipts…</output>}
          {error && <p role="alert">{error}</p>}
          {rows.map((row) => (
            <article key={row.id}>
              <p>
                Consumed {row.document.consumedRaw} token atomic units from buy
                receipt {row.document.buyReceiptId}. Finalized slot{' '}
                {row.document.slot}. Native change{' '}
                {row.document.nativeChangeRaw} lamports; fee{' '}
                {row.document.networkFeeLamports} lamports.
              </p>
              <p>Sell preparation: {row.preparationId}</p>
              <a
                href={`https://explorer.solana.com/tx/${encodeURIComponent(row.document.signature)}`}
                target="_blank"
                rel="noreferrer"
              >
                View finalized sell
              </a>
              <small>{row.document.limitations}</small>
            </article>
          ))}
          {!busy && !error && !rows.length && (
            <p>No sell receipts saved for this plan.</p>
          )}
        </>
      )}
    </section>
  );
}
