'use client';
import { ImportedReceiptChart } from './imported-receipt-chart';
import { notifyImportedReceiptSaved } from '@/lib/imported-receipt-events';
import { ImportedSessionReview } from './imported-session-review';
import { ConditionalSigningReview } from './conditional-signing-review';
import { ImportedAcquisitionReview } from './imported-acquisition-review';
import { SwapFailureEvidence } from './swap-failure-evidence';
import {
  validatedSwapFailure,
  type SwapFailureReceipt,
} from '@/lib/swap-failure';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from './ui/button';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import {
  importedApprovalPage,
  canSubmitImportedApproval,
  matchingImportedReceipt,
  type ImportedApprovalRow,
  type ImportedSwapReceipt,
} from '@/lib/imported-approval-history';
import {
  requireSessionApproval,
  type SessionApprovalSelection,
} from '@/lib/trade-session-approval';
import { restoreRegisteredWarmupPacket } from '@/lib/warmup-approval-history';
import {
  requireConditionalApproval,
  type ConditionalApprovalSelection,
} from '@/lib/conditional-approval-selection';

export function ImportedApprovalHistory({
  project,
  onReviewBuy,
  selection,
  submissionBlocked = false,
}: {
  project: ImportedTokenProject;
  onReviewBuy?: (receipt: ImportedSwapReceipt) => void;
  selection?: SessionApprovalSelection | ConditionalApprovalSelection;
  submissionBlocked?: boolean;
}) {
  const [open, setOpen] = useState(!!selection),
    [rows, setRows] = useState<ImportedApprovalRow[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [accepted, setAccepted] = useState<string | null>(null),
    [now, setNow] = useState(() => Date.now()),
    [uncertain, setUncertain] = useState<Set<string>>(() => new Set()),
    [receipts, setReceipts] = useState<Record<string, ImportedSwapReceipt>>({});
  const pending = useRef<AbortController | null>(null),
    field = useId();
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
          `/api/imported-projects/signing?projectId=${encodeURIComponent(project.id)}${selection ? '&intentId=' + encodeURIComponent(selection.intentId) : older && cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
          { cache: 'no-store', signal },
        );
        const value = (await response.json()) as { error?: string };
        if (!response.ok)
          throw new Error(value.error || 'Approval history unavailable.');
        const page = importedApprovalPage(value, project.id);
        if (selection) {
          if (page.intents.length !== 1 || page.nextCursor !== null)
            throw new Error('Selected approval response differs.');
          if ('order' in selection)
            await requireConditionalApproval(page.intents[0], selection);
          else await requireSessionApproval(page.intents[0], selection);
        }
        if (controller.signal.aborted) return;
        setRows((prior) =>
          older
            ? [
                ...prior,
                ...page.intents.filter(
                  (row) => !prior.some((item) => item.id === row.id),
                ),
              ]
            : page.intents,
        );
        setCursor(page.nextCursor);
        setUncertain(
          (prior) =>
            new Set(
              [...prior].filter(
                (id) => !page.intents.some((row) => row.id === id),
              ),
            ),
        );
      } catch (err) {
        if (!controller.signal.aborted) {
          if (selection) setRows([]);
          setError(
            err instanceof Error
              ? err.message
              : 'Approval history unavailable.',
          );
        }
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    },
    [start, project.id, selection, cursor],
  );
  useEffect(() => {
    let disposed = false;
    void Promise.resolve().then(() => {
      if (selection && !disposed) void read();
    });
    return () => {
      disposed = true;
    };
  }, [selection, read]);
  useEffect(() => {
    let disposed = false;
    void Promise.resolve().then(() => {
      if (submissionBlocked && !disposed) setAccepted(null);
    });
    return () => {
      disposed = true;
    };
  }, [submissionBlocked]);
  async function act(
    row: ImportedApprovalRow,
    action: 'cancel' | 'submit' | 'recover',
  ) {
    if (
      busy ||
      row.projectId !== project.id ||
      (action === 'submit' &&
        (submissionBlocked ||
          accepted !== row.id ||
          !canSubmitImportedApproval(row, project, now, uncertain.has(row.id))))
    )
      return;
    const { controller, signal } = start();
    try {
      const transaction =
        action === 'submit'
          ? (await restoreRegisteredWarmupPacket(row.document, row.signature!))
              .transaction
          : undefined;
      signal.throwIfAborted();
      const response = await fetch('/api/imported-projects/signing', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({
          action,
          id: row.id,
          ...(transaction ? { transaction } : {}),
        }),
      });
      const data = (await response.json()) as {
        error?: string;
        state?: 'submitted' | 'finalized' | 'failed' | 'cancelled';
        signature?: string;
        receipt?: unknown;
        failureReceipt?: SwapFailureReceipt;
      };
      if (!response.ok)
        throw new Error(
          data.error || 'Recovery unavailable. Keep this signature reserved.',
        );
      if (
        action === 'cancel'
          ? data.state !== 'cancelled'
          : data.signature !== row.signature ||
            (action === 'submit'
              ? data.state !== 'submitted'
              : !data.state || !['finalized', 'failed'].includes(data.state))
      )
        throw new Error('Approval response differs.');
      const receipt =
        data.state === 'finalized'
          ? matchingImportedReceipt(data.receipt, row)
          : null;
      const failureReceipt =
        data.state === 'failed'
          ? validatedSwapFailure(
              data.failureReceipt,
              row.document,
              row.signature!,
            )
          : null;
      if (controller.signal.aborted) return;
      setRows((prior) =>
        prior.map((item) =>
          item.id === row.id
            ? { ...item, state: data.state!, failureReceipt }
            : item,
        ),
      );
      if (receipt) {
        setReceipts((prior) => ({ ...prior, [row.id]: receipt }));
        notifyImportedReceiptSaved(receipt);
      }
      setNotice(
        data.state === 'finalized'
          ? 'Finalized swap receipt recorded. Refresh the wallet balance before preparing another transaction.'
          : `Approval state: ${data.state}.`,
      );
    } catch (err) {
      if (!controller.signal.aborted) {
        if (action === 'submit')
          setUncertain((prior) => new Set(prior).add(row.id));
        setError(err instanceof Error ? err.message : 'Recovery unavailable.');
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section aria-label="Imported approval recovery" className="space-y-3">
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => {
          setAccepted(null);
          if (open) {
            pending.current?.abort();
            setOpen(false);
          } else {
            setOpen(true);
            void read();
          }
        }}
      >
        {open ? 'Close swap approval recovery' : 'Open swap approval recovery'}
      </Button>
      {open && (
        <>
          <p>
            Resume saved approvals, including older project revisions and
            archives. Nothing is signed or submitted automatically. Pending
            outcomes keep the wallet reserved.
          </p>
          <Button variant="outline" disabled={busy} onClick={() => void read()}>
            Refresh swap approvals
          </Button>
          {selection && submissionBlocked && (
            <p>
              Submission is unavailable while the selected workflow is being
              updated or is inactive. Existing signatures and finalized outcomes
              remain recoverable.
            </p>
          )}
          {rows.map((row) => {
            const canSubmit =
                !submissionBlocked &&
                canSubmitImportedApproval(
                  row,
                  project,
                  now,
                  uncertain.has(row.id),
                ),
              receipt = receipts[row.id];
            return (
              <article key={row.id} className="space-y-2 border-t py-3">
                <h5>
                  {row.side} · {row.state}
                </h5>
                {row.document.acquisition && (
                  <ImportedAcquisitionReview
                    acquisition={row.document.acquisition}
                  />
                )}
                <p className="warmup-address">
                  Wallet {row.wallet}. Project revision {row.projectRevision}.
                  Wallet revision {row.walletRevision}. Approval expires{' '}
                  {row.document.expiresAt}.
                </p>
                <p>
                  Spend {row.document.inputRaw} atomic units of{' '}
                  {row.document.inputMint}. Receive at least{' '}
                  {row.document.minimumOutputRaw} atomic units of{' '}
                  {row.document.outputMint}. Network fee{' '}
                  {row.document.maximumFeeLamports} lamports.
                </p>
                {row.document.session && (
                  <ImportedSessionReview session={row.document.session} />
                )}
                {row.document.conditional && (
                  <ConditionalSigningReview
                    conditional={row.document.conditional}
                  />
                )}
                {row.document.settlement && (
                  <p>
                    Maximum new-account rent{' '}
                    {row.document.settlement.maximumRentLamports} lamports.
                    Maximum upfront SOL debit{' '}
                    {row.document.settlement.maximumNativeDebitLamports}{' '}
                    lamports. Wrap{' '}
                    {row.document.settlement.wrappedFromNativeRaw} lamports.{' '}
                    {row.document.settlement.closesWrappedAccount
                      ? 'Wrapped SOL closes and returns to this wallet.'
                      : 'Wrapped SOL stays in its token account.'}
                  </p>
                )}
                {row.document.platformFee && (
                  <p>
                    Quoted platform fee {row.document.platformFee.bps} basis
                    points in {row.document.platformFee.mint}.
                  </p>
                )}
                <p className="warmup-address">
                  Approval {row.id}. Preparation {row.preparationId}. Exact
                  packet {row.document.sha256}.
                </p>
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
                {row.state === 'awaiting_signature' && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void act(row, 'cancel')}
                  >
                    Cancel this unsigned swap approval
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
                      />
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
                      Submit saved signed swap to mainnet
                    </Button>
                  </>
                )}
                {row.signature &&
                  (['signed', 'submitted', 'finalized'].includes(row.state) ||
                    (row.state === 'failed' && !row.failureReceipt)) && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void act(row, 'recover')}
                    >
                      {row.state === 'finalized'
                        ? 'View saved finalized swap receipt'
                        : row.state === 'failed'
                          ? 'Check original failure evidence'
                          : 'Verify finalized swap outcome'}
                    </Button>
                  )}
                {uncertain.has(row.id) && (
                  <p>
                    Submission response was not confirmed. Refresh approvals or
                    verify its finalized outcome before another action.
                  </p>
                )}
                {row.state === 'failed' && (
                  <SwapFailureEvidence receipt={row.failureReceipt} />
                )}
                {receipt && (
                  <p>
                    Finalized {receipt.document.side.toLowerCase()} receipt:{' '}
                    {receipt.document.tokenUnitsRaw} token atomic units{' '}
                    {receipt.document.side === 'Buy' ? 'acquired' : 'consumed'}.
                    Observed {receipt.document.observedAt} via{' '}
                    {receipt.document.source}. This receipt does not establish
                    profit or current holdings.
                  </p>
                )}
                {receipt &&
                  receipt.projectId === project.id &&
                  receipt.document.mint === project.document.token.address && (
                    <ImportedReceiptChart receipt={receipt} />
                  )}
                {receipt?.document.side === 'Buy' &&
                  row.state === 'finalized' &&
                  !project.archived &&
                  onReviewBuy && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => onReviewBuy(receipt)}
                    >
                      Review sell of acquired tokens
                    </Button>
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
              Load older swap approvals
            </Button>
          )}
          {!busy && !error && rows.length === 0 && (
            <p>No saved swap approvals for this project.</p>
          )}
          {busy && <output>Reading or recovering this swap approval…</output>}
          {notice && <output>{notice}</output>}
          {error && <p role="alert">{error}</p>}
        </>
      )}
    </section>
  );
}
