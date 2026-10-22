'use client';
import { SwapFailureEvidence } from './swap-failure-evidence';
import { validatedWarmupFailure } from '@/lib/warmup-approval-history';
import type { SwapFailureReceipt } from '@/lib/swap-failure';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from './ui/button';
import type { SavedWarmup } from '@/lib/wallet-warmup-storage';
import {
  restoreRegisteredWarmupPacket,
  type WarmupApprovalHistoryRow,
} from '@/lib/warmup-approval-history';
import { notifyWarmupReceiptSaved } from '@/lib/warmup-receipt-events';
import { readPanelJson } from './read-panel-json';
import { warmupApprovalStateLabel } from './warmup-transaction-progress';

export function WarmupApprovalHistory({
  plan,
  autoOpen = false,
  viewOnly = false,
  onChanged,
}: {
  plan: SavedWarmup;
  autoOpen?: boolean;
  /** Activity may remount while reloading. Keep recovery writes in My wallets. */
  viewOnly?: boolean;
  onChanged?: () => void;
}) {
  const [open, setOpen] = useState(autoOpen),
    [rows, setRows] = useState<WarmupApprovalHistoryRow[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [accepted, setAccepted] = useState<string | null>(null),
    [now, setNow] = useState(() => Date.now()),
    [unconfirmed, setUnconfirmed] = useState<Set<string>>(() => new Set());
  const pending = useRef<AbortController | null>(null),
    field = useId();
  const initialLoad = useRef<string | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);
  const start = useCallback(() => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    setNotice('');
    setAccepted(null);
    return {
      controller,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
    };
  }, []);
  const read = useCallback(
    async (older = false) => {
      const { controller, signal } = start();
      try {
        const response = await fetch(
          `/api/wallet-workspace/warmup/signing?planId=${encodeURIComponent(plan.id)}${older && cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
          { cache: 'no-store', signal },
        );
        const data = (await readPanelJson(
          response,
          'Approval history unavailable. Try refreshing.',
        )) as {
          error?: string;
          planId: string;
          intents: WarmupApprovalHistoryRow[];
          nextCursor: string | null;
        };
        if (!data || typeof data !== 'object')
          throw new Error('Approval history unavailable. Try refreshing.');
        if (
          !response.ok ||
          data.planId !== plan.id ||
          !Array.isArray(data.intents) ||
          data.intents.length > 50 ||
          data.intents.some(
            (row) =>
              row.planId !== plan.id ||
              row.document?.id !== row.id ||
              row.document?.preparationId !== row.preparationId ||
              row.document?.wallet !== row.wallet ||
              row.document.network !== 'mainnet',
          )
        )
          throw new Error(data.error || 'Approval history context differs.');
        data.intents.forEach(validatedWarmupFailure);
        if (controller.signal.aborted) return;
        setRows((prior) =>
          older
            ? [
                ...prior,
                ...data.intents.filter(
                  (row) => !prior.some((item) => item.id === row.id),
                ),
              ]
            : data.intents,
        );
        setCursor(data.nextCursor);
        setUnconfirmed(
          (prior) =>
            new Set(
              [...prior].filter(
                (id) => !data.intents.some((row) => row.id === id),
              ),
            ),
        );
      } catch (err) {
        if (!controller.signal.aborted)
          setError(
            err instanceof Error
              ? err.message
              : 'Approval history unavailable.',
          );
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    },
    [plan.id, cursor, start],
  );
  useEffect(() => {
    if (autoOpen && initialLoad.current !== plan.id) {
      initialLoad.current = plan.id;
      setOpen(true);
      void read();
    }
  }, [autoOpen, plan.id, read]);
  async function act(
    row: WarmupApprovalHistoryRow,
    action: 'cancel' | 'submit' | 'recover' | 'receipt',
  ) {
    if (
      viewOnly ||
      busy ||
      row.planId !== plan.id ||
      (action === 'submit' && accepted !== row.id)
    )
      return;
    const { controller, signal } = start();
    try {
      let transaction: string | undefined;
      if (action === 'submit') {
        if (
          plan.archived ||
          row.planRevision !== plan.revision ||
          row.state !== 'signed' ||
          !row.signature ||
          unconfirmed.has(row.id) ||
          Date.parse(row.document.expiresAt) <= now
        )
          throw new Error(
            'This signed approval cannot be submitted. Keep its signature for receipt recovery.',
          );
        transaction = (
          await restoreRegisteredWarmupPacket(row.document, row.signature)
        ).transaction;
        signal.throwIfAborted();
      }
      const response = await fetch(
        action === 'receipt'
          ? `/api/wallet-workspace/warmup/${row.side === 'Buy' ? 'buy' : 'sell'}-receipts`
          : '/api/wallet-workspace/warmup/signing',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal,
          body: JSON.stringify(
            action === 'receipt'
              ? { preparationId: row.preparationId, signature: row.signature }
              : { action, id: row.id, ...(transaction ? { transaction } : {}) },
          ),
        },
      );
      const data = (await readPanelJson(
        response,
        'Approval recovery unavailable. Keep the original signature for recovery.',
      )) as {
        error?: string;
        state?: WarmupApprovalHistoryRow['state'];
        signature?: string;
        message?: string;
        failureReceipt?: SwapFailureReceipt;
        receipt?: {
          planId: string;
          preparationId: string;
          document: {
            signature: string;
            wallet: string;
            signatureVerified: boolean;
            commitment: string;
          };
        };
      };
      if (!data || typeof data !== 'object')
        throw new Error(
          'Approval recovery unavailable. Keep the original signature for recovery.',
        );
      if (!response.ok)
        throw new Error(
          data.error || 'Recovery unavailable. Keep this signature reserved.',
        );
      let state = data.state;
      if (action === 'receipt') {
        const receipt = data.receipt;
        if (
          !receipt ||
          receipt.planId !== plan.id ||
          receipt.preparationId !== row.preparationId ||
          receipt.document.signature !== row.signature ||
          receipt.document.wallet !== row.wallet ||
          receipt.document.signatureVerified !== true ||
          receipt.document.commitment !== 'finalized'
        )
          throw new Error('Finalized matching receipt unavailable.');
        state = 'finalized';
      } else if (
        !state ||
        ![
          'awaiting_signature',
          'signed',
          'submitted',
          'cancelled',
          'failed',
          'finalized',
        ].includes(state) ||
        (action === 'cancel'
          ? state !== 'cancelled'
          : data.signature !== row.signature)
      )
        throw new Error('Recovery response differs from this approval.');
      const failureReceipt = validatedWarmupFailure({
        ...row,
        state: state!,
        failureReceipt: data.failureReceipt ?? row.failureReceipt,
      });
      if (controller.signal.aborted) return;
      setRows((prior) =>
        prior.map((item) =>
          item.id === row.id
            ? { ...item, state: state!, failureReceipt }
            : item,
        ),
      );
      setNotice(
        action === 'receipt'
          ? `Finalized ${row.side.toLowerCase()} receipt recorded. Remaining buy units and history updated.`
          : data.message ||
              `Approval state: ${warmupApprovalStateLabel(state!)}.`,
      );
      if (action === 'receipt') notifyWarmupReceiptSaved(plan.id, row.side);
      onChanged?.();
    } catch (err) {
      if (!controller.signal.aborted) {
        if (action === 'submit')
          setUnconfirmed((prior) => new Set(prior).add(row.id));
        setError(err instanceof Error ? err.message : 'Recovery unavailable.');
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section
      aria-label={
        viewOnly ? 'Saved warmup approvals' : 'Warmup approval recovery'
      }
    >
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => {
          if (open) {
            pending.current?.abort();
            setOpen(false);
            setAccepted(null);
          } else {
            setOpen(true);
            void read();
          }
        }}
      >
        {viewOnly
          ? open
            ? 'Close saved approvals'
            : 'View saved approvals'
          : open
            ? 'Close approval recovery'
            : 'Open approval recovery'}
      </Button>
      {open && (
        <>
          <p>
            {viewOnly
              ? 'Saved approval history only. Open warmup in My wallets for cancellation, submission or receipt recovery. Reloading this Activity view cannot submit a transaction.'
              : 'Resume saved approvals after a reload, including older plan revisions and archives. Nothing is signed or submitted automatically. Submitted or uncertain outcomes require receipt recovery.'}
          </p>
          <Button variant="outline" disabled={busy} onClick={() => void read()}>
            Refresh approvals
          </Button>
          {rows.map((row) => {
            const canSubmit =
              !viewOnly &&
              row.state === 'signed' &&
              !unconfirmed.has(row.id) &&
              !!row.signature &&
              !plan.archived &&
              row.planRevision === plan.revision &&
              Date.parse(row.document.expiresAt) > now;
            return (
              <article key={row.id} className="space-y-2 border-t py-3">
                <h5>
                  {row.side} · Cycle {row.cycle} ·{' '}
                  {warmupApprovalStateLabel(row.state)}
                </h5>
                <p>
                  Solana mainnet. Wallet {row.wallet}. Plan revision{' '}
                  {row.planRevision}. Created {row.createdAt}. Approval expires{' '}
                  {row.document.expiresAt}.
                </p>
                <p>
                  Spend {row.document.inputRaw} atomic units of{' '}
                  {row.document.inputMint}; minimum output{' '}
                  {row.document.minimumOutputRaw} atomic units of{' '}
                  {row.document.outputMint}. Network fee{' '}
                  {row.document.maximumFeeLamports} lamports.
                </p>
                {row.document.settlement && (
                  <p>
                    Maximum new-account rent{' '}
                    {row.document.settlement.maximumRentLamports} lamports;
                    maximum upfront SOL debit{' '}
                    {row.document.settlement.maximumNativeDebitLamports}{' '}
                    lamports. Wrap{' '}
                    {row.document.settlement.wrappedFromNativeRaw} lamports.{' '}
                    {row.document.settlement.closesWrappedAccount
                      ? 'Wrapped SOL returns to this wallet after the route.'
                      : 'Wrapped SOL stays in its token account.'}
                  </p>
                )}
                {row.document.platformFee && (
                  <p>
                    Quoted platform fee {row.document.platformFee.bps} bps in{' '}
                    {row.document.platformFee.mint}.
                  </p>
                )}
                <p className="warmup-address">
                  Approval {row.id}. Preparation {row.preparationId}. Exact
                  packet {row.document.sha256}.
                </p>
                {row.document.buyReceipt?.historicalBuy && (
                  <p>
                    Historical buy lot {row.document.buyReceipt.receiptId}:
                    source plan revision{' '}
                    {row.document.buyReceipt.historicalBuy.planRevision}, source
                    wallet revision{' '}
                    {row.document.buyReceipt.historicalBuy.walletRevision}.
                    Original buy signature {row.document.buyReceipt.signature}.
                  </p>
                )}
                {row.signature && (
                  <p className="warmup-address">
                    Registered signature {row.signature}.{' '}
                    <a
                      href={`https://explorer.solana.com/tx/${encodeURIComponent(row.signature)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View transaction
                    </a>
                  </p>
                )}
                {!viewOnly && row.state === 'awaiting_signature' && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void act(row, 'cancel')}
                  >
                    Cancel this unsigned approval
                  </Button>
                )}
                {canSubmit && (
                  <>
                    <label
                      className="warmup-checkbox-choice"
                      htmlFor={field + row.id}
                    >
                      <input
                        id={field + row.id}
                        type="checkbox"
                        disabled={busy}
                        checked={accepted === row.id}
                        onChange={(event) =>
                          setAccepted(event.target.checked ? row.id : null)
                        }
                      />{' '}
                      <span>
                        I reviewed this wallet, exact transaction, amounts,
                        fees, rent and SOL debit. Submit this registered
                        signature once.
                      </span>
                    </label>
                    <Button
                      disabled={busy || accepted !== row.id}
                      onClick={() => void act(row, 'submit')}
                    >
                      Submit this saved signed transaction to mainnet
                    </Button>
                  </>
                )}
                {!viewOnly && row.state === 'signed' && !canSubmit && (
                  <p>
                    {unconfirmed.has(row.id)
                      ? 'Submission is uncertain. Check the original signature before another action.'
                      : plan.archived
                        ? 'This plan is archived. Submission is unavailable; recover the registered signature.'
                        : row.planRevision !== plan.revision
                          ? 'The plan revision changed. Submission is unavailable for this saved approval; recover its original signature.'
                          : 'The signed packet expired or its registration is incomplete. Recover the original signature before preparing another transaction.'}
                  </p>
                )}
                {viewOnly &&
                  row.signature &&
                  ['signed', 'submitted', 'failed'].includes(row.state) && (
                    <p>
                      Keep this original signature for recovery in My wallets. A
                      saved approval does not prove finality. No automatic retry
                      or replacement.
                    </p>
                  )}
                {!viewOnly &&
                  row.signature &&
                  ['signed', 'submitted'].includes(row.state) && (
                    <>
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => void act(row, 'recover')}
                      >
                        Check finalized outcome
                      </Button>
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => void act(row, 'receipt')}
                      >
                        Verify finalized {row.side.toLowerCase()} receipt
                      </Button>
                      {!canSubmit && (
                        <p>
                          Keep this signature reserved until its finalized
                          outcome is verified. No automatic retry or
                          replacement.
                        </p>
                      )}
                    </>
                  )}
                {unconfirmed.has(row.id) && (
                  <p>
                    Submission response was not confirmed. Refresh approvals or
                    check the finalized outcome before another action.
                  </p>
                )}
                {row.state === 'finalized' && (
                  <p>
                    Matching finalized receipt recorded. Open receipt history to
                    review acquired or consumed units.
                  </p>
                )}
                {row.state === 'failed' && (
                  <>
                    <SwapFailureEvidence receipt={row.failureReceipt} />
                    {!viewOnly && !row.failureReceipt && row.signature && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => void act(row, 'recover')}
                      >
                        Check original failure evidence
                      </Button>
                    )}
                  </>
                )}
              </article>
            );
          })}
          {cursor && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void read(true)}
            >
              Load older approvals
            </Button>
          )}
          {!busy && !error && rows.length === 0 && (
            <p>No saved approvals for this plan.</p>
          )}
          {notice && <output>{notice}</output>}
          {error && <p role="alert">{error}</p>}
          {busy && <output>Reading or recovering this approval…</output>}
        </>
      )}
    </section>
  );
}
